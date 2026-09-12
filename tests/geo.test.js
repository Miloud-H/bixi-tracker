import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { haversineDistance, findNearestStation, tripColor } from "../public/js/geo.js";

describe("haversineDistance", () => {
  test("is zero for the same point", () => {
    assert.equal(haversineDistance(45.5, -73.6, 45.5, -73.6), 0);
  });

  test("matches a known distance (McGill to Berri-UQAM, ~1.6 km)", () => {
    const d = haversineDistance(45.5042, -73.5760, 45.5155, -73.5610);
    assert.ok(d > 1300 && d < 1900, `expected ~1300-1900 m, got ${d}`);
  });

  test("is symmetric", () => {
    const a = haversineDistance(45.50, -73.60, 45.52, -73.55);
    const b = haversineDistance(45.52, -73.55, 45.50, -73.60);
    assert.ok(Math.abs(a - b) < 1e-9);
  });
});

describe("findNearestStation", () => {
  const stations = [
    { name: "Near",   lat: 45.5001, lon: -73.6001 },
    { name: "Far",    lat: 45.6000, lon: -73.7000 },
  ];

  test("returns the closest station within maxDist", () => {
    const st = findNearestStation(stations, 45.5, -73.6, 200);
    assert.equal(st.name, "Near");
  });

  test("returns null when the closest station is still beyond maxDist", () => {
    const st = findNearestStation(stations, 45.5, -73.6, 1);
    assert.equal(st, null);
  });

  test("returns null for an empty station list", () => {
    assert.equal(findNearestStation([], 45.5, -73.6), null);
  });

  test("defaults maxDist to STATION_SNAP_METERS", () => {
    // "Near" is a few meters away, well inside the default 80m snap radius.
    const st = findNearestStation(stations, 45.5, -73.6);
    assert.equal(st.name, "Near");
  });
});

describe("tripColor", () => {
  test("is deterministic for the same bike_id", () => {
    assert.equal(tripColor("E12345"), tripColor("E12345"));
  });

  test("never lands in the green band [80, 160) that clashes with the map tiles", () => {
    for (let i = 0; i < 500; i++) {
      const id = `E${i.toString().padStart(5, "0")}`;
      const hue = Number(tripColor(id).match(/hsl\((\d+),/)[1]);
      assert.ok(hue < 80 || hue >= 160, `bike_id ${id} produced a green hue: ${hue}`);
    }
  });

  test("differs across most ids (not a constant color)", () => {
    const colors = new Set();
    for (let i = 0; i < 50; i++) colors.add(tripColor(`E${i}`));
    assert.ok(colors.size > 10, "expected meaningful spread across 50 distinct ids");
  });
});
