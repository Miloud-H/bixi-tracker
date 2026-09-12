use std::fs;

use base64ct::{Base64UrlUnpadded, Encoding};
use reqwest::Client;
use web_push_native::jwt_simple::algorithms::{ECDSAP256PublicKeyLike, ES256KeyPair};
use web_push_native::p256::PublicKey;
use web_push_native::{Auth, WebPushBuilder};

use crate::db::DbPool;

const VAPID_KEY_PATH: &str = "vapid_key.pem";
const VAPID_CONTACT:  &str = "mailto:haboudoumiloud@gmail.com";

/// Load the VAPID signing key from disk, generating and persisting a new one on first run.
/// The key must stay stable across restarts — every existing browser push subscription
/// is bound to the public key it was created with.
pub fn load_or_create_vapid_key() -> ES256KeyPair {
    if let Ok(pem) = fs::read_to_string(VAPID_KEY_PATH) {
        match ES256KeyPair::from_pem(&pem) {
            Ok(kp) => return kp,
            Err(e) => eprintln!("Failed to parse {VAPID_KEY_PATH} ({e}), regenerating"),
        }
    }

    let kp = ES256KeyPair::generate();
    match kp.to_pem() {
        Ok(pem) => {
            if let Err(e) = fs::write(VAPID_KEY_PATH, pem) {
                eprintln!("Failed to save {VAPID_KEY_PATH}: {e}");
            }
        }
        Err(e) => eprintln!("Failed to serialize VAPID key: {e}"),
    }
    kp
}

/// The browser's PushManager.subscribe requires the *uncompressed* SEC1 point
/// (0x04 || X || Y, 65 bytes) — ES256PublicKey::to_bytes() returns the
/// compressed 33-byte form instead, which the browser rejects outright.
pub fn public_key_b64(kp: &ES256KeyPair) -> String {
    let bytes = kp.public_key().public_key().to_bytes_uncompressed();
    Base64UrlUnpadded::encode_string(&bytes)
}

pub struct PushTarget {
    pub endpoint: String,
    pub p256dh:   String,
    pub auth:     String,
}

// Known Web Push service hosts (Chrome/Edge/Opera/Brave via FCM, Firefox,
// Safari). `reqwest::Url` is reqwest's own re-export of the `url` crate —
// no extra dependency.
const ALLOWED_PUSH_HOSTS: &[&str] = &[
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
];

/// Guards against SSRF: `endpoint` comes straight from an unauthenticated
/// `POST /api/push/subscribe` body, and is later used verbatim as the target
/// of a server-initiated HTTP request (`send_push`, triggered whenever the
/// watched bike returns). Without this check, anyone could point the server
/// at an arbitrary URL of their choosing — and since any in-flight bike_id
/// works as a trigger, at a whole fleet of them, for repeated outbound
/// requests over time rather than a single one-off.
pub fn is_known_push_host(endpoint: &str) -> bool {
    reqwest::Url::parse(endpoint)
        .ok()
        .filter(|u| u.scheme() == "https")
        .and_then(|u| u.host_str().map(|h| ALLOWED_PUSH_HOSTS.contains(&h)))
        .unwrap_or(false)
}

/// A bike that just reappeared in the GBFS feed after being in-flight.
#[derive(Debug, PartialEq)]
pub struct ReturnedBike {
    pub bike_id:     String,
    pub dep_lat:     f64,
    pub dep_lon:     f64,
    pub arr_lat:     f64,
    pub arr_lon:     f64,
    pub elapsed_min: i64,
}

pub enum PushOutcome {
    Sent,
    /// Push service reports the subscription no longer exists (404/410) — drop it.
    Gone,
    Failed,
}

pub async fn send_push(
    client:  &Client,
    vapid:   &ES256KeyPair,
    target:  &PushTarget,
    payload: &serde_json::Value,
) -> PushOutcome {
    // Defense in depth: post_push_subscribe already rejects unknown hosts at
    // registration time, but this is the actual point where an SSRF would
    // fire, so it's checked again here rather than trusting every row already
    // in the table stayed valid (e.g. if it were ever populated another way).
    if !is_known_push_host(&target.endpoint) {
        return PushOutcome::Failed;
    }

    let Ok(endpoint) = target.endpoint.parse() else { return PushOutcome::Failed };

    let Ok(p256dh_bytes) = Base64UrlUnpadded::decode_vec(&target.p256dh) else { return PushOutcome::Failed };
    let Ok(ua_public) = PublicKey::from_sec1_bytes(&p256dh_bytes) else { return PushOutcome::Failed };

    let Ok(auth_bytes) = Base64UrlUnpadded::decode_vec(&target.auth) else { return PushOutcome::Failed };
    if auth_bytes.len() != 16 {
        return PushOutcome::Failed;
    }
    let ua_auth = Auth::clone_from_slice(&auth_bytes);

    let builder = WebPushBuilder::new(endpoint, ua_public, ua_auth)
        .with_vapid(vapid, VAPID_CONTACT);

    let request = match builder.build(payload.to_string().into_bytes()) {
        Ok(r) => r,
        Err(e) => { eprintln!("Push build error: {e}"); return PushOutcome::Failed; }
    };

    let reqwest_request = match reqwest::Request::try_from(request) {
        Ok(r) => r,
        Err(e) => { eprintln!("Push request conversion error: {e}"); return PushOutcome::Failed; }
    };

    match client.execute(reqwest_request).await {
        Ok(res) if res.status() == 404 || res.status() == 410 => PushOutcome::Gone,
        Ok(res) if res.status().is_success() => PushOutcome::Sent,
        Ok(res) => { eprintln!("Push send failed: {}", res.status()); PushOutcome::Failed }
        Err(e) => { eprintln!("Push network error: {e}"); PushOutcome::Failed }
    }
}

/// Notify every browser watching this bike, then clear those subscriptions —
/// the watch is one-shot, whether the push actually reached the device or not.
pub async fn notify_bike_returned(
    pool:       &DbPool,
    client:     &Client,
    vapid:      &ES256KeyPair,
    bike:       &ReturnedBike,
    distance_m: Option<f64>,
) {
    let targets: Vec<PushTarget> = {
        let conn = match pool.get() {
            Ok(c) => c,
            Err(e) => { eprintln!("DB pool error in notify_bike_returned: {e}"); return; }
        };
        let mut stmt = match conn.prepare(
            "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE bike_id = ?1"
        ) {
            Ok(s) => s,
            Err(e) => { eprintln!("DB prepare error in notify_bike_returned: {e}"); return; }
        };
        let rows = stmt.query_map([&bike.bike_id], |row| {
            Ok(PushTarget {
                endpoint: row.get(0)?,
                p256dh:   row.get(1)?,
                auth:     row.get(2)?,
            })
        });
        match rows {
            Ok(r) => r.filter_map(|t| t.ok()).collect(),
            Err(e) => { eprintln!("DB query error in notify_bike_returned: {e}"); return; }
        }
    };

    if targets.is_empty() {
        return;
    }

    let body = match distance_m {
        Some(d) if d > 0.0 => format!("A parcouru {:.0} m en {} min et vient de se garer.", d, bike.elapsed_min.max(0)),
        _ => format!("Vient de se garer après {} min.", bike.elapsed_min.max(0)),
    };

    let payload = serde_json::json!({
        "title":   format!("🚲 Vélo {} arrivé !", bike.bike_id),
        "body":    body,
        "bikeId":  bike.bike_id,
        "depLat":  bike.dep_lat,
        "depLon":  bike.dep_lon,
        "lat":     bike.arr_lat,
        "lon":     bike.arr_lon,
    });

    for target in &targets {
        match send_push(client, vapid, target, &payload).await {
            PushOutcome::Sent  => {}
            PushOutcome::Gone  => {}
            PushOutcome::Failed => eprintln!("Push failed for bike {}", bike.bike_id),
        }
    }

    if let Ok(conn) = pool.get()
        && let Err(e) = conn.execute("DELETE FROM push_subscriptions WHERE bike_id = ?1", [&bike.bike_id])
    {
        eprintln!("DB delete error in notify_bike_returned: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_known_push_hosts() {
        assert!(is_known_push_host("https://fcm.googleapis.com/fcm/send/abc123"));
        assert!(is_known_push_host("https://updates.push.services.mozilla.com/wpush/v2/xyz"));
        assert!(is_known_push_host("https://web.push.apple.com/some-id"));
    }

    #[test]
    fn rejects_an_arbitrary_attacker_controlled_host() {
        // The SSRF case this exists to stop: nothing about this URL is
        // otherwise invalid, it's just not a real push service.
        assert!(!is_known_push_host("https://evil.example.com/steal-me"));
    }

    #[test]
    fn rejects_non_https_and_malformed_input() {
        assert!(!is_known_push_host("http://fcm.googleapis.com/fcm/send/abc123"), "must require https");
        assert!(!is_known_push_host("not a url at all"));
        assert!(!is_known_push_host(""));
    }

    #[test]
    fn rejects_a_lookalike_host() {
        // e.g. "fcm.googleapis.com.evil.com" or "evilfcm.googleapis.com" —
        // exact host match only, no substring/prefix/suffix matching.
        assert!(!is_known_push_host("https://fcm.googleapis.com.evil.com/x"));
        assert!(!is_known_push_host("https://notfcm.googleapis.com/x"));
    }

    /// Regression test for the bug fixed in 63ebc4d: ES256PublicKey::to_bytes()
    /// returns the *compressed* SEC1 point (33 bytes), which browsers reject
    /// outright — PushManager.subscribe requires the uncompressed 65-byte point
    /// (0x04 || X || Y).
    #[test]
    fn public_key_is_uncompressed_sec1_point() {
        let kp = ES256KeyPair::generate();
        let b64 = public_key_b64(&kp);
        let bytes = Base64UrlUnpadded::decode_vec(&b64).expect("valid base64url");

        assert_eq!(bytes.len(), 65, "must be the uncompressed point, not compressed (33 bytes)");
        assert_eq!(bytes[0], 0x04, "uncompressed SEC1 points start with 0x04");
    }
}
