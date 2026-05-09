# BIXI Tracker

Real-time and historical visualization of electric BIXI bikes in Montréal and Sherbrooke.

The backend polls Velobixi's public GBFS API every 30 seconds, detects bike movements, and records them as trips in SQLite. Four frontend views let you explore the data.

## Pages

| Page | Description |
|------|-------------|
| **Tracker** (`/`) | Live map with time-scrubbing slider, bike search, group detection, station cards |
| **Atlas** (`/atlas.html`) | Zone-to-zone flow visualization by hour |
| **Heatmap** (`/heatmap.html`) | Departure or arrival density heatmap by hour (day or 7-day rollup) |
| **History** (`/history.html`) | Daily trip count chart with period comparison and weekday breakdown |

All pages share a dark/light theme (persisted in `localStorage`) and the selected date (persisted in `sessionStorage` for in-session navigation).

## Stack

- **Backend** : Rust / Axum 0.8 / SQLite (r2d2 + rusqlite) / gzip via tower-http
- **Frontend** : Vanilla JavaScript (ES modules), Leaflet.js, Chart.js
- **PWA** : service worker (network-first for HTML + API, cache-first for assets)

## Development

```bash
cargo run
```

Server starts on `http://localhost:3000`. Static files are served from `public/`.

## Project Structure

```
src/
  main.rs      # Pool init, tracker spawn, router setup
  db.rs        # SQLite schema + WAL mode
  tracker.rs   # GBFS polling loop, trip detection and insertion
  routes.rs    # All API handlers
  models.rs    # Shared types
  zones.rs     # 57 named zones for Montréal and Sherbrooke

public/
  index.html / style.css          # Tracker
  atlas.html  / atlas.css         # Atlas
  heatmap.html / heatmap.css      # Heatmap
  history.html / history.css      # History
  manifest.json / sw.js           # PWA
  icons/icon.svg
  js/
    app.js      # Tracker orchestrator
    atlas.js    # Zone flow map
    heatmap.js  # Heat layer map
    history.js  # Chart.js history
    map.js      # Leaflet helpers (trips, focus, station popup)
    trips.js    # API fetch, time filtering
    ui.js       # Panels, charts, alerts, timeline player
    geo.js      # Haversine, station lookup, city config
```

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

Count of bikes currently in transit (absent from the GBFS feed for 90 s+).

### `GET /api/heatmap?date=YYYY-MM-DD[&week=1][&type=arrivals]`

Departure (default) or arrival density per rounded GPS cell per hour. `week=1` aggregates the 7 days ending on `date`.

### `GET /api/flows?date=YYYY-MM-DD&city=montreal|sherbrooke`

Zone-to-zone trip counts aggregated by hour, with average distance and duration.

### `GET /api/history?days=30&city=all|montreal|sherbrooke[&from=YYYY-MM-DD&to=YYYY-MM-DD]`

Daily trip counts. Use `from`/`to` for an explicit date range (used by period comparison).

### `GET /api/zones[?city=montreal|sherbrooke]`

Named zone definitions (lat/lon) used by the Atlas.

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
