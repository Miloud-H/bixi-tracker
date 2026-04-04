# BIXI Tracker

Real-time visualization of electric BIXI bikes in Montreal.

The backend polls Velobixi's public GBFS API every 30 seconds, detects bike movements, and records them as trips. The frontend displays these trips on an interactive map featuring a time-scrubbing slider.

## Stack

- **Backend** : Rust / Axum / SQLite (via r2d2 + rusqlite)
- **Frontend** : Vanilla JavaScript (ES modules), Leaflet.js
- **Reverse proxy** : nginx

## Development Setup

```bash
cargo run
```

The server will start on `http://localhost:3000`. Static files are served from the `public/` directory.

## Project Structure

```
src/
  main.rs      # Entry point: pool init, tracker spawn, server binding
  db.rs        # SQLite connection pool + schema initialization
  tracker.rs   # GBFS polling loop, trip detection, and insertion
  routes.rs    # GET /api/trips handler
  models.rs    # Shared types (Trip, Bike, BikeState, TripQuery)

public/
  index.html
  style.css
  js/
    app.js     # Main orchestrator
    map.js     # Leaflet init, trip rendering, map interactions
    trips.js   # API fetching, time filtering, formatting
    ui.js      # Control panel, alerts, timeline player
    geo.js     # Distance calculations, station lookup, color logic
```

## Nginx Configuration

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

## API

### `GET /api/trips?date=YYYY-MM-DD`

Returns the list of trips for a specific date (Montreal local time).

```json
[
  {
    "bike_id": "E12345",
    "start_time": "2025-06-01T14:00:00Z",
    "start_lat": 45.512,
    "start_lon": -73.567,
    "end_time": "2025-06-01T14:12:00Z",
    "end_lat": 45.523,
    "end_lon": -73.551,
    "distance": 1423.5,
    "group_id": null
  }
]
```

`group_id` is non-null if multiple bikes performed the same trip within the same 5-minute window (indicating a group ride or station redistribution).
