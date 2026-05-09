export const MONTREAL_CENTER = [45.5017, -73.5673];
export const SEARCH_RADIUS_METERS = 100;
export const STATION_SNAP_METERS = 80;

// Villes détectées dans le flux GBFS Velobixi
export const CITIES = {
  montreal: {
    label: "Grand Montréal",
    center: [45.5017, -73.5673],
    zoom: 13,
    // Tout ce qui n'est pas Sherbrooke
    // Tout ce qui n'est pas Sherbrooke
    filter: (trip) => trip.start_lon < -72.5,
  },
  sherbrooke: {
    label: "Sherbrooke",
    center: [45.404, -71.888],
    zoom: 13,
    filter: (trip) => trip.start_lon >= -72.5,
  },
  all: {
    label: "Toutes les villes",
    center: [45.5017, -73.5673],
    zoom: 11,
    filter: () => true,
  },
};

export function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function findNearestStation(stations, lat, lon, maxDist = STATION_SNAP_METERS) {
  let closest = null;
  let minDist = Infinity;
  for (const st of stations) {
    const dist = haversineDistance(lat, lon, st.lat, st.lon);
    if (dist < minDist) {
      minDist = dist;
      closest = st;
    }
  }
  return minDist <= maxDist ? closest : null;
}

/**
 * Génère une couleur stable à partir d'un bike_id,
 * en évitant les verts (qui clashent avec les tiles).
 */
export function tripColor(bikeId) {
  // Hash simple mais stable : somme des char codes
  let hash = 0;
  for (let i = 0; i < bikeId.length; i++) {
    hash = (hash * 31 + bikeId.charCodeAt(i)) >>> 0;
  }
  const range = 280;
  const rawHue = (hash * 47) % range;
  const hue = rawHue >= 80 ? rawHue + 80 : rawHue;
  return `hsl(${hue}, 80%, 45%)`;
}