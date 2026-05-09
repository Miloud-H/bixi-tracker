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
// --- Flows endpoint ---

#[derive(serde::Serialize)]
pub struct Flow {
    pub origin: String,
    pub destination: String,
    pub hour: u8,
    pub count: i64,
    pub avg_distance: f64,
    pub avg_duration_min: f64,
}

#[derive(serde::Deserialize)]
pub struct FlowQuery {
    pub date: Option<String>,
}

pub async fn get_flows(
    State(pool): State<DbPool>,
    Query(params): Query<FlowQuery>,
) -> Json<Vec<Flow>> {
    let date_str = params
        .date
        .unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());

    let Ok(date) = NaiveDate::parse_from_str(&date_str, "%Y-%m-%d") else {
        return Json(vec![]);
    };

    let (start_utc, end_utc) = day_bounds_utc(date);

    let conn = match pool.get() {
        Ok(c) => c,
        Err(e) => { eprintln!("DB pool error in get_flows: {e}"); return Json(vec![]); }
    };

    // On charge tous les trajets de la journée et on fait l'agrégation par zone côté Rust
    // pour éviter les jointures SQL complexes avec les zones hardcodées
    let mut stmt = match conn.prepare(
        "SELECT start_lat, start_lon, end_lat, end_lon, distance,
                CAST(strftime('%H', datetime(start_time, '-4 hours')) AS INTEGER) as hour,
                (julianday(end_time) - julianday(start_time)) * 1440.0 as duration_min
         FROM trips
         WHERE end_time >= ?1 AND end_time <= ?2
           AND distance > 100",
    ) {
        Ok(s) => s,
        Err(e) => { eprintln!("DB prepare error: {e}"); return Json(vec![]); }
    };

    #[derive(Debug)]
    struct RawTrip {
        start_lat: f64, start_lon: f64,
        end_lat: f64, end_lon: f64,
        distance: f64, hour: u8, duration_min: f64,
    }

    let rows = match stmt.query_map([&start_utc, &end_utc], |row| {
        Ok(RawTrip {
            start_lat: row.get(0)?, start_lon: row.get(1)?,
            end_lat: row.get(2)?, end_lon: row.get(3)?,
            distance: row.get(4)?,
            hour: row.get::<_, i64>(5)? as u8,
            duration_min: row.get(6)?,
        })
    }) {
        Ok(r) => r,
        Err(e) => { eprintln!("DB query error: {e}"); return Json(vec![]); }
    };

    let raw_trips: Vec<RawTrip> = rows.filter_map(|r| r.ok()).collect();

    // Zones définies côté Rust — même liste que le frontend
    let zones: &[(&str, f64, f64)] = &[
        ("Transit_Gare_Centrale", 45.5000, -73.5665),
        ("Transit_Gare_Lucien_Lallier", 45.4950, -73.5710),
        ("Transit_Gare_Parc", 45.5315, -73.6235),
        ("Transit_Berri_UQAM", 45.5155, -73.5610),
        ("Transit_Vendome", 45.4740, -73.6035),
        ("Transit_Snowdon", 45.4855, -73.6275),
        ("Transit_Jean_Talon_Metro", 45.5390, -73.6135),
        ("Transit_Lionel_Groulx", 45.4825, -73.5795),
        ("Edu_UdeM_Poly", 45.5044, -73.6130),
        ("Edu_McGill", 45.5042, -73.5760),
        ("Edu_Concordia_Guy", 45.4955, -73.5780),
        ("Edu_UQAM_Design", 45.5135, -73.5685),
        ("Edu_HEC_Mtl", 45.5035, -73.6205),
        ("Edu_ETS", 45.4945, -73.5625),
        ("Sante_CHUM", 45.5110, -73.5560),
        ("Sante_CUSM_Glen", 45.4725, -73.5995),
        ("Sante_H_Sainte_Justine", 45.5030, -73.6235),
        ("Sante_H_General_Mtl", 45.4975, -73.5885),
        ("Sante_H_Notre_Dame", 45.5265, -73.5575),
        ("Res_Angus", 45.5410, -73.5650),
        ("Res_Plateau_Est", 45.5320, -73.5725),
        ("Res_Mile_End", 45.5255, -73.5985),
        ("Res_Hochelaga", 45.5435, -73.5415),
        ("Res_Verdun_Wellington", 45.4615, -73.5685),
        ("Res_Sud_Ouest", 45.4855, -73.5820),
        ("Res_Griffintown", 45.4925, -73.5605),
        ("Res_Little_Italy", 45.5345, -73.6125),
        ("Res_Outremont", 45.5155, -73.6055),
        ("Affaires_Ville_Marie", 45.5019, -73.5677),
        ("Comm_Marche_Jean_Talon", 45.5361, -73.6150),
        ("Comm_Marche_Atwater", 45.4795, -73.5765),
        ("Comm_Mont_Royal_Avenue", 45.5245, -73.5815),
        ("Comm_Ste_Catherine_Ouest", 45.5015, -73.5725),
        ("Loisir_Vieux_Port", 45.5040, -73.5510),
        ("Loisir_Parc_Lafontaine", 45.5265, -73.5695),
        ("Loisir_Canal_Lachine", 45.4800, -73.5780),
        ("Loisir_Parc_Mont_Royal", 45.4975, -73.5905),
        ("Nuit_Crescent", 45.4985, -73.5765),
        ("Nuit_Village", 45.5195, -73.5550),
        // Zones ajoutées pour couvrir les vides géographiques
        ("Res_Rosemont", 45.5445, -73.5810),
        ("Res_Petite_Patrie", 45.5360, -73.5940),
        ("Res_Villeray", 45.5490, -73.6190),
        ("Res_Cote_des_Neiges", 45.4945, -73.6380),
        ("Res_NDG", 45.4720, -73.6380),
        ("Res_Pointe_St_Charles", 45.4650, -73.5555),
        ("Res_Centre_Sud", 45.5175, -73.5465),
        ("Res_Maisonneuve", 45.5490, -73.5320),
        ("Res_Parc_Extension", 45.5295, -73.6380),
        ("Res_Westmount", 45.4815, -73.6010),
        ("Res_Plateau_Ouest", 45.5245, -73.5875),
        ("Res_Rosemont_Est", 45.5480, -73.5530),
        ("Transit_Papineau", 45.5260, -73.5500),
        ("Transit_Plamondon", 45.4860, -73.6400),
        ("Transit_Joliette", 45.5395, -73.5285),
        ("Transit_Charlevoix", 45.4680, -73.5660),
        ("Comm_Chabanel", 45.5410, -73.6550),
        ("Loisir_Parc_Maisonneuve", 45.5545, -73.5475),
    ];

    let snap_zone = |lat: f64, lon: f64| -> Option<&str> {
        zones.iter()
            .min_by(|(_, al, ao), (_, bl, bo)| {
                let da = (lat - al).powi(2) + (lon - ao).powi(2);
                let db = (lat - bl).powi(2) + (lon - bo).powi(2);
                da.partial_cmp(&db).unwrap()
            })
            .map(|(name, _, _)| *name)
    };

    // Agréger par (origin, destination, hour)
    type FlowKey = (String, String, u8);
    let mut agg: HashMap<FlowKey, (i64, f64, f64)> = HashMap::new();

    for trip in &raw_trips {
        let Some(orig) = snap_zone(trip.start_lat, trip.start_lon) else { continue };
        let Some(dest) = snap_zone(trip.end_lat, trip.end_lon) else { continue };
        if orig == dest { continue; }

        let entry = agg.entry((orig.to_string(), dest.to_string(), trip.hour))
            .or_insert((0, 0.0, 0.0));
        entry.0 += 1;
        entry.1 += trip.distance;
        entry.2 += trip.duration_min;
    }

    let flows: Vec<Flow> = agg.into_iter()
        .map(|((origin, destination, hour), (count, total_dist, total_dur))| Flow {
            origin, destination, hour,
            count,
            avg_distance: total_dist / count as f64,
            avg_duration_min: total_dur / count as f64,
        })
        .filter(|f| f.count >= 2) // Filtrer le bruit
        .collect();

    Json(flows)
}