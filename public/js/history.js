import { initTheme, toggleTheme, escapeHtml } from './ui.js';
import { getChartColors } from './chartTheme.js';

let activeDays   = 30;
let activeCity   = 'all';
let comparing    = false;
let weekdayMode  = false;
let weatherOn    = false;
let currentData  = [];
let previousData = null; // cache pour redessiner (ex: bascule de thème) sans refetch
let chart        = null;
let weekdayChart = null;

// ── Superposition météo (Montréal — voir project_weather_prediction en
// mémoire : ~99% du volume, une seule estimation "système" reste représentative) ──
const MONTREAL = { lat: 45.5019, lon: -73.5674 };
const weatherCache = new Map(); // "from|to" -> { "YYYY-MM-DD": tempMoy }

async function fetchWeatherRange(fromDate, toDate) {
  const key = `${fromDate}|${toDate}`;
  if (weatherCache.has(key)) return weatherCache.get(key);

  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${MONTREAL.lat}&longitude=${MONTREAL.lon}` +
    `&start_date=${fromDate}&end_date=${toDate}&daily=temperature_2m_mean,precipitation_sum&timezone=America%2FToronto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();

  const byDate = {};
  data.daily.time.forEach((d, i) => {
    byDate[d] = {
      temp:   data.daily.temperature_2m_mean[i],
      precip: data.daily.precipitation_sum[i],
    };
  });
  weatherCache.set(key, byDate);
  return byDate;
}

// Même seuil que l'analyse météo (weather_correlation.py) : un jour "de pluie"
// a plus de 1mm de précipitations, pas juste une trace.
const RAIN_MM = 1;

function toYMD(date) {
  return date.toISOString().split('T')[0];
}

function compareDateRange(days) {
  const now   = new Date();
  const to    = new Date(now - days * 86400000);
  const from  = new Date(now - 2 * days * 86400000);
  return { from: toYMD(from), to: toYMD(to) };
}

async function fetchHistory(params) {
  const q = new URLSearchParams(params).toString();
  return fetch(`/api/history?${q}`).then(r => r.json());
}

async function load() {
  document.getElementById('loader').style.display = 'flex';
  try {
    const [current, previous] = await Promise.all([
      fetchHistory({ days: activeDays, city: activeCity }),
      comparing && activeDays > 0 && !weekdayMode
        ? fetchHistory({ ...compareDateRange(activeDays), city: activeCity })
        : Promise.resolve(null),
    ]);
    currentData  = current;
    previousData = previous;
    if (weekdayMode) {
      renderWeekday(current);
    } else {
      render(current, previous);
    }
  } catch {
    document.getElementById('loader').style.display = 'none';
  }
  loadFleetStats();
}

// ── Classement des vélos + odomètre total (toutes dates, indépendant du
// filtre de période — c'est un cumul "depuis le début", pas une fenêtre) ──

async function loadFleetStats() {
  const el = document.getElementById('fleetStats');
  if (!el) return;
  try {
    const stats = await fetch(`/api/stats?city=${activeCity}`).then(r => r.json());
    renderFleetStats(stats);
  } catch (e) {
    console.error('Fleet stats unavailable:', e);
    el.innerHTML = '';
  }
}

const MEDALS = ['🥇', '🥈', '🥉'];

function renderFleetStats(stats) {
  const listEl = document.getElementById('fleetList');
  const odoEl  = document.getElementById('fleetOdometer');
  if (!listEl || !odoEl) return;

  odoEl.textContent = `${Math.round(stats.total_distance_km).toLocaleString('fr-CA')} km parcourus au total`;

  const maxDist = Math.max(...stats.top_bikes.map(b => b.distance_km), 1);
  const rows = stats.top_bikes.map((b, i) => `
    <li class="fleet-row ${i < 3 ? 'is-top' : ''}">
      <span class="fleet-rank">${MEDALS[i] ?? `#${i + 1}`}</span>
      <span class="fleet-bike">${escapeHtml(b.bike_id)}</span>
      <div class="fleet-bar-wrap"><div class="fleet-bar" style="--w:${(b.distance_km / maxDist * 100).toFixed(0)}%"></div></div>
      <span class="fleet-meta">${b.trips.toLocaleString('fr-CA')} trajets · ${Math.round(b.distance_km).toLocaleString('fr-CA')} km</span>
    </li>`).join('');

  listEl.innerHTML = rows || '<li class="fleet-empty">Aucune donnée.</li>';
}

// ── Collapsible : replié par défaut, état mémorisé par appareil ──
const fleetToggle = document.getElementById('fleetToggle');
const fleetList   = document.getElementById('fleetList');
let fleetOpen = localStorage.getItem('bixi-fleet-open') === '1';

function applyFleetOpen() {
  fleetList.hidden = !fleetOpen;
  fleetToggle.setAttribute('aria-expanded', String(fleetOpen));
  fleetToggle.classList.toggle('open', fleetOpen);
}
applyFleetOpen();
fleetToggle.addEventListener('click', () => {
  fleetOpen = !fleetOpen;
  localStorage.setItem('bixi-fleet-open', fleetOpen ? '1' : '0');
  applyFleetOpen();
});

function rollingAvg(values, window = 7) {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

async function render(data, prevData) {
  const labels  = data.map(d => d.date);
  const counts  = data.map(d => d.count);
  const avgLine = rollingAvg(counts, 7);

  const total = counts.reduce((s, v) => s + v, 0);
  const avg   = data.length ? Math.round(total / data.length) : 0;
  const best  = data.reduce((m, d) => d.count > m.count ? d : m, { count: 0, date: '—' });

  document.getElementById('statTotal').innerHTML = total.toLocaleString('fr-CA');
  document.getElementById('statDays').innerHTML  = data.length.toLocaleString('fr-CA');
  document.getElementById('statBest').innerHTML  =
    `${best.count.toLocaleString('fr-CA')} <span>${best.date}</span>`;

  if (prevData) {
    const prevTotal = prevData.reduce((s, d) => s + d.count, 0);
    const prevAvg   = prevData.length ? Math.round(prevTotal / prevData.length) : 0;
    const delta     = prevAvg > 0 ? Math.round((avg - prevAvg) / prevAvg * 100) : null;
    const sign       = delta > 0 ? '+' : '';
    const trendClass = delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : 'delta-flat';
    document.getElementById('statAvg').innerHTML =
      `${avg.toLocaleString('fr-CA')} <span>/ jour</span>` +
      (delta !== null ? ` <span class="delta-badge ${trendClass}">${sign}${delta}%</span>` : '');
  } else {
    document.getElementById('statAvg').innerHTML = `${avg.toLocaleString('fr-CA')} <span>/ jour</span>`;
  }

  const titleMap = { 30: '30 derniers jours', 90: '90 derniers jours', 0: 'Depuis le début' };
  document.getElementById('titlePeriod').textContent = titleMap[activeDays] ?? `${activeDays} jours`;

  const datasets = [
    {
      type: 'bar',
      label: 'Trajets',
      data: counts,
      backgroundColor: 'rgba(167, 139, 250, 0.45)',
      borderColor:     'rgba(167, 139, 250, 0.8)',
      borderWidth: 1,
      borderRadius: 3,
      order: 2,
    },
    {
      type: 'line',
      label: 'Moy. 7 j.',
      data: avgLine,
      borderColor:     '#a78bfa',
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.4,
      order: 1,
    },
  ];

  if (prevData) {
    const prevCounts  = alignTo(prevData, data.length);
    const prevAvgLine = rollingAvg(prevCounts, 7);
    const prevDates   = prevData.map(d => d.date);

    datasets.push({
      type: 'bar',
      label: 'Période préc.',
      data: prevCounts,
      backgroundColor: 'rgba(100, 181, 246, 0.25)',
      borderColor:     'rgba(100, 181, 246, 0.6)',
      borderWidth: 1,
      borderRadius: 3,
      order: 4,
      prevDates,
    });
    datasets.push({
      type: 'line',
      label: 'Moy. préc.',
      data: prevAvgLine,
      borderColor:     '#64b5f6',
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.4,
      order: 3,
      prevDates,
    });
  }

  // Superposition météo — désactivée si "Comparer" est actif (2 périodes,
  // pas de sens univoque pour une seule courbe de température).
  let showWeatherAxis = false;
  if (weatherOn && !prevData && data.length) {
    try {
      const wx = await fetchWeatherRange(data[0].date, data[data.length - 1].date);
      const precipByDay = labels.map(d => wx[d]?.precip ?? 0);
      datasets.push({
        type: 'line',
        label: 'Température moy. (Montréal)',
        data: labels.map(d => wx[d]?.temp ?? null),
        borderColor: '#ffab40',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [4, 3],
        // Un point visible seulement les jours de pluie -- la ligne reste
        // fine sinon, la pluie ressort d'un coup d'œil sans surcharger le
        // graphique.
        pointRadius: precipByDay.map(p => p >= RAIN_MM ? 4 : 0),
        pointHoverRadius: precipByDay.map(p => p >= RAIN_MM ? 6 : 3),
        pointBackgroundColor: '#29b6f6',
        tension: 0.3,
        spanGaps: true,
        yAxisID: 'temp',
        order: 0,
        isWeather: true,
        precipByDay,
      });
      showWeatherAxis = true;
    } catch (e) {
      console.error('Weather overlay unavailable:', e);
    }
  }

  if (chart) chart.destroy();

  const c = getChartColors();
  chart = new Chart(document.getElementById('historyChart'), {
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: c.textSecondary, font: { size: 11 }, boxWidth: 12 },
        },
        tooltip: {
          backgroundColor: c.tooltipBg,
          titleColor: c.textPrimary,
          bodyColor:  c.textSecondary,
          borderColor: c.border,
          borderWidth: 1,
          callbacks: {
            label: ctx => {
              if (ctx.dataset.isWeather) {
                if (ctx.parsed.y == null) return null;
                const precip = ctx.dataset.precipByDay?.[ctx.dataIndex] ?? 0;
                const rain = precip >= RAIN_MM ? ` · 🌧️ ${precip.toFixed(1)} mm` : '';
                return `${ctx.dataset.label} : ${Math.round(ctx.parsed.y)}°C${rain}`;
              }
              const v = Math.round(ctx.parsed.y).toLocaleString('fr-CA');
              if (ctx.dataset.prevDates) {
                const d = ctx.dataset.prevDates[ctx.dataIndex] ?? '';
                return `${ctx.dataset.label} (${d}) : ${v}`;
              }
              return `${ctx.dataset.label} : ${v}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { color: c.textMuted, font: { size: 10 }, maxTicksLimit: 12, maxRotation: 0 },
          grid:  { color: c.border },
        },
        y: {
          ticks: { color: c.textMuted, font: { size: 10 }, callback: v => v.toLocaleString('fr-CA') },
          grid:  { color: c.border },
          beginAtZero: true,
        },
        ...(showWeatherAxis ? {
          temp: {
            position: 'right',
            ticks: { color: '#ffab40', font: { size: 10 }, callback: v => `${v}°` },
            grid: { drawOnChartArea: false },
          },
        } : {}),
      },
    },
  });

  document.getElementById('loader').style.display = 'none';
}

// Aligne la période précédente sur la même longueur (pad avec 0 si plus courte)
function alignTo(data, length) {
  const counts = data.map(d => d.count);
  while (counts.length < length) counts.unshift(0);
  return counts.slice(-length);
}

// ── Jour de semaine ──

const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

function aggregateByWeekday(data) {
  const sums  = new Array(7).fill(0);
  const cnts  = new Array(7).fill(0);
  for (const d of data) {
    const dow = new Date(d.date + 'T12:00:00').getDay(); // 0=Dim
    const idx = (dow + 6) % 7;                           // 0=Lun
    sums[idx] += d.count;
    cnts[idx]++;
  }
  return sums.map((s, i) => cnts[i] > 0 ? Math.round(s / cnts[i]) : 0);
}

function renderWeekday(data) {
  const avgs = aggregateByWeekday(data);
  const max  = Math.max(...avgs, 1);

  if (weekdayChart) weekdayChart.destroy();
  if (chart) { chart.destroy(); chart = null; }

  const c = getChartColors();
  weekdayChart = new Chart(document.getElementById('historyChart'), {
    type: 'bar',
    data: {
      labels: WEEKDAYS,
      datasets: [{
        label: 'Moy. trajets / jour',
        data: avgs,
        backgroundColor: avgs.map(v => `rgba(167,139,250,${0.3 + 0.6 * v / max})`),
        borderColor: 'rgba(167,139,250,0.85)',
        borderWidth: 1,
        borderRadius: 5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: c.textSecondary, font: { size: 11 }, boxWidth: 12 } },
        tooltip: {
          backgroundColor: c.tooltipBg,
          titleColor: c.textPrimary,
          bodyColor: c.textSecondary,
          borderColor: c.border,
          borderWidth: 1,
          callbacks: { label: ctx => ` ${ctx.raw.toLocaleString('fr-CA')} trajets en moy.` },
        },
      },
      scales: {
        x: { ticks: { color: c.textSecondary, font: { size: 13, weight: '500' } }, grid: { color: c.border } },
        y: {
          ticks: { color: c.textMuted, font: { size: 10 }, callback: v => v.toLocaleString('fr-CA') },
          grid: { color: c.border },
          beginAtZero: true,
        },
      },
    },
  });

  document.getElementById('loader').style.display = 'none';
}

// ── Contrôles période ──
document.querySelectorAll('[data-days]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-days]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeDays = parseInt(btn.dataset.days);
    load();
  });
});

// ── Contrôles ville ──
document.querySelectorAll('[data-city]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-city]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeCity = btn.dataset.city;
    load();
  });
});

// ── Comparer ──
document.getElementById('btnCompare').addEventListener('click', () => {
  comparing = !comparing;
  document.getElementById('btnCompare').classList.toggle('active', comparing);
  // Mutuellement exclusif avec la météo : une seule courbe de température
  // n'a pas de sens univoque face à 2 périodes superposées.
  if (comparing && weatherOn) {
    weatherOn = false;
    document.getElementById('btnWeather').classList.remove('active');
  }
  if (!weekdayMode) load();
});

// ── Météo (superposition température, désactive "Comparer") ──
document.getElementById('btnWeather').addEventListener('click', () => {
  weatherOn = !weatherOn;
  document.getElementById('btnWeather').classList.toggle('active', weatherOn);
  if (weatherOn && comparing) {
    comparing = false;
    document.getElementById('btnCompare').classList.remove('active');
  }
  if (!weekdayMode) load();
});

// ── Par jour de semaine ──
document.getElementById('btnWeekday').addEventListener('click', () => {
  weekdayMode = !weekdayMode;
  document.getElementById('btnWeekday').classList.toggle('active', weekdayMode);
  if (weekdayMode) {
    renderWeekday(currentData);
  } else {
    if (weekdayChart) { weekdayChart.destroy(); weekdayChart = null; }
    load();
  }
});

// ── Thème ──
// Les couleurs Chart.js sont figées au moment du new Chart(...) (lues via
// getComputedStyle) — sans redessiner ici, le graphique garderait les
// couleurs de l'ancien thème jusqu'au prochain load().
let theme = initTheme();
document.getElementById('themeToggle')?.addEventListener('click', () => {
  theme = toggleTheme(theme);
  if (weekdayMode) renderWeekday(currentData);
  else if (currentData.length) render(currentData, previousData);
});

load();
