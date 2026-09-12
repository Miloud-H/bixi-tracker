// Couleurs pour les graphiques (Chart.js et canvas natif), dérivées des
// custom properties de theme.css plutôt que redéfinies en dur par fichier.
// getComputedStyle lit l'état [data-theme] courant directement — pas besoin
// de ternaire isDark/valeur-par-thème, la cascade CSS s'en charge déjà.
export function getChartColors() {
  const s = getComputedStyle(document.documentElement);
  const v = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
  return {
    textPrimary:   v("--text-primary", "#1a1a1a"),
    textSecondary: v("--text-secondary", "#555555"),
    textMuted:     v("--text-muted", "#999999"),
    border:        v("--border", "#e8e8e8"),
    accent:        v("--accent", "#2ecc71"),
    accentRed:     v("--accent-red", "#e74c3c"),
    accentBlue:    v("--accent-blue", "#3498db"),
    tooltipBg:     v("--stats-bg", "rgba(255,255,255,0.95)"),
  };
}
