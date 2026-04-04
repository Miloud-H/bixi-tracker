import {
  haversineDistance,
  findNearestStation,
  tripColor,
  MONTREAL_CENTER,
  SEARCH_RADIUS_METERS,
  STATION_SNAP_METERS,
} from "./geo.js";
import { formatTime } from "./trips.js";

// Leaflet is loaded globally via <script> tag in index.html
const L = window.L;

export function initMap() {
  const map = L.map("map").setView(MONTREAL_CENTER, 13);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap &copy; CARTO",
  }).addTo(map);

  return map;
}

export function renderTrips(map, trips, stations) {
  const layer = L.layerGroup().addTo(map);

  trips.forEach((trip, i) => {
    const isGroup = trip.group_id !== null;
    const color = isGroup ? "#e74c3c" : tripColor(i);
    const weight = isGroup ? 4 : 2;

    const startStation = findNearestStation(stations, trip.start_lat, trip.start_lon);
    const endStation = findNearestStation(stations, trip.end_lat, trip.end_lon);

    const groupCount = isGroup
      ? trips.filter((t) => t.group_id === trip.group_id).length
      : 0;

    const groupLabel = isGroup
      ? `<br><b style="color:#e74c3c;">👥 Groupe de ${groupCount} vélos (ID: ${trip.group_id})</b><br>
         <button onclick="window.app.highlightGroup(${trip.group_id})" style="width:100%;font-size:10px;background:#f1f1f1;border:1px solid #ccc;padding:2px;">
           Surligner le groupe
         </button>`
      : "";

    const popup = `
      🚲 <b>ID: <a href="#" onclick="window.app.searchBike('${trip.bike_id}'); return false;">${trip.bike_id}</a></b>
      ${groupLabel}<br>
      ⏱ ${formatTime(trip.start_time)} ➔ ${formatTime(trip.end_time)}<br>
      📍 Dépt: ${startStation ? startStation.name : "Hors station"}<br>
      📍 Arriv: ${endStation ? endStation.name : "Hors station"}<br>
      📏 Dist: ${Math.round(trip.distance)} m
    `;

    const line = L.polyline(
      [[trip.start_lat, trip.start_lon], [trip.end_lat, trip.end_lon]],
      { color, originalColor: color, weight, opacity: 0.7, lineJoin: "round" }
    )
      .addTo(layer)
      .bindPopup(popup);

    line.group_id = trip.group_id;

    // Direction arrow at midpoint
    const p1 = map.project([trip.start_lat, trip.start_lon]);
    const p2 = map.project([trip.end_lat, trip.end_lon]);
    const mid = map.unproject(L.point((p1.x + p2.x) / 2, (p1.y + p2.y) / 2));
    const angle = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;

    L.marker(mid, {
      icon: L.divIcon({
        className: "trip-arrow",
        html: `<div style="transform:rotate(${angle}deg);color:${color};font-size:16px;text-shadow:1px 1px 2px #fff;">➤</div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      }),
      interactive: false,
    }).addTo(layer);

    L.circleMarker([trip.end_lat, trip.end_lon], {
      radius: 3,
      color,
      fillOpacity: 1,
      stroke: false,
    }).addTo(layer);
  });

  return layer;
}

export function highlightGroup(layer, groupId) {
  layer.eachLayer((l) => {
    if (l instanceof L.Polyline) {
      if (l.group_id === groupId) {
        l.setStyle({ color: "#00FFFF", weight: 6, opacity: 1 });
        l.bringToFront();
      } else {
        l.setStyle({ color: "#bdc3c7", weight: 1, opacity: 0.1 });
      }
    } else if (l instanceof L.CircleMarker) {
      l.setStyle({ opacity: 0.1, fillOpacity: 0.1 });
    }
  });
}

export function resetLayerStyles(layer) {
  if (!layer) return;
  layer.eachLayer((l) => {
    if (l instanceof L.Polyline) {
      const isGroup = l.group_id !== null && l.group_id !== undefined;
      l.setStyle({
        color: isGroup ? "#e74c3c" : (l.options.originalColor || "#3498db"),
        weight: isGroup ? 4 : 2,
        opacity: 0.7,
      });
    } else if (l instanceof L.CircleMarker) {
      l.setStyle({ opacity: 1, fillOpacity: 1 });
    }
  });
}

export function focusTrip(map, sl1, sl2, el1, el2) {
  const line = L.polyline([[sl1, sl2], [el1, el2]], {
    color: "red",
    weight: 6,
    opacity: 1,
    dashArray: "10, 10",
  });
  const focusLayer = L.layerGroup([line]).addTo(map);
  map.fitBounds(L.latLngBounds([[sl1, sl2], [el1, el2]]).pad(0.2));
  return focusLayer;
}

export function bindClickPopup(map, trips, stations) {
  map.on("click", (e) => {
    const { lat, lng } = e.latlng;
    const nearby = trips.filter(
      (t) => haversineDistance(lat, lng, t.end_lat, t.end_lon) <= SEARCH_RADIUS_METERS
    );

    if (nearby.length === 0) {
      L.popup()
        .setLatLng(e.latlng)
        .setContent(`Aucun trajet trouvé dans ${SEARCH_RADIUS_METERS} m`)
        .openOn(map);
      return;
    }

    let html = `<b>${nearby.length} trajet(s) terminés ici :</b><ul style="padding:10px;margin:0;font-size:11px;">`;
    nearby.forEach((t) => {
      html += `<li>🚲 <a href="#" onclick="window.app.searchBike('${t.bike_id}')">${t.bike_id}</a> — ${formatTime(t.end_time)}</li>`;
    });
    html += "</ul>";
    L.popup().setLatLng(e.latlng).setContent(html).openOn(map);
  });
}