// Vélos suivis récemment — purement local (localStorage), rien ne part au
// serveur. "Pending" survit à un onglet fermé/rouvert (la notif push peut
// ramener l'utilisateur sur une toute nouvelle instance de App), donc on lit
// depuis le storage plutôt que d'un état en mémoire.

const PENDING_KEY = "bixi-pending-watches";
const HISTORY_KEY = "bixi-watch-history";
const MAX_HISTORY  = 30;

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage plein ou bloqué (navigation privée) — le suivi reste
    // fonctionnel, seul l'historique n'est pas persisté.
  }
}

export function setPendingWatch(bikeId, { departedAt, depLat, depLon }) {
  const pending = readJSON(PENDING_KEY, {});
  pending[bikeId] = { departedAt, depLat, depLon };
  writeJSON(PENDING_KEY, pending);
}

export function clearPendingWatch(bikeId) {
  const pending = readJSON(PENDING_KEY, {});
  delete pending[bikeId];
  writeJSON(PENDING_KEY, pending);
}

export function getHistory() {
  return readJSON(HISTORY_KEY, []);
}

export function clearHistory() {
  writeJSON(HISTORY_KEY, []);
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Turns a resolved watch into a history entry, using whatever departure info
 * was captured when the watch started. Returns null (no-op) if there's no
 * pending watch for this bike — e.g. a push notification and the foreground
 * poll both resolved the same watch; only the first call records anything.
 */
export function recordArrival(bikeId, { arrLat, arrLon } = {}) {
  const pending = readJSON(PENDING_KEY, {})[bikeId];
  if (!pending) return null;

  const hasArrival   = typeof arrLat === "number" && typeof arrLon === "number";
  const hasDeparture = typeof pending.depLat === "number" && typeof pending.depLon === "number";

  const entry = {
    bikeId,
    departedAt: pending.departedAt ?? null,
    arrivedAt:  new Date().toISOString(),
    depLat: pending.depLat ?? null,
    depLon: pending.depLon ?? null,
    arrLat: hasArrival ? arrLat : null,
    arrLon: hasArrival ? arrLon : null,
    distanceM: hasArrival && hasDeparture
      ? Math.round(haversineMeters(pending.depLat, pending.depLon, arrLat, arrLon))
      : null,
  };

  const history = getHistory();
  history.unshift(entry);
  writeJSON(HISTORY_KEY, history.slice(0, MAX_HISTORY));
  clearPendingWatch(bikeId);

  return entry;
}
