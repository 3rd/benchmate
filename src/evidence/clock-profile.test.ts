import { expect, test } from "bun:test";
import type { Clock } from "../types";
import { profileClock } from "./clock-profile";

test("profiles positive ticks, zero deltas, and deterministic read-pair quantiles", () => {
  const timestamps = [0, 0, 0, 0, 1, 1, 3, 3, 7];
  let index = 0;
  const clock: Clock = {
    provider: "performance.now",
    now: () => timestamps[index++] ?? 7,
  };

  const profile = profileClock(clock, "auto", 4);

  expect(profile).toEqual({
    provider: "performance.now",
    method: "auto",
    monotonic: true,
    sampleCount: 4,
    minimumPositiveTickMs: 1,
    zeroDeltaRateX: 0.25,
    readPairCostMs: { p50: 1.5, p99: 3.939_999_999_999_999_5 },
  });
  expect(Object.isFrozen(profile)).toBeTrue();
  expect(Object.isFrozen(profile.readPairCostMs)).toBeTrue();
});

test("rejects a clock that decreases before user setup can run", () => {
  const timestamps = [0, 1, 0];
  let index = 0;
  const clock: Clock = {
    provider: "performance.now",
    now: () => timestamps[index++] ?? 0,
  };

  expect(() => profileClock(clock, "performance.now", 1)).toThrow("Clock decreased during profiling.");
});
