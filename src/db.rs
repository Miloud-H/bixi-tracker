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
        );

        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            bike_id    TEXT NOT NULL,
            endpoint   TEXT NOT NULL,
            p256dh     TEXT NOT NULL,
            auth       TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(bike_id, endpoint)
        );
        CREATE INDEX IF NOT EXISTS idx_push_bike_id ON push_subscriptions(bike_id);",
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

/// Delete push subscriptions older than the given number of seconds.
///
/// A subscription is normally deleted the moment its watched bike returns
/// (`push::notify_bike_returned`) — but a bike that's lost, stolen, or broken
/// never triggers that path, so its watch would otherwise linger in the table
/// forever. `max_age_secs` should comfortably exceed the in-flight timeout
/// (120 min) so this never races a legitimate, still-active watch.
pub fn cleanup_push_subscriptions(pool: &DbPool, max_age_secs: i64) {
    let conn = match pool.get() {
        Ok(c) => c,
        Err(e) => { eprintln!("DB pool error during push subscription cleanup: {e}"); return; }
    };

    let cutoff = (Utc::now() - chrono::Duration::seconds(max_age_secs)).to_rfc3339();

    match conn.execute("DELETE FROM push_subscriptions WHERE created_at < ?1", [&cutoff]) {
        Ok(n) if n > 0 => println!("🧹 Cleaned up {n} orphaned push subscription(s)"),
        Ok(_) => {}
        Err(e) => eprintln!("DB cleanup error: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An in-memory pool capped at 1 connection: `:memory:` gives each new
    /// connection its own empty DB, so without capping the pool a test's
    /// setup `.get()` and the cleanup function's internal `.get()` could
    /// silently land on two unrelated databases.
    fn memory_pool() -> DbPool {
        let manager = SqliteConnectionManager::memory();
        let pool = r2d2::Pool::builder().max_size(1).build(manager).unwrap();
        init_schema(&pool).unwrap();
        pool
    }

    #[test]
    fn init_schema_creates_expected_tables() {
        let pool = memory_pool();
        let conn = pool.get().unwrap();
        for table in ["trips", "bike_positions", "push_subscriptions"] {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |r| r.get(0),
            ).unwrap();
            assert_eq!(count, 1, "table {table} should exist after init_schema");
        }
    }

    #[test]
    fn cleanup_positions_deletes_only_rows_past_max_age() {
        let pool = memory_pool();
        let now = Utc::now();
        {
            let conn = pool.get().unwrap();
            conn.execute(
                "INSERT INTO bike_positions (bike_id, lat, lon, seen_at) VALUES (?1, 45.5, -73.6, ?2)",
                rusqlite::params!["FRESH", now.to_rfc3339()],
            ).unwrap();
            conn.execute(
                "INSERT INTO bike_positions (bike_id, lat, lon, seen_at) VALUES (?1, 45.5, -73.6, ?2)",
                rusqlite::params!["STALE", (now - chrono::Duration::seconds(600)).to_rfc3339()],
            ).unwrap();
        }

        cleanup_positions(&pool, 300); // 5 min — the stale row is 10 min old, the fresh one is ~0

        let conn = pool.get().unwrap();
        let remaining: String = conn
            .query_row("SELECT bike_id FROM bike_positions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, "FRESH", "only the row past max_age_secs should be deleted");
    }

    #[test]
    fn cleanup_positions_is_a_noop_when_nothing_is_stale() {
        let pool = memory_pool();
        {
            let conn = pool.get().unwrap();
            conn.execute(
                "INSERT INTO bike_positions (bike_id, lat, lon, seen_at) VALUES (?1, 45.5, -73.6, ?2)",
                rusqlite::params!["FRESH", Utc::now().to_rfc3339()],
            ).unwrap();
        }

        cleanup_positions(&pool, 300);

        let conn = pool.get().unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM bike_positions", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn cleanup_push_subscriptions_deletes_only_rows_past_max_age() {
        let pool = memory_pool();
        let now = Utc::now();
        {
            let conn = pool.get().unwrap();
            conn.execute(
                "INSERT INTO push_subscriptions (bike_id, endpoint, p256dh, auth, created_at)
                 VALUES (?1, ?2, 'k', 'a', ?3)",
                rusqlite::params!["B1", "https://push.example/1", now.to_rfc3339()],
            ).unwrap();
            conn.execute(
                "INSERT INTO push_subscriptions (bike_id, endpoint, p256dh, auth, created_at)
                 VALUES (?1, ?2, 'k', 'a', ?3)",
                rusqlite::params!["B2", "https://push.example/2", (now - chrono::Duration::hours(4)).to_rfc3339()],
            ).unwrap();
        }

        // Matches PUSH_SUBSCRIPTION_MAX_AGE_SECS (3h) in tracker.rs — B2 (4h old) must go, B1 must stay.
        cleanup_push_subscriptions(&pool, 3 * 60 * 60);

        let conn = pool.get().unwrap();
        let remaining: String = conn
            .query_row("SELECT bike_id FROM push_subscriptions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining, "B1");
    }
}