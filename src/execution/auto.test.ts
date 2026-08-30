import { expect, test } from "bun:test";
import type { ClockProfile } from "../types";
import { runAutoMeasurement } from "./auto";

const clock: ClockProfile = {
  provider: "performance.now",
  method: "auto",
  monotonic: true,
  sampleCount: 2048,
  minimumPositiveTickMs: 0.001,
  zeroDeltaRateX: 0,
  readPairCostMs: { p50: 0.001, p99: 0.001 },
};

test("locks a fresh fixed measurement horizon after stable warmup and planning", async () => {
  const phases: string[] = [];
  const outcome = await runAutoMeasurement({
    auto: {
      mode: "auto",
      precisionX: 0.01,
      maxTimeMs: 1000,
      maxWarmupTimeMs: 200,
      minPilotBlocks: 64,
      minEffectiveBlocks: 20,
    },
    clock,
    intervalScale: "inverse-ms",
    runUnit: async (phase, operations) => {
      phases.push(phase);
      return { elapsedMs: 2, value: 2 / operations, operations };
    },
  });

  expect(outcome.status).toBe("complete");
  expect(outcome.plan).toMatchObject({ physicalBlocksPerSuperblock: 4, physicalBlockCount: 80, effectiveBlockCount: 20 });
  expect(outcome.measurementValues).toHaveLength(80);
  expect(phases.slice(-80)).toEqual(Array.from({ length: 80 }, () => "measurement"));
  expect(outcome.interval).toMatchObject({ method: "superblock-t", coverage: "nominal" });
});

test("returns timer-limited when no operation count clears clock quantization", async () => {
  let calls = 0;
  const outcome = await runAutoMeasurement({
    auto: {
      mode: "auto",
      precisionX: 0.01,
      maxTimeMs: 1000,
      maxWarmupTimeMs: 200,
      minPilotBlocks: 64,
      minEffectiveBlocks: 20,
    },
    clock,
    intervalScale: "inverse-ms",
    runUnit: async (_stage, operations) => {
      calls++;
      return { elapsedMs: 0, value: 0, operations };
    },
  });

  expect(outcome.status).toBe("timer-limited");
  expect(outcome.interval).toBeNull();
  expect(outcome.measurementValues).toEqual([]);
  expect(calls).toBeGreaterThan(0);
});

test("does not extend a locked horizon when final precision is missed", async () => {
  const outcome = await runAutoMeasurement({
    auto: {
      mode: "auto",
      precisionX: 0.01,
      maxTimeMs: 1000,
      maxWarmupTimeMs: 200,
      minPilotBlocks: 64,
      minEffectiveBlocks: 20,
    },
    clock,
    intervalScale: "identity",
    runUnit: async (stage, operations, round) => ({
      elapsedMs: 2,
      value: stage === "measurement" && round >= 40 ? 2 : 1,
      operations,
    }),
  });

  expect(outcome.plan?.physicalBlockCount).toBe(80);
  expect(outcome.measurementValues).toHaveLength(80);
  expect(outcome.status).toBe("precision-missed");
  expect(outcome.interval).toBeNull();
});
