const API_URL = "/api/trips";

export async function fetchTrips(date) {
  const res = await fetch(`${API_URL}?date=${date}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function fetchActive() {
  try {
    const res = await fetch("/api/active");
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

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

export function filterByTimeWindow(trips, centerMinutes, windowMinutes) {
  const from = centerMinutes - windowMinutes;
  const to = centerMinutes + windowMinutes;
  return trips.filter((t) => {
    const mins = tripEndMinutes(t);
    return mins >= from && mins <= to;
  });
}

export function filterByDistance(trips, minMeters) {
  if (!minMeters || minMeters <= 0) return trips;
  return trips.filter((t) => t.distance >= minMeters);
}