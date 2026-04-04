use chrono::Utc;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Result;

pub type DbPool = Pool<SqliteConnectionManager>;

pub fn init_pool(path: &str) -> Result<DbPool, r2d2::Error> {
    let manager = SqliteConnectionManager::file(path);
    Pool::new(manager)
}

pub fn init_schema(pool: &DbPool) -> Result<()> {
    let conn = pool.get().expect("Failed to get DB connection for schema init");

    conn.execute_batch("PRAGMA journal_mode = WAL;")?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS trips (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            bike_id     TEXT NOT NULL,
            start_time  TEXT NOT NULL,
            start_lat   REAL NOT NULL,
            start_lon   REAL NOT NULL,
            end_time    TEXT NOT NULL,
            end_lat     REAL NOT NULL,
            end_lon     REAL NOT NULL,
            distance    REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_end_time ON trips(end_time);

        CREATE TABLE IF NOT EXISTS bike_positions (
            bike_id    TEXT PRIMARY KEY,
            lat        REAL NOT NULL,
            lon        REAL NOT NULL,
            seen_at    TEXT NOT NULL
        );",
    )?;

    Ok(())
}

/// Delete stale bike positions older than the given number of seconds.
pub fn cleanup_positions(pool: &DbPool, max_age_secs: i64) {
    let conn = match pool.get() {
        Ok(c) => c,
        Err(e) => { eprintln!("DB pool error during cleanup: {e}"); return; }
    };

    let cutoff = (Utc::now() - chrono::Duration::seconds(max_age_secs)).to_rfc3339();

    match conn.execute("DELETE FROM bike_positions WHERE seen_at < ?1", [&cutoff]) {
        Ok(n) if n > 0 => println!("🧹 Cleaned up {n} stale bike positions"),
        Ok(_) => {}
        Err(e) => eprintln!("DB cleanup error: {e}"),
    }
}