use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use chrono_tz::America::Montreal;

use crate::models::{ActiveStats, Flow, FlowQuery, HeatPoint, HeatQuery, Trip, TripQuery, Zone};
use crate::AppState;

// --- Trips ---

pub async fn get_trips(
    State(state): State<AppState>,
    Query(params): Query<TripQuery>,
) -> Result<Json<Vec<Trip>>, StatusCode> {
    let date_str = params
        .date
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());

    let Ok(date) = NaiveDate::parse_from_str(&date_str, "%Y-%m-%d") else {
        return Ok(Json(vec![]));
    };

    let (start_utc, end_utc) = day_bounds_utc(date);

    let conn = state.pool.get()
        .map_err(|e| { eprintln!("DB pool error in get_trips: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    let mut stmt = conn.prepare(
        "SELECT bike_id, start_time, start_lat, start_lon,
                end_time, end_lat, end_lon, distance
         FROM trips
         WHERE end_time >= ?1 AND end_time <= ?2
         ORDER BY end_time ASC",
    ).map_err(|e| { eprintln!("DB prepare error: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    let rows = stmt.query_map([&start_utc, &end_utc], |row| {
        Ok(Trip {
            bike_id:    row.get(0)?,
            start_time: row.get(1)?,
            start_lat:  row.get(2)?,
            start_lon:  row.get(3)?,
            end_time:   row.get(4)?,
            end_lat:    row.get(5)?,
            end_lon:    row.get(6)?,
            distance:   row.get(7)?,
            group_id:   None,
        })
    }).map_err(|e| { eprintln!("DB query error: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    let mut trips: Vec<Trip> = rows.filter_map(|r| r.ok()).collect();
    assign_group_ids(&mut trips);
    Ok(Json(trips))
}

// --- Active ---

pub async fn get_active(
    State(state): State<AppState>,
) -> Json<ActiveStats> {
    let count = state.in_flight.read().map(|g| g.len()).unwrap_or(0);
    Json(ActiveStats {
        active_count: count,
        last_updated: Utc::now().to_rfc3339(),
    })
}

// --- Zones ---

pub async fn get_zones() -> Json<Vec<Zone>> {
    Json(
        crate::zones::ZONES
            .iter()
            .map(|(name, lat, lon)| Zone { name, lat: *lat, lon: *lon })
            .collect(),
    )
}

// --- Heatmap ---

pub async fn get_heatmap(
    State(state): State<AppState>,
    Query(params): Query<HeatQuery>,
) -> Result<Json<Vec<HeatPoint>>, StatusCode> {
    let date_str = params
        .date
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());

    if let Some(cached) = state.heat_cache.get(&date_str) {
        return Ok(Json(cached));
    }

    let Ok(date) = NaiveDate::parse_from_str(&date_str, "%Y-%m-%d") else {
        return Ok(Json(vec![]));
    };

    let (start_utc, end_utc) = day_bounds_utc(date);

    let conn = state.pool.get()
        .map_err(|e| { eprintln!("DB pool error in get_heatmap: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    let mut stmt = conn.prepare(
        "SELECT ROUND(start_lat, 3), ROUND(start_lon, 3),
                CAST(strftime('%H', datetime(start_time, '-4 hours')) AS INTEGER),
                COUNT(*) as volume
         FROM trips
         WHERE end_time >= ?1 AND end_time <= ?2
           AND distance > 100
         GROUP BY 1, 2, 3
         ORDER BY volume DESC",
    ).map_err(|e| { eprintln!("DB prepare error: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    let rows = stmt.query_map([&start_utc, &end_utc], |row| {
        Ok(HeatPoint {
            lat:    row.get(0)?,
            lon:    row.get(1)?,
            hour:   row.get::<_, i64>(2)? as u8,
            volume: row.get(3)?,
        })
    }).map_err(|e| { eprintln!("DB query error: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    let points: Vec<HeatPoint> = rows.filter_map(|r| r.ok()).collect();
    state.heat_cache.set(date_str, points.clone());
    Ok(Json(points))
}

// --- Flows ---

pub async fn get_flows(
    State(state): State<AppState>,
    Query(params): Query<FlowQuery>,
) -> Result<Json<Vec<Flow>>, StatusCode> {
    let date_str = params
        .date
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());

    if let Some(cached) = state.flow_cache.get(&date_str) {
        return Ok(Json(cached));
    }

    let Ok(date) = NaiveDate::parse_from_str(&date_str, "%Y-%m-%d") else {
        return Ok(Json(vec![]));
    };

    let (start_utc, end_utc) = day_bounds_utc(date);

    let conn = state.pool.get()
        .map_err(|e| { eprintln!("DB pool error in get_flows: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    let mut stmt = conn.prepare(
        "SELECT start_lat, start_lon, end_lat, end_lon, distance,
                CAST(strftime('%H', datetime(start_time, '-4 hours')) AS INTEGER) as hour,
                (julianday(end_time) - julianday(start_time)) * 1440.0 as duration_min
         FROM trips
         WHERE end_time >= ?1 AND end_time <= ?2
           AND distance > 100",
    ).map_err(|e| { eprintln!("DB prepare error: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    #[derive(Debug)]
    struct RawTrip {
        start_lat: f64, start_lon: f64,
        end_lat:   f64, end_lon:   f64,
        distance:  f64, hour: u8,  duration_min: f64,
    }

    let rows = stmt.query_map([&start_utc, &end_utc], |row| {
        Ok(RawTrip {
            start_lat:    row.get(0)?, start_lon:    row.get(1)?,
            end_lat:      row.get(2)?, end_lon:      row.get(3)?,
            distance:     row.get(4)?,
            hour:         row.get::<_, i64>(5)? as u8,
            duration_min: row.get(6)?,
        })
    }).map_err(|e| { eprintln!("DB query error: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    let raw_trips: Vec<RawTrip> = rows.filter_map(|r| r.ok()).collect();

    type FlowKey = (String, String, u8);
    let mut agg: HashMap<FlowKey, (i64, f64, f64)> = HashMap::new();

    for trip in &raw_trips {
        let Some(orig) = crate::zones::snap_nearest(trip.start_lat, trip.start_lon) else { continue };
        let Some(dest) = crate::zones::snap_nearest(trip.end_lat,   trip.end_lon)   else { continue };
        if orig == dest { continue; }

        let entry = agg
            .entry((orig.to_string(), dest.to_string(), trip.hour))
            .or_insert((0, 0.0, 0.0));
        entry.0 += 1;
        entry.1 += trip.distance;
        entry.2 += trip.duration_min;
    }

    let flows: Vec<Flow> = agg
        .into_iter()
        .map(|((origin, destination, hour), (count, total_dist, total_dur))| Flow {
            origin, destination, hour, count,
            avg_distance:    total_dist / count as f64,
            avg_duration_min: total_dur / count as f64,
        })
        .filter(|f| f.count >= 2)
        .collect();

    state.flow_cache.set(date_str, flows.clone());
    Ok(Json(flows))
}

// --- Helpers ---

fn day_bounds_utc(date: NaiveDate) -> (String, String) {
    let start = Montreal
        .from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap())
        .single().unwrap()
        .with_timezone(&Utc);
    let end = Montreal
        .from_local_datetime(&date.and_hms_opt(23, 59, 59).unwrap())
        .single().unwrap()
        .with_timezone(&Utc);
    (start.to_rfc3339(), end.to_rfc3339())
}

fn assign_group_ids(trips: &mut Vec<Trip>) {
    use std::collections::HashMap;
    type Signature = (String, String, i64);

    let mut counts:    HashMap<Signature, i32> = HashMap::new();
    let mut sig_to_id: HashMap<Signature, i32> = HashMap::new();
    let mut next_id = 1i32;

    let signatures: Vec<Option<Signature>> = trips
        .iter()
        .map(|t| {
            let ts = DateTime::parse_from_rfc3339(&t.start_time).ok()?;
            let slot = ts.timestamp() / 300;
            Some((
                format!("{:.3},{:.3}", t.start_lat, t.start_lon),
                format!("{:.3},{:.3}", t.end_lat,   t.end_lon),
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
