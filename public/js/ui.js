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

// --- Histogram (canvas behind slider) ---

export function drawHistogram(canvas, allTrips) {
  if (!canvas || allTrips.length === 0) return;
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const ctx = canvas.getContext("2d");
  const W = canvas.offsetWidth || 260;
  const H = canvas.offsetHeight || 36;
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

// --- Daily activity chart (Chart.js) ---

let dailyChartInstance = null;

export function drawDailyChart(allTrips) {
  const canvas = document.getElementById("dailyChart");
  if (!canvas) return;

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const accent = isDark ? "#00e676" : "#2ecc71";
  const textColor = isDark ? "#9aa3b8" : "#555555";
  const gridColor = isDark ? "#2a3348" : "#e8e8e8";

  // Bucket by hour
  const hours = new Array(24).fill(0);
  for (const t of allTrips) {
    const h = Math.floor(tripEndMinutes(t) / 60);
    if (h >= 0 && h < 24) hours[h]++;
  }

  const labels = hours.map((_, i) => `${i}h`);

  if (dailyChartInstance) {
    dailyChartInstance.data.datasets[0].data = hours;
    dailyChartInstance.update();
    return;
  }

  dailyChartInstance = new Chart(canvas, {
    type: "line",
    data: {
      labels,
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
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { label: (ctx) => ` ${ctx.raw} trajets` }
      }},
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

// --- Slider label + track fill ---

export function updateSliderLabel(minutes) {
  document.getElementById("timeLabel").textContent = minutesToHHMM(minutes);
  const slider = document.getElementById("timeSlider");
  slider.style.setProperty("--slider-pct", (minutes / 1439 * 100) + "%");
}

// --- Distance filter label ---

export function updateDistLabel(meters) {
  const el = document.getElementById("distLabel");
  if (!el) return;
  el.textContent = meters === 0 ? "0 m" : meters >= 1000
    ? (meters / 1000).toFixed(1) + " km"
    : meters + " m";
}

// --- Play button state ---

export function setPlayingState(playing) {
  const btn = document.getElementById("togglePlay");
  if (!btn) return;
  btn.textContent = playing ? "⏸ Pause" : "▶ Lecture";
  btn.classList.toggle("playing", playing);
}

// --- Active bikes counter ---

export function updateActiveCount(count) {
  const el = document.getElementById("statActive");
  if (el) el.textContent = count !== null ? count : "–";
}

// --- Stats footer ---

export function updateStats(visibleTrips, allTrips, selectedDate) {
  const pad = (n) => n.toString().padStart(2, "0");
  document.getElementById("statCount").textContent = visibleTrips.length;

  const totalKm = allTrips
    .filter((t) => {
      const d = new Date(t.end_time);
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` === selectedDate;
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
    if (snap) counts[snap.name] = (counts[snap.name] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length === 0) {
    panel.innerHTML = `<div style="color:var(--text-muted);font-size:11px;padding:4px 0;">Aucune donnée</div>`;
    return;
  }
  const maxCount = top[0][1];
  panel.innerHTML = top.map(([name, count]) => `
    <div class="stat-row">
      <span class="stat-label" title="${name}">${name}</span>
      <div class="stat-bar-wrap"><div class="stat-bar" style="width:${(count/maxCount*100).toFixed(0)}%"></div></div>
      <span class="stat-count">${count}</span>
    </div>`).join("");
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
    const hl = i === 0 ? "border-left:3px solid var(--accent-red);background:var(--bg-item);" : "";
    html += `
      <li style="padding:5px 6px;margin-bottom:4px;border-radius:5px;${hl}">
        🚲 <b>${t.bike_id}</b>
        <span style="color:var(--text-muted);font-size:11px;margin-left:4px;">${timeAgo} min</span>
        <a href="#" onclick="${onFocus}(${t.start_lat},${t.start_lon},${t.end_lat},${t.end_lon});return false;" style="float:right;">👁</a>
      </li>`;
  });
  div.innerHTML = html + "</ul>";
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