const zonesRaw = await fetch('/api/zones').then(r => r.json());
const ZONES = Object.fromEntries(zonesRaw.map(z => [z.name, [z.lat, z.lon]]));

function zoneColor(name) {
  if (name.startsWith('Transit'))  return '#00d2ff';
  if (name.startsWith('Edu'))      return '#bb86fc';
  if (name.startsWith('Res'))      return '#69f0ae';
  if (name.startsWith('Comm') || name.startsWith('Affaires')) return '#ffd740';
  if (name.startsWith('Nuit'))     return '#ff4081';
  if (name.startsWith('Sante'))    return '#ff5252';
  if (name.startsWith('Loisir'))   return '#ffff00';
  return '#ffffff';
}

function zoneLabel(name) {
  return name.replace(/_/g, ' ');
}

const map = L.map('map', { zoomControl: false }).setView([45.508, -73.587], 13);
L.control.zoom({ position: 'bottomright' }).addTo(map);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO',
}).addTo(map);

let allFlows    = [];
let activeLines = [];
let selectedZone = null;
let playing = false;
let playInterval = null;
const markers = {};

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

map.on('click', () => {
  if (selectedZone) { selectedZone = null; render(currentHour()); }
});

const datePicker = document.getElementById('datePicker');
const now = new Date();
const offset = now.getTimezoneOffset() * 60000;
datePicker.value = new Date(now.getTime() - offset).toISOString().split('T')[0];

async function loadFlows() {
  document.getElementById('loader').style.display = 'flex';
  try {
    const res = await fetch(`/api/flows?date=${datePicker.value}`);
    allFlows = await res.json();
  } catch (e) {
    console.error('Failed to load flows', e);
    allFlows = [];
  }
  document.getElementById('loader').style.display = 'none';
  render(currentHour());
}

datePicker.addEventListener('change', loadFlows);

function currentHour() {
  return parseInt(document.getElementById('hourSlider').value);
}

function render(hour) {
  activeLines.forEach(l => map.removeLayer(l));
  activeLines = [];

  const hourFlows = allFlows.filter(f => f.hour === hour);
  const zoneVol = {};

  hourFlows.forEach(f => {
    zoneVol[f.origin]      = (zoneVol[f.origin]      || 0) + f.count;
    zoneVol[f.destination] = (zoneVol[f.destination] || 0) + f.count;
  });

  const maxVol = Math.max(...Object.values(zoneVol), 1);
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
    ? `Focus sur <b style="color:#fff">${zoneLabel(selectedZone)}</b>`
    : `<b style="color:#9aa3b8">${totalTransfers}</b> trajets entre zones · ${hourFlows.length} connexions actives`;

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

loadFlows();
