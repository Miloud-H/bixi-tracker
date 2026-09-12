import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { predictTrips, describe as describeDay } from "../public/js/weatherForecast.js";

describe("predictTrips", () => {
  test("never predicts a negative trip count on a terrible-weather day", () => {
    const trips = predictTrips(-20, 50, false);
    assert.ok(trips >= 0);
  });

  test("rounds to the nearest 50", () => {
    const trips = predictTrips(20, 0, false);
    assert.equal(trips % 50, 0);
  });

  test("a warmer day predicts more trips, all else equal", () => {
    const cold = predictTrips(5, 0, false);
    const warm = predictTrips(25, 0, false);
    assert.ok(warm > cold, `expected warm (${warm}) > cold (${cold})`);
  });

  test("rain predicts fewer trips, all else equal", () => {
    const dry = predictTrips(20, 0, false);
    const rainy = predictTrips(20, 20, false);
    assert.ok(rainy < dry, `expected rainy (${rainy}) < dry (${dry})`);
  });

  test("a weekend predicts fewer trips than a weekday, all else equal", () => {
    const weekday = predictTrips(20, 0, false);
    const weekend = predictTrips(20, 0, true);
    assert.ok(weekend < weekday, `expected weekend (${weekend}) < weekday (${weekday})`);
  });
});

describe("describe", () => {
  test("rain takes priority over the predicted-volume bucket", () => {
    // predicted alone would read as "excellent", but 5mm+ of rain overrides it.
    const { emoji } = describeDay(15000, 6);
    assert.equal(emoji, "🌧️");
  });

  test("buckets the predicted volume when it's dry", () => {
    assert.equal(describeDay(15000, 0).emoji, "☀️");
    assert.equal(describeDay(9000, 0).emoji, "🙂");
    assert.equal(describeDay(5000, 0).emoji, "😐");
    assert.equal(describeDay(1000, 0).emoji, "🥶");
  });
});
