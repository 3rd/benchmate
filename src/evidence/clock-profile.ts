import type { Clock, ClockMethod, ClockProfile } from "../types";

const CLOCK_PROFILE_SAMPLES = 2048;

const quantileSorted = (values: readonly number[], probability: number) => {
  const position = (values.length - 1) * probability;
  const lower = values[Math.floor(position)];
  const upper = values[Math.ceil(position)];
  if (lower === undefined || upper === undefined) throw new Error("Clock profiling produced no samples.");
  return lower + (upper - lower) * (position - Math.floor(position));
};

const profileClock = (
  clock: Clock,
  method: ClockMethod,
  sampleCount: number = CLOCK_PROFILE_SAMPLES,
): ClockProfile => {
  if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
    throw new RangeError(`'sampleCount' must be a positive safe integer, got ${sampleCount}`);
  }

  const deltas = Array.from({ length: sampleCount }, () => 0);
  let previous = clock.now();
  if (!Number.isFinite(previous)) throw new Error("Clock returned a non-finite timestamp.");

  for (let index = 0; index < sampleCount; index++) {
    const first = clock.now();
    const second = clock.now();
    if (!Number.isFinite(first) || !Number.isFinite(second)) {
      throw new TypeError("Clock returned a non-finite timestamp.");
    }
    if (first < previous || second < first) throw new Error("Clock decreased during profiling.");
    deltas[index] = second - first;
    previous = second;
  }

  const sorted = [...deltas].sort((a, b) => a - b);
  const positive = sorted.filter((delta) => delta > 0);
  const minimumPositiveTickMs = positive[0] ?? 0;
  const zeroDeltas = sorted.length - positive.length;

  return Object.freeze({
    provider: clock.provider,
    method,
    monotonic: true,
    sampleCount,
    minimumPositiveTickMs,
    zeroDeltaRateX: zeroDeltas / sampleCount,
    readPairCostMs: Object.freeze({
      p50: quantileSorted(sorted, 0.5),
      p99: quantileSorted(sorted, 0.99),
    }),
  });
};

export { CLOCK_PROFILE_SAMPLES, profileClock };
