mod db;
mod models;
mod routes;
mod tracker;

use std::net::SocketAddr;

use axum::{routing::get, Router};
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use tower_http::services::ServeDir;

#[tokio::main]
async fn main() {
    let pool = db::init_pool("bixi_data.db").expect("Failed to create DB pool");
    db::init_schema(&pool).expect("Failed to initialize DB schema");

    let tracker_pool = pool.clone();
    tokio::spawn(async move {
        tracker::run(tracker_pool).await;
    });

    let app = Router::new()
        .route("/api/trips", get(routes::get_trips))
        .fallback_service(ServeDir::new("public"))
        .with_state(pool)
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([127, 0, 0, 1], 3000));
    let listener = TcpListener::bind(addr).await.unwrap();
    println!("🌐 Server running on http://{addr}");

    axum::serve(listener, app).await.unwrap();
}