const API_URL = "/api/trips";

export async function fetchTrips(date) {
  const res = await fetch(`${API_URL}?date=${date}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

/**
 * Returns the trip's end time as minutes since midnight (Montreal local time).
 */
export function tripEndMinutes(trip) {
  const date = new Date(trip.end_time);
  const [h, m] = date
    .toLocaleTimeString("it-IT", {
      timeZone: "America/Montreal",
      hour: "2-digit",
      minute: "2-digit",
    })
    .split(":")
    .map(Number);
  return h * 60 + m;
}

/**
 * Format an RFC3339 timestamp as HH:MM in Montreal local time.
 */
export function formatTime(dateStr) {
  if (!dateStr) return "--:--";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("it-IT", {
    timeZone: "America/Montreal",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function minutesToHHMM(mins) {
  const h = Math.floor(mins / 60).toString().padStart(2, "0");
  const m = (mins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Filter trips to those whose end time falls within [center-window, center+window] minutes.
 */
export function filterByTimeWindow(trips, centerMinutes, windowMinutes) {
  const from = centerMinutes - windowMinutes;
  const to = centerMinutes + windowMinutes;
  return trips.filter((t) => {
    const mins = tripEndMinutes(t);
    return mins >= from && mins <= to;
  });
}