use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// A route error that always surfaces as HTTP 500 to the client — this app has
/// no user-facing error taxonomy (bad input just returns an empty list, see
/// e.g. `get_trips`), so every route failure here is an internal one: a DB
/// connection couldn't be obtained, a query failed, etc. The real cause is
/// logged server-side via `IntoResponse`; the client only ever sees the
/// generic status code, never DB internals.
#[derive(Debug)]
pub struct AppError(String);

/// Attaches a short call-site label to a fallible result before it becomes an
/// `AppError`, e.g. `state.pool.get().ctx("get_trips: pool")?` — mirrors
/// `anyhow::Context` without pulling in the crate for this one use. Replaces
/// what used to be a `match { Ok(x) => x, Err(e) => { eprintln!(...); return
/// Err(StatusCode::INTERNAL_SERVER_ERROR) } }` at every DB call site.
pub trait ResultExt<T> {
    fn ctx(self, label: &str) -> Result<T, AppError>;
}

impl<T, E: std::fmt::Display> ResultExt<T> for Result<T, E> {
    fn ctx(self, label: &str) -> Result<T, AppError> {
        self.map_err(|e| AppError(format!("{label}: {e}")))
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        eprintln!("API error — {}", self.0);
        StatusCode::INTERNAL_SERVER_ERROR.into_response()
    }
}
