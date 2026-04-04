import { minutesToHHMM, formatTime } from "./trips.js";
import { findNearestStation, haversineDistance } from "./geo.js";

// --- Alert banner ---

export function showAlert(message) {
  const box = document.getElementById("alertBox");
  const el = document.createElement("div");
  el.className = "alert-banner";
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "0.5s";
    setTimeout(() => el.remove(), 500);
  }, 5000);
}

// --- Stats footer ---

export function updateStats(visibleTrips, allTrips, selectedDate) {
  const pad = (n) => n.toString().padStart(2, "0");

  document.getElementById("statCount").textContent = visibleTrips.length;

  const totalKm = allTrips
    .filter((t) => {
      const d = new Date(t.end_time);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` === selectedDate;
    })
    .reduce((sum, t) => sum + t.distance, 0) / 1000;

  document.getElementById("statDist").textContent = totalKm.toFixed(1);

  const uniqueGroups = new Set(
    visibleTrips.filter((t) => t.group_id !== null).map((t) => t.group_id)
  );
  document.getElementById("groupCount").textContent = uniqueGroups.size;
}

// --- Slider label ---

export function updateSliderLabel(minutes) {
  document.getElementById("timeLabel").textContent = minutesToHHMM(minutes);
}

// --- Bike search panel ---

export function renderBikePanel(trips, stations, onFocus) {
  const container = document.getElementById("bikeResults");
  if (trips.length === 0) {
    container.innerHTML = "Aucun trajet trouvé.";
    return;
  }

  let html = `<b>${trips.length} trajet(s) :</b><ul>`;
  trips.forEach((t) => {
    const from = findNearestStation(stations, t.start_lat, t.start_lon)?.name ?? "Inconnu";
    const to = findNearestStation(stations, t.end_lat, t.end_lon)?.name ?? "Inconnu";
    html += `
      <li>
        <span class="time">${formatTime(t.start_time)} → ${formatTime(t.end_time)}</span><br>
        ${from} ➔ ${to}
        <button onclick="${onFocus}(${t.start_lat},${t.start_lon},${t.end_lat},${t.end_lon})"
                style="width:auto;padding:2px 5px;">Voir</button>
      </li>`;
  });
  container.innerHTML = html + "</ul>";
}

// --- Group highlight panel ---

export function renderGroupPanel(groupId, members, stations, onFocus) {
  const container = document.getElementById("bikeResults");
  let html = `<b style="color:#e74c3c;">👥 Membres du Groupe #${groupId} :</b><ul style="margin-top:5px;padding:0;">`;
  members.forEach((t) => {
    html += `
      <li style="list-style:none;padding:5px;background:#f9f9f9;border-radius:4px;margin-bottom:3px;">
        🚲 <b><a href="#" onclick="window.app.searchBike('${t.bike_id}');return false;">${t.bike_id}</a></b>
        <span style="font-size:10px;color:#666;">(Arr: ${formatTime(t.end_time)})</span>
        <button onclick="window.app.focusTrip(${t.start_lat},${t.start_lon},${t.end_lat},${t.end_lon})"
                style="width:auto;padding:0 4px;float:right;cursor:pointer;">👁️</button>
      </li>`;
  });
  html += `</ul><button onclick="window.app.resetStyles()" style="width:100%;margin-top:5px;font-size:11px;cursor:pointer;">✖ Quitter le focus</button>`;
  container.innerHTML = html;
}

// --- Nearby arrivals panel ---

export function renderNearbyPanel(stationName, arrivals, onFocus) {
  const div = document.getElementById("nearbyResults");
  if (arrivals.length === 0) {
    div.innerHTML = `📍 <b>${stationName}</b><br>Aucune arrivée récente.`;
    return;
  }

  let html = `📍 <b>${stationName}</b><br><ul style="list-style:none;padding:0;margin-top:5px;">`;
  arrivals.forEach((t, i) => {
    const timeAgo = Math.round((Date.now() - new Date(t.end_time)) / 60_000);
    const highlight = i === 0 ? "border-left:3px solid #e74c3c;background:#fff5f5;" : "";
    html += `
      <li style="padding:5px;margin-bottom:3px;border-radius:4px;${highlight}">
        🚲 <b>${t.bike_id}</b> (${timeAgo} min)
        <a href="#" onclick="${onFocus}(${t.start_lat},${t.start_lon},${t.end_lat},${t.end_lon});return false;"
           style="text-decoration:none;margin-left:5px;">👁️</a>
      </li>`;
  });
  div.innerHTML = html + "</ul>";
}

// --- Timeline player ---

export class TimelinePlayer {
  constructor(sliderId, onTick) {
    this.slider = document.getElementById(sliderId);
    this.onTick = onTick;
    this.playing = false;
    this.interval = null;
  }

  toggle() {
    this.playing = !this.playing;
    const btn = document.getElementById("togglePlay");
    if (this.playing) {
      btn.textContent = "⏸ Pause";
      this.interval = setInterval(() => {
        this.slider.value = (parseInt(this.slider.value) + 1) % 1440;
        this.onTick();
      }, 500);
    } else {
      btn.textContent = "▶️ Play Timeline";
      clearInterval(this.interval);
    }
  }

  stop() {
    this.playing = false;
    clearInterval(this.interval);
    document.getElementById("togglePlay").textContent = "▶️ Play Timeline";
  }
}