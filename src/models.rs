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

pub type InFlightBikes = Arc<RwLock<HashMap<String, DateTime<Utc>>>>;

#[derive(Serialize)]
pub struct ActiveStats {
    pub active_count: usize,
    pub last_updated: String,
}