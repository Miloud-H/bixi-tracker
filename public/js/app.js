import { initMap, renderTrips, highlightGroup, resetLayerStyles, focusTrip, bindClickPopup } from "./map.js";
import { fetchTrips, fetchActive, filterByTimeWindow, filterByDistance } from "./trips.js";
import { findNearestStation, haversineDistance } from "./geo.js";
import {
  initTheme, toggleTheme,
  showAlert, updateStats, updateSliderLabel, updateTopStations,
  updateDistLabel, updateActiveCount,
  drawHistogram, drawDailyChart,
  renderBikePanel, renderGroupPanel, renderNearbyPanel,
  TimelinePlayer,
} from "./ui.js";

const GBFS_STATIONS_URL  = "https://gbfs.velobixi.com/gbfs/en/station_information.json";
const RELOAD_INTERVAL_MS = 30_000;
const ACTIVE_INTERVAL_MS = 35_000; // légèrement décalé du tracker

class App {
  constructor() {
    this.map        = initMap();
    this.stations   = [];
    this.allTrips   = [];
    this.tripsLayer = null;
    this.focusLayer = null;
    this.lastTripCount = 0;
    this.theme      = initTheme();
    this.chartOpen  = false;
    this.activeSearch = "";

    this.datePicker   = document.getElementById("datePicker");
    this.timeSlider   = document.getElementById("timeSlider");
    this.timeWindow   = document.getElementById("timeWindow");
    this.showAllCheck = document.getElementById("showAllTrips");
    this.distSlider   = document.getElementById("distSlider");
    this.histCanvas   = document.getElementById("histogramCanvas");

    this.player = new TimelinePlayer("timeSlider", () => this.render());

    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    this.datePicker.value = new Date(now.getTime() - offset).toISOString().split("T")[0];
    this.timeSlider.value = now.getHours() * 60 + now.getMinutes();

    this.bindEvents();
  }

  bindEvents() {
    let debounce;
    const debouncedRender = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.render(), 10);
    };

    this.timeSlider.addEventListener("input", debouncedRender);
    this.timeWindow.addEventListener("input", debouncedRender);
    this.distSlider.addEventListener("input", () => {
      updateDistLabel(parseInt(this.distSlider.value));
      debouncedRender();
    });

    this.datePicker.addEventListener("change", () => this.load());
    this.showAllCheck.addEventListener("change", () => this.render());

    document.getElementById("togglePlay").addEventListener("click", () => this.player.toggle());
    document.getElementById("btnSearch").addEventListener("click", () => this.searchBike());
    document.getElementById("btnReset").addEventListener("click", () => this.reset());
    document.getElementById("btnNearby").addEventListener("click", () => this.checkNearbyArrivals());

    document.getElementById("btnChart").addEventListener("click", () => {
      this.chartOpen = !this.chartOpen;
      const panel = document.getElementById("chartPanel");
      panel.classList.toggle("open", this.chartOpen);
      if (this.chartOpen) drawDailyChart(this.allTrips);
    });

    document.getElementById("themeToggle").addEventListener("click", () => {
      this.theme = toggleTheme(this.theme);
      drawHistogram(this.histCanvas, this.allTrips);
      if (this.chartOpen) drawDailyChart(this.allTrips);
    });

    this.map.on("popupclose", () => this.resetStyles());
  }

  async init() {
    const json = await fetch(GBFS_STATIONS_URL).then((r) => r.json());
    this.stations = json.data.stations;
    bindClickPopup(this.map, () => this.allTrips, this.stations);
    await this.load();
    await this.refreshActive();

    setInterval(() => this.load(),          RELOAD_INTERVAL_MS);
    setInterval(() => this.refreshActive(), ACTIVE_INTERVAL_MS);
  }

  async refreshActive() {
    const data = await fetchActive();
    updateActiveCount(data ? data.active_count : null);
  }

  async load() {
    try {
      const trips = await fetchTrips(this.datePicker.value);
      const now = new Date();
      const offset = now.getTimezoneOffset() * 60000;
      const localToday = new Date(now.getTime() - offset).toISOString().split("T")[0];
      const isToday = this.datePicker.value === localToday;
      if (isToday && this.lastTripCount > 0 && trips.length > this.lastTripCount) {
        showAlert(`🚀 ${trips.length - this.lastTripCount} nouveau(x) trajet(s) !`);
      }
      this.lastTripCount = trips.length;
      this.allTrips = trips;

      drawHistogram(this.histCanvas, trips);
      if (this.chartOpen) drawDailyChart(trips);
      this.render();
    } catch (e) {
      console.error("Failed to load trips:", e);
    }
  }

  render() {
    const sliderVal = parseInt(this.timeSlider.value);
    const windowMin = parseInt(this.timeWindow.value) || 5;
    const showAll   = this.showAllCheck.checked;
    const minDist   = parseInt(this.distSlider.value) || 0;

    updateSliderLabel(sliderVal);

    if (this.tripsLayer) this.map.removeLayer(this.tripsLayer);

    let visible = showAll
      ? this.allTrips
      : filterByTimeWindow(this.allTrips, sliderVal, windowMin);

    visible = filterByDistance(visible, minDist);

    this.tripsLayer = renderTrips(this.map, visible, this.stations);
    updateStats(visible);
    updateTopStations(visible, this.stations);

    if (this.activeSearch) this._applyBikeHighlight(this.activeSearch);
  }

  // --- Public (popup onclick via window.app) ---

  searchBike(id) {
    const input = document.getElementById("bikeSearch");
    if (id) {
      input.value = id;
      this.map.closePopup();
    }
    const query = input.value.trim().toUpperCase();
    this.activeSearch = query;

    const trips = this.allTrips.filter((t) => t.bike_id.toUpperCase() === query);
    renderBikePanel(trips, this.stations, "window.app.focusTrip");

    if (!this.tripsLayer) return;

    if (query === "") {
      resetLayerStyles(this.tripsLayer);
      return;
    }

    this._applyBikeHighlight(query);

    if (trips.length === 0) return;
    const bounds = [];
    trips.forEach((t) => bounds.push([t.start_lat, t.start_lon], [t.end_lat, t.end_lon]));
    if (bounds.length) this.map.fitBounds(bounds, { padding: [50, 50] });
  }

  _applyBikeHighlight(query) {
    if (!this.tripsLayer) return;
    this.tripsLayer.eachLayer((l) => {
      const isMatch = l.bike_id && l.bike_id.toUpperCase() === query;
      if (l instanceof L.Polyline) {
        if (isMatch) {
          l.setStyle({ color: "#e74c3c", weight: 5, opacity: 1 });
          l.bringToFront();
        } else {
          l.setStyle({ color: "#bdc3c7", weight: 1, opacity: 0.15 });
        }
      } else if (l instanceof L.CircleMarker) {
        l.setStyle({ opacity: isMatch ? 1 : 0.15, fillOpacity: isMatch ? 1 : 0.15 });
      } else if (l.getElement) {
        l.getElement().style.opacity = isMatch ? "1" : "0.15";
      }
    });
  }

  focusTrip(sl1, sl2, el1, el2) {
    if (this.focusLayer) this.map.removeLayer(this.focusLayer);
    this.focusLayer = focusTrip(this.map, sl1, sl2, el1, el2);
  }

  highlightGroup(groupId) {
    if (!groupId || !this.tripsLayer) return;
    highlightGroup(this.tripsLayer, groupId);
    const members = this.allTrips.filter((t) => t.group_id === groupId);
    renderGroupPanel(groupId, members, this.stations, "window.app.focusTrip");
    showAlert(`Focus groupe #${groupId} — ${members.length} vélos`);
  }

  resetStyles() {
    this.activeSearch = "";
    resetLayerStyles(this.tripsLayer);
    if (this.focusLayer) { this.map.removeLayer(this.focusLayer); this.focusLayer = null; }
    document.getElementById("nearbyResults").innerHTML = "";
    document.getElementById("bikeResults").innerHTML   = "";
  }

  reset() {
    document.getElementById("bikeSearch").value = "";
    this.distSlider.value = 0;
    updateDistLabel(0);
    this.resetStyles();
    this.map.flyTo([45.5017, -73.5673], 13);
    this.render();
  }

  checkNearbyArrivals() {
    const div = document.getElementById("nearbyResults");
    div.textContent = "Localisation… 🛰";
    navigator.geolocation.getCurrentPosition(
      ({ coords: { latitude, longitude } }) => {
        const nearest = findNearestStation(this.stations, latitude, longitude, 250);
        if (!nearest) { div.textContent = "❌ Aucune station à proximité (250 m)."; return; }

        const arrivals = this.allTrips
          .filter((t) => haversineDistance(nearest.lat, nearest.lon, t.end_lat, t.end_lon) <= 60)
          .sort((a, b) => new Date(b.end_time) - new Date(a.end_time))
          .slice(0, 3);

        if (arrivals.length > 0) {
          const f = arrivals[0];
          this.focusTrip(f.start_lat, f.start_lon, f.end_lat, f.end_lon);
        } else {
          this.map.setView([nearest.lat, nearest.lon], 16);
        }
        renderNearbyPanel(nearest.name, arrivals, "window.app.focusTrip");
      },
      (err) => { div.textContent = `❌ GPS : ${err.message}`; }
    );
  }
}

const app = new App();
window.app = app;
app.init();