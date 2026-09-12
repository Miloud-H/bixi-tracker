// Leaflet is loaded globally via <script> tag in each page.
const L = window.L;

// Esri World Gray Canvas — free, no API key (CARTO's free anonymous tiles
// started requiring one). Each theme is split across two services: a muted
// base map and a transparent labels overlay drawn on top of it.
const CANVAS = {
  dark: {
    base: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    ref:  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
  },
  light: {
    base: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    ref:  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
  },
};

/**
 * Attaches the base+reference tile pair for a theme to `map`, and returns a
 * setTiles(theme) function that swaps them for another theme on demand
 * (no-op if already showing that theme).
 */
export function createTileSwitcher(map) {
  let layers = null;
  let current = null;

  return function setTiles(theme) {
    if (theme === current) return;
    if (layers) { layers.base.remove(); layers.ref.remove(); }

    const t = CANVAS[theme] || CANVAS.light;
    layers = {
      base: L.tileLayer(t.base, { attribution: "&copy; Esri", maxZoom: 16 }).addTo(map),
      ref:  L.tileLayer(t.ref,  { attribution: "&copy; Esri", maxZoom: 16 }).addTo(map),
    };
    current = theme;
  };
}
