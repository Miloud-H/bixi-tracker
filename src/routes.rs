use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::America::Montreal;

use crate::models::{
    ActiveStats, DayStats, Flow, FlowQuery, HeatPoint, HeatQuery,
    HistoryQuery, Trip, TripQuery, Zone, ZoneQuery,
};
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

pub async fn get_active(State(state): State<AppState>) -> Json<ActiveStats> {
    let count = state.in_flight.read().map(|g| g.len()).unwrap_or(0);
    Json(ActiveStats {
        active_count: count,
        last_updated: Utc::now().to_rfc3339(),
    })
}

// --- Zones ---

pub async fn get_zones(Query(params): Query<ZoneQuery>) -> Json<Vec<Zone>> {
    Json(
        crate::zones::ZONES.iter()
            .filter(|(_, _, _, c)| params.city.as_deref().map_or(true, |city| *c == city))
            .map(|(name, lat, lon, city)| Zone { name, lat: *lat, lon: *lon, city })
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
    let is_week   = params.week.unwrap_or(0) == 1;
    let is_arrivals = params.trip_type.as_deref() == Some("arrivals");
    let kind      = if is_arrivals { "arrivals" } else { "departures" };
    let period    = if is_week { "week" } else { "day" };
    let cache_key = format!("{date_str}:{kind}:{period}");

    if let Some(cached) = state.heat_cache.get(&cache_key) {
        return Ok(Json(cached));
    }

    let Ok(end_date) = NaiveDate::parse_from_str(&date_str, "%Y-%m-%d") else {
        return Ok(Json(vec![]));
    };

    let (start_utc, end_utc) = if is_week {
        let start_date = end_date - Duration::days(6);
        let (s, _) = day_bounds_utc(start_date);
        let (_, e) = day_bounds_utc(end_date);
        (s, e)
    } else {
        day_bounds_utc(end_date)
    };

    let conn = state.pool.get()
        .map_err(|e| { eprintln!("DB pool error in get_heatmap: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    let sql = if is_arrivals {
        "SELECT ROUND(end_lat, 3), ROUND(end_lon, 3),
                CAST(strftime('%H', datetime(end_time, '-4 hours')) AS INTEGER),
                COUNT(*) as volume
         FROM trips
         WHERE end_time >= ?1 AND end_time <= ?2
           AND distance > 100
         GROUP BY 1, 2, 3
         ORDER BY volume DESC"
    } else {
        "SELECT ROUND(start_lat, 3), ROUND(start_lon, 3),
                CAST(strftime('%H', datetime(start_time, '-4 hours')) AS INTEGER),
                COUNT(*) as volume
         FROM trips
         WHERE end_time >= ?1 AND end_time <= ?2
           AND distance > 100
         GROUP BY 1, 2, 3
         ORDER BY volume DESC"
    };

    let mut stmt = conn.prepare(sql)
        .map_err(|e| { eprintln!("DB prepare error: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    let rows = stmt.query_map([&start_utc, &end_utc], |row| {
        Ok(HeatPoint {
            lat:    row.get(0)?,
            lon:    row.get(1)?,
            hour:   row.get::<_, i64>(2)? as u8,
            volume: row.get(3)?,
        })
    }).map_err(|e| { eprintln!("DB query error: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    let points: Vec<HeatPoint> = rows.filter_map(|r| r.ok()).collect();
    state.heat_cache.set(cache_key, points.clone());
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
    let city = params.city.as_deref().unwrap_or("montreal").to_string();
    let cache_key = format!("{date_str}:{city}");

    if let Some(cached) = state.flow_cache.get(&cache_key) {
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
            start_lat:    row.get(0)?, start_lon: row.get(1)?,
            end_lat:      row.get(2)?, end_lon:   row.get(3)?,
            distance:     row.get(4)?,
            hour:         row.get::<_, i64>(5)? as u8,
            duration_min: row.get(6)?,
        })
    }).map_err(|e| { eprintln!("DB query error: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    let raw_trips: Vec<RawTrip> = rows.filter_map(|r| r.ok()).collect();

    type FlowKey = (String, String, u8);
    let mut agg: HashMap<FlowKey, (i64, f64, f64)> = HashMap::new();

    for trip in &raw_trips {
        // Filtre par ville via longitude
        let trip_city = if trip.start_lon < -72.5 { "montreal" } else { "sherbrooke" };
        if trip_city != city { continue; }

        let Some(orig) = crate::zones::snap_nearest_for_city(trip.start_lat, trip.start_lon, &city) else { continue };
        let Some(dest) = crate::zones::snap_nearest_for_city(trip.end_lat,   trip.end_lon,   &city) else { continue };
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
            avg_distance:     total_dist / count as f64,
            avg_duration_min: total_dur  / count as f64,
        })
        .filter(|f| f.count >= 2)
        .collect();

    state.flow_cache.set(cache_key, flows.clone());
    Ok(Json(flows))
}

// --- Historique ---

pub async fn get_history(
    State(state): State<AppState>,
    Query(params): Query<HistoryQuery>,
) -> Result<Json<Vec<DayStats>>, StatusCode> {
    let city = params.city.as_deref().unwrap_or("all");

    let city_filter = match city {
        "montreal"   => " AND start_lon < -72.5",
        "sherbrooke" => " AND start_lon >= -72.5",
        _            => "",
    };

    let (start_utc, end_clause) = if let (Some(from), Some(to)) = (&params.from, &params.to) {
        let s = format!("{}T04:00:00+00:00", from);
        let e = format!("{}T04:00:00+00:00", to);
        (s, format!(" AND end_time < '{e}'"))
    } else {
        let days = params.days.unwrap_or(30);
        let s = if days <= 0 {
            "2000-01-01T00:00:00+00:00".to_string()
        } else {
            (Utc::now() - Duration::days(days)).to_rfc3339()
        };
        (s, String::new())
    };

    let conn = state.pool.get()
        .map_err(|e| { eprintln!("DB pool error in get_history: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    let sql = format!(
        "SELECT strftime('%Y-%m-%d', datetime(end_time, '-4 hours')) as day, COUNT(*) as count
         FROM trips
         WHERE end_time >= ?1{end_clause}{city_filter}
         GROUP BY day
         ORDER BY day ASC"
    );

    let mut stmt = conn.prepare(&sql)
        .map_err(|e| { eprintln!("DB prepare error: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    let rows = stmt.query_map([&start_utc], |row| {
        Ok(DayStats { date: row.get(0)?, count: row.get(1)? })
    }).map_err(|e| { eprintln!("DB query error: {e}"); StatusCode::INTERNAL_SERVER_ERROR })?;

    Ok(Json(rows.filter_map(|r| r.ok()).collect()))
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
