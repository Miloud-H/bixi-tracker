use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};

/// Where `ApiCache` gets "now" from — real time in production, a manually
/// advanced fake in tests. Without this, TTL expiry can only be tested by
/// actually sleeping past the TTL, which is slow and can flake under load.
pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> Instant;
}

#[derive(Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

// So an `Arc<FakeClock>` can be handed to the cache while the test keeps its
// own handle to advance it — `ApiCache` only ever needs `&self` to read time.
impl<C: Clock> Clock for Arc<C> {
    fn now(&self) -> Instant {
        (**self).now()
    }
}

/// A clock that only moves when `advance` is called. Built on `Instant`
/// (no unsafe, no new dependency): it captures one real `Instant` at
/// construction and reports `base + offset`, where `offset` is bumped by
/// `advance`. `Instant` has no public "set to an arbitrary point" constructor
/// on stable Rust, so this is the standard workaround. Test-only — cfg-gated
/// out of production builds entirely.
#[cfg(test)]
pub struct FakeClock {
    base: Instant,
    offset_ms: AtomicU64,
}

#[cfg(test)]
impl FakeClock {
    pub fn new() -> Self {
        Self { base: Instant::now(), offset_ms: AtomicU64::new(0) }
    }

    pub fn advance(&self, d: Duration) {
        self.offset_ms.fetch_add(d.as_millis() as u64, Ordering::SeqCst);
    }
}

#[cfg(test)]
impl Clock for FakeClock {
    fn now(&self) -> Instant {
        self.base + Duration::from_millis(self.offset_ms.load(Ordering::SeqCst))
    }
}

pub struct ApiCache<T: Clone, C: Clock = SystemClock> {
    inner: Mutex<HashMap<String, (Instant, T)>>,
    ttl:   Duration,
    clock: C,
}

impl<T: Clone> ApiCache<T, SystemClock> {
    pub fn new(ttl_secs: u64) -> Arc<Self> {
        Self::with_clock(ttl_secs, SystemClock)
    }
}

impl<T: Clone, C: Clock> ApiCache<T, C> {
    pub fn with_clock(ttl_secs: u64, clock: C) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(HashMap::new()),
            ttl:   Duration::from_secs(ttl_secs),
            clock,
        })
    }

    pub fn get(&self, key: &str) -> Option<T> {
        let inner = self.inner.lock().ok()?;
        let (ts, val) = inner.get(key)?;
        if self.clock.now().duration_since(*ts) < self.ttl { Some(val.clone()) } else { None }
    }

    pub fn set(&self, key: String, value: T) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.insert(key, (self.clock.now(), value));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn miss_before_anything_is_set() {
        let cache: Arc<ApiCache<i32>> = ApiCache::new(60);
        assert_eq!(cache.get("k"), None);
    }

    #[test]
    fn hit_right_after_set() {
        let cache: Arc<ApiCache<i32>> = ApiCache::new(60);
        cache.set("k".to_string(), 42);
        assert_eq!(cache.get("k"), Some(42));
    }

    #[test]
    fn miss_for_a_different_key() {
        let cache: Arc<ApiCache<i32>> = ApiCache::new(60);
        cache.set("k".to_string(), 42);
        assert_eq!(cache.get("other"), None);
    }

    #[test]
    fn still_a_hit_just_under_the_ttl() {
        let clock = Arc::new(FakeClock::new());
        let cache = ApiCache::with_clock(60, clock.clone());
        cache.set("k".to_string(), 42);

        clock.advance(Duration::from_secs(59));

        assert_eq!(cache.get("k"), Some(42));
    }

    #[test]
    fn expires_once_the_ttl_has_passed() {
        let clock = Arc::new(FakeClock::new());
        let cache = ApiCache::with_clock(60, clock.clone());
        cache.set("k".to_string(), 42);

        clock.advance(Duration::from_secs(61));

        assert_eq!(cache.get("k"), None, "must expire once the TTL has elapsed");
    }

    #[test]
    fn set_after_expiry_refreshes_the_entry() {
        let clock = Arc::new(FakeClock::new());
        let cache = ApiCache::with_clock(60, clock.clone());
        cache.set("k".to_string(), 1);

        clock.advance(Duration::from_secs(61));
        assert_eq!(cache.get("k"), None);

        cache.set("k".to_string(), 2);
        assert_eq!(cache.get("k"), Some(2), "a fresh set must reset the TTL clock for that key");
    }
}
