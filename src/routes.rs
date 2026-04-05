use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use axum::extract::{Query, State};
use axum::Json;
use chrono::{DateTime, NaiveDate, Utc, TimeZone};
use chrono_tz::America::Montreal;

use crate::models::{ActiveStats, Trip, TripQuery};
use crate::db::DbPool;

pub async fn get_trips(
    State(pool): State<DbPool>,
    Query(params): Query<TripQuery>,
) -> Json<Vec<Trip>> {
    let date_str = params
        .date
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());

    let Ok(date) = NaiveDate::parse_from_str(&date_str, "%Y-%m-%d") else {
        return Json(vec![]);
    };

    let (start_utc, end_utc) = day_bounds_utc(date);

    let conn = match pool.get() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("DB pool error in get_trips: {e}");
            return Json(vec![]);
        }
    };

    let mut stmt = match conn.prepare(
        "SELECT bike_id, start_time, start_lat, start_lon,
                end_time, end_lat, end_lon, distance
         FROM trips
         WHERE end_time >= ?1 AND end_time <= ?2
         ORDER BY end_time ASC",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("DB prepare error: {e}");
            return Json(vec![]);
        }
    };

    let rows = match stmt.query_map([&start_utc, &end_utc], |row| {
        Ok(Trip {
            bike_id: row.get(0)?,
            start_time: row.get(1)?,
            start_lat: row.get(2)?,
            start_lon: row.get(3)?,
            end_time: row.get(4)?,
            end_lat: row.get(5)?,
            end_lon: row.get(6)?,
            distance: row.get(7)?,
            group_id: None,
        })
    }) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("DB query error: {e}");
            return Json(vec![]);
        }
    };

    let mut trips: Vec<Trip> = rows.filter_map(|r| r.ok()).collect();

    assign_group_ids(&mut trips);

    Json(trips)
}

/// Convert a local Montreal date into UTC RFC3339 bounds.
fn day_bounds_utc(date: NaiveDate) -> (String, String) {
    let start = Montreal
        .from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
        .single()
        .unwrap()
        .with_timezone(&Utc);

    let end = Montreal
        .from_local_datetime(&date.and_hms_opt(23, 59, 59).unwrap())
        .single()
        .unwrap()
        .with_timezone(&Utc);

    (start.to_rfc3339(), end.to_rfc3339())
}

/// Group trips that share the same origin/destination within the same 5-minute window.
/// Precision ~110 m — enough to cluster bikes at the same station.
fn assign_group_ids(trips: &mut Vec<Trip>) {
    type Signature = (String, String, i64);

    let mut counts: HashMap<Signature, i32> = HashMap::new();
    let mut sig_to_id: HashMap<Signature, i32> = HashMap::new();
    let mut next_id = 1i32;

    let signatures: Vec<Option<Signature>> = trips
        .iter()
        .map(|t| {
            let ts = DateTime::parse_from_rfc3339(&t.start_time).ok()?;
            let slot = ts.timestamp() / 300;
            Some((
                format!("{:.3},{:.3}", t.start_lat, t.start_lon),
                format!("{:.3},{:.3}", t.end_lat, t.end_lon),
                slot,
            ))
        })
        .collect();

    for sig in signatures.iter().flatten() {
        *counts.entry(sig.clone()).or_insert(0) += 1;
    }

    for (trip, sig) in trips.iter_mut().zip(signatures.iter()) {
        if let Some(sig) = sig {
            if counts.get(sig).copied().unwrap_or(0) > 1 {
                let gid = *sig_to_id.entry(sig.clone()).or_insert_with(|| {
                    let id = next_id;
                    next_id += 1;
                    id
                });
                trip.group_id = Some(gid);
            }
        }
    }
}

// --- Active bikes endpoint ---

pub async fn get_active(
    State(in_flight): State<Arc<RwLock<HashMap<String, DateTime<Utc>>>>>
) -> Json<ActiveStats> {
    let count = match in_flight.read() {
        Ok(g) => g.len(),
        Err(_) => 0,
    };

    Json(ActiveStats {
        active_count: count,
        last_updated: Utc::now().to_rfc3339(),
    })
}