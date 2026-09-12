import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  localToday,
  tripStartMinutes,
  tripEndMinutes,
  formatTime,
  minutesToHHMM,
  filterActiveAt,
  filterByDistance,
} from "../public/js/trips.js";

describe("Montréal timezone conversion (tripStartMinutes/tripEndMinutes/formatTime)", () => {
  // These pin the actual DST offset, not just "some" timezone math — a wrong
  // IANA zone id or a hardcoded UTC offset would silently break exactly one
  // of these two and not the other.
  test("summer (EDT, UTC-4): 18:30Z is 14:30 local", () => {
    const trip = { start_time: "2026-07-15T18:30:00Z", end_time: "2026-07-15T18:30:00Z" };
    assert.equal(tripStartMinutes(trip), 14 * 60 + 30);
    assert.equal(tripEndMinutes(trip), 14 * 60 + 30);
    assert.equal(formatTime(trip.start_time), "14:30");
  });

  test("winter (EST, UTC-5): 18:30Z is 13:30 local", () => {
    const trip = { start_time: "2026-01-15T18:30:00Z", end_time: "2026-01-15T18:30:00Z" };
    assert.equal(tripStartMinutes(trip), 13 * 60 + 30);
    assert.equal(tripEndMinutes(trip), 13 * 60 + 30);
    assert.equal(formatTime(trip.start_time), "13:30");
  });

  test("formatTime falls back to --:-- for missing or invalid input", () => {
    assert.equal(formatTime(null), "--:--");
    assert.equal(formatTime(undefined), "--:--");
    assert.equal(formatTime("not a date"), "--:--");
  });
});

describe("minutesToHHMM", () => {
  test("pads single digits", () => {
    assert.equal(minutesToHHMM(0), "00:00");
    assert.equal(minutesToHHMM(90), "01:30");
  });

  test("formats the last minute of the day", () => {
    assert.equal(minutesToHHMM(23 * 60 + 59), "23:59");
  });
});

describe("filterActiveAt", () => {
  const trips = [
    { start_time: "2026-07-15T14:00:00Z", end_time: "2026-07-15T14:20:00Z" }, // 10:00-10:20 EDT
    { start_time: "2026-07-15T15:00:00Z", end_time: "2026-07-15T15:10:00Z" }, // 11:00-11:10 EDT
  ];

  test("keeps a trip whose window straddles the slider", () => {
    const active = filterActiveAt(trips, 10 * 60 + 10); // 10:10
    assert.equal(active.length, 1);
    assert.equal(active[0], trips[0]);
  });

  test("includes both boundary minutes (start and end inclusive)", () => {
    assert.equal(filterActiveAt(trips, 10 * 60).length, 1);      // exactly start
    assert.equal(filterActiveAt(trips, 10 * 60 + 20).length, 1); // exactly end
  });

  test("excludes a trip outside the slider position", () => {
    const active = filterActiveAt(trips, 12 * 60);
    assert.equal(active.length, 0);
  });
});

describe("filterByDistance", () => {
  const trips = [{ distance: 300 }, { distance: 900 }, { distance: 1500 }];

  test("keeps only trips at or above the threshold", () => {
    const filtered = filterByDistance(trips, 900);
    assert.deepEqual(filtered.map((t) => t.distance), [900, 1500]);
  });

  test("returns all trips unchanged when minMeters is 0 or falsy", () => {
    assert.equal(filterByDistance(trips, 0), trips);
    assert.equal(filterByDistance(trips, null), trips);
  });
});

describe("localToday", () => {
  test("returns an ISO-shaped YYYY-MM-DD date", () => {
    assert.match(localToday(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
