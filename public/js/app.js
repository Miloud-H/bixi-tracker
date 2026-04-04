import { initMap, renderTrips, highlightGroup, resetLayerStyles, focusTrip, bindClickPopup } from "./map.js";
import { fetchTrips, filterByTimeWindow, minutesToHHMM } from "./trips.js";
import { findNearestStation, haversineDistance, STATION_SNAP_METERS } from "./geo.js";
import { showAlert, updateStats, updateSliderLabel, renderBikePanel, renderGroupPanel, renderNearbyPanel, TimelinePlayer } from "./ui.js";

const GBFS_STATIONS_URL = "https://gbfs.velobixi.com/gbfs/en/station_information.json";
const RELOAD_INTERVAL_MS = 30_000;

class App {
  constructor() {
    this.map = initMap();
    this.stations = [];
    this.allTrips = [];
    this.tripsLayer = null;
    this.bikeLayer = null;
    this.focusLayer = null;
    this.lastTripCount = 0;

    this.datePicker = document.getElementById("datePicker");
    this.timeSlider = document.getElementById("timeSlider");
    this.timeWindow = document.getElementById("timeWindow");
    this.showAllCheckbox = document.getElementById("showAllTrips");

    this.player = new TimelinePlayer("timeSlider", () => this.render());

    this.datePicker.value = new Date().toISOString().split("T")[0];
    this.bindEvents();
  }

  bindEvents() {
    let debounce;
    this.timeSlider.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.render(), 10);
    });
    this.datePicker.addEventListener("change", () => this.load());
    this.showAllCheckbox.addEventListener("change", () => this.render());
    document.getElementById("togglePlay").addEventListener("click", () => this.player.toggle());
    document.getElementById("btnSearch").addEventListener("click", () => this.searchBike());
    document.getElementById("btnReset").addEventListener("click", () => this.reset());
    document.getElementById("btnNearby").addEventListener("click", () => this.checkNearbyArrivals());

    this.map.on("popupclose", () => this.resetStyles());
  }

  async init() {
    const json = await fetch(GBFS_STATIONS_URL).then((r) => r.json());
    this.stations = json.data.stations;
    bindClickPopup(this.map, this.allTrips, this.stations);
    await this.load();
    setInterval(() => this.load(), RELOAD_INTERVAL_MS);
  }

  async load() {
    try {
      const trips = await fetchTrips(this.datePicker.value);
      const isToday = this.datePicker.value === new Date().toISOString().split("T")[0];
      if (isToday && this.lastTripCount > 0 && trips.length > this.lastTripCount) {
        showAlert(`🚀 ${trips.length - this.lastTripCount} nouveau(x) trajet(s) !`);
      }
      this.lastTripCount = trips.length;
      this.allTrips = trips;
      this.render();
    } catch (e) {
      console.error("Failed to load trips:", e);
    }
  }

  render() {
    const sliderVal = parseInt(this.timeSlider.value);
    const windowMin = parseInt(this.timeWindow.value) || 5;
    const showAll = this.showAllCheckbox.checked;

    updateSliderLabel(sliderVal);

    if (this.tripsLayer) this.map.removeLayer(this.tripsLayer);

    const visible = showAll
      ? this.allTrips
      : filterByTimeWindow(this.allTrips, sliderVal, windowMin);

    this.tripsLayer = renderTrips(this.map, visible, this.stations);
    updateStats(visible, this.allTrips, this.datePicker.value);
  }

  // --- Public actions (called from popup HTML via window.app) ---

  searchBike(id) {
    const input = document.getElementById("bikeSearch");
    if (id) input.value = id;
    const query = input.value.trim().toUpperCase();
    const trips = this.allTrips.filter((t) => t.bike_id.toUpperCase() === query);

    if (this.bikeLayer) this.map.removeLayer(this.bikeLayer);
    this.bikeLayer = window.L.layerGroup().addTo(this.map);

    renderBikePanel(trips, this.stations, "window.app.focusTrip");

    if (trips.length === 0) return;

    const bounds = [];
    trips.forEach((t) => {
      window.L.polyline([[t.start_lat, t.start_lon], [t.end_lat, t.end_lon]], {
        color: "red", weight: 4, dashArray: "5, 10",
      }).addTo(this.bikeLayer);
      bounds.push([t.start_lat, t.start_lon], [t.end_lat, t.end_lon]);
    });

    if (bounds.length) this.map.fitBounds(bounds);
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
    showAlert(`Focus sur le groupe #${groupId} (${members.length} vélos)`);
  }

  resetStyles() {
    resetLayerStyles(this.tripsLayer);
    if (this.bikeLayer) { this.map.removeLayer(this.bikeLayer); this.bikeLayer = null; }
    if (this.focusLayer) { this.map.removeLayer(this.focusLayer); this.focusLayer = null; }
    document.getElementById("nearbyResults").innerHTML = "";
    document.getElementById("bikeResults").innerHTML = "";
  }

  reset() {
    document.getElementById("bikeSearch").value = "";
    this.resetStyles();
    this.map.flyTo([45.5017, -73.5673], 13);
    this.render();
  }

  checkNearbyArrivals() {
    const div = document.getElementById("nearbyResults");
    div.textContent = "Localisation... 🛰️";

    navigator.geolocation.getCurrentPosition(
      ({ coords: { latitude, longitude } }) => {
        const nearest = findNearestStation(this.stations, latitude, longitude, 250);
        if (!nearest) {
          div.textContent = "❌ Aucune station à proximité (250 m).";
          return;
        }

        const arrivals = this.allTrips
          .filter((t) => haversineDistance(nearest.lat, nearest.lon, t.end_lat, t.end_lon) <= 60)
          .sort((a, b) => new Date(b.end_time) - new Date(a.end_time))
          .slice(0, 3);

        if (arrivals.length > 0) {
          const first = arrivals[0];
          this.focusTrip(first.start_lat, first.start_lon, first.end_lat, first.end_lon);
        } else {
          this.map.setView([nearest.lat, nearest.lon], 16);
        }

        renderNearbyPanel(nearest.name, arrivals, "window.app.focusTrip");
      },
      (err) => { div.textContent = `❌ Erreur GPS : ${err.message}`; }
    );
  }
}

const app = new App();
window.app = app; // exposed for popup onclick handlers
app.init();