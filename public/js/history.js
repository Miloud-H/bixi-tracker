let activeDays = 30;
let activeCity = 'all';
let chart = null;

async function load() {
  document.getElementById('loader').style.display = 'flex';
  try {
    const url = `/api/history?days=${activeDays}&city=${activeCity}`;
    const data = await fetch(url).then(r => r.json());
    render(data);
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

function render(data) {
  const labels  = data.map(d => d.date);
  const counts  = data.map(d => d.count);
  const avgLine = rollingAvg(counts, 7);

  const total   = counts.reduce((s, v) => s + v, 0);
  const avg     = data.length ? Math.round(total / data.length) : 0;
  const best    = data.reduce((m, d) => d.count > m.count ? d : m, { count: 0, date: '—' });

  document.getElementById('statTotal').innerHTML = total.toLocaleString('fr-CA');
  document.getElementById('statAvg').innerHTML   = `${avg.toLocaleString('fr-CA')} <span>/ jour</span>`;
  document.getElementById('statBest').innerHTML  = `${best.count.toLocaleString('fr-CA')} <span>${best.date}</span>`;
  document.getElementById('statDays').innerHTML  = data.length.toLocaleString('fr-CA');

  const titleMap = { 30: '30 derniers jours', 90: '90 derniers jours', 0: 'Depuis le début' };
  document.getElementById('titlePeriod').textContent = titleMap[activeDays] ?? `${activeDays} jours`;

  if (chart) chart.destroy();

  chart = new Chart(document.getElementById('historyChart'), {
    data: {
      labels,
      datasets: [
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
      ],
    },
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
            label: ctx => `${ctx.dataset.label} : ${Math.round(ctx.parsed.y).toLocaleString('fr-CA')}`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#5a6480',
            font: { size: 10 },
            maxTicksLimit: 12,
            maxRotation: 0,
          },
          grid: { color: '#1a2030' },
        },
        y: {
          ticks: {
            color: '#5a6480',
            font: { size: 10 },
            callback: v => v.toLocaleString('fr-CA'),
          },
          grid: { color: '#1a2030' },
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

load();
