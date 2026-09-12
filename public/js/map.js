import {
  haversineDistance,
  findNearestStation,
  tripColor,
  MONTREAL_CENTER,
  SEARCH_RADIUS_METERS,
} from "./geo.js";
import { formatTime, formatElapsed } from "./trips.js";
import { createTileSwitcher } from "./tiles.js";
import { escapeHtml } from "./ui.js";

// Leaflet is loaded globally via <script> tag in index.html
const L = window.L;

// Un seul renderer canvas partagé, réutilisé à chaque render() plutôt que
// recréé (Leaflet recommande explicitement ce pattern pour des layers
// ajoutés/retirés fréquemment) : évite de générer un nouvel élément <canvas>
// à chaque déplacement du slider.
export function initMap(theme = "light") {
  const map = L.map("map", { zoomControl: false }).setView(MONTREAL_CENTER, 13);
  L.control.zoom({ position: "bottomleft" }).addTo(map);

  // Exposed so the theme toggle can swap tiles later without recreating the map.
  map.setTiles = createTileSwitcher(map);
  map.setTiles(theme);

  map.tripsRenderer = L.canvas({ padding: 0.5 }).addTo(map);

  // Délégation pour le contenu des popups Leaflet : ils sont recréés à
  // chaque ouverture (pas un conteneur stable auquel attacher un listener
  // à l'avance), donc on écoute au niveau du conteneur de la carte, qui
  // lui persiste, et on laisse le clic remonter jusqu'ici.
  map.getContainer().addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    if (el.dataset.action === "search-bike") {
      e.preventDefault();
      window.app.searchBike(el.dataset.bikeId);
    } else if (el.dataset.action === "highlight-group") {
      window.app.highlightGroup(Number(el.dataset.groupId));
    } else if (el.dataset.action === "watch-bike") {
      e.preventDefault();
      window.app.watchBike(el.dataset.bikeId);
      map.closePopup();
    }
  });

  return map;
}

// Contenu du popup calculé à la demande (Leaflet accepte une fonction comme
// contenu de bindPopup et ne l'appelle qu'à l'ouverture) plutôt que pour
// chaque trajet au chargement — évite ~2 lookups de station (scan linéaire
// sur ~1100 stations) x N trajets rien que pour du texte que personne ne lira
// dans l'immense majorité des cas.
function buildTripPopup(trip, stations, allTrips) {
  const isGroup = trip.group_id !== null;
  const startStation = findNearestStation(stations, trip.start_lat, trip.start_lon);
  const endStation = findNearestStation(stations, trip.end_lat, trip.end_lon);

  const groupCount = isGroup
    ? allTrips.filter((t) => t.group_id === trip.group_id).length
    : 0;

  const groupLabel = isGroup
    ? `<br><b class="popup-group-label">👥 Groupe de ${groupCount} vélos (ID: ${trip.group_id})</b><br>
       <button class="highlightButton" data-action="highlight-group" data-group-id="${trip.group_id}">
         Surligner le groupe
       </button>`
    : "";

  return `
    🚲 <b>ID: <a href="#" data-action="search-bike" data-bike-id="${escapeHtml(trip.bike_id)}">${escapeHtml(trip.bike_id)}</a></b>
    ${groupLabel}<br>
    ⏱ ${formatTime(trip.start_time)} ➔ ${formatTime(trip.end_time)}<br>
    📍 Dépt: ${startStation ? escapeHtml(startStation.name) : "Hors station"}<br>
    📍 Arriv: ${endStation ? escapeHtml(endStation.name) : "Hors station"}<br>
    📏 Dist: ${Math.round(trip.distance)} m
  `;
}

// Au-delà de ce nombre de trajets affichés simultanément, les flèches de
// direction individuelles se chevauchent trop pour être lisibles de toute
// façon — et contrairement aux lignes/points, ce sont des Markers Leaflet
// (toujours du DOM, jamais du canvas), donc le poste le plus coûteux à
// grande échelle ("Toute la journée" -> souvent 10k+ trajets).
const ARROW_MAX_TRIPS = 1500;

export function renderTrips(map, trips, stations) {
  const layer = L.layerGroup().addTo(map);
  const renderer = map.tripsRenderer;
  const showArrows = trips.length <= ARROW_MAX_TRIPS;

  trips.forEach((trip) => {
    const isGroup = trip.group_id !== null;
    const color = isGroup ? "#e74c3c" : tripColor(trip.bike_id);
    const weight = isGroup ? 4 : 2;

    const line = L.polyline(
      [[trip.start_lat, trip.start_lon], [trip.end_lat, trip.end_lon]],
      { color, originalColor: color, weight, opacity: 0.7, lineJoin: "round", renderer }
    )
      .addTo(layer)
      .bindPopup(() => buildTripPopup(trip, stations, trips));

    line.group_id = trip.group_id;
    line.bike_id = trip.bike_id;

    if (showArrows) {
      // Direction arrow at midpoint
      const p1 = map.project([trip.start_lat, trip.start_lon]);
      const p2 = map.project([trip.end_lat, trip.end_lon]);
      const mid = map.unproject(L.point((p1.x + p2.x) / 2, (p1.y + p2.y) / 2));
      const angle = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;

      const arrow = L.marker(mid, {
        icon: L.divIcon({
          className: "trip-arrow",
          html: `<div class="trip-arrow-icon" style="transform:rotate(${angle}deg);color:${color};">➤</div>`,
          iconSize: [20, 20],
          iconAnchor: [10, 10],
        }),
        interactive: false,
      }).addTo(layer);
      arrow.group_id = trip.group_id;
      arrow.bike_id = trip.bike_id;
    }

    const dot = L.circleMarker([trip.end_lat, trip.end_lon], {
      radius: 3,
      color,
      fillOpacity: 1,
      stroke: false,
      renderer,
    }).addTo(layer);
    dot.group_id = trip.group_id;
    dot.bike_id = trip.bike_id;
  });

  return layer;
}

export function highlightGroup(layer, groupId) {
  layer._map.closePopup();
  layer.eachLayer((l) => {
    const isTarget = l.group_id === groupId;
    if (isTarget) {
      if (l instanceof L.Polyline) {
        l.setStyle({ color: "#00FFFF", weight: 6, opacity: 1 });
        l.bringToFront();
      } else if (l instanceof L.CircleMarker) {
        l.setStyle({ opacity: 1, fillOpacity: 1 });
      } else if (l.getElement && l.getElement()) { // Pour les Markers (flèches)
        l.getElement().style.opacity = "1";
      }
    } else {
      if (l instanceof L.Polyline) {
        l.setStyle({ color: "#bdc3c7", weight: 1, opacity: 0.2 });
      } else if (l instanceof L.CircleMarker) {
        l.setStyle({ opacity: 0.2, fillOpacity: 0.2 });
      } else if (l.getElement && l.getElement()) {
        l.getElement().style.opacity = "0.2";
      }
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
    } else if (l.getElement && l.getElement()) {
      l.getElement().style.opacity = "1";
    }
  });
}

export function focusTrip(map, sl1, sl2, el1, el2) {
  const start = [sl1, sl2];
  const end   = [el1, el2];

  const line = L.polyline([start, end], {
    color: "#64b5f6",
    weight: 4,
    opacity: 0.9,
    dashArray: "8, 5",
  });

  const p1  = map.project(start);
  const p2  = map.project(end);
  const mid = map.unproject(L.point((p1.x + p2.x) / 2, (p1.y + p2.y) / 2));
  const angle = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
  const arrow = L.marker(mid, {
    icon: L.divIcon({
      className: "",
      html: `<div class="focus-arrow-icon" style="transform:rotate(${angle}deg);">➤</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    }),
    interactive: false,
  });

  const startDot = L.circleMarker(start, {
    radius: 9, fillColor: "#00e676", color: "#fff", weight: 2, fillOpacity: 1,
  }).bindTooltip("Départ", { permanent: true, direction: "top", className: "focus-tip" });

  const endDot = L.circleMarker(end, {
    radius: 9, fillColor: "#ff5252", color: "#fff", weight: 2, fillOpacity: 1,
  }).bindTooltip("Arrivée", { permanent: true, direction: "top", className: "focus-tip" });

  const focusLayer = L.layerGroup([line, arrow, startDot, endDot]).addTo(map);
  map.fitBounds(L.latLngBounds([start, end]).pad(0.3));
  return focusLayer;
}

// --- Vélos "en vol" (overlay carte, voir /api/bikes/in-flight) ---
// Contrairement à un trajet, on ne connaît que le point de départ — pas de
// ligne ni de flèche de direction, juste un point pulsant + temps écoulé.
// Rendu en L.marker/divIcon (DOM, pas canvas) : c'est le seul moyen d'avoir
// l'animation CSS de pulsation, et le volume (quelques dizaines à ~200 vélos
// aux heures de pointe) reste largement sous ARROW_MAX_TRIPS.

export function renderInFlight(map, bikes, watchedIds) {
  const layer = L.layerGroup().addTo(map);

  bikes.forEach((bike) => {
    const isWatched = watchedIds?.has(bike.bike_id);
    const watchButton = isWatched
      ? `<span class="watch-btn is-watching">✓ Suivi</span>`
      : `<button class="watch-btn" data-action="watch-bike" data-bike-id="${escapeHtml(bike.bike_id)}">Suivre</button>`;

    L.marker([bike.dep_lat, bike.dep_lon], {
      icon: L.divIcon({
        className: "inflight-marker",
        html: '<div class="inflight-dot"></div>',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
    })
      .addTo(layer)
      .bindPopup(
        `🚴 <b><a href="#" data-action="search-bike" data-bike-id="${escapeHtml(bike.bike_id)}">${escapeHtml(bike.bike_id)}</a></b><br>
         En route depuis ${formatElapsed(bike.elapsed_secs)}<br>
         <span class="popup-hint">Position de départ — pas de suivi live (le flux GBFS ne rapporte pas la position d'un vélo loué)</span><br>
         ${watchButton}`
      );
  });

  return layer;
}

export function bindClickPopup(map, getTrips, stations, onStationClick) {
  map.on("click", (e) => {
    const { lat, lng } = e.latlng;
    const nearby = getTrips().filter(
      (t) => haversineDistance(lat, lng, t.end_lat, t.end_lon) <= SEARCH_RADIUS_METERS
    );

    if (nearby.length === 0) return;

    if (onStationClick) {
      const station = findNearestStation(stations, lat, lng, 300) ||
        { name: "Station inconnue", lat, lon: lng };
      e.originalEvent.preventDefault();
      onStationClick(station);
      return;
    }

    let html = `<b>${nearby.length} trajet(s) terminés ici :</b><ul class="click-popup-list">`;
    nearby.forEach((t) => {
      html += `<li>🚲 <a href="#" data-action="search-bike" data-bike-id="${escapeHtml(t.bike_id)}">${escapeHtml(t.bike_id)}</a> — ${formatTime(t.end_time)}</li>`;
    });
    html += "</ul>";
    L.popup().setLatLng(e.latlng).setContent(html).openOn(map);
  });
}