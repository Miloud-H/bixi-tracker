use std::collections::HashMap;
use std::time::Duration;

use chrono::{DateTime, Utc};
use geo::{point, Distance, Haversine};
use rusqlite::params;

use crate::db::DbPool;
use crate::models::{Bike, BikeState, GbfsResponse};

const GBFS_URL: &str = "https://gbfs.velobixi.com/gbfs/en/free_bike_status.json";
const POLL_INTERVAL_SECS: u64 = 30;

/// Valid bounding box for Montreal bikes.
fn is_valid_position(lat: f64, lon: f64) -> bool {
    (45.0..=46.0).contains(&lat) && (-74.5..=-73.0).contains(&lon)
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
/// Avoids false trips after a long server downtime.
const MAX_POSITION_AGE_SECS: i64 = 300; // 5 minutes

/// Load last known positions from DB, discarding any older than MAX_POSITION_AGE_SECS.
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

/// Insert all detected trips in a single transaction. Returns count of inserted rows.
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

/// Persist all current positions to DB in a single transaction.
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


/// (moved more than 15 m and speed under 50 km/h).
fn is_valid_trip(distance_m: f64, duration_secs: f64) -> bool {
    if distance_m <= 15.0 || duration_secs <= 0.0 {
        return false;
    }
    let speed_kmh = (distance_m / duration_secs) * 3.6;
    speed_kmh < 50.0
}

pub async fn run(pool: DbPool) {
    let client = reqwest::Client::new();
    let mut positions = load_positions(&pool);
    let mut polls_since_cleanup = 0u32;
    const CLEANUP_EVERY_N_POLLS: u32 = 120; // toutes les heures (120 × 30s)

    println!("Tracker BIXI started");

    loop {
        match client.get(GBFS_URL).send().await {
            Ok(res) => {
                if let Ok(gbfs) = res.json::<GbfsResponse>().await {
                    let now = Utc::now();
                    let mut detected: Vec<(String, String, f64, f64, f64, f64, f64)> = Vec::new();

                    for bike in gbfs.data.bikes {
                        let (lat, lon) = normalize_coords(&bike);

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
                            }
                        }

                        positions.insert(
                            bike.bike_id.clone(),
                            BikeState { lat, lon, timestamp: now },
                        );
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