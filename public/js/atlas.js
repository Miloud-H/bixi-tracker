const ZONES = {
  Transit_Gare_Centrale:    [45.5000, -73.5665],
  Transit_Gare_Lucien_Lallier: [45.4950, -73.5710],
  Transit_Gare_Parc:        [45.5315, -73.6235],
  Transit_Berri_UQAM:       [45.5155, -73.5610],
  Transit_Vendome:          [45.4740, -73.6035],
  Transit_Snowdon:          [45.4855, -73.6275],
  Transit_Jean_Talon_Metro: [45.5390, -73.6135],
  Transit_Lionel_Groulx:    [45.4825, -73.5795],
  Edu_UdeM_Poly:            [45.5044, -73.6130],
  Edu_McGill:               [45.5042, -73.5760],
  Edu_Concordia_Guy:        [45.4955, -73.5780],
  Edu_UQAM_Design:          [45.5135, -73.5685],
  Edu_HEC_Mtl:              [45.5035, -73.6205],
  Edu_ETS:                  [45.4945, -73.5625],
  Sante_CHUM:               [45.5110, -73.5560],
  Sante_CUSM_Glen:          [45.4725, -73.5995],
  Sante_H_Sainte_Justine:   [45.5030, -73.6235],
  Sante_H_General_Mtl:      [45.4975, -73.5885],
  Sante_H_Notre_Dame:       [45.5265, -73.5575],
  Res_Angus:                [45.5410, -73.5650],
  Res_Plateau_Est:          [45.5320, -73.5725],
  Res_Mile_End:             [45.5255, -73.5985],
  Res_Hochelaga:            [45.5435, -73.5415],
  Res_Verdun_Wellington:    [45.4615, -73.5685],
  Res_Sud_Ouest:            [45.4855, -73.5820],
  Res_Griffintown:          [45.4925, -73.5605],
  Res_Little_Italy:         [45.5345, -73.6125],
  Res_Outremont:            [45.5155, -73.6055],
  Affaires_Ville_Marie:     [45.5019, -73.5677],
  Comm_Marche_Jean_Talon:   [45.5361, -73.6150],
  Comm_Marche_Atwater:      [45.4795, -73.5765],
  Comm_Mont_Royal_Avenue:   [45.5245, -73.5815],
  Comm_Ste_Catherine_Ouest: [45.5015, -73.5725],
  Comm_Chabanel:            [45.5410, -73.6550],
  Loisir_Vieux_Port:        [45.5040, -73.5510],
  Loisir_Parc_Lafontaine:   [45.5265, -73.5695],
  Loisir_Canal_Lachine:     [45.4800, -73.5780],
  Loisir_Parc_Mont_Royal:   [45.4975, -73.5905],
  Nuit_Crescent:            [45.4985, -73.5765],
  Nuit_Village:             [45.5195, -73.5550],
  Res_Rosemont:             [45.5445, -73.5810],
  Res_Petite_Patrie:        [45.5360, -73.5940],
  Res_Villeray:             [45.5490, -73.6190],
  Res_Cote_des_Neiges:      [45.4945, -73.6380],
  Res_NDG:                  [45.4720, -73.6380],
  Res_Pointe_St_Charles:    [45.4650, -73.5555],
  Res_Centre_Sud:           [45.5175, -73.5465],
  Res_Maisonneuve:          [45.5490, -73.5320],
  Res_Parc_Extension:       [45.5295, -73.6380],
  Res_Westmount:            [45.4815, -73.6010],
  Res_Plateau_Ouest:        [45.5245, -73.5875],
  Res_Rosemont_Est:         [45.5480, -73.5530],
  Transit_Papineau:         [45.5260, -73.5500],
  Transit_Plamondon:        [45.4860, -73.6400],
  Transit_Joliette:         [45.5395, -73.5285],
  Transit_Charlevoix:       [45.4680, -73.5660],
  Loisir_Parc_Maisonneuve:  [45.5545, -73.5475],
};

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
