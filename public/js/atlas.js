import { initTheme, toggleTheme } from './ui.js';
import { createTileSwitcher } from './tiles.js';
import { localToday } from './trips.js';

const zonesRaw = await fetch('/api/zones').then(r => r.json());

const CITY_CONFIG = {
  montreal:   { center: [45.508, -73.587], zoom: 13 },
  sherbrooke: { center: [45.404, -71.893], zoom: 13 },
};

let activeCity = 'montreal';

function buildZones(city) {
  return Object.fromEntries(
    zonesRaw.filter(z => z.city === city).map(z => [z.name, [z.lat, z.lon]])
  );
}

let ZONES = buildZones('montreal');

function zoneColor(name) {
  if (name.startsWith('Sherbrooke')) return '#ff9800';
  if (name.startsWith('Transit'))    return '#00d2ff';
  if (name.startsWith('Edu'))        return '#bb86fc';
  if (name.startsWith('Sante'))      return '#ff5252';
  if (name.startsWith('Loisir'))     return '#ffff00';
  if (name.startsWith('Nuit'))       return '#ff4081';
  if (name.startsWith('Res'))        return '#69f0ae';
  return '#ffffff';
}

function zoneLabel(name) {
  return name.replace(/^Sherbrooke_/, '').replace(/_/g, ' ');
}

const map = L.map('map', { zoomControl: false }).setView([45.508, -73.587], 13);
L.control.zoom({ position: 'bottomright' }).addTo(map);

const setTiles = createTileSwitcher(map);

let allFlows    = [];
let activeLines = [];
let selectedZone = null;
let playing = false;
let playInterval = null;
let markers = {};

// "Pouls navetteur" : déséquilibre net matin/soir par zone, agrégé sur tout
// l'historique (pas un jour en particulier comme le reste de la page) —
// voir GET /api/zones/imbalance. Caché par ville pour éviter un refetch au
// simple aller-retour entre les deux modes.
let imbalanceMode = false;
const imbalanceCache = {}; // city -> [{zone, am_net, pm_net}, ...]

function buildMarkers() {
  Object.values(markers).forEach(m => map.removeLayer(m));
  markers = {};

  for (const [name, latlng] of Object.entries(ZONES)) {
    const m = L.circleMarker(latlng, {
      radius: 5,
      fillColor: zoneColor(name),
      color: '#fff',
      weight: 0,
      fillOpacity: 0.25,
    }).addTo(map);

    m.bindTooltip(zoneLabel(name), { permanent: false, direction: 'top' });

    m.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      selectedZone = selectedZone === name ? null : name;
      render(currentHour());
    });

    markers[name] = m;
  }
}

async function loadImbalance() {
  if (imbalanceCache[activeCity]) return imbalanceCache[activeCity];
  document.getElementById('loader').style.display = 'flex';
  try {
    const res = await fetch(`/api/zones/imbalance?city=${activeCity}`);
    imbalanceCache[activeCity] = await res.json();
  } catch (e) {
    console.error('Failed to load zone imbalance', e);
    imbalanceCache[activeCity] = [];
  }
  document.getElementById('loader').style.display = 'none';
  return imbalanceCache[activeCity];
}

// Rouge = perd des vélos le matin (zones résidentielles) ; bleu = en gagne
// (pôles d'emploi/transit). Rayon = amplitude du déséquilibre, pas le
// volume brut — une zone à am_net≈0 est simplement équilibrée, pas creuse.
function renderImbalance() {
  activeLines.forEach(l => map.removeLayer(l));
  activeLines = [];

  const data = imbalanceCache[activeCity] || [];
  const byZone = Object.fromEntries(data.map(r => [r.zone, r]));
  const maxAbs = Math.max(1, ...data.map(r => Math.abs(r.am_net)));

  for (const [name, marker] of Object.entries(markers)) {
    const r = byZone[name];
    const amNet = r ? r.am_net : 0;
    const t = Math.abs(amNet) / maxAbs; // 0..1
    const color = amNet === 0 ? '#888' : amNet < 0 ? '#ff5252' : '#00d2ff';

    marker.setRadius(4 + Math.sqrt(t) * 16);
    marker.setStyle({
      fillColor:   color,
      fillOpacity: r ? 0.25 + t * 0.6 : 0.1,
      color:       '#fff',
      weight:      r ? 1 : 0,
    });
    if (r) marker.bringToFront();

    marker.setTooltipContent(
      r
        ? `<b>${zoneLabel(name)}</b><br>Matin (6h-10h) : ${amNet > 0 ? '+' : ''}${amNet}<br>Soir (15h-19h) : ${r.pm_net > 0 ? '+' : ''}${r.pm_net}`
        : zoneLabel(name)
    );
  }

  document.getElementById('focusInfo').style.display = 'none';
  document.getElementById('statsDisplay').innerHTML =
    `Déséquilibre net matin/soir · <b>${data.length}</b> zones · tout l'historique disponible`;
}

map.on('click', () => {
  if (selectedZone) { selectedZone = null; render(currentHour()); }
});

const datePicker = document.getElementById('datePicker');
datePicker.value = sessionStorage.getItem('bixi-date') || localToday();

let theme = initTheme();
setTiles(theme);
document.getElementById('themeToggle')?.addEventListener('click', () => {
  theme = toggleTheme(theme);
  setTiles(theme);
});

async function loadFlows() {
  document.getElementById('loader').style.display = 'flex';
  try {
    const res = await fetch(`/api/flows?date=${datePicker.value}&city=${activeCity}`);
    allFlows = await res.json();
  } catch (e) {
    console.error('Failed to load flows', e);
    allFlows = [];
  }
  document.getElementById('loader').style.display = 'none';
  render(currentHour());
}

datePicker.addEventListener('change', () => {
  sessionStorage.setItem('bixi-date', datePicker.value);
  loadFlows();
});

function currentHour() {
  return parseInt(document.getElementById('hourSlider').value);
}

function render(hour) {
  if (imbalanceMode) { renderImbalance(); return; }

  for (const [name, marker] of Object.entries(markers)) {
    marker.setTooltipContent(zoneLabel(name));
  }

  activeLines.forEach(l => map.removeLayer(l));
  activeLines = [];

  const hourFlows = allFlows.filter(f => f.hour === hour);
  const zoneVol = {};

  hourFlows.forEach(f => {
    zoneVol[f.origin]      = (zoneVol[f.origin]      || 0) + f.count;
    zoneVol[f.destination] = (zoneVol[f.destination] || 0) + f.count;
  });

  let totalTransfers = 0;

  hourFlows.forEach(f => {
    if (!ZONES[f.origin] || !ZONES[f.destination]) return;

    const isIncoming = f.destination === selectedZone;
    const isOutgoing = f.origin      === selectedZone;

    if (selectedZone && !isIncoming && !isOutgoing) return;

    const speedKmh = f.avg_duration_min > 0
      ? (f.avg_distance / 1000) / (f.avg_duration_min / 60)
      : 0;

    let color;
    if (selectedZone) {
      color = isIncoming ? '#00e676' : '#ff1744';
    } else {
      color = speedKmh < 10 ? '#ff3333' : '#00d2ff';
    }

    const weight = Math.max(1, Math.sqrt(f.count) * 0.8);

    const line = L.polyline([ZONES[f.origin], ZONES[f.destination]], {
      color,
      weight,
      opacity: selectedZone ? 0.85 : 0.5,
      lineCap: 'round',
      className: 'flow-line',
    }).addTo(map);

    line.bindTooltip(
      `<b>${zoneLabel(f.origin)}</b> → <b>${zoneLabel(f.destination)}</b><br>` +
      `${f.count} trajet${f.count > 1 ? 's' : ''} · ` +
      `${Math.round(f.avg_distance)}m · ` +
      `${speedKmh.toFixed(1)} km/h`,
      { sticky: true, className: 'atlas-tooltip' }
    );

    activeLines.push(line);
    totalTransfers += f.count;
  });

  for (const [name, marker] of Object.entries(markers)) {
    const vol = zoneVol[name] || 0;
    const color = zoneColor(name);
    const isSelected = name === selectedZone;
    const dimmed = selectedZone && !isSelected && vol === 0;

    marker.setRadius(vol > 0 ? 5 + Math.sqrt(vol) * 1.2 : 4);
    marker.setStyle({
      fillColor:   isSelected ? '#fff' : color,
      fillOpacity: dimmed ? 0.08 : isSelected ? 1 : vol > 0 ? 0.85 : 0.2,
      color:       isSelected ? '#fff' : vol > 0 ? '#fff' : 'transparent',
      weight:      isSelected ? 2 : vol > 0 ? 1 : 0,
    });
    if (vol > 0) marker.bringToFront();
  }

  document.getElementById('hourDisplay').textContent =
    hour.toString().padStart(2, '0') + ':00';

  const focusInfo = document.getElementById('focusInfo');
  if (selectedZone) {
    const incoming = hourFlows.filter(f => f.destination === selectedZone).reduce((s, f) => s + f.count, 0);
    const outgoing = hourFlows.filter(f => f.origin      === selectedZone).reduce((s, f) => s + f.count, 0);
    focusInfo.style.display = 'block';
    focusInfo.innerHTML = `<b>${zoneLabel(selectedZone)}</b> — ↓ ${incoming} arrivées · ↑ ${outgoing} départs · Cliquer la carte pour quitter`;
  } else {
    focusInfo.style.display = 'none';
  }

  document.getElementById('statsDisplay').innerHTML = selectedZone
    ? `Focus sur <b class="stat-focus-name">${zoneLabel(selectedZone)}</b>`
    : `<b>${totalTransfers}</b> trajets entre zones · ${hourFlows.length} connexions actives`;

  const slider = document.getElementById('hourSlider');
  slider.style.setProperty('--pct', ((hour / 23) * 100) + '%');
}

document.getElementById('hourSlider').addEventListener('input', (e) => {
  render(parseInt(e.target.value));
});

document.getElementById('btnPlay').addEventListener('click', () => {
  playing = !playing;
  const btn = document.getElementById('btnPlay');
  if (playing) {
    btn.textContent = '⏸ Pause';
    btn.classList.add('active');
    playInterval = setInterval(() => {
      const s = document.getElementById('hourSlider');
      s.value = (parseInt(s.value) + 1) % 24;
      render(parseInt(s.value));
    }, 800);
  } else {
    btn.textContent = '▶ Lecture';
    btn.classList.remove('active');
    clearInterval(playInterval);
  }
});

document.getElementById('btnReset').addEventListener('click', () => {
  selectedZone = null;
  render(currentHour());
});

document.getElementById('legendToggle').addEventListener('click', () => {
  document.getElementById('legend').classList.toggle('open');
});

document.querySelectorAll('[data-city]').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-city]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeCity = btn.dataset.city;
    ZONES = buildZones(activeCity);
    selectedZone = null;
    buildMarkers();
    const cfg = CITY_CONFIG[activeCity];
    map.flyTo(cfg.center, cfg.zoom, { duration: 0.8 });
    if (imbalanceMode) { await loadImbalance(); renderImbalance(); }
    else loadFlows();
  });
});

// "Pouls navetteur" désactive les contrôles par jour/heure (sans objet ici —
// la vue agrège tout l'historique) plutôt que de laisser des sliders morts.
document.getElementById('btnImbalance').addEventListener('click', async () => {
  imbalanceMode = !imbalanceMode;
  const btn = document.getElementById('btnImbalance');
  btn.classList.toggle('active', imbalanceMode);
  document.querySelector('.panel-time').style.display = imbalanceMode ? 'none' : '';
  document.getElementById('hourSlider').style.display  = imbalanceMode ? 'none' : '';
  document.getElementById('datePicker').style.display  = imbalanceMode ? 'none' : '';
  document.getElementById('btnPlay').style.display     = imbalanceMode ? 'none' : '';

  if (imbalanceMode) {
    await loadImbalance();
    renderImbalance();
  } else {
    render(currentHour());
  }
});

buildMarkers();
loadFlows();
