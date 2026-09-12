// Estimation légère du volume de trajets attendu selon la météo du jour/lendemain.
//
// Coefficients issus d'une régression OLS entraînée sur une seule saison de
// données (Montréal, avril-août 2026, n=147, R²=0.78) — voir
// analysis/weather_regression.py pour la méthode complète et les mises en
// garde (une seule saison de données : les coefficients sont provisoires,
// à re-calibrer une fois 2-3 saisons disponibles). Purement indicatif, pas
// un vrai modèle prédictif calibré.
//
//   trajets = 4069 + 444.62·temp_moy − 234.77·précip_mm − 1449.13·weekend
const MODEL = { intercept: 4069.04, temp: 444.62, precip: -234.77, weekend: -1449.13 };

// Coordonnées Montréal — la très grande majorité du volume du système (voir
// project_weather_prediction en mémoire : ~10 400 trajets/j vs ~73 à Sherbrooke),
// donc une seule estimation "système" basée sur Montréal reste représentative.
const MONTREAL = { lat: 45.5019, lon: -73.5674 };

function predictTrips(tempMean, precipSum, isWeekend) {
  const raw = MODEL.intercept
    + MODEL.temp * tempMean
    + MODEL.precip * precipSum
    + MODEL.weekend * (isWeekend ? 1 : 0);
  return Math.max(0, Math.round(raw / 50) * 50);
}

function describe(predicted, precipSum) {
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
