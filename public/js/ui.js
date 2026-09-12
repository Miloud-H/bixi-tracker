import { minutesToHHMM, formatTime, tripEndMinutes } from "./trips.js";
import { findNearestStation } from "./geo.js";
import { getChartColors } from "./chartTheme.js";

// --- HTML escaping ---
// bike_id / station names come from BIXI's GBFS feed, not from our own code —
// external data, even if not directly user-supplied. Never trust it verbatim
// inside innerHTML (a station name containing e.g. "<img onerror=...>" would
// otherwise execute).
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

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
  const ctx = canvas.getContext("2d");
  const W = canvas.offsetWidth || 260;
  const H = canvas.offsetHeight || 32;
  canvas.width  = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const buckets = new Array(48).fill(0);
  for (const t of allTrips) {
    const slot = Math.min(Math.floor(tripEndMinutes(t) / 30), 47);
    buckets[slot]++;
  }
  const max = Math.max(...buckets, 1);
  const accent = getChartColors().accent;
  const slotW = W / 48;

  ctx.clearRect(0, 0, W, H);
  buckets.forEach((count, i) => {
    const barH = (count / max) * H;
    const grad = ctx.createLinearGradient(0, H - barH, 0, H);
    grad.addColorStop(0, accent + "cc");
    grad.addColorStop(1, accent + "22");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(i * slotW + 1, H - barH, slotW - 2, barH, 2);
    ctx.fill();
  });
}

// --- Station hour chart ---

export function drawStationHourChart(canvas, byHour) {
  if (!canvas) return;
  const colors = getChartColors();
  const ctx = canvas.getContext("2d");
  const W = canvas.offsetWidth || 240;
  const H = 52;
  canvas.width  = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const max = Math.max(...byHour, 1);
  const barW = W / 24;
  const accent = colors.accent;

  ctx.clearRect(0, 0, W, H);
  byHour.forEach((count, i) => {
    if (count === 0) return;
    const barH = Math.max(2, (count / max) * (H - 14));
    const grad = ctx.createLinearGradient(0, H - barH - 14, 0, H - 14);
    grad.addColorStop(0, accent + "dd");
    grad.addColorStop(1, accent + "33");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(i * barW + 1, H - 14 - barH, barW - 2, barH, 2);
    ctx.fill();
  });

  // Heure labels every 6h
  ctx.fillStyle = colors.textMuted;
  ctx.font = `${9 * devicePixelRatio / devicePixelRatio}px DM Mono, monospace`;
  ctx.textAlign = "center";
  [0, 6, 12, 18, 23].forEach(h => {
    ctx.fillText(h + "h", (h + 0.5) * barW, H - 2);
  });
}

// --- Daily chart ---

let dailyChartInstance = null;

export function drawDailyChart(allTrips) {
  const canvas = document.getElementById("dailyChart");
  if (!canvas) return;
  const colors = getChartColors();
  const accent = colors.accent;
  const textColor = colors.textSecondary;
  const gridColor = colors.border;

  const hours = new Array(24).fill(0);
  for (const t of allTrips) {
    const h = Math.floor(tripEndMinutes(t) / 60);
    if (h >= 0 && h < 24) hours[h]++;
  }

  if (dailyChartInstance) {
    dailyChartInstance.data.datasets[0].data = hours;
    dailyChartInstance.update();
    return;
  }

  dailyChartInstance = new Chart(canvas, {
    type: "line",
    data: {
      labels: hours.map((_, i) => `${i}h`),
      datasets: [{
        data: hours,
        borderColor: accent,
        backgroundColor: accent + "22",
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.raw} trajets` } },
      },
      scales: {
        x: { ticks: { color: textColor, font: { size: 9 }, maxTicksLimit: 8 }, grid: { color: gridColor } },
        y: { ticks: { color: textColor, font: { size: 9 } }, grid: { color: gridColor }, beginAtZero: true },
      },
    },
  });
}

export function destroyDailyChart() {
  if (dailyChartInstance) { dailyChartInstance.destroy(); dailyChartInstance = null; }
}

// --- Duration distribution chart ---

let durationChartInstance = null;

export function drawDurationChart(canvas, allTrips) {
  if (!canvas) return;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  // Violet distinct de l'accent vert/rouge habituel (var(--accent)) — un choix
  // délibéré pour ce graphique en particulier, pas un token de theme.css.
  const accent = isDark ? "#a78bfa" : "#7c3aed";
  const colors = getChartColors();
  const textColor = colors.textSecondary;
  const gridColor = colors.border;

  const bins   = [0, 0, 0, 0, 0, 0, 0, 0];
  const labels = ["<5m", "5-10", "10-15", "15-20", "20-30", "30-45", "45-60", "60+"];

  for (const t of allTrips) {
    const dur = (new Date(t.end_time) - new Date(t.start_time)) / 60000;
    if      (dur <  5)  bins[0]++;
    else if (dur < 10)  bins[1]++;
    else if (dur < 15)  bins[2]++;
    else if (dur < 20)  bins[3]++;
    else if (dur < 30)  bins[4]++;
    else if (dur < 45)  bins[5]++;
    else if (dur < 60)  bins[6]++;
    else                bins[7]++;
  }

  if (durationChartInstance) {
    durationChartInstance.data.datasets[0].data = bins;
    durationChartInstance.data.datasets[0].backgroundColor = accent + "88";
    durationChartInstance.data.datasets[0].borderColor = accent;
    durationChartInstance.update();
    return;
  }

  durationChartInstance = new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data: bins,
        backgroundColor: accent + "88",
        borderColor: accent,
        borderWidth: 1,
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.raw} trajet${ctx.raw !== 1 ? "s" : ""}` } },
      },
      scales: {
        x: { ticks: { color: textColor, font: { size: 9 } }, grid: { color: gridColor } },
        y: { ticks: { color: textColor, font: { size: 9 } }, grid: { color: gridColor }, beginAtZero: true },
      },
    },
  });
}

export function destroyDurationChart() {
  if (durationChartInstance) { durationChartInstance.destroy(); durationChartInstance = null; }
}

// --- Slider ---

export function updateSliderLabel(minutes) {
  document.getElementById("timeLabel").textContent = minutesToHHMM(minutes);
  const slider = document.getElementById("timeSlider");
  slider.style.setProperty("--slider-pct", (minutes / 1439 * 100) + "%");
}

export function updateTripCountInline(count) {
  const el = document.getElementById("tripCountInline");
  if (el) el.textContent = count === 1 ? "1 trajet" : `${count} trajets`;
}

// Grise le slider + histogramme quand "Toute la journée" est coché
export function setSliderDisabled(disabled) {
  const wrapper = document.querySelector(".slider-wrapper");
  const timeDisplay = document.querySelector(".time-display");
  if (wrapper) wrapper.classList.toggle("slider-disabled", disabled);
  if (timeDisplay) timeDisplay.classList.toggle("slider-disabled", disabled);
}

// --- Distance ---

export function updateDistLabel(meters) {
  const el = document.getElementById("distLabel");
  if (!el) return;
  el.textContent = meters === 0 ? "0 m"
    : meters >= 1000 ? (meters / 1000).toFixed(1) + " km"
    : meters + " m";
}

// --- Play button ---

export function setPlayingState(playing) {
  const btn = document.getElementById("togglePlay");
  if (!btn) return;
  btn.textContent = playing ? "⏸ Pause" : "▶ Lecture";
  btn.classList.toggle("playing", playing);
}

// --- Active count ---

export function updateActiveCount(count) {
  const el = document.getElementById("statActive");
  if (el) el.textContent = count !== null ? count : "–";
}

// --- Stats bar ---

export function updateStats(visibleTrips, dayTotal = null) {
  document.getElementById("statCount").textContent = visibleTrips.length;
  const uniqueGroups = new Set(
    visibleTrips.filter((t) => t.group_id !== null).map((t) => t.group_id)
  );
  document.getElementById("groupCount").textContent = uniqueGroups.size;
  const dayTotalEl = document.getElementById("statDayTotal");
  if (dayTotalEl) dayTotalEl.textContent = dayTotal !== null ? dayTotal.toLocaleString() : "–";
}

// --- Top stations ---

export function updateTopStations(trips, stations) {
  const panel = document.getElementById("statsPanel");
  if (!panel) return;
  const counts = {};
  for (const t of trips) {
    const snap = findNearestStation(stations, t.end_lat, t.end_lon, 120);
    if (snap) counts[snap.name] = (counts[snap.name] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length === 0) {
    panel.innerHTML = `<div class="panel-hint">Aucune donnée pour cette sélection</div>`;
    return;
  }
  const maxCount = top[0][1];
  panel.innerHTML = top.map(([name, count]) => `
    <div class="stat-row">
      <span class="stat-label" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      <div class="stat-bar-wrap"><div class="stat-bar" style="--w:${(count / maxCount * 100).toFixed(0)}%"></div></div>
      <span class="stat-count">${count}</span>
    </div>`).join("");
}

// --- Alert ---

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

// --- Bike search panel + Group panel ---
// Les deux partagent #bikeResults ; les items cliquables portent juste
// data-action/data-index, un seul listener délégué gère les deux (le
// contenu est régénéré via innerHTML donc rien à réattacher par item).

let _bikePanelTrips = [];   // dernier trips[] passé à renderBikePanel
let _groupPanelTrips = [];  // dernier members[] passé à renderGroupPanel

export function renderBikePanel(trips, stations) {
  const container = document.getElementById("bikeResults");
  _bikePanelTrips = trips;
  if (trips.length === 0) {
    container.innerHTML = `<div class="panel-empty">Aucun trajet trouvé pour cet ID.</div>`;
    return;
  }
  let html = `<div class="panel-meta">${trips.length} trajet(s) sur la période</div><ul>`;
  trips.forEach((t, i) => {
    const from = findNearestStation(stations, t.start_lat, t.start_lon)?.name ?? "Hors station";
    const to   = findNearestStation(stations, t.end_lat,   t.end_lon)?.name   ?? "Hors station";
    const dist = Math.round(t.distance);
    html += `
      <li>
        <span class="time">${formatTime(t.start_time)} → ${formatTime(t.end_time)}</span>
        <span class="trip-dist">${dist} m</span><br>
        <span class="trip-stations">
          ${escapeHtml(from)}<br>↓ ${escapeHtml(to)}
        </span>
        <button class="btn-voir" data-action="focus-bike-trip" data-index="${i}">Voir</button>
      </li>`;
  });
  container.innerHTML = html + "</ul>";
}

// --- Group panel ---

export function renderGroupPanel(groupId, members) {
  const container = document.getElementById("bikeResults");
  _groupPanelTrips = members;
  let html = `<b class="group-title">Groupe #${groupId} — ${members.length} vélos</b><ul class="group-list">`;
  members.forEach((t, i) => {
    html += `
      <li>
        🚲 <a href="#" data-action="search-bike" data-bike-id="${escapeHtml(t.bike_id)}">${escapeHtml(t.bike_id)}</a>
        <span class="group-time-inline">${formatTime(t.end_time)}</span>
        <button class="btn-eye-float" data-action="focus-group-trip" data-index="${i}">👁</button>
      </li>`;
  });
  html += `</ul><button class="btn-exit-focus" data-action="reset-styles">✕ Quitter le focus</button>`;
  container.innerHTML = html;
}

document.getElementById("bikeResults")?.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  if (action === "focus-bike-trip") {
    const t = _bikePanelTrips[Number(el.dataset.index)];
    if (t) window.app.focusTrip(t.start_lat, t.start_lon, t.end_lat, t.end_lon);
  } else if (action === "focus-group-trip") {
    const t = _groupPanelTrips[Number(el.dataset.index)];
    if (t) window.app.focusTrip(t.start_lat, t.start_lon, t.end_lat, t.end_lon);
  } else if (action === "search-bike") {
    e.preventDefault();
    window.app.searchBike(el.dataset.bikeId);
  } else if (action === "reset-styles") {
    window.app.resetStyles();
  }
});

// --- Nearby panel — refonte complète ---

let _nearbyArrivals = []; // dernier arrivals[] passé à renderNearbyPanel

export function renderNearbyPanel(stationName, arrivals) {
  const div = document.getElementById("nearbyResults");
  _nearbyArrivals = arrivals;

  const header = `
    <div class="nearby-station-header">
      <span class="nearby-station-icon">📍</span>
      <span class="nearby-station-name" title="${escapeHtml(stationName)}">${escapeHtml(stationName)}</span>
    </div>`;

  if (arrivals.length === 0) {
    div.innerHTML = header + `<div class="nearby-empty">Aucune arrivée récente à cette station.</div>`;
    return;
  }

  const items = arrivals.map((t, i) => {
    const timeAgo = Math.round((Date.now() - new Date(t.end_time)) / 60_000);
    const isLatest = i === 0;
    const timeAgoLabel = timeAgo === 0 ? "à l'instant" : `il y a ${timeAgo} min`;
    return `
      <li class="nearby-arrival-item ${isLatest ? "is-latest" : ""}">
        <span class="nearby-arrival-bike">🚲 ${escapeHtml(t.bike_id)}</span>
        <span class="nearby-arrival-time">${formatTime(t.end_time)}</span>
        <span class="nearby-arrival-ago">${timeAgoLabel}</span>
        <a href="#" class="nearby-eye-link" data-action="focus-arrival" data-index="${i}">👁</a>
      </li>`;
  }).join("");

  div.innerHTML = header + `<ul class="nearby-arrivals">${items}</ul>`;
}

document.getElementById("nearbyResults")?.addEventListener("click", (e) => {
  const el = e.target.closest('[data-action="focus-arrival"]');
  if (!el) return;
  e.preventDefault();
  const t = _nearbyArrivals[Number(el.dataset.index)];
  if (t) window.app.focusTrip(t.start_lat, t.start_lon, t.end_lat, t.end_lon);
});

// --- Nearby departures panel ---

export function renderDeparturesPanel(stationName, departures) {
  const div = document.getElementById("departureResults");

  const header = `
    <div class="nearby-station-header">
      <span class="nearby-station-icon">🚴</span>
      <span class="nearby-station-name" title="${escapeHtml(stationName)}">${escapeHtml(stationName)}</span>
    </div>`;

  if (departures.length === 0) {
    div.innerHTML = header + `<div class="nearby-empty">Aucun départ récent détecté.</div>`;
    return;
  }

  const items = departures.map((d, i) => {
    const mins  = Math.round(d.elapsed_secs / 60);
    const label = mins === 0 ? "à l'instant" : `il y a ${mins} min`;
    return `
      <li class="nearby-arrival-item ${i === 0 ? "is-latest" : ""}">
        <span class="nearby-arrival-bike">🚲 ${escapeHtml(d.bike_id)}</span>
        <span class="nearby-arrival-ago">${label}</span>
        <button class="watch-btn" data-action="watch-bike" data-bike-id="${escapeHtml(d.bike_id)}">Suivre</button>
      </li>`;
  }).join("");

  div.innerHTML = header + `<ul class="nearby-arrivals">${items}</ul>`;
}

document.getElementById("departureResults")?.addEventListener("click", (e) => {
  const el = e.target.closest('[data-action="watch-bike"]');
  if (!el) return;
  window.app.watchBike(el.dataset.bikeId);
});

// --- Vélos "en fuite" (proches du timeout in-flight, voir /api/bikes/overdue) ---
// Repliable comme le classement des vélos sur History : replié par défaut
// (localStorage), pour ne pas monopoliser la sidebar dès qu'il y a 4-5 vélos.

let overdueOpen = localStorage.getItem("bixi-overdue-open") === "1";

function applyOverdueOpen() {
  const toggle = document.getElementById("overdueToggle");
  const list = document.getElementById("overdueResults");
  if (!toggle || !list) return;
  toggle.classList.toggle("open", overdueOpen);
  toggle.setAttribute("aria-expanded", String(overdueOpen));
  list.hidden = !overdueOpen;
}

export function renderOverdueBikes(bikes) {
  const section = document.getElementById("overdueSection");
  const div = document.getElementById("overdueResults");
  const count = document.getElementById("overdueCount");
  if (!section || !div || !count) return;

  if (!bikes || bikes.length === 0) {
    section.style.display = "none";
    div.innerHTML = "";
    return;
  }
  section.style.display = "";
  count.textContent = bikes.length;

  const items = bikes.map((b) => `
    <li class="nearby-arrival-item">
      <span class="nearby-arrival-bike">🚲 ${escapeHtml(b.bike_id)}</span>
      <span class="nearby-arrival-ago">${b.elapsed_minutes} min</span>
      <a href="#" class="nearby-eye-link" data-action="focus-overdue" data-lat="${b.dep_lat}" data-lon="${b.dep_lon}">👁</a>
    </li>`).join("");

  div.innerHTML = `<ul class="nearby-arrivals">${items}</ul>`;
  applyOverdueOpen();
}

document.getElementById("overdueToggle")?.addEventListener("click", () => {
  overdueOpen = !overdueOpen;
  localStorage.setItem("bixi-overdue-open", overdueOpen ? "1" : "0");
  applyOverdueOpen();
});

document.getElementById("overdueResults")?.addEventListener("click", (e) => {
  const el = e.target.closest('[data-action="focus-overdue"]');
  if (!el) return;
  e.preventDefault();
  window.app.focusOverdue(parseFloat(el.dataset.lat), parseFloat(el.dataset.lon));
});

// --- Watch status indicator ---

export function renderWatchStatus(bikeIds) {
  const el = document.getElementById("watchStatus");
  if (!bikeIds || bikeIds.length === 0) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = bikeIds.map((id) => `
    <div class="watch-active">
      ⏱ Suivi&nbsp;<b>${escapeHtml(id)}</b>
      <button class="watch-stop" data-action="stop-watch" data-bike-id="${escapeHtml(id)}">✕</button>
    </div>`).join("");
}

document.getElementById("watchStatus")?.addEventListener("click", (e) => {
  const el = e.target.closest('[data-action="stop-watch"]');
  if (!el) return;
  window.app.stopWatch(el.dataset.bikeId);
});

// --- Watch history (local, per-device) ---

export function renderWatchHistory(entries) {
  const div = document.getElementById("watchHistoryResults");
  if (!div) return;

  const header = `
    <div class="nearby-station-header">
      <span class="nearby-station-icon">📜</span>
      <span class="nearby-station-name">Vélos suivis récemment</span>
      <button class="watch-stop" data-action="clear-watch-history" title="Vider l'historique">🗑</button>
    </div>`;

  if (!entries || entries.length === 0) {
    div.innerHTML = header + `<div class="nearby-empty">Aucun vélo suivi n'est encore arrivé (les suivis en cours apparaissent en haut, en "⏱ Suivi").</div>`;
    return;
  }

  const items = entries.map((e) => {
    const dep = e.departedAt ? formatTime(e.departedAt) : "?";
    const arr = formatTime(e.arrivedAt);
    const durMin = e.departedAt
      ? Math.max(0, Math.round((new Date(e.arrivedAt) - new Date(e.departedAt)) / 60_000))
      : null;
    const details = [
      durMin !== null ? `${durMin} min` : null,
      e.distanceM !== null ? `${e.distanceM} m` : null,
    ].filter(Boolean).join(" · ");

    return `
      <li class="nearby-arrival-item">
        <span class="nearby-arrival-bike">🚲 ${escapeHtml(e.bikeId)}</span>
        <span class="nearby-arrival-time">${dep} → ${arr}</span>
        <span class="nearby-arrival-ago">${details}</span>
      </li>`;
  }).join("");

  div.innerHTML = header + `<ul class="nearby-arrivals">${items}</ul>`;
}

document.getElementById("watchHistoryResults")?.addEventListener("click", (e) => {
  if (e.target.closest('[data-action="clear-watch-history"]')) window.app.clearWatchHistory();
});

// --- Prévision météo (estimation de trajets) ---

export function renderRidingForecast(days) {
  const div = document.getElementById("forecastPanel");
  if (!div) return;

  if (!days || days.length === 0) {
    div.innerHTML = `<div class="nearby-empty">Prévision indisponible.</div>`;
    return;
  }

  const labels = ["Aujourd'hui", "Demain"];
  const items = days.slice(0, 2).map((d, i) => `
    <div class="forecast-line" title="${d.text}">
      <strong>${labels[i] || d.day}</strong>
      ${d.emoji} ${Math.round(d.tempMean)}°C · ${d.precipSum >= 0.5 ? Math.round(d.precipSum) + " mm" : "sec"} · ≈${d.predicted.toLocaleString("fr-CA")} trajets
    </div>`).join("");

  div.innerHTML = items;
}

// --- Timeline player ---

export class TimelinePlayer {
  constructor(sliderId, onTick) {
    this.slider   = document.getElementById(sliderId);
    this.onTick   = onTick;
    this.playing  = false;
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