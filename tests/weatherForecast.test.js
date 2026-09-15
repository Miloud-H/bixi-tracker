import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { predictTrips, describe as describeDay } from "../public/js/weatherForecast.js";

// dow suit Date.getDay() : 0=dimanche ... 6=samedi.
describe("predictTrips", () => {
  test("never predicts a negative trip count on a terrible-weather day", () => {
    const trips = predictTrips(-20, 50, 1);
    assert.ok(trips >= 0);
  });

  test("rounds to the nearest 50", () => {
    const trips = predictTrips(20, 0, 1);
    assert.equal(trips % 50, 0);
  });

  test("a warmer day predicts more trips, all else equal", () => {
    const cold = predictTrips(5, 0, 1);
    const warm = predictTrips(25, 0, 1);
    assert.ok(warm > cold, `expected warm (${warm}) > cold (${cold})`);
  });

  test("rain predicts fewer trips, all else equal", () => {
    const dry = predictTrips(20, 0, 1);
    const rainy = predictTrips(20, 20, 1);
    assert.ok(rainy < dry, `expected rainy (${rainy}) < dry (${dry})`);
  });

  test("Sunday predicts fewer trips than a midweek day, all else equal", () => {
    const wednesday = predictTrips(20, 0, 3);
    const sunday = predictTrips(20, 0, 0);
    assert.ok(sunday < wednesday, `expected sunday (${sunday}) < wednesday (${wednesday})`);
  });

  // Trouvaille du 2026-09-15 (voir analysis/weather_regression_multiseason.py) :
  // le vendredi est le jour le plus achalandé de la semaine, pas un jour de
  // semaine "normal" — un simple flag weekend/semaine ratait cette forme.
  test("Friday predicts more trips than any other day, all else equal", () => {
    const friday = predictTrips(20, 0, 5);
    for (let dow = 0; dow <= 6; dow++) {
      if (dow === 5) continue;
      const other = predictTrips(20, 0, dow);
      assert.ok(friday >= other, `expected friday (${friday}) >= dow ${dow} (${other})`);
    }
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
