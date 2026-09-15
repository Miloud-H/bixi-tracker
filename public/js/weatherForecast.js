// Estimation légère du volume de trajets attendu selon la météo du jour/lendemain.
//
// temp/précip viennent d'une régression multi-saisons sur les données
// ouvertes OFFICIELLES BIXI (2021-2025, toute la flotte, n=1438 jours,
// R²=0.82 — voir analysis/weather_regression_multiseason.py) convertie en
// effet RELATIF (%/unité, modèle log-linéaire) puis réappliquée à notre
// échelle — la seule saison 2026 n'a pas assez de variation météo pour
// séparer proprement météo/calendrier (garde-fou dans
// project_weather_prediction en mémoire), 5 saisons le permettent.
//
// `dow` (delta par jour de semaine, dim=0..sam=6 comme Date.getDay()) vient
// en revanche d'une régression directe sur NOTRE saison e-bike 2026 (pas de
// transfert multi-saisons ici) : testé le 2026-09-15, dans le modèle
// multi-saisons l'effet jour-de-semaine n'est PAS significatif une fois
// exprimé en %, contrairement à temp/précip — signe que c'est un delta
// absolu (~fixe en nombre de trajets) plutôt qu'un pourcentage qui grossit
// avec le réseau, donc pas transférable de la même façon. Le vendredi est en
// réalité le jour le plus achalandé (pas un jour de semaine "normal"), et le
// dimanche est aussi creux que le lundi — un simple flag weekend/semaine
// ratait complètement cette forme (confirmé sur les 2 échelles : multi-
// saisons ET notre saison seule donnent la même forme générale).
//
// L'intercept (lundi, 0°C, sec) est recalibré en "dé-météorisant" les
// trajets récents avec temp/précip/dow ci-dessus puis en moyennant — stable
// autour de ~3450 sur des fenêtres de 14 à 45 jours au moment du calcul.
// Une régression figée sur avril-août (l'ancienne approche) sous-estimait
// nettement septembre : le système grossit tout au long de la saison.
//
// /!\ Cet intercept va se re-périmer avec la croissance du système — à
// rafraîchir périodiquement (ex. à chaque nouveau dump de la DB de prod, voir
// project_data_report en mémoire), pas un fix définitif.
const MODEL = {
  intercept: 3450,
  temp: 460.4,
  precip: -97.4,
  // dim,   lun, mar,    mer,    jeu,    ven,    sam
  dow: [-751.7, 0, 1473.4, 1472.1, 2173.7, 2246.7, 606.1],
};

// Coordonnées Montréal — la très grande majorité du volume du système (voir
// project_weather_prediction en mémoire : ~10 400 trajets/j vs ~73 à Sherbrooke),
// donc une seule estimation "système" basée sur Montréal reste représentative.
const MONTREAL = { lat: 45.5019, lon: -73.5674 };

export function predictTrips(tempMean, precipSum, dow) {
  const raw = MODEL.intercept
    + MODEL.temp * tempMean
    + MODEL.precip * precipSum
    + MODEL.dow[dow];
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
    const predicted = predictTrips(tempMean, precipSum, dow);
    return { day, tempMean, precipSum, predicted, ...describe(predicted, precipSum) };
  });
}
