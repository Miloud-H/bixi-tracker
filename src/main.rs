mod db;
mod models;
mod routes;
mod tracker;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use axum::{routing::get, Router};
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

use crate::models::InFlightBikes;

#[tokio::main]
async fn main() {
    let pool = db::init_pool("bixi_data.db").expect("Failed to create DB pool");
    db::init_schema(&pool).expect("Failed to initialize DB schema");

    let in_flight: InFlightBikes = Arc::new(RwLock::new(HashMap::new()));

    let tracker_pool = pool.clone();
    let tracker_in_flight = in_flight.clone();
    tokio::spawn(async move {
        tracker::run(tracker_pool, tracker_in_flight).await;
    });

    let app = Router::new()
        .route("/api/trips",  get(routes::get_trips).with_state(pool))
        .route("/api/active", get(routes::get_active).with_state(in_flight))
        .fallback_service(ServeDir::new("public"))
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    let listener = TcpListener::bind(addr).await.unwrap();
    println!("Server running on http://{addr}");

    axum::serve(listener, app).await.unwrap();
}