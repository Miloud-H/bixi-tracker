import { minutesToHHMM, formatTime, tripEndMinutes } from "./trips.js";
import { findNearestStation, haversineDistance } from "./geo.js";

// --- Theme ---

export function initTheme() {
  const saved = localStorage.getItem("bixi-theme") || "light";
  applyTheme(saved);
  return saved;
}

export function toggleTheme(current) {
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem("bixi-theme", next);
  return next;
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = theme === "dark" ? "☀ Clair" : "🌙 Sombre";
}

// --- Histogram ---

export function drawHistogram(canvas, allTrips) {
  if (!canvas || allTrips.length === 0) return;

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const ctx = canvas.getContext("2d");
  const W = canvas.offsetWidth;
  const H = canvas.offsetHeight;
  canvas.width = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  // Bucket trips into 30-min slots (48 slots)
  const buckets = new Array(48).fill(0);
  for (const t of allTrips) {
    const mins = tripEndMinutes(t);
    const slot = Math.min(Math.floor(mins / 30), 47);
    buckets[slot]++;
  }
  const max = Math.max(...buckets, 1);

  ctx.clearRect(0, 0, W, H);

  const slotW = W / 48;
  const accentColor = isDark ? "#00e676" : "#2ecc71";

  buckets.forEach((count, i) => {
    const barH = (count / max) * H;
    const x = i * slotW;

    const gradient = ctx.createLinearGradient(0, H - barH, 0, H);
    gradient.addColorStop(0, accentColor + "cc");
    gradient.addColorStop(1, accentColor + "22");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(x + 1, H - barH, slotW - 2, barH, 2);
    ctx.fill();
  });
}

// --- Slider track fill ---

export function updateSliderLabel(minutes) {
  document.getElementById("timeLabel").textContent = minutesToHHMM(minutes);
  const slider = document.getElementById("timeSlider");
  const pct = (minutes / 1439) * 100;
  slider.style.setProperty("--slider-pct", pct + "%");
}

// --- Play button state ---

export function setPlayingState(playing) {
  const btn = document.getElementById("togglePlay");
  if (!btn) return;
  btn.textContent = playing ? "⏸ Pause" : "▶ Lecture";
  btn.classList.toggle("playing", playing);
}

// --- Alert banner ---

export function showAlert(message) {
  const box = document.getElementById("alertBox");
  const el = document.createElement("div");
  el.className = "alert-banner";
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "0.4s";
    setTimeout(() => el.remove(), 400);
  }, 4000);
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

// --- Top stations ---

export function updateTopStations(trips, stations) {
  const panel = document.getElementById("statsPanel");
  if (!panel) return;

  const counts = {};
  for (const t of trips) {
    const snap = findNearestStation(stations, t.end_lat, t.end_lon, 120);
    if (!snap) continue;
    counts[snap.name] = (counts[snap.name] || 0) + 1;
  }

  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (top.length === 0) {
    panel.innerHTML = `<div style="color:var(--text-muted);font-size:11px;padding:4px 0;">Aucune donnée</div>`;
    return;
  }

  const maxCount = top[0][1];
  panel.innerHTML = top.map(([name, count]) => `
    <div class="stat-row">
      <span class="stat-label" title="${name}">${name}</span>
      <div class="stat-bar-wrap">
        <div class="stat-bar" style="width:${(count / maxCount) * 100}%"></div>
      </div>
      <span class="stat-count">${count}</span>
    </div>
  `).join("");
}

// --- Bike search panel ---

export function renderBikePanel(trips, stations, onFocus) {
  const container = document.getElementById("bikeResults");
  if (trips.length === 0) {
    container.innerHTML = `<div style="color:var(--text-muted);padding:6px 0;">Aucun trajet trouvé.</div>`;
    return;
  }

  let html = `<b style="color:var(--text-primary);">${trips.length} trajet(s)</b><ul style="margin-top:6px;">`;
  trips.forEach((t) => {
    const from = findNearestStation(stations, t.start_lat, t.start_lon)?.name ?? "Hors station";
    const to   = findNearestStation(stations, t.end_lat,   t.end_lon)?.name   ?? "Hors station";
    html += `
      <li>
        <span class="time">${formatTime(t.start_time)} → ${formatTime(t.end_time)}</span><br>
        <span style="color:var(--text-secondary)">${from} ➔ ${to}</span>
        <button onclick="${onFocus}(${t.start_lat},${t.start_lon},${t.end_lat},${t.end_lon})"
                style="width:auto;padding:2px 6px;margin-top:3px;">Voir</button>
      </li>`;
  });
  container.innerHTML = html + "</ul>";
}

// --- Group panel ---

export function renderGroupPanel(groupId, members, stations, onFocus) {
  const container = document.getElementById("bikeResults");
  let html = `<b style="color:var(--accent-red);">Groupe #${groupId} — ${members.length} vélos</b><ul style="margin-top:6px;padding:0;">`;
  members.forEach((t) => {
    html += `
      <li>
        🚲 <a href="#" onclick="window.app.searchBike('${t.bike_id}');return false;">${t.bike_id}</a>
        <span style="font-size:10px;color:var(--text-muted);margin-left:4px;">${formatTime(t.end_time)}</span>
        <button onclick="window.app.focusTrip(${t.start_lat},${t.start_lon},${t.end_lat},${t.end_lon})"
                style="float:right;width:auto;padding:0 6px;">👁</button>
      </li>`;
  });
  html += `</ul><button onclick="window.app.resetStyles()" style="width:100%;margin-top:6px;font-size:11px;">✕ Quitter le focus</button>`;
  container.innerHTML = html;
}

// --- Nearby arrivals panel ---

export function renderNearbyPanel(stationName, arrivals, onFocus) {
  const div = document.getElementById("nearbyResults");
  if (arrivals.length === 0) {
    div.innerHTML = `<div style="padding:4px 0;color:var(--text-muted);">📍 <b style="color:var(--text-primary)">${stationName}</b><br>Aucune arrivée récente.</div>`;
    return;
  }

  let html = `<div style="margin-bottom:6px;">📍 <b style="color:var(--text-primary)">${stationName}</b></div><ul style="list-style:none;padding:0;">`;
  arrivals.forEach((t, i) => {
    const timeAgo = Math.round((Date.now() - new Date(t.end_time)) / 60_000);
    const highlight = i === 0 ? `border-left:3px solid var(--accent-red);background:var(--bg-item);` : "";
    html += `
      <li style="padding:5px 6px;margin-bottom:4px;border-radius:5px;${highlight}">
        🚲 <b>${t.bike_id}</b>
        <span style="color:var(--text-muted);font-size:11px;margin-left:4px;">${timeAgo} min</span>
        <a href="#" onclick="${onFocus}(${t.start_lat},${t.start_lon},${t.end_lat},${t.end_lon});return false;"
           style="float:right;">👁</a>
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
    setPlayingState(this.playing);
    if (this.playing) {
      this.interval = setInterval(() => {
        this.slider.value = (parseInt(this.slider.value) + 1) % 1440;
        this.onTick();
      }, 500);
    } else {
      clearInterval(this.interval);
    }
  }

  stop() {
    this.playing = false;
    clearInterval(this.interval);
    setPlayingState(false);
  }
}