const CITIES = {
  montreal:   { center: [45.5088, -73.5878], zoom: 13, filter: p => p.lon < -72.5 },
  sherbrooke: { center: [45.4042, -71.8929], zoom: 13, filter: p => p.lon >= -72.5 },
};

const map = L.map('map', { zoomControl: false }).setView(CITIES.montreal.center, CITIES.montreal.zoom);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  maxZoom: 18,
}).addTo(map);

let allPoints  = [];
let heatLayer  = null;
let activeCity = 'montreal';
let weekMode   = false;
let playInterval = null;

const slider = document.getElementById('hourSlider');

function updateSliderBg() {
  slider.style.setProperty('--pct', (slider.value / 23) * 100 + '%');
}

function render() {
  const hour = parseInt(slider.value);
  document.getElementById('hourDisplay').textContent = hour.toString().padStart(2, '0');

  const cityFilter = CITIES[activeCity].filter;
  const pts = allPoints.filter(p => p.hour === hour && cityFilter(p));

  if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }

  if (pts.length === 0) {
    document.getElementById('statsDisplay').innerHTML =
      weekMode ? `Aucun départ à <b>${hour}h</b> (7 jours)` : `Aucun départ à <b>${hour}h</b>`;
    return;
  }

  const maxVol = Math.max(...pts.map(p => p.volume), 1);
  heatLayer = L.heatLayer(
    pts.map(p => [p.lat, p.lon, p.volume / maxVol]),
    {
      radius: 22,
      blur: 16,
      maxZoom: 15,
      max: 1.0,
      gradient: { 0.2: '#0000ff', 0.4: '#00ffff', 0.6: '#00ff00', 0.8: '#ffff00', 1.0: '#ff0000' },
    }
  ).addTo(map);

  const total = pts.reduce((s, p) => s + p.volume, 0);
  document.getElementById('statsDisplay').innerHTML = weekMode
    ? `<b>${total}</b> départs à <b>${hour}h</b> sur 7 jours — <b>${pts.length}</b> zones`
    : `<b>${total}</b> départs à <b>${hour}h</b> — <b>${pts.length}</b> zones actives`;
}

async function loadData(date) {
  document.getElementById('loader').style.display = 'flex';
  try {
    const url = weekMode
      ? `/api/heatmap?date=${date}&week=1`
      : `/api/heatmap?date=${date}`;
    allPoints = await fetch(url).then(r => r.json());
    render();
  } catch {
    document.getElementById('statsDisplay').textContent = 'Erreur de chargement';
  } finally {
    document.getElementById('loader').style.display = 'none';
  }
}

const datePicker = document.getElementById('datePicker');
const today = new Date().toLocaleDateString('fr-CA');
datePicker.value = sessionStorage.getItem('bixi-date') || today;
datePicker.addEventListener('change', () => {
  sessionStorage.setItem('bixi-date', datePicker.value);
  loadData(datePicker.value);
});

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = t === 'dark' ? '☀ Clair' : '🌙 Sombre';
}
applyTheme(localStorage.getItem('bixi-theme') || 'light');
document.getElementById('themeToggle')?.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('bixi-theme', next);
  applyTheme(next);
});

slider.addEventListener('input', () => { updateSliderBg(); render(); });
updateSliderBg();

document.querySelectorAll('.city-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.city-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeCity = btn.dataset.city;
    const city = CITIES[activeCity];
    map.flyTo(city.center, city.zoom, { duration: 0.8 });
    render();
  });
});

const btnWeek = document.getElementById('btnWeek');
btnWeek.addEventListener('click', () => {
  weekMode = !weekMode;
  btnWeek.classList.toggle('active', weekMode);
  btnWeek.textContent = weekMode ? '📅 Jour' : '📅 Semaine';
  loadData(datePicker.value);
});

const btnPlay = document.getElementById('btnPlay');
btnPlay.addEventListener('click', () => {
  if (playInterval) {
    clearInterval(playInterval);
    playInterval = null;
    btnPlay.textContent = '▶ Lecture';
    btnPlay.classList.remove('playing');
  } else {
    btnPlay.textContent = '⏸ Pause';
    btnPlay.classList.add('playing');
    playInterval = setInterval(() => {
      slider.value = (parseInt(slider.value) + 1) % 24;
      updateSliderBg();
      render();
    }, 800);
  }
});

document.getElementById('legendToggle').addEventListener('click', () => {
  document.getElementById('legend').classList.toggle('open');
});

loadData(today);
