use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use geo::{point, Distance, Haversine};
use rusqlite::params;
use web_push_native::jwt_simple::algorithms::ES256KeyPair;

use crate::db::DbPool;
use crate::models::{Bike, BikeState, GbfsResponse, InFlightBikes};
use crate::push::{self, ReturnedBike};

const GBFS_URL: &str = "https://gbfs.velobixi.com/gbfs/en/free_bike_status.json";
const POLL_INTERVAL_SECS: u64 = 15;
const IN_FLIGHT_PATH: &str = "in_flight.json";

// Un vélo doit être absent du flux GBFS pendant ce délai avant d'être considéré
// "parti" — filtre les accrocs ponctuels du flux (un vélo qui disparaît une
// itération puis revient sans avoir vraiment bougé).
const MIN_ABSENT_SECS: i64 = 45;

fn is_valid_position(lat: f64, lon: f64) -> bool {
    (45.0..=46.0).contains(&lat) && (-74.5..=-71.5).contains(&lon)
}

/// Swap lat/lon if they appear inverted (known GBFS quirk).
fn normalize_coords(bike: &Bike) -> (f64, f64) {
    if bike.lat < 0.0 && bike.lon > 0.0 {
        (bike.lon, bike.lat)
    } else {
        (bike.lat, bike.lon)
    }
}

const MAX_POSITION_AGE_SECS: i64 = 300;

// Comfortably past the 120-min in-flight timeout, so this never deletes a
// still-active watch — only ones whose bike never came back.
const PUSH_SUBSCRIPTION_MAX_AGE_SECS: i64 = 3 * 60 * 60;

fn load_positions(pool: &DbPool) -> HashMap<String, BikeState> {
    let conn = match pool.get() {
        Ok(c) => c,
        Err(e) => { eprintln!("DB pool error loading positions: {e}"); return HashMap::new(); }
    };

    let cutoff = (Utc::now() - chrono::Duration::seconds(MAX_POSITION_AGE_SECS)).to_rfc3339();

    let mut stmt = match conn.prepare(
        "SELECT bike_id, lat, lon, seen_at FROM bike_positions WHERE seen_at >= ?1"
    ) {
        Ok(s) => s,
        Err(e) => { eprintln!("DB prepare error: {e}"); return HashMap::new(); }
    };

    let rows = match stmt.query_map([&cutoff], |row| {
        let seen_at: String = row.get(3)?;
        Ok((
            row.get::<_, String>(0)?,
            BikeState {
                lat: row.get(1)?,
                lon: row.get(2)?,
                timestamp: DateTime::parse_from_rfc3339(&seen_at)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|_| Utc::now()),
            },
        ))
    }) {
        Ok(r) => r,
        Err(e) => { eprintln!("DB query error loading positions: {e}"); return HashMap::new(); }
    };

    let positions: HashMap<String, BikeState> = rows.filter_map(|r| r.ok()).collect();

    if !positions.is_empty() {
        println!("📂 Restored {} recent positions from DB", positions.len());
    }

    positions
}

fn load_in_flight(in_flight: &InFlightBikes) {
    let data = match std::fs::read_to_string(IN_FLIGHT_PATH) {
        Ok(d) => d,
        Err(_) => return,
    };

    let map: HashMap<String, (String, f64, f64)> = match serde_json::from_str(&data) {
        Ok(m) => m,
        Err(e) => { eprintln!("Failed to parse in_flight.json (format change?): {e}"); return; }
    };

    let cutoff = Utc::now() - chrono::Duration::minutes(120);
    let mut count = 0usize;

    if let Ok(mut flight) = in_flight.write() {
        for (bike_id, (ts_str, lat, lon)) in map {
            if let Ok(ts) = DateTime::parse_from_rfc3339(&ts_str) {
                let ts_utc = ts.with_timezone(&Utc);
                if ts_utc > cutoff {
                    flight.insert(bike_id, (ts_utc, lat, lon));
                    count += 1;
                }
            }
        }
    }

    if count > 0 {
        println!("Restored {} in-flight bikes from disk", count);
    }
}

fn save_in_flight(in_flight: &InFlightBikes) {
    let flight = match in_flight.read() {
        Ok(f) => f,
        Err(_) => return,
    };

    let map: HashMap<&String, (String, f64, f64)> = flight
        .iter()
        .map(|(id, (ts, lat, lon))| (id, (ts.to_rfc3339(), *lat, *lon)))
        .collect();

    match serde_json::to_string(&map) {
        Ok(json) => {
            if let Err(e) = std::fs::write(IN_FLIGHT_PATH, json) {
                eprintln!("Failed to save in_flight.json: {e}");
            }
        }
        Err(e) => eprintln!("Failed to serialize in_flight: {e}"),
    }
}

fn insert_trips(
    pool: &DbPool,
    trips: &[(String, String, f64, f64, f64, f64, f64)],
    end_time: &str,
) -> u32 {
    if trips.is_empty() { return 0; }

    let mut conn = match pool.get() {
        Ok(c) => c,
        Err(e) => { eprintln!("DB pool error inserting trips: {e}"); return 0; }
    };

    let tx = match conn.transaction() {
        Ok(t) => t,
        Err(e) => { eprintln!("DB transaction error: {e}"); return 0; }
    };

    let mut count = 0u32;
    for (bike_id, start_time, start_lat, start_lon, end_lat, end_lon, distance) in trips {
        match tx.execute(
            "INSERT INTO trips
             (bike_id, start_time, start_lat, start_lon, end_time, end_lat, end_lon, distance)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![bike_id, start_time, start_lat, start_lon, end_time, end_lat, end_lon, distance],
        ) {
            Ok(_) => count += 1,
            Err(e) => eprintln!("DB insert error: {e}"),
        }
    }

    if let Err(e) = tx.commit() {
        eprintln!("DB commit error: {e}");
        return 0;
    }

    count
}

fn save_positions(pool: &DbPool, positions: &HashMap<String, BikeState>) {
    let mut conn = match pool.get() {
        Ok(c) => c,
        Err(e) => { eprintln!("DB pool error saving positions: {e}"); return; }
    };

    let tx = match conn.transaction() {
        Ok(t) => t,
        Err(e) => { eprintln!("DB transaction error: {e}"); return; }
    };

    for (bike_id, state) in positions {
        if let Err(e) = tx.execute(
            "INSERT INTO bike_positions (bike_id, lat, lon, seen_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(bike_id) DO UPDATE SET lat=?2, lon=?3, seen_at=?4",
            params![bike_id, state.lat, state.lon, state.timestamp.to_rfc3339()],
        ) {
            eprintln!("DB upsert position error: {e}");
        }
    }

    if let Err(e) = tx.commit() {
        eprintln!("DB transaction commit error: {e}");
    }
}

fn is_valid_trip(distance_m: f64, duration_secs: f64) -> bool {
    if distance_m <= 100.0 || duration_secs <= 0.0 {
        return false;
    }

    if duration_secs > 7200.0 {
        return false;
    }

    let speed_kmh = (distance_m / duration_secs) * 3.6;
    speed_kmh >= 3.0 && speed_kmh < 50.0
}

pub async fn run(pool: DbPool, in_flight: InFlightBikes, vapid_key: Arc<ES256KeyPair>) {
    let client = reqwest::Client::new();
    let mut positions = load_positions(&pool);
    load_in_flight(&in_flight);
    let mut disappeared_at: HashMap<String, DateTime<Utc>> = HashMap::new();
    let mut polls_since_cleanup = 0u32;
    const CLEANUP_EVERY_N_POLLS: u32 = 240; // ~1h avec un poll toutes les 15s

    println!("Tracker BIXI started");

    loop {
        match client.get(GBFS_URL).send().await {
            Ok(res) => {
                if let Ok(gbfs) = res.json::<GbfsResponse>().await {
                    let now = Utc::now();
                    let available_ids: std::collections::HashSet<&str> = gbfs.data.bikes.iter()
                        .filter(|b| b.is_available())
                        .map(|b| b.bike_id.as_str())
                        .collect();

                    let mut detected: Vec<(String, String, f64, f64, f64, f64, f64)> = Vec::new();
                    let mut returned: Vec<String> = Vec::new();

                    for bike in &gbfs.data.bikes {
                        let (lat, lon) = normalize_coords(bike);

                        if !is_valid_position(lat, lon) {
                            continue;
                        }

                        if let Some(prev) = positions.get(&bike.bike_id) {
                            let p1 = point!(x: prev.lon, y: prev.lat);
                            let p2 = point!(x: lon, y: lat);
                            let distance = Haversine::distance(p1, p2);
                            let duration = (now - prev.timestamp).num_seconds() as f64;

                            if is_valid_trip(distance, duration) {
                                detected.push((
                                    bike.bike_id.clone(),
                                    prev.timestamp.to_rfc3339(),
                                    prev.lat, prev.lon,
                                    lat, lon,
                                    distance,
                                ));
                                returned.push(bike.bike_id.clone());
                            }
                        }

                        disappeared_at.remove(&bike.bike_id);

                        if bike.is_available() {
                            positions.insert(
                                bike.bike_id.clone(),
                                BikeState { lat, lon, timestamp: now },
                            );
                        } else {
                            positions.remove(&bike.bike_id);
                        }
                    }

                    for id in positions.keys() {
                        if !available_ids.contains(id.as_str()) {
                            disappeared_at.entry(id.clone()).or_insert(now);
                        }
                    }
                    disappeared_at.retain(|id, _| !available_ids.contains(id.as_str()));

                    let just_returned: Vec<ReturnedBike> = {
                        let mut flight = in_flight.write().unwrap();

                        // Bikes that were in-flight and are visible again in this poll —
                        // captured before mutation so watchers can be notified below.
                        let just_returned: Vec<ReturnedBike> = flight.iter()
                            .filter(|(id, _)| available_ids.contains(id.as_str()))
                            .filter_map(|(id, &(departed_at, dep_lat, dep_lon))| {
                                let arr = positions.get(id)?;
                                Some(ReturnedBike {
                                    bike_id:      id.clone(),
                                    dep_lat, dep_lon,
                                    arr_lat: arr.lat, arr_lon: arr.lon,
                                    elapsed_min: (now - departed_at).num_minutes(),
                                })
                            })
                            .collect();

                        for (id, &first_absent) in &disappeared_at {
                            if (now - first_absent).num_seconds() >= MIN_ABSENT_SECS
                                && !flight.contains_key(id)
                            {
                                let (dep_lat, dep_lon) = positions.get(id)
                                    .map(|p| (p.lat, p.lon))
                                    .unwrap_or((0.0, 0.0));
                                flight.insert(id.clone(), (first_absent, dep_lat, dep_lon));
                            }
                        }
                        for id in &returned {
                            flight.remove(id);
                        }
                        // Keep only bikes still absent from the feed and within the 2h window.
                        // Without this, returned bikes linger until timeout inflating the count.
                        flight.retain(|id, (start, _, _)| {
                            disappeared_at.contains_key(id)
                                && (now - *start).num_minutes() < 120
                        });

                        just_returned
                    };

                    for bike in &just_returned {
                        let distance_m = detected.iter()
                            .find(|t| t.0 == bike.bike_id)
                            .map(|t| t.6);
                        push::notify_bike_returned(&pool, &client, &vapid_key, bike, distance_m).await;
                    }

                    let new_trips = insert_trips(&pool, &detected, &now.to_rfc3339());

                    if new_trips > 0 {
                        println!(
                            "[{}] {} new trip(s) recorded",
                            now.format("%H:%M:%S"),
                            new_trips
                        );
                    }

                    save_positions(&pool, &positions);
                    save_in_flight(&in_flight);

                    polls_since_cleanup += 1;
                    if polls_since_cleanup >= CLEANUP_EVERY_N_POLLS {
                        crate::db::cleanup_positions(&pool, MAX_POSITION_AGE_SECS);
                        crate::db::cleanup_push_subscriptions(&pool, PUSH_SUBSCRIPTION_MAX_AGE_SECS);
                        polls_since_cleanup = 0;
                    }
                }
            }
            Err(e) => eprintln!("GBFS network error: {e}"),
        }

        tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bike(lat: f64, lon: f64) -> Bike {
        Bike { bike_id: "T1".to_string(), lat, lon, is_reserved: 0, is_disabled: 0 }
    }

    #[test]
    fn valid_trip_within_bounds() {
        // 500 m in 5 min = 6 km/h — inside the 3-50 km/h window.
        assert!(is_valid_trip(500.0, 300.0));
    }

    #[test]
    fn rejects_trip_too_short() {
        // The 100 m floor filters GPS jitter from a parked bike.
        assert!(!is_valid_trip(100.0, 300.0));
        assert!(!is_valid_trip(50.0, 300.0));
    }

    #[test]
    fn rejects_zero_or_negative_duration() {
        assert!(!is_valid_trip(500.0, 0.0));
        assert!(!is_valid_trip(500.0, -10.0));
    }

    #[test]
    fn rejects_trip_over_two_hours() {
        assert!(!is_valid_trip(2000.0, 7201.0));
    }

    #[test]
    fn rejects_implausible_speed() {
        // Too slow to be riding (under 3 km/h) — likely a stationary GPS drift.
        assert!(!is_valid_trip(110.0, 600.0));
        // Too fast for a bike (50+ km/h) — likely a GPS jump or vehicle transport.
        assert!(!is_valid_trip(5000.0, 100.0));
    }

    #[test]
    fn normalize_coords_leaves_correct_order_untouched() {
        let (lat, lon) = normalize_coords(&bike(45.5, -73.6));
        assert_eq!((lat, lon), (45.5, -73.6));
    }

    #[test]
    fn normalize_coords_swaps_inverted_pair() {
        // Known GBFS quirk: some feeds report (lon, lat) instead of (lat, lon).
        let (lat, lon) = normalize_coords(&bike(-73.6, 45.5));
        assert_eq!((lat, lon), (45.5, -73.6));
    }

    #[test]
    fn valid_position_accepts_montreal_and_sherbrooke() {
        assert!(is_valid_position(45.5017, -73.5673)); // Montréal
        assert!(is_valid_position(45.4040, -71.8929)); // Sherbrooke
    }

    #[test]
    fn valid_position_rejects_out_of_range() {
        assert!(!is_valid_position(0.0, 0.0));
        assert!(!is_valid_position(45.5, -80.0));
    }
}