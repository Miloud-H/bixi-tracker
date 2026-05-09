import { minutesToHHMM, formatTime, tripEndMinutes } from "./trips.js";
import { findNearestStation } from "./geo.js";

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
  const accent = isDark ? "#00e676" : "#2ecc71";
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

// --- Daily chart ---

let dailyChartInstance = null;

export function drawDailyChart(allTrips) {
  const canvas = document.getElementById("dailyChart");
  if (!canvas) return;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const accent = isDark ? "#00e676" : "#2ecc71";
  const textColor = isDark ? "#9aa3b8" : "#555555";
  const gridColor = isDark ? "#2a3348" : "#e8e8e8";

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
  const totalKm = visibleTrips.reduce((sum, t) => sum + t.distance, 0) / 1000;
  document.getElementById("statDist").textContent = totalKm.toFixed(1);
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
    panel.innerHTML = `<div style="color:var(--text-muted);font-size:11px;padding:6px 0;">Aucune donnée pour cette sélection</div>`;
    return;
  }
  const maxCount = top[0][1];
  panel.innerHTML = top.map(([name, count]) => `
    <div class="stat-row">
      <span class="stat-label" title="${name}">${name}</span>
      <div class="stat-bar-wrap"><div class="stat-bar" style="width:${(count / maxCount * 100).toFixed(0)}%"></div></div>
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

// --- Bike search panel ---

export function renderBikePanel(trips, stations, onFocus) {
  const container = document.getElementById("bikeResults");
  if (trips.length === 0) {
    container.innerHTML = `<div style="color:var(--text-muted);padding:8px 0;font-size:12px;">Aucun trajet trouvé pour cet ID.</div>`;
    return;
  }
  let html = `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">${trips.length} trajet(s) sur la période</div><ul>`;
  trips.forEach((t) => {
    const from = findNearestStation(stations, t.start_lat, t.start_lon)?.name ?? "Hors station";
    const to   = findNearestStation(stations, t.end_lat,   t.end_lon)?.name   ?? "Hors station";
    const dist = Math.round(t.distance);
    html += `
      <li>
        <span class="time">${formatTime(t.start_time)} → ${formatTime(t.end_time)}</span>
        <span style="color:var(--text-muted);font-size:10px;margin-left:6px;">${dist} m</span><br>
        <span style="color:var(--text-secondary);font-size:11px;">
          ${from}<br>↓ ${to}
        </span>
        <button onclick="${onFocus}(${t.start_lat},${t.start_lon},${t.end_lat},${t.end_lon})"
                style="width:auto;padding:2px 8px;margin-top:4px;">Voir</button>
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

// --- Nearby panel — refonte complète ---

export function renderNearbyPanel(stationName, arrivals, onFocus) {
  const div = document.getElementById("nearbyResults");

  const header = `
    <div class="nearby-station-header">
      <span class="nearby-station-icon">📍</span>
      <span class="nearby-station-name" title="${stationName}">${stationName}</span>
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
        <span class="nearby-arrival-bike">🚲 ${t.bike_id}</span>
        <span class="nearby-arrival-time">${formatTime(t.end_time)}</span>
        <span class="nearby-arrival-ago">${timeAgoLabel}</span>
        <a href="#" onclick="${onFocus}(${t.start_lat},${t.start_lon},${t.end_lat},${t.end_lon});return false;"
           style="color:var(--accent);text-decoration:none;font-size:14px;">👁</a>
      </li>`;
  }).join("");

  div.innerHTML = header + `<ul class="nearby-arrivals">${items}</ul>`;
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