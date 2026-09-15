// Estimation légère du volume de trajets attendu selon la météo du jour/lendemain.
//
// Intercept calibré sur notre propre saison e-bike 2026 (Montréal,
// avril-août, n=147) — c'est la bonne échelle pour ce qu'on affiche. Les
// coefficients temp/précip/weekend, eux, viennent d'une régression multi-
// saisons sur les données ouvertes OFFICIELLES BIXI (2021-2025, toute la
// flotte, n=1438 jours, R²=0.82 — voir analysis/weather_regression_multiseason.py)
// convertie en effet RELATIF (%/unité, modèle log-linéaire) puis réappliquée
// à notre intercept — la seule saison 2026 seule n'a pas assez de variation
// météo pour séparer proprement météo/calendrier (voir garde-fou dans
// project_weather_prediction en mémoire), mais 5 saisons le permettent.
// Comparé à l'ancien modèle mono-saison : la température était déjà juste
// (+10.9%/°C vs +11.3%/°C), mais la pluie (-5.8%/mm) et surtout le weekend
// (-35.6%, et pas significatif une fois d'autres saisons ajoutées) étaient
// nettement surestimés par la confusion météo/calendrier d'une saison seule.
//
//   trajets = 4069 + 460.4·temp_moy − 97.4·précip_mm − 275.9·weekend
const MODEL = { intercept: 4069.04, temp: 460.4, precip: -97.4, weekend: -275.9 };

// Coordonnées Montréal — la très grande majorité du volume du système (voir
// project_weather_prediction en mémoire : ~10 400 trajets/j vs ~73 à Sherbrooke),
// donc une seule estimation "système" basée sur Montréal reste représentative.
const MONTREAL = { lat: 45.5019, lon: -73.5674 };

export function predictTrips(tempMean, precipSum, isWeekend) {
  const raw = MODEL.intercept
    + MODEL.temp * tempMean
    + MODEL.precip * precipSum
    + MODEL.weekend * (isWeekend ? 1 : 0);
  return Math.max(0, Math.round(raw / 50) * 50);
}

export function describe(predicted, precipSum) {
  if (precipSum >= 5)   return { emoji: "🌧️", text: "Pluie prévue" };
  if (predicted >= 12000) return { emoji: "☀️", text: "Excellente journée pour rouler" };
  if (predicted >= 8000)  return { emoji: "🙂", text: "Bonne journée pour rouler" };
  if (predicted >= 4000)  return { emoji: "😐", text: "Journée plus calme" };
  return { emoji: "🥶", text: "Journée creuse prévue" };
}

// Renvoie [aujourd'hui, demain] avec température, précipitations et
// estimation de trajets. Lance une exception si l'API est indisponible —
// à appeler dans un try/catch (fonctionnalité non-critique).
export async function fetchRidingForecast() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${MONTREAL.lat}&longitude=${MONTREAL.lon}` +
    `&daily=temperature_2m_mean,precipitation_sum&timezone=America%2FToronto&forecast_days=2`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const data = await res.json();

  return data.daily.time.map((day, i) => {
    const tempMean  = data.daily.temperature_2m_mean[i];
    const precipSum = data.daily.precipitation_sum[i];
    const dow = new Date(`${day}T12:00:00`).getDay(); // midi : évite tout souci de fuseau horaire
    const isWeekend = dow === 0 || dow === 6;
    const predicted = predictTrips(tempMean, precipSum, isWeekend);
    return { day, tempMean, precipSum, predicted, ...describe(predicted, precipSum) };
  });
}
