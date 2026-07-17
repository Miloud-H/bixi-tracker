import { initMap, renderTrips, highlightGroup, resetLayerStyles, focusTrip, bindClickPopup } from "./map.js";
import { fetchTrips, fetchActive, filterActiveAt, filterByDistance } from "./trips.js";
import { findNearestStation, haversineDistance, CITIES } from "./geo.js";
import {
  initTheme, toggleTheme,
  showAlert, updateStats, updateSliderLabel, updateTopStations,
  updateDistLabel, updateActiveCount, updateTripCountInline, setSliderDisabled,
  drawHistogram, drawDailyChart, destroyDailyChart, drawStationHourChart,
  drawDurationChart, destroyDurationChart,
  renderBikePanel, renderGroupPanel, renderNearbyPanel,
  renderDeparturesPanel, renderWatchStatus,
  setPlayingState, TimelinePlayer,
} from "./ui.js";

const GBFS_STATIONS_URL  = "https://gbfs.velobixi.com/gbfs/en/station_information.json";
const RELOAD_INTERVAL_MS = 30_000;
const ACTIVE_INTERVAL_MS = 35_000;

function urlBase64ToUint8Array(base64Url) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64  = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

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
    this.chartTab     = "hourly";
    this.activeSearch  = "";
    this.activeCity    = "montreal";
    this.watches          = new Map(); // bikeId -> { interval }
    this.pushSubscription = null;
    this._notifPermission = null;

    this.datePicker   = document.getElementById("datePicker");
    this.timeSlider   = document.getElementById("timeSlider");
    this.showAllCheck = document.getElementById("showAllTrips");
    this.distSlider   = document.getElementById("distSlider");
    this.histCanvas   = document.getElementById("histogramCanvas");

    this.player = new TimelinePlayer("timeSlider", () => this.render());

    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    const today = new Date(now.getTime() - offset).toISOString().split("T")[0];
    this.datePicker.value = sessionStorage.getItem("bixi-date") || today;
    this.timeSlider.value = now.getHours() * 60 + now.getMinutes();

    this.bindEvents();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", (e) => {
        if (e.data?.type === "bike-arrived") this._focusBikeArrival(e.data);
      });
    }
    this._focusFromUrlParams();
  }

  // Vélo localisé via une notification push (onglet déjà ouvert -> message,
  // onglet fermé -> paramètres d'URL après ouverture d'une nouvelle fenêtre).
  _focusBikeArrival({ lat, lon, depLat, depLon, bikeId }) {
    lat = parseFloat(lat); lon = parseFloat(lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return;

    depLat = parseFloat(depLat); depLon = parseFloat(depLon);
    if (!Number.isNaN(depLat) && !Number.isNaN(depLon)) {
      this.focusTrip(depLat, depLon, lat, lon);
      this.map.fitBounds([[depLat, depLon], [lat, lon]], { padding: [60, 60] });
    } else {
      this.map.setView([lat, lon], 17);
    }

    showAlert(bikeId ? `🚲 ${bikeId} arrivé ici` : "🚲 Vélo arrivé ici");
  }

  _focusFromUrlParams() {
    const params = new URLSearchParams(location.search);
    if (!params.has("focusLat")) return;

    this._focusBikeArrival({
      lat:    params.get("focusLat"),
      lon:    params.get("focusLon"),
      depLat: params.get("focusDepLat"),
      depLon: params.get("focusDepLon"),
      bikeId: params.get("focusBike"),
    });

    history.replaceState(null, "", location.pathname);
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

    this.datePicker.addEventListener("change", () => {
      sessionStorage.setItem("bixi-date", this.datePicker.value);
      this.load();
    });

    this.showAllCheck.addEventListener("change", () => {
      setSliderDisabled(this.showAllCheck.checked);
      this.render();
    });

    document.getElementById("togglePlay").addEventListener("click", () => this.player.toggle());
    document.getElementById("btnNow").addEventListener("click", () => this.goToNow());
    document.getElementById("btnSearch").addEventListener("click", () => this.searchBike());
    document.getElementById("btnReset").addEventListener("click", () => this.reset());
    document.getElementById("btnNearby").addEventListener("click",     () => this.checkNearbyArrivals());
    document.getElementById("btnDepartures").addEventListener("click", () => this.checkNearbyDepartures());

    document.getElementById("bikeSearch").addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.searchBike();
    });

    document.getElementById("btnChart").addEventListener("click", () => {
      this.chartOpen = !this.chartOpen;
      const panel = document.getElementById("chartPanel");
      panel.classList.toggle("open", this.chartOpen);
      document.getElementById("btnChart").textContent = this.chartOpen ? "📊 Fermer" : "📊 Courbe";
      if (this.chartOpen) this._drawActiveChart();
    });

    document.querySelectorAll(".chart-tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".chart-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        this.chartTab = tab.dataset.chart;
        document.getElementById("dailyChart").style.display    = this.chartTab === "hourly"   ? "" : "none";
        document.getElementById("durationChart").style.display = this.chartTab === "duration" ? "" : "none";
        this._drawActiveChart();
      });
    });

    document.getElementById("themeToggle").addEventListener("click", () => {
      this.theme = toggleTheme(this.theme);
      drawHistogram(this.histCanvas, this.filteredTrips());
      if (this.chartOpen) {
        destroyDailyChart();
        destroyDurationChart();
        this._drawActiveChart();
      }
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
      if (this.chartOpen) this._drawActiveChart();
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

  _drawActiveChart() {
    if (this.chartTab === "hourly") {
      drawDailyChart(this.filteredTrips());
    } else {
      drawDurationChart(document.getElementById("durationChart"), this.filteredTrips());
    }
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
    document.getElementById("nearbyResults").innerHTML    = "";
    document.getElementById("departureResults").innerHTML = "";
    document.getElementById("bikeResults").innerHTML      = "";
    this.stopWatch();
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

  checkNearbyDepartures() {
    const div = document.getElementById("departureResults");
    div.innerHTML = `<div class="nearby-empty">Localisation… 🛰</div>`;
    navigator.geolocation.getCurrentPosition(
      async ({ coords: { latitude, longitude } }) => {
        const nearest = findNearestStation(this.stations, latitude, longitude, 250);
        if (!nearest) {
          div.innerHTML = `<div class="nearby-empty">❌ Aucune station dans 250 m.</div>`;
          return;
        }
        try {
          const res        = await fetch(`/api/departures/nearby?lat=${nearest.lat}&lon=${nearest.lon}`);
          const departures = await res.json();
          renderDeparturesPanel(nearest.name, departures);
        } catch (e) {
          div.innerHTML = `<div class="nearby-empty">❌ Erreur réseau.</div>`;
        }
      },
      (err) => {
        div.innerHTML = `<div class="nearby-empty">❌ GPS indisponible : ${err.message}</div>`;
      }
    );
  }

  async watchBike(bikeId) {
    if (this.watches.has(bikeId)) return; // déjà suivi

    this.watches.set(bikeId, { interval: null });
    renderWatchStatus([...this.watches.keys()]);

    // Abonnement push serveur : fonctionne même app fermée / écran verrouillé.
    // Best-effort — si ça échoue (pas de SW, permission refusée, navigateur non
    // compatible), le polling ci-dessous reste un filet de sécurité tant que l'onglet est ouvert.
    try {
      await this._subscribePush(bikeId);
    } catch (e) {
      console.error("Push subscribe failed, falling back to in-page polling only:", e);
    }

    const notifPermission = await this._ensureNotifPermission();

    const interval = setInterval(async () => {
      try {
        const res  = await fetch(`/api/bike/status?bike_id=${bikeId}`);
        const data = await res.json();
        if (!data.in_flight) {
          this.stopWatch(bikeId);
          if (notifPermission === "granted") {
            new Notification("🚲 Vélo arrivé !", {
              body: `Le vélo ${bikeId} vient de se garer.`,
              icon: "/icons/icon.svg",
            });
          } else {
            showAlert(`🚲 Vélo ${bikeId} arrivé !`);
          }
        }
      } catch (e) {
        console.error("Watch poll error:", e);
      }
    }, 30_000);

    const w = this.watches.get(bikeId);
    if (w) w.interval = interval;
    else clearInterval(interval); // annulé pendant l'abonnement push
  }

  async _ensureNotifPermission() {
    if (typeof Notification === "undefined") return "denied";
    if (this._notifPermission) return this._notifPermission;
    this._notifPermission = await Notification.requestPermission().catch(() => "denied");
    return this._notifPermission;
  }

  async _subscribePush(bikeId) {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();

    if (!sub) {
      const { public_key } = await fetch("/api/push/vapid-public-key").then((r) => r.json());
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(public_key),
      });
    }

    this.pushSubscription = sub;

    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bike_id: bikeId, subscription: sub.toJSON() }),
    });
  }

  stopWatch(bikeId) {
    if (bikeId === undefined) {
      for (const id of [...this.watches.keys()]) this.stopWatch(id);
      return;
    }

    const w = this.watches.get(bikeId);
    if (!w) return;
    if (w.interval) clearInterval(w.interval);
    this.watches.delete(bikeId);

    if (this.pushSubscription) {
      fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bike_id: bikeId, endpoint: this.pushSubscription.endpoint }),
      }).catch(() => {});
    }

    renderWatchStatus([...this.watches.keys()]);
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