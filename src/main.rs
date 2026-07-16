mod cache;
mod db;
mod models;
mod push;
mod routes;
mod tracker;
mod zones;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use axum::{
    routing::{get, post},
    Router,
};
use tokio::net::TcpListener;
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

use cache::ApiCache;
use models::{Flow, HeatPoint, InFlightBikes};
use push::load_or_create_vapid_key;

#[derive(Clone)]
pub struct AppState {
    pub pool:             db::DbPool,
    pub in_flight:        InFlightBikes,
    pub flow_cache:       Arc<ApiCache<Vec<Flow>>>,
    pub heat_cache:       Arc<ApiCache<Vec<HeatPoint>>>,
    pub vapid_public_key: String,
}

#[tokio::main]
async fn main() {
    let pool = db::init_pool("bixi_data.db").expect("Failed to create DB pool");
    db::init_schema(&pool).expect("Failed to initialize DB schema");

    let in_flight: InFlightBikes = Arc::new(RwLock::new(HashMap::new()));

    let vapid_key = Arc::new(load_or_create_vapid_key());
    let vapid_public_key = push::public_key_b64(&vapid_key);

    let tracker_pool      = pool.clone();
    let tracker_in_flight = in_flight.clone();
    let tracker_vapid     = vapid_key.clone();
    tokio::spawn(async move {
        tracker::run(tracker_pool, tracker_in_flight, tracker_vapid).await;
    });

    let state = AppState {
        pool,
        in_flight,
        flow_cache: ApiCache::new(300),
        heat_cache: ApiCache::new(300),
        vapid_public_key,
    };

    let app = Router::new()
        .route("/api/trips",   get(routes::get_trips))
        .route("/api/active",  get(routes::get_active))
        .route("/api/flows",   get(routes::get_flows))
        .route("/api/heatmap", get(routes::get_heatmap))
        .route("/api/zones",              get(routes::get_zones))
        .route("/api/history",            get(routes::get_history))
        .route("/api/departures/nearby",  get(routes::get_departures_nearby))
        .route("/api/bike/status",        get(routes::get_bike_status))
        .route("/api/push/vapid-public-key", get(routes::get_vapid_key))
        .route("/api/push/subscribe",        post(routes::post_push_subscribe))
        .route("/api/push/unsubscribe",      post(routes::post_push_unsubscribe))
        .with_state(state)
        .fallback_service(ServeDir::new("public"))
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    let listener = TcpListener::bind(addr).await.unwrap();
    println!("Server running on http://{addr}");

    axum::serve(listener, app).await.unwrap();
}
