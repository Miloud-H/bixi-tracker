use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct ApiCache<T: Clone> {
    inner: Mutex<HashMap<String, (Instant, T)>>,
    ttl:   Duration,
}

impl<T: Clone> ApiCache<T> {
    pub fn new(ttl_secs: u64) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(HashMap::new()),
            ttl:   Duration::from_secs(ttl_secs),
        })
    }

    pub fn get(&self, key: &str) -> Option<T> {
        let inner = self.inner.lock().ok()?;
        let (ts, val) = inner.get(key)?;
        if ts.elapsed() < self.ttl { Some(val.clone()) } else { None }
    }

    pub fn set(&self, key: String, value: T) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.insert(key, (Instant::now(), value));
        }
    }
}
