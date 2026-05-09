let activeDays = 30;
let activeCity = 'all';
let comparing  = false;
let chart = null;

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
      comparing && activeDays > 0
        ? fetchHistory({ ...compareDateRange(activeDays), city: activeCity })
        : Promise.resolve(null),
    ]);
    render(current, previous);
  } catch {
    document.getElementById('loader').style.display = 'none';
  }
}

function rollingAvg(values, window = 7) {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

function render(data, prevData) {
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
    const sign      = delta > 0 ? '+' : '';
    const color     = delta > 0 ? '#00e676' : delta < 0 ? '#ff5252' : '#9aa3b8';
    document.getElementById('statAvg').innerHTML =
      `${avg.toLocaleString('fr-CA')} <span>/ jour</span>` +
      (delta !== null ? ` <span style="color:${color};font-size:12px;">${sign}${delta}%</span>` : '');
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

  if (chart) chart.destroy();

  chart = new Chart(document.getElementById('historyChart'), {
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: { color: '#9aa3b8', font: { size: 11 }, boxWidth: 12 },
        },
        tooltip: {
          backgroundColor: 'rgba(14,17,23,0.95)',
          titleColor: '#e8eaf0',
          bodyColor:  '#9aa3b8',
          borderColor: '#2a3348',
          borderWidth: 1,
          callbacks: {
            label: ctx => {
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
          ticks: { color: '#5a6480', font: { size: 10 }, maxTicksLimit: 12, maxRotation: 0 },
          grid:  { color: '#1a2030' },
        },
        y: {
          ticks: { color: '#5a6480', font: { size: 10 }, callback: v => v.toLocaleString('fr-CA') },
          grid:  { color: '#1a2030' },
          beginAtZero: true,
        },
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
  load();
});

// ── Thème ──
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

load();
