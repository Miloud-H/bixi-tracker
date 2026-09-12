use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::America::Montreal;

use crate::error::{AppError, ResultExt};
use crate::models::{
    ActiveStats, BikeLeaderboardEntry, BikeStatus, BikeStatusQuery, DayStats, DepartingBike,
    FleetStats, FleetStatsQuery, Flow, FlowQuery, HeatPoint, HeatQuery, HistoryQuery,
    NearbyQuery, OverdueBike, SubscribeRequest, Trip, TripQuery, UnsubscribeRequest,
    VapidKeyResponse, Zone, ZoneQuery,
};
use crate::AppState;

// --- Trips ---

pub async fn get_trips(
    State(state): State<AppState>,
    Query(params): Query<TripQuery>,
) -> Result<Json<Vec<Trip>>, AppError> {
    let date_str = params
        .date
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());

    let Ok(date) = NaiveDate::parse_from_str(&date_str, "%Y-%m-%d") else {
        return Ok(Json(vec![]));
    };

    let (start_utc, end_utc) = day_bounds_utc(date);

    let conn = state.pool.get().ctx("get_trips: pool")?;

    let mut stmt = conn.prepare(
        "SELECT bike_id, start_time, start_lat, start_lon,
                end_time, end_lat, end_lon, distance
         FROM trips
         WHERE end_time >= ?1 AND end_time <= ?2
         ORDER BY end_time ASC",
    ).ctx("get_trips: prepare")?;

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
    }).ctx("get_trips: query")?;

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
            .filter(|(_, _, _, c)| params.city.as_deref().is_none_or(|city| *c == city))
            .map(|(name, lat, lon, city)| Zone { name, lat: *lat, lon: *lon, city })
            .collect(),
    )
}

// --- Heatmap ---

pub async fn get_heatmap(
    State(state): State<AppState>,
    Query(params): Query<HeatQuery>,
) -> Result<Json<Vec<HeatPoint>>, AppError> {
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

    let conn = state.pool.get().ctx("get_heatmap: pool")?;

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

    let mut stmt = conn.prepare(sql).ctx("get_heatmap: prepare")?;

    let rows = stmt.query_map([&start_utc, &end_utc], |row| {
        Ok(HeatPoint {
            lat:    row.get(0)?,
            lon:    row.get(1)?,
            hour:   row.get::<_, i64>(2)? as u8,
            volume: row.get(3)?,
        })
    }).ctx("get_heatmap: query")?;

    let points: Vec<HeatPoint> = rows.filter_map(|r| r.ok()).collect();
    state.heat_cache.set(cache_key, points.clone());
    Ok(Json(points))
}

// --- Flows ---

pub async fn get_flows(
    State(state): State<AppState>,
    Query(params): Query<FlowQuery>,
) -> Result<Json<Vec<Flow>>, AppError> {
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

    let conn = state.pool.get().ctx("get_flows: pool")?;

    let mut stmt = conn.prepare(
        "SELECT start_lat, start_lon, end_lat, end_lon, distance,
                CAST(strftime('%H', datetime(start_time, '-4 hours')) AS INTEGER) as hour,
                (julianday(end_time) - julianday(start_time)) * 1440.0 as duration_min
         FROM trips
         WHERE end_time >= ?1 AND end_time <= ?2
           AND distance > 100",
    ).ctx("get_flows: prepare")?;

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
    }).ctx("get_flows: query")?;

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

// --- Départs récents à proximité ---

/// Snapshot of every currently in-flight bike as a `DepartingBike` — shared by
/// `get_departures_nearby` (filtered to one station) and `get_in_flight_bikes`
/// (unfiltered, system-wide).
fn all_in_flight(state: &AppState) -> Vec<DepartingBike> {
    let now = Utc::now();
    let flight = match state.in_flight.read() {
        Ok(f) => f,
        Err(_) => return vec![],
    };

    flight
        .iter()
        .map(|(bike_id, (departed_at, dep_lat, dep_lon))| DepartingBike {
            bike_id:      bike_id.clone(),
            departed_at:  departed_at.to_rfc3339(),
            elapsed_secs: (now - *departed_at).num_seconds(),
            dep_lat:      *dep_lat,
            dep_lon:      *dep_lon,
        })
        .collect()
}

pub async fn get_departures_nearby(
    State(state): State<AppState>,
    Query(params): Query<NearbyQuery>,
) -> Json<Vec<DepartingBike>> {
    const SNAP_M: f64 = 120.0; // emprise physique d'une station BIXI

    let mut bikes: Vec<DepartingBike> = all_in_flight(&state)
        .into_iter()
        .filter(|b| {
            crate::zones::haversine_km(params.lat, params.lon, b.dep_lat, b.dep_lon) * 1000.0 <= SNAP_M
        })
        .collect();

    bikes.sort_by_key(|b| b.elapsed_secs);
    Json(bikes)
}

// --- Tous les vélos en vol, sans filtre de proximité — pour l'overlay carte
// "vélos en vol" du Tracker. Contrairement à un trajet terminé, un vélo en
// vol n'a qu'une position de départ connue (le flux GBFS ne rapporte pas sa
// position tant qu'il est loué) — l'overlay affiche donc un point fixe au
// départ + temps écoulé, pas une position qui bouge en direct. ---

pub async fn get_in_flight_bikes(State(state): State<AppState>) -> Json<Vec<DepartingBike>> {
    let mut bikes = all_in_flight(&state);
    bikes.sort_by_key(|b| b.elapsed_secs);
    Json(bikes)
}

// --- Vélos "en fuite" : en transit depuis longtemps, proches du timeout
// in-flight (120 min, voir tracker.rs) sans être forcément revenus dans le
// flux. Seuil à 90 min = "à surveiller", pas encore expiré. ---

pub async fn get_overdue_bikes(State(state): State<AppState>) -> Json<Vec<OverdueBike>> {
    const OVERDUE_THRESHOLD_MIN: i64 = 90;
    let now = Utc::now();

    let flight = match state.in_flight.read() {
        Ok(f) => f,
        Err(_) => return Json(vec![]),
    };

    let mut bikes: Vec<OverdueBike> = flight
        .iter()
        .filter_map(|(bike_id, (departed_at, dep_lat, dep_lon))| {
            let elapsed_minutes = (now - *departed_at).num_minutes();
            if elapsed_minutes >= OVERDUE_THRESHOLD_MIN {
                Some(OverdueBike { bike_id: bike_id.clone(), elapsed_minutes, dep_lat: *dep_lat, dep_lon: *dep_lon })
            } else {
                None
            }
        })
        .collect();

    bikes.sort_by_key(|b| std::cmp::Reverse(b.elapsed_minutes));
    Json(bikes)
}

// --- Statut d'un vélo (en route ou arrivé) ---

pub async fn get_bike_status(
    State(state): State<AppState>,
    Query(params): Query<BikeStatusQuery>,
) -> Json<BikeStatus> {
    let in_flight = state.in_flight.read()
        .map(|f| f.contains_key(&params.bike_id))
        .unwrap_or(false);
    Json(BikeStatus { in_flight })
}

// --- Push notifications ---

pub async fn get_vapid_key(State(state): State<AppState>) -> Json<VapidKeyResponse> {
    Json(VapidKeyResponse { public_key: state.vapid_public_key.clone() })
}

pub async fn post_push_subscribe(
    State(state): State<AppState>,
    Json(body): Json<SubscribeRequest>,
) -> Result<StatusCode, AppError> {
    let conn = state.pool.get().ctx("post_push_subscribe: pool")?;

    conn.execute(
        "INSERT INTO push_subscriptions (bike_id, endpoint, p256dh, auth, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(bike_id, endpoint) DO UPDATE SET p256dh=?3, auth=?4",
        rusqlite::params![
            body.bike_id,
            body.subscription.endpoint,
            body.subscription.keys.p256dh,
            body.subscription.keys.auth,
            Utc::now().to_rfc3339(),
        ],
    ).ctx("post_push_subscribe: insert")?;

    Ok(StatusCode::CREATED)
}

pub async fn post_push_unsubscribe(
    State(state): State<AppState>,
    Json(body): Json<UnsubscribeRequest>,
) -> Result<StatusCode, AppError> {
    let conn = state.pool.get().ctx("post_push_unsubscribe: pool")?;

    conn.execute(
        "DELETE FROM push_subscriptions WHERE bike_id = ?1 AND endpoint = ?2",
        rusqlite::params![body.bike_id, body.endpoint],
    ).ctx("post_push_unsubscribe: delete")?;

    Ok(StatusCode::OK)
}

// --- Historique ---

pub async fn get_history(
    State(state): State<AppState>,
    Query(params): Query<HistoryQuery>,
) -> Result<Json<Vec<DayStats>>, AppError> {
    let city = params.city.as_deref().unwrap_or("all");

    let city_filter = match city {
        "montreal"   => " AND start_lon < -72.5",
        "sherbrooke" => " AND start_lon >= -72.5",
        _            => "",
    };

    // `to`, like `from`, must be a *bound* parameter (?2), never interpolated
    // into the SQL text — it's raw user input from the query string.
    let (start_utc, end_clause, to_bound): (String, &str, Option<String>) =
        if let (Some(from), Some(to)) = (&params.from, &params.to) {
            let s = format!("{}T04:00:00+00:00", from);
            let e = format!("{}T04:00:00+00:00", to);
            (s, " AND end_time < ?2", Some(e))
        } else {
            let days = params.days.unwrap_or(30);
            let s = if days <= 0 {
                "2000-01-01T00:00:00+00:00".to_string()
            } else {
                (Utc::now() - Duration::days(days)).to_rfc3339()
            };
            (s, "", None)
        };

    let conn = state.pool.get().ctx("get_history: pool")?;

    let sql = format!(
        "SELECT strftime('%Y-%m-%d', datetime(end_time, '-4 hours')) as day, COUNT(*) as count
         FROM trips
         WHERE end_time >= ?1{end_clause}{city_filter}
         GROUP BY day
         ORDER BY day ASC"
    );

    let mut stmt = conn.prepare(&sql).ctx("get_history: prepare")?;

    let mut bind_params: Vec<&dyn rusqlite::types::ToSql> = vec![&start_utc];
    if let Some(to_val) = &to_bound {
        bind_params.push(to_val);
    }

    let rows = stmt.query_map(rusqlite::params_from_iter(bind_params), |row| {
        Ok(DayStats { date: row.get(0)?, count: row.get(1)? })
    }).ctx("get_history: query")?;

    Ok(Json(rows.filter_map(|r| r.ok()).collect()))
}

// --- Stats flotte (classement des vélos + odomètre total) ---

pub async fn get_fleet_stats(
    State(state): State<AppState>,
    Query(params): Query<FleetStatsQuery>,
) -> Result<Json<FleetStats>, AppError> {
    let city = params.city.as_deref().unwrap_or("all");
    let city_filter = match city {
        "montreal"   => " WHERE start_lon < -72.5",
        "sherbrooke" => " WHERE start_lon >= -72.5",
        _            => "",
    };

    let conn = state.pool.get().ctx("get_fleet_stats: pool")?;

    let totals_sql = format!("SELECT COUNT(*), COALESCE(SUM(distance), 0) FROM trips{city_filter}");
    let (total_trips, total_distance_m): (i64, f64) = conn
        .query_row(&totals_sql, [], |row| Ok((row.get(0)?, row.get(1)?)))
        .ctx("get_fleet_stats: totals")?;

    let top_sql = format!(
        "SELECT bike_id, COUNT(*) as trips, COALESCE(SUM(distance), 0) as dist
         FROM trips{city_filter}
         GROUP BY bike_id
         ORDER BY dist DESC
         LIMIT 5"
    );
    let mut stmt = conn.prepare(&top_sql).ctx("get_fleet_stats: top prepare")?;

    let top_bikes: Vec<BikeLeaderboardEntry> = stmt
        .query_map([], |row| {
            let dist_m: f64 = row.get(2)?;
            Ok(BikeLeaderboardEntry {
                bike_id:     row.get(0)?,
                trips:       row.get(1)?,
                distance_km: dist_m / 1000.0,
            })
        })
        .ctx("get_fleet_stats: top query")?
        .filter_map(|r| r.ok())
        .collect();

    Ok(Json(FleetStats {
        total_trips,
        total_distance_km: total_distance_m / 1000.0,
        top_bikes,
    }))
}

// --- Helpers ---

// `.single().unwrap()` below is safe specifically because these are always
// midnight and 23:59:59: North American DST transitions land at 2:00-3:00
// local time (the "spring forward" hour doesn't exist, the "fall back" hour
// is ambiguous — either would make `.single()` return None), and neither
// bound ever falls in that window. This would NOT be safe for an arbitrary
// time of day — see `day_bounds_survive_both_dst_transitions` below, which
// exercises Montréal's actual 2026 transition dates rather than just
// asserting it in a comment.
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

fn assign_group_ids(trips: &mut [Trip]) {
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
        if let Some(sig) = sig
            && counts.get(sig).copied().unwrap_or(0) > 1
        {
            let gid = *sig_to_id.entry(sig.clone()).or_insert_with(|| {
                let id = next_id;
                next_id += 1;
                id
            });
            trip.group_id = Some(gid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trip(start_time: &str, start_lat: f64, start_lon: f64, end_lat: f64, end_lon: f64) -> Trip {
        Trip {
            bike_id: "T1".to_string(),
            start_time: start_time.to_string(),
            start_lat, start_lon,
            end_time: "2026-01-01T00:10:00+00:00".to_string(),
            end_lat, end_lon,
            distance: 500.0,
            group_id: None,
        }
    }

    #[test]
    fn groups_trips_sharing_origin_destination_and_time_slot() {
        let mut trips = vec![
            trip("2026-01-01T08:00:00+00:00", 45.5, -73.5, 45.51, -73.51),
            trip("2026-01-01T08:02:00+00:00", 45.5, -73.5, 45.51, -73.51), // same 5-min slot
            trip("2026-01-01T09:00:00+00:00", 45.6, -73.6, 45.61, -73.61), // unrelated
        ];
        assign_group_ids(&mut trips);

        assert!(trips[0].group_id.is_some());
        assert_eq!(trips[0].group_id, trips[1].group_id, "same origin/destination/slot must share a group");
        assert_eq!(trips[2].group_id, None, "a lone trip must not be grouped");
    }

    #[test]
    fn does_not_group_trips_in_different_time_slots() {
        let mut trips = vec![
            trip("2026-01-01T08:00:00+00:00", 45.5, -73.5, 45.51, -73.51),
            trip("2026-01-01T08:10:00+00:00", 45.5, -73.5, 45.51, -73.51), // same coords, different slot
        ];
        assign_group_ids(&mut trips);

        assert_eq!(trips[0].group_id, None);
        assert_eq!(trips[1].group_id, None);
    }

    #[test]
    fn day_bounds_cover_roughly_24h_and_are_ordered() {
        // Mid-July: comfortably clear of any DST transition.
        let date = NaiveDate::from_ymd_opt(2026, 7, 15).unwrap();
        let (start, end) = day_bounds_utc(date);

        let start_dt = DateTime::parse_from_rfc3339(&start).unwrap();
        let end_dt = DateTime::parse_from_rfc3339(&end).unwrap();

        assert!(end_dt > start_dt);
        let span_secs = (end_dt - start_dt).num_seconds();
        assert!((86_000..=86_400).contains(&span_secs), "expected ~24h span, got {span_secs}s");
    }

    #[test]
    fn day_bounds_survive_both_dst_transitions() {
        // Proves the `.single().unwrap()` safety claim above empirically
        // instead of just by comment: Montréal's actual 2026 transition
        // dates (spring forward loses an hour, fall back repeats one) —
        // must not panic, and a "spring forward" day is ~1h shorter.
        let spring_forward = NaiveDate::from_ymd_opt(2026, 3, 8).unwrap();
        let fall_back       = NaiveDate::from_ymd_opt(2026, 11, 1).unwrap();

        let (s1, e1) = day_bounds_utc(spring_forward);
        let (s2, e2) = day_bounds_utc(fall_back);

        let span = |s: &str, e: &str| {
            (DateTime::parse_from_rfc3339(e).unwrap() - DateTime::parse_from_rfc3339(s).unwrap())
                .num_seconds()
        };
        assert!((82_000..=82_800).contains(&span(&s1, &e1)), "spring-forward day should be ~23h");
        assert!((89_600..=90_000).contains(&span(&s2, &e2)), "fall-back day should be ~25h");
    }

    /// In-memory `AppState` for calling a route handler directly (no HTTP
    /// layer) — same `:memory:` + `max_size(1)` pattern as `db.rs`'s tests.
    fn memory_state() -> AppState {
        let manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let pool = r2d2::Pool::builder().max_size(1).build(manager).unwrap();
        crate::db::init_schema(&pool).unwrap();
        AppState {
            pool,
            in_flight:        std::sync::Arc::new(std::sync::RwLock::new(HashMap::new())),
            flow_cache:       crate::cache::ApiCache::new(300),
            heat_cache:       crate::cache::ApiCache::new(300),
            vapid_public_key: String::new(),
        }
    }

    /// Regression test for the SQL injection fixed alongside this test:
    /// `HistoryQuery.to` used to be interpolated straight into the SQL text
    /// (`format!(" AND end_time < '{e}'")`) instead of bound like `from`
    /// already was. A `to` value crafted to break out of that string literal
    /// (`' OR '1'='1`) would have turned the WHERE clause always-true,
    /// leaking trips well outside the requested date range.
    #[tokio::test]
    async fn get_history_to_param_is_bound_not_interpolated() {
        let state = memory_state();
        {
            let conn = state.pool.get().unwrap();
            conn.execute(
                "INSERT INTO trips (bike_id, start_time, start_lat, start_lon, end_time, end_lat, end_lon, distance)
                 VALUES ('B1', '2026-06-01T11:50:00+00:00', 45.5, -73.6, '2026-06-01T12:00:00+00:00', 45.51, -73.61, 500)",
                [],
            ).unwrap();
        }

        let query = HistoryQuery {
            days: None,
            city: None,
            from: Some("2025-01-01".to_string()),
            to:   Some("2026-01-01' OR 1=1 --".to_string()),
        };

        let result = get_history(State(state), Query(query)).await.unwrap();

        assert!(
            result.0.is_empty(),
            "the June trip must stay excluded — an injected clause must not bypass the date filter"
        );
    }
}
