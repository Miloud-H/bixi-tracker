# BIXI Tracker

Real-time and historical visualization of electric BIXI bikes in Montréal and Sherbrooke.

The backend polls Velobixi's public GBFS API every 15 seconds, detects bike movements, and records them as trips in SQLite. Four frontend views let you explore the data, plus a live "watch a departed bike" flow backed by real Web Push.

## Pages

| Page | Description |
|------|-------------|
| **Tracker** (`/`) | Live map with time-scrubbing slider, bike search, group detection, station cards, nearby arrivals/departures, and multi-bike watch with push notifications |
| **Atlas** (`/atlas.html`) | Zone-to-zone flow visualization by hour |
| **Heatmap** (`/heatmap.html`) | Departure or arrival density heatmap by hour (day or 7-day rollup) |
| **History** (`/history.html`) | Daily trip count chart with period comparison and weekday breakdown |

All pages share a dark/light theme (persisted in `localStorage`) and the selected date (persisted in `sessionStorage` for in-session navigation).

### Watching a departed bike

From the Tracker, "Départs" lists bikes that recently left your nearest station. Hitting "Suivre" on one:
- Subscribes the browser to Web Push (VAPID, no third-party push service account needed) — a notification fires when the bike reappears in the GBFS feed, even if the tab is closed or the phone is locked.
- Also polls `/api/bike/status` client-side as a foreground fallback while the tab stays open.
- Tapping the notification focuses the map on the bike's departure → arrival trip.

Several bikes can be watched at once; a watched bike is hidden from the "Départs" list until you cancel or it arrives.

## Stack

- **Backend** : Rust / Axum 0.8 / SQLite (r2d2 + rusqlite) / gzip via tower-http / Web Push via `web-push-native` (pure Rust, no OpenSSL — kept the musl static build dependency-free)
- **Frontend** : Vanilla JavaScript (ES modules on the Tracker page; standalone scripts on Atlas/Heatmap/History), Leaflet.js, Chart.js
- **PWA** : service worker (network-first for HTML + API, cache-first for assets, handles `push`/`notificationclick`)

## Development

```bash
cargo run
```

Server starts on `http://localhost:3000`. Static files are served from `public/`. On first run it generates `vapid_key.pem` (Web Push signing key) and `bixi_data.db` (SQLite) in the working directory — both gitignored; **never delete `vapid_key.pem` in production**, every browser's push subscription is bound to the public key it was created with.

## Project Structure

```
src/
  main.rs      # Pool init, VAPID key load, tracker spawn, router setup
  db.rs        # SQLite schema + WAL mode, stale-row cleanup
  cache.rs      # Tiny in-memory TTL cache (flows/heatmap)
  tracker.rs   # GBFS polling loop, trip detection, in-flight tracking, push triggers
  push.rs      # VAPID key, Web Push sending, subscription notify-and-clear
  routes.rs    # All API handlers
  models.rs    # Shared types
  zones.rs     # 36 named zones for Montréal (28) and Sherbrooke (8)

public/
  index.html / style.css          # Tracker
  atlas.html  / atlas.css         # Atlas
  heatmap.html / heatmap.css      # Heatmap
  history.html / history.css      # History
  manifest.json / sw.js           # PWA — includes Web Push handling
  icons/icon.svg
  js/
    app.js      # Tracker orchestrator (bike watch, push subscribe/unsubscribe)
    atlas.js    # Zone flow map
    heatmap.js  # Heat layer map
    history.js  # Chart.js history
    map.js      # Leaflet helpers (trips, focus, station popup)
    trips.js    # API fetch, time filtering, localToday()
    ui.js       # Panels, charts, alerts, timeline player, theme (initTheme/toggleTheme)
    geo.js      # Haversine, station lookup, city config
    tiles.js    # Esri basemap (base + labels overlay), theme-aware tile switcher
```

All four pages are ES modules and share `ui.js` (theme), `tiles.js` (the three map pages), and `trips.js`'s `localToday()` — no page reimplements its own theme toggling or tile setup anymore.

## API

### `GET /api/trips?date=YYYY-MM-DD`

Trips for a given date (Montréal local time). `group_id` is non-null when multiple bikes shared the same origin/destination within a 5-minute window.

```json
[
  {
    "bike_id": "E12345",
    "start_time": "2025-06-01T14:00:00Z",
    "start_lat": 45.512, "start_lon": -73.567,
    "end_time":   "2025-06-01T14:12:00Z",
    "end_lat":   45.523, "end_lon": -73.551,
    "distance": 1423.5,
    "group_id": null
  }
]
```

### `GET /api/active`

Count of bikes currently in transit (absent from the GBFS feed for 45 s+).

### `GET /api/heatmap?date=YYYY-MM-DD[&week=1][&trip_type=arrivals]`

Departure (default) or arrival density per rounded GPS cell per hour. `week=1` aggregates the 7 days ending on `date`. Note the param is **`trip_type`**, not `type`.

### `GET /api/flows?date=YYYY-MM-DD&city=montreal|sherbrooke`

Zone-to-zone trip counts aggregated by hour, with average distance and duration. A trip endpoint snaps to the nearest named zone within 900 m; roughly half of all trips fall outside every zone and aren't counted here (see `zones.rs`).

### `GET /api/history?days=30&city=all|montreal|sherbrooke[&from=YYYY-MM-DD&to=YYYY-MM-DD]`

Daily trip counts. Use `from`/`to` for an explicit date range (used by period comparison).

### `GET /api/zones[?city=montreal|sherbrooke]`

Named zone definitions (lat/lon) used by the Atlas.

### `GET /api/departures/nearby?lat=X&lon=Y`

Bikes currently in transit that departed within 120 m of the given coordinates, sorted by elapsed time.

### `GET /api/bike/status?bike_id=X`

`{ "in_flight": bool }` — used by the client-side foreground polling fallback.

### `GET /api/push/vapid-public-key`

`{ "public_key": "..." }` — base64url, uncompressed P-256 point, for `PushManager.subscribe`.

### `POST /api/push/subscribe`

Body: `{ "bike_id": "...", "subscription": <PushSubscription.toJSON() output> }`. Registers a one-shot watch — the row is deleted once the bike returns (successful push or not) or after ~3h regardless (see `db::cleanup_push_subscriptions`).

### `POST /api/push/unsubscribe`

Body: `{ "bike_id": "...", "endpoint": "..." }`. Cancels a specific watch without touching the browser's underlying push subscription (which may back other watches).

## Nginx

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
