export const MONTREAL_CENTER = [45.5017, -73.5673];
export const SEARCH_RADIUS_METERS = 100;
export const STATION_SNAP_METERS = 80;

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
 * Generates a visually distinct color from an index,
 * avoiding green hues (which clash with the map tiles).
 */
export function tripColor(index) {
  const range = 280;
  const rawHue = (index * 47) % range;
  const hue = rawHue >= 80 ? rawHue + 80 : rawHue;
  return `hsl(${hue}, 80%, 45%)`;
}