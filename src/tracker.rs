use std::collections::HashMap;
use std::time::Duration;

use chrono::{DateTime, Utc};
use geo::{point, Distance, Haversine};
use rusqlite::params;

use crate::db::DbPool;
use crate::models::{Bike, BikeState, GbfsResponse, InFlightBikes};

const GBFS_URL: &str = "https://gbfs.velobixi.com/gbfs/en/free_bike_status.json";
const POLL_INTERVAL_SECS: u64 = 30;
const IN_FLIGHT_PATH: &str = "in_flight.json";

/// Valid bounding box for Montreal bikes.
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

/// Maximum age of a saved position before it's considered stale.
const MAX_POSITION_AGE_SECS: i64 = 300; // 5 minutes

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

    let map: HashMap<String, String> = match serde_json::from_str(&data) {
        Ok(m) => m,
        Err(e) => { eprintln!("Failed to parse in_flight.json: {e}"); return; }
    };

    let cutoff = Utc::now() - chrono::Duration::minutes(120);
    let mut count = 0usize;

    if let Ok(mut flight) = in_flight.write() {
        for (bike_id, ts_str) in map {
            if let Ok(ts) = DateTime::parse_from_rfc3339(&ts_str) {
                let ts_utc = ts.with_timezone(&Utc);
                if ts_utc > cutoff {
                    flight.insert(bike_id, ts_utc);
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

    let map: HashMap<&String, String> = flight
        .iter()
        .map(|(id, ts)| (id, ts.to_rfc3339()))
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
    if distance_m <= 15.0 || duration_secs <= 0.0 {
        return false;
    }
    let speed_kmh = (distance_m / duration_secs) * 3.6;
    speed_kmh < 50.0
}

pub async fn run(pool: DbPool, in_flight: InFlightBikes) {
    let client = reqwest::Client::new();
    let mut positions = load_positions(&pool);
    load_in_flight(&in_flight);
    let mut polls_since_cleanup = 0u32;
    const CLEANUP_EVERY_N_POLLS: u32 = 120; // Each hour (120 × 30s)

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

                        if bike.is_available() {
                            positions.insert(
                                bike.bike_id.clone(),
                                BikeState { lat, lon, timestamp: now },
                            );
                        } else {
                            positions.remove(&bike.bike_id);
                        }
                    }

                    {
                        let mut flight = in_flight.write().unwrap();
                        for (id, state) in &positions {
                            if !available_ids.contains(id.as_str()) {
                                let absent_secs = (now - state.timestamp).num_seconds();
                                if absent_secs >= 60 {
                                    flight.entry(id.clone()).or_insert(now);
                                }
                            }
                        }
                        for id in &returned {
                            flight.remove(id);
                        }
                        flight.retain(|_, start| (now - *start).num_minutes() < 120);
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
                        polls_since_cleanup = 0;
                    }
                }
            }
            Err(e) => eprintln!("GBFS network error: {e}"),
        }

        tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
    }
}