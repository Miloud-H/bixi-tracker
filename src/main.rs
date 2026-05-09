mod cache;
mod db;
mod models;
mod routes;
mod tracker;
mod zones;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use axum::{routing::get, Router};
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

use cache::ApiCache;
use models::{Flow, HeatPoint, InFlightBikes};

#[derive(Clone)]
pub struct AppState {
    pub pool:        db::DbPool,
    pub in_flight:   InFlightBikes,
    pub flow_cache:  Arc<ApiCache<Vec<Flow>>>,
    pub heat_cache:  Arc<ApiCache<Vec<HeatPoint>>>,
}

#[tokio::main]
async fn main() {
    let pool = db::init_pool("bixi_data.db").expect("Failed to create DB pool");
    db::init_schema(&pool).expect("Failed to initialize DB schema");

    let in_flight: InFlightBikes = Arc::new(RwLock::new(HashMap::new()));

    let tracker_pool      = pool.clone();
    let tracker_in_flight = in_flight.clone();
    tokio::spawn(async move {
        tracker::run(tracker_pool, tracker_in_flight).await;
    });

    let state = AppState {
        pool,
        in_flight,
        flow_cache: ApiCache::new(300),
        heat_cache: ApiCache::new(300),
    };

    let app = Router::new()
        .route("/api/trips",   get(routes::get_trips))
        .route("/api/active",  get(routes::get_active))
        .route("/api/flows",   get(routes::get_flows))
        .route("/api/heatmap", get(routes::get_heatmap))
        .route("/api/zones",   get(routes::get_zones))
        .with_state(state)
        .fallback_service(ServeDir::new("public"))
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    let listener = TcpListener::bind(addr).await.unwrap();
    println!("Server running on http://{addr}");

    axum::serve(listener, app).await.unwrap();
}
