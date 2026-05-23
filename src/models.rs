use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

// --- GBFS API types ---

#[derive(Deserialize, Debug)]
pub struct GbfsResponse {
    pub data: GbfsData,
}

#[derive(Deserialize, Debug)]
pub struct GbfsData {
    pub bikes: Vec<Bike>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Bike {
    pub bike_id: String,
    pub lat: f64,
    pub lon: f64,
    #[serde(default)]
    pub is_reserved: u8,
    #[serde(default)]
    pub is_disabled: u8,
}

impl Bike {
    pub fn is_available(&self) -> bool {
        self.is_reserved == 0 && self.is_disabled == 0
    }
}

// --- Internal state ---

#[derive(Debug, Clone)]
pub struct BikeState {
    pub lat: f64,
    pub lon: f64,
    pub timestamp: DateTime<Utc>,
}

// --- API response types ---

#[derive(Serialize)]
pub struct Trip {
    pub bike_id: String,
    pub start_time: String,
    pub start_lat: f64,
    pub start_lon: f64,
    pub end_time: String,
    pub end_lat: f64,
    pub end_lon: f64,
    pub distance: f64,
    pub group_id: Option<i32>,
}

#[derive(Deserialize)]
pub struct TripQuery {
    pub date: Option<String>,
}

/// (departure_time, departure_lat, departure_lon)
pub type InFlightEntry = (DateTime<Utc>, f64, f64);
pub type InFlightBikes = Arc<RwLock<HashMap<String, InFlightEntry>>>;

#[derive(Serialize)]
pub struct ActiveStats {
    pub active_count: usize,
    pub last_updated: String,
}

#[derive(Serialize, Clone)]
pub struct DepartingBike {
    pub bike_id:      String,
    pub departed_at:  String,
    pub elapsed_secs: i64,
    pub dep_lat:      f64,
    pub dep_lon:      f64,
}

#[derive(Deserialize)]
pub struct NearbyQuery {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Serialize)]
pub struct BikeStatus {
    pub in_flight: bool,
}

#[derive(Deserialize)]
pub struct BikeStatusQuery {
    pub bike_id: String,
}

// --- Zone Atlas ---

#[derive(Serialize)]
pub struct Zone {
    pub name: &'static str,
    pub lat:  f64,
    pub lon:  f64,
    pub city: &'static str,
}

#[derive(Deserialize)]
pub struct ZoneQuery {
    pub city: Option<String>,
}

// --- Heatmap / Atlas types ---

#[derive(Serialize, Clone)]
pub struct HeatPoint {
    pub lat:    f64,
    pub lon:    f64,
    pub hour:   u8,
    pub volume: i64,
}

#[derive(Deserialize)]
pub struct HeatQuery {
    pub date:      Option<String>,
    pub week:      Option<u8>,    // 1 = 7 jours
    pub trip_type: Option<String>, // "departures" (défaut) ou "arrivals"
}

#[derive(Serialize, Clone)]
pub struct Flow {
    pub origin: String,
    pub destination: String,
    pub hour: u8,
    pub count: i64,
    pub avg_distance: f64,
    pub avg_duration_min: f64,
}

#[derive(Deserialize)]
pub struct FlowQuery {
    pub date: Option<String>,
    pub city: Option<String>,
}

// --- Historique ---

#[derive(Serialize, Clone)]
pub struct DayStats {
    pub date:  String,
    pub count: i64,
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    pub days: Option<i64>,  // 0 = tout
    pub city: Option<String>,
    pub from: Option<String>,  // YYYY-MM-DD, prioritaire sur days
    pub to:   Option<String>,  // YYYY-MM-DD exclusif
}
