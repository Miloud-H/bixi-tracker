import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// watchHistory.js reads/writes `localStorage` directly (a browser global) —
// Node has none by default, so a minimal in-memory stand-in is installed
// before the module is ever imported. It only needs the two methods the
// module actually calls.
class MemoryStorage {
  #map = new Map();
  getItem(key) { return this.#map.has(key) ? this.#map.get(key) : null; }
  setItem(key, value) { this.#map.set(key, String(value)); }
  clear() { this.#map.clear(); }
}
globalThis.localStorage = new MemoryStorage();

const {
  setPendingWatch,
  clearPendingWatch,
  getHistory,
  clearHistory,
  recordArrival,
} = await import("../public/js/watchHistory.js");

beforeEach(() => {
  globalThis.localStorage.clear();
});

describe("pending watches + recordArrival", () => {
  test("recordArrival is a no-op when there's no pending watch for the bike", () => {
    assert.equal(recordArrival("GHOST", { arrLat: 45.5, arrLon: -73.6 }), null);
    assert.deepEqual(getHistory(), []);
  });

  test("recordArrival turns a pending watch into a history entry and clears it", () => {
    setPendingWatch("E1", { departedAt: "2026-01-01T12:00:00Z", depLat: 45.50, depLon: -73.60 });

    const entry = recordArrival("E1", { arrLat: 45.51, arrLon: -73.60 });

    assert.equal(entry.bikeId, "E1");
    assert.equal(entry.depLat, 45.50);
    assert.equal(entry.arrLat, 45.51);
    assert.ok(entry.distanceM > 0, "distance should be computed from dep/arr coordinates");
    assert.deepEqual(getHistory()[0], entry);

    // The pending watch must be cleared — a second call has nothing left to resolve.
    assert.equal(recordArrival("E1", { arrLat: 45.51, arrLon: -73.60 }), null);
  });

  test("recordArrival without arrival coordinates still records the departure", () => {
    setPendingWatch("E2", { departedAt: "2026-01-01T12:00:00Z", depLat: 45.50, depLon: -73.60 });

    const entry = recordArrival("E2");

    assert.equal(entry.arrLat, null);
    assert.equal(entry.distanceM, null, "no distance without an arrival position");
  });

  test("clearPendingWatch drops a watch without recording history", () => {
    setPendingWatch("E3", { departedAt: "2026-01-01T12:00:00Z", depLat: 45.5, depLon: -73.6 });
    clearPendingWatch("E3");

    assert.equal(recordArrival("E3", { arrLat: 45.5, arrLon: -73.6 }), null);
  });

  test("history is capped and newest-first", () => {
    for (let i = 0; i < 35; i++) {
      setPendingWatch(`E${i}`, { departedAt: "2026-01-01T12:00:00Z", depLat: 45.5, depLon: -73.6 });
      recordArrival(`E${i}`, { arrLat: 45.5, arrLon: -73.6 });
    }

    const history = getHistory();
    assert.equal(history.length, 30, "capped at MAX_HISTORY");
    assert.equal(history[0].bikeId, "E34", "most recent arrival comes first");
  });

  test("clearHistory empties it", () => {
    setPendingWatch("E1", { departedAt: "2026-01-01T12:00:00Z", depLat: 45.5, depLon: -73.6 });
    recordArrival("E1", { arrLat: 45.5, arrLon: -73.6 });

    clearHistory();

    assert.deepEqual(getHistory(), []);
  });
});
