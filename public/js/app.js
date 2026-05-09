import { initMap, renderTrips, highlightGroup, resetLayerStyles, focusTrip, bindClickPopup } from "./map.js";
import { fetchTrips, fetchActive, filterActiveAt, filterByDistance } from "./trips.js";
import { findNearestStation, haversineDistance, CITIES } from "./geo.js";
import {
  initTheme, toggleTheme,
  showAlert, updateStats, updateSliderLabel, updateTopStations,
  updateDistLabel, updateActiveCount, updateTripCountInline, setSliderDisabled,
  drawHistogram, drawDailyChart, drawStationHourChart,
  renderBikePanel, renderGroupPanel, renderNearbyPanel,
  setPlayingState, TimelinePlayer,
} from "./ui.js";

const GBFS_STATIONS_URL  = "https://gbfs.velobixi.com/gbfs/en/station_information.json";
const RELOAD_INTERVAL_MS = 30_000;
const ACTIVE_INTERVAL_MS = 35_000;

class App {
  constructor() {
    this.map          = initMap();
    this.stations     = [];
    this.allTrips     = [];
    this.tripsLayer   = null;
    this.focusLayer   = null;
    this.lastTripCount = 0;
    this.theme        = initTheme();
    this.chartOpen    = false;
    this.activeSearch = "";
    this.activeCity   = "montreal"; // ville sélectionnée

    this.datePicker   = document.getElementById("datePicker");
    this.timeSlider   = document.getElementById("timeSlider");
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

  filteredTrips() {
    const f = CITIES[this.activeCity]?.filter ?? (() => true);
    return this.allTrips.filter(f);
  }

  updateRangeSliderPct(el) {
    const pct = ((el.value - (el.min || 0)) / ((el.max || 100) - (el.min || 0))) * 100;
    el.style.setProperty("--slider-pct", `${pct}%`);
  }

  bindEvents() {
    let debounce;
    const debouncedRender = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.render(), 10);
    };

    this.timeSlider.addEventListener("input", (e) => {
      this.updateRangeSliderPct(e.target);
      debouncedRender();
    });
    this.distSlider.addEventListener("input", (e) => {
      updateDistLabel(parseInt(this.distSlider.value));
      this.updateRangeSliderPct(e.target);
      debouncedRender();
    });

    this.datePicker.addEventListener("change", () => this.load());

    this.showAllCheck.addEventListener("change", () => {
      setSliderDisabled(this.showAllCheck.checked);
      this.render();
    });

    document.getElementById("togglePlay").addEventListener("click", () => this.player.toggle());
    document.getElementById("btnNow").addEventListener("click", () => this.goToNow());
    document.getElementById("btnSearch").addEventListener("click", () => this.searchBike());
    document.getElementById("btnReset").addEventListener("click", () => this.reset());
    document.getElementById("btnNearby").addEventListener("click", () => this.checkNearbyArrivals());

    document.getElementById("bikeSearch").addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.searchBike();
    });

    document.getElementById("btnChart").addEventListener("click", () => {
      this.chartOpen = !this.chartOpen;
      const panel = document.getElementById("chartPanel");
      panel.classList.toggle("open", this.chartOpen);
      document.getElementById("btnChart").textContent = this.chartOpen ? "📊 Fermer" : "📊 Courbe";
      if (this.chartOpen) drawDailyChart(this.allTrips);
    });

    document.getElementById("themeToggle").addEventListener("click", () => {
      this.theme = toggleTheme(this.theme);
      drawHistogram(this.histCanvas, this.filteredTrips());
      if (this.chartOpen) drawDailyChart(this.filteredTrips());
    });

    this.map.on("popupclose", () => this.resetStyles());
    this.map.on("click", (e) => {
      if (!e.originalEvent.defaultPrevented) this.closeStationCard();
    });

    // Sélecteur de ville
    document.querySelectorAll(".city-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".city-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.activeCity = btn.dataset.city;
        const city = CITIES[this.activeCity];
        this.map.flyTo(city.center, city.zoom, { duration: 0.8 });
        this.render();
        drawHistogram(this.histCanvas, this.filteredTrips());
        if (this.chartOpen) drawDailyChart(this.filteredTrips());
      });
    });
  }

  async init() {
    const json = await fetch(GBFS_STATIONS_URL).then((r) => r.json());
    this.stations = json.data.stations;
    bindClickPopup(this.map, () => this.filteredTrips(), this.stations,
      (station) => this.showStationCard(station));
    await this.load();
    await this.refreshActive();

    setInterval(() => this.load(),          RELOAD_INTERVAL_MS);
    setInterval(() => this.refreshActive(), ACTIVE_INTERVAL_MS);
    this.updateRangeSliderPct(this.timeSlider);
    this.updateRangeSliderPct(this.distSlider);
  }

  goToNow() {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    const localToday = new Date(now.getTime() - offset).toISOString().split("T")[0];

    // Si on n'est pas sur aujourd'hui, recharger d'abord
    if (this.datePicker.value !== localToday) {
      this.datePicker.value = localToday;
      this.load().then(() => {
        this.timeSlider.value = now.getHours() * 60 + now.getMinutes();
        this.updateRangeSliderPct(this.timeSlider);
        this.render();
      });
    } else {
      this.timeSlider.value = now.getHours() * 60 + now.getMinutes();
      this.updateRangeSliderPct(this.timeSlider);
      this.render();
    }
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

      drawHistogram(this.histCanvas, this.filteredTrips());
      if (this.chartOpen) drawDailyChart(this.filteredTrips());
      this.render();
    } catch (e) {
      console.error("Failed to load trips:", e);
    }
  }

  render() {
    const sliderVal = parseInt(this.timeSlider.value);
    const showAll   = this.showAllCheck.checked;
    const minDist   = parseInt(this.distSlider.value) || 0;
    const cityFilter = CITIES[this.activeCity]?.filter ?? (() => true);

    updateSliderLabel(sliderVal);

    if (this.tripsLayer) this.map.removeLayer(this.tripsLayer);

    // Appliquer filtre ville en premier
    const cityTrips = this.allTrips.filter(cityFilter);

    let visible = showAll
      ? cityTrips
      : filterActiveAt(cityTrips, sliderVal);

    visible = filterByDistance(visible, minDist);

    this.tripsLayer = renderTrips(this.map, visible, this.stations);
    updateStats(visible, cityTrips.length);
    updateTripCountInline(visible.length);
    updateTopStations(visible, this.stations);

    if (this.activeSearch) this._applyBikeHighlight(this.activeSearch);
  }

  // --- Public ---

  searchBike(id) {
    const input = document.getElementById("bikeSearch");
    if (id) { input.value = id; this.map.closePopup(); }
    const query = input.value.trim().toUpperCase();
    this.activeSearch = query;

    const trips = this.allTrips.filter((t) => t.bike_id.toUpperCase() === query);
    renderBikePanel(trips, this.stations, "window.app.focusTrip");

    if (!this.tripsLayer) return;
    if (query === "") { resetLayerStyles(this.tripsLayer); return; }

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
        if (isMatch) { l.setStyle({ color: "#e74c3c", weight: 5, opacity: 1 }); l.bringToFront(); }
        else l.setStyle({ color: "#bdc3c7", weight: 1, opacity: 0.15 });
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

  showStationCard(station) {
    const arrivals   = this.allTrips.filter(t =>
      haversineDistance(t.end_lat,   t.end_lon,   station.lat, station.lon) <= 60);
    const departures = this.allTrips.filter(t =>
      haversineDistance(t.start_lat, t.start_lon, station.lat, station.lon) <= 60);

    const byHour = new Array(24).fill(0);
    arrivals.forEach(t => { byHour[new Date(t.end_time).getHours()]++; });

    const originCount = {};
    arrivals.forEach(t => {
      const s = findNearestStation(this.stations, t.start_lat, t.start_lon);
      const name = s ? s.name : "Hors station";
      originCount[name] = (originCount[name] || 0) + 1;
    });
    const topOrigins = Object.entries(originCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

    document.getElementById("scName").textContent       = station.name;
    document.getElementById("scArrivals").textContent   = arrivals.length;
    document.getElementById("scDepartures").textContent = departures.length;
    document.getElementById("scOrigins").innerHTML      = topOrigins.length
      ? topOrigins.map(([n, c]) =>
          `<div class="sc-origin"><span class="sc-origin-name">${n}</span><span class="sc-origin-cnt">${c}</span></div>`
        ).join("")
      : `<div class="sc-origin-empty">Aucune donnée</div>`;

    const card = document.getElementById("stationCard");
    card.classList.add("sc-visible");
    drawStationHourChart(document.getElementById("scChart"), byHour);
  }

  closeStationCard() {
    document.getElementById("stationCard").classList.remove("sc-visible");
  }

  reset() {
    document.getElementById("bikeSearch").value = "";
    this.distSlider.value = 0;
    updateDistLabel(0);
    this.updateRangeSliderPct(this.distSlider);
    this.resetStyles();
    const city = CITIES[this.activeCity];
    this.map.flyTo(city.center, city.zoom, { duration: 0.8 });
    this.render();
  }

  checkNearbyArrivals() {
    const div = document.getElementById("nearbyResults");
    div.innerHTML = `<div class="nearby-empty">Localisation… 🛰</div>`;
    navigator.geolocation.getCurrentPosition(
      ({ coords: { latitude, longitude } }) => {
        const nearest = findNearestStation(this.stations, latitude, longitude, 250);
        if (!nearest) {
          div.innerHTML = `<div class="nearby-empty">❌ Aucune station dans un rayon de 250 m.</div>`;
          return;
        }
        const arrivals = this.allTrips
          .filter((t) => haversineDistance(nearest.lat, nearest.lon, t.end_lat, t.end_lon) <= 60)
          .sort((a, b) => new Date(b.end_time) - new Date(a.end_time))
          .slice(0, 5);

        if (arrivals.length > 0) {
          const f = arrivals[0];
          this.focusTrip(f.start_lat, f.start_lon, f.end_lat, f.end_lon);
        } else {
          this.map.setView([nearest.lat, nearest.lon], 16);
        }
        renderNearbyPanel(nearest.name, arrivals, "window.app.focusTrip");
      },
      (err) => {
        div.innerHTML = `<div class="nearby-empty">❌ GPS indisponible : ${err.message}</div>`;
      }
    );
  }
}

const app = new App();
window.app = app;
app.init();