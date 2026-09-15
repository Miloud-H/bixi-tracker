mod cache;
mod db;
mod error;
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
        .route("/api/health",  get(routes::get_health))
        .route("/api/trips",   get(routes::get_trips))
        .route("/api/active",  get(routes::get_active))
        .route("/api/flows",   get(routes::get_flows))
        .route("/api/heatmap", get(routes::get_heatmap))
        .route("/api/zones",              get(routes::get_zones))
        .route("/api/history",            get(routes::get_history))
        .route("/api/departures/nearby",  get(routes::get_departures_nearby))
        .route("/api/bikes/in-flight",    get(routes::get_in_flight_bikes))
        .route("/api/bike/status",        get(routes::get_bike_status))
        .route("/api/stats",              get(routes::get_fleet_stats))
        .route("/api/bikes/overdue",      get(routes::get_overdue_bikes))
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

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();
}

/// Resolves on Ctrl+C (dev) or SIGTERM (`systemctl stop`/restart in prod).
/// Paired with `.with_graceful_shutdown` above: axum stops accepting new
/// connections but lets in-flight requests finish instead of dropping them
/// mid-response — otherwise a deploy restart could cut off, say, a client
/// mid-`/api/history` fetch. Doesn't touch the tracker's background polling
/// loop (`tracker::run`, spawned in `main`) — that task simply ends when the
/// process exits, same as today; it periodically persists `in_flight.json`
/// on its own so an abrupt stop there was already an accepted, pre-existing
/// tradeoff, not something this change is meant to fix.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }

    println!("Shutdown signal received — draining in-flight requests...");
}
