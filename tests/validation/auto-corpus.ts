import { expect, test } from "bun:test";
import { createAutoPlan, runAutoMeasurement } from "../../src/execution/auto";
import { assessStability, findDependencePlan, groupMeans, studentTInterval } from "../../src/results/superblocks";
import type { ClockProfile } from "../../src/types";

const RUNS_PER_SCENARIO = Number(process.env.BENCHMATE_CORPUS_COUNT ?? 2_500);
const CORPUS_SEED_OFFSET = Number(process.env.BENCHMATE_CORPUS_SEED_OFFSET ?? 0);
const CORPUS_SEED_STRIDE = Number(process.env.BENCHMATE_CORPUS_SEED_STRIDE ?? 10_000);

const clock: ClockProfile = {
  provider: "performance.now",
  method: "auto",
  monotonic: true,
  sampleCount: 2048,
  minimumPositiveTickMs: 0.001,
  zeroDeltaRateX: 0,
  readPairCostMs: { p50: 0.001, p99: 0.001 },
};

const createRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
};

const createNormal = (random: () => number) => {
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    const first = Math.max(Number.MIN_VALUE, random());
    const second = random();
    const magnitude = Math.sqrt(-2 * Math.log(first));
    spare = magnitude * Math.sin(2 * Math.PI * second);
    return magnitude * Math.cos(2 * Math.PI * second);
  };
};

type CorpusResult = {
  completionRate: number;
  coverage: number;
  lockedHorizon: boolean;
};

const runStationaryCorpus = async (
  transform: (normal: number) => number,
  seedOffset: number,
  precisionX = 0.01
): Promise<CorpusResult> => {
  let complete = 0;
  let covered = 0;
  let lockedHorizon = true;
  for (let runIndex = 0; runIndex < RUNS_PER_SCENARIO; runIndex++) {
    const normal = createNormal(createRandom(CORPUS_SEED_OFFSET + runIndex + seedOffset));
    const outcome = await runAutoMeasurement({
      auto: {
        mode: "auto",
        precisionX,
        maxTimeMs: 15_000,
        maxWarmupTimeMs: 5_000,
        minPilotBlocks: 64,
        minEffectiveBlocks: 20,
      },
      clock,
      intervalScale: "inverse-ms",
      runUnit: async (stage, operations) => ({
        elapsedMs: 2 * operations,
        value: stage === "sizing" || stage === "warmup" ? 1 : transform(normal()),
        operations,
      }),
    });
    if (outcome.status === "complete" && outcome.interval) {
      complete++;
      if (outcome.interval.lower <= 1_000 && (outcome.interval.upper ?? Number.POSITIVE_INFINITY) >= 1_000) covered++;
    }
    lockedHorizon &&= outcome.plan !== null && outcome.measurementValues.length === outcome.plan.physicalBlockCount;
  }

  return { completionRate: complete / RUNS_PER_SCENARIO, coverage: covered / complete, lockedHorizon };
};

test("stationary normal corpus meets completion and 95% coverage gates", async () => {
  const { completionRate, coverage } = await runStationaryCorpus((normal) => Math.max(0.001, 1 + normal * 0.005), 1);
  expect(completionRate).toBeGreaterThanOrEqual(0.9);
  expect(coverage).toBeGreaterThanOrEqual(0.935);
  expect(coverage).toBeLessThanOrEqual(0.965);
});

test("stationary lognormal corpus meets completion and 95% coverage gates", async () => {
  const sigma = 0.005;
  const { completionRate, coverage } = await runStationaryCorpus(
    (normal) => Math.exp(sigma * normal - (sigma * sigma) / 2),
    20_001
  );
  expect(completionRate).toBeGreaterThanOrEqual(0.9);
  expect(coverage).toBeGreaterThanOrEqual(0.935);
  expect(coverage).toBeLessThanOrEqual(0.965);
});

test("tighter precision corpus keeps one locked horizon and valid coverage", async () => {
  const { completionRate, coverage, lockedHorizon } = await runStationaryCorpus(
    (normal) => Math.max(0.001, 1 + normal * 0.01),
    30_001,
    0.005
  );
  expect(completionRate).toBeGreaterThanOrEqual(0.9);
  expect(coverage).toBeGreaterThanOrEqual(0.935);
  expect(coverage).toBeLessThanOrEqual(0.965);
  expect(lockedHorizon).toBeTrue();
});

const runArCorpus = async (correlation: number, scenarioIndex: number): Promise<CorpusResult> => {
  let complete = 0;
  let covered = 0;
  let fitsBudget = 0;
  let lockedHorizon = true;
  for (let runIndex = 0; runIndex < RUNS_PER_SCENARIO; runIndex++) {
    const normal = createNormal(
      createRandom(CORPUS_SEED_OFFSET + 40_001 + scenarioIndex * CORPUS_SEED_STRIDE + runIndex)
    );
    let state = 0;
    const outcome = await runAutoMeasurement({
      auto: {
        mode: "auto",
        precisionX: 0.01,
        maxTimeMs: 15_000,
        maxWarmupTimeMs: 5_000,
        minPilotBlocks: 64,
        minEffectiveBlocks: 20,
      },
      clock,
      intervalScale: "inverse-ms",
      runUnit: async (stage, operations) => {
        if (stage !== "sizing" && stage !== "warmup") {
          state = correlation * state + Math.sqrt(1 - correlation * correlation) * normal();
        }
        return {
          elapsedMs: 2,
          value: stage === "sizing" || stage === "warmup" ? 1 : Math.max(0.001, 1 + state * 0.005),
          operations,
        };
      },
    });
    if (outcome.status === "complete" && outcome.interval) {
      complete++;
      if (outcome.interval.lower <= 1_000 && (outcome.interval.upper ?? Number.POSITIVE_INFINITY) >= 1_000) covered++;
    }
    if (outcome.plan !== null && outcome.plan.plannedDurationMs <= outcome.plan.remainingBudgetMs) {
      fitsBudget++;
      lockedHorizon &&= outcome.measurementValues.length === outcome.plan.physicalBlockCount;
    }
  }
  return { completionRate: complete / fitsBudget, coverage: covered / complete, lockedHorizon };
};

test("AR(1) rho 0 corpus meets completion and coverage gates after reblocking", async () => {
  const { completionRate, coverage } = await runArCorpus(0, 0);
  expect(completionRate).toBeGreaterThanOrEqual(0.9);
  expect(coverage).toBeGreaterThanOrEqual(0.935);
  expect(coverage).toBeLessThanOrEqual(0.965);
}, 20_000);

test("AR(1) rho 0.5 corpus meets completion and coverage gates after reblocking", async () => {
  const { completionRate, coverage } = await runArCorpus(0.5, 1);
  expect(completionRate).toBeGreaterThanOrEqual(0.9);
  expect(coverage).toBeGreaterThanOrEqual(0.935);
  expect(coverage).toBeLessThanOrEqual(0.965);
}, 20_000);

test("AR(1) rho 0.9 corpus meets completion and coverage gates after reblocking", () => {
  const auto = {
    mode: "auto" as const,
    precisionX: 0.01,
    maxTimeMs: 15_000,
    maxWarmupTimeMs: 5_000,
    minPilotBlocks: 64,
    minEffectiveBlocks: 20,
  };
  let complete = 0;
  let covered = 0;
  let fitsBudget = 0;
  for (let runIndex = 0; runIndex < RUNS_PER_SCENARIO; runIndex++) {
    const normal = createNormal(createRandom(CORPUS_SEED_OFFSET + 60_001 + runIndex));
    let state = 0;
    const nextValue = () => {
      state = 0.9 * state + Math.sqrt(0.19) * normal();
      return Math.max(0.001, 1 + state * 0.005);
    };
    const pilot = Array.from({ length: 1_024 }, nextValue);
    const dependencePlan = findDependencePlan(pilot);
    if (!dependencePlan) continue;
    const plan = createAutoPlan({
      auto,
      elapsedMs: pilot.length * 2,
      operationsPerBlock: 1,
      pilotDurations: Array.from({ length: pilot.length }, () => 2),
      pilotValues: pilot,
      physicalBlocksPerSuperblock: dependencePlan.superblockSize,
    });
    if (!plan || plan.plannedDurationMs > plan.remainingBudgetMs) continue;
    fitsBudget++;
    const measurement = Array.from({ length: plan.physicalBlockCount }, nextValue);
    const finalSuperblocks = groupMeans(measurement, plan.physicalBlocksPerSuperblock);
    const interval = studentTInterval(finalSuperblocks);
    const stability = assessStability(finalSuperblocks, auto.precisionX);
    if (!interval || interval.halfWidth / Math.abs(interval.mean) > auto.precisionX || !stability.stable) {
      continue;
    }
    complete++;
    if (interval.lower <= 1 && interval.upper >= 1) covered++;
  }

  const completionRate = complete / fitsBudget;
  const coverage = covered / complete;
  expect(completionRate).toBeGreaterThanOrEqual(0.9);
  expect(coverage).toBeGreaterThanOrEqual(0.935);
  expect(coverage).toBeLessThanOrEqual(0.965);
}, 60_000);

test("warmup step corpus converges only after the changing window is replaced", async () => {
  let complete = 0;
  let minimumWarmupBlocks = Number.POSITIVE_INFINITY;
  for (let runIndex = 0; runIndex < RUNS_PER_SCENARIO; runIndex++) {
    let warmupBlocks = 0;
    const outcome = await runAutoMeasurement({
      auto: {
        mode: "auto",
        precisionX: 0.01,
        maxTimeMs: 15_000,
        maxWarmupTimeMs: 5_000,
        minPilotBlocks: 64,
        minEffectiveBlocks: 20,
      },
      clock,
      intervalScale: "inverse-ms",
      runUnit: async (stage, operations) => {
        if (stage === "warmup") warmupBlocks++;
        return {
          elapsedMs: 2,
          value: stage === "warmup" && warmupBlocks <= 20 ? 1.1 : 1,
          operations,
        };
      },
    });
    if (outcome.status === "complete") complete++;
    minimumWarmupBlocks = Math.min(minimumWarmupBlocks, warmupBlocks);
  }

  expect(complete).toBe(RUNS_PER_SCENARIO);
  expect(minimumWarmupBlocks).toBeGreaterThan(35);
}, 20_000);

test("late final-tier change corpus rejects false complete evidence without shortening the horizon", async () => {
  let falseComplete = 0;
  let retainedBlocks = true;
  for (let runIndex = 0; runIndex < RUNS_PER_SCENARIO; runIndex++) {
    const outcome = await runAutoMeasurement({
      auto: {
        mode: "auto",
        precisionX: 0.01,
        maxTimeMs: 15_000,
        maxWarmupTimeMs: 5_000,
        minPilotBlocks: 64,
        minEffectiveBlocks: 20,
      },
      clock,
      intervalScale: "inverse-ms",
      runUnit: async (stage, operations, round) => ({
        elapsedMs: 2,
        value: stage === "measurement" && round >= 40 ? 1.1 : 1,
        operations,
      }),
    });
    if (outcome.status === "complete") falseComplete++;
    retainedBlocks &&= outcome.plan !== null && outcome.measurementValues.length === outcome.plan.physicalBlockCount;
  }

  expect(falseComplete / RUNS_PER_SCENARIO).toBeLessThanOrEqual(0.05);
  expect(retainedBlocks).toBeTrue();
}, 20_000);

test("positive and negative final drift corpora reject false complete evidence", async () => {
  for (const direction of [-1, 1]) {
    let falseComplete = 0;
    let retainedBlocks = true;
    for (let runIndex = 0; runIndex < RUNS_PER_SCENARIO; runIndex++) {
      const outcome = await runAutoMeasurement({
        auto: {
          mode: "auto",
          precisionX: 0.01,
          maxTimeMs: 15_000,
          maxWarmupTimeMs: 5_000,
          minPilotBlocks: 64,
          minEffectiveBlocks: 20,
        },
        clock,
        intervalScale: "inverse-ms",
        runUnit: async (stage, operations, round) => ({
          elapsedMs: 2,
          value: stage === "measurement" ? 1 + direction * 0.1 * (round / 79) : 1,
          operations,
        }),
      });
      if (outcome.status === "complete") falseComplete++;
      retainedBlocks &&= outcome.plan !== null && outcome.measurementValues.length === outcome.plan.physicalBlockCount;
    }

    expect(falseComplete / RUNS_PER_SCENARIO).toBeLessThanOrEqual(0.05);
    expect(retainedBlocks).toBeTrue();
  }
}, 30_000);

test("quantized clock corpus never marks timer-limited series complete", async () => {
  const quantizedClock: ClockProfile = {
    ...clock,
    minimumPositiveTickMs: 0.1,
    zeroDeltaRateX: 0.5,
    readPairCostMs: { p50: 0, p99: 0.1 },
  };
  let timerLimited = 0;
  let complete = 0;
  for (let runIndex = 0; runIndex < RUNS_PER_SCENARIO; runIndex++) {
    const outcome = await runAutoMeasurement({
      auto: {
        mode: "auto",
        precisionX: 0.01,
        maxTimeMs: 15_000,
        maxWarmupTimeMs: 5_000,
        minPilotBlocks: 64,
        minEffectiveBlocks: 20,
      },
      clock: quantizedClock,
      intervalScale: "inverse-ms",
      runUnit: async (_stage, operations) => ({ elapsedMs: 0, value: 0, operations }),
    });
    if (outcome.status === "timer-limited") timerLimited++;
    if (outcome.status === "complete") complete++;
  }

  expect(timerLimited).toBe(RUNS_PER_SCENARIO);
  expect(complete).toBe(0);
}, 20_000);

test("independent clock-jitter corpus preserves stationary completion and coverage", async () => {
  let complete = 0;
  let covered = 0;
  for (let runIndex = 0; runIndex < RUNS_PER_SCENARIO; runIndex++) {
    const random = createRandom(CORPUS_SEED_OFFSET + 80_001 + runIndex);
    const taskNoise = createNormal(random);
    const clockNoise = createNormal(random);
    const outcome = await runAutoMeasurement({
      auto: {
        mode: "auto",
        precisionX: 0.01,
        maxTimeMs: 15_000,
        maxWarmupTimeMs: 5_000,
        minPilotBlocks: 64,
        minEffectiveBlocks: 20,
      },
      clock,
      intervalScale: "inverse-ms",
      runUnit: async (stage, operations) => ({
        elapsedMs: 2,
        value:
          stage === "sizing" || stage === "warmup"
            ? 1
            : Math.max(0.001, 1 + taskNoise() * 0.003 + clockNoise() * 0.002),
        operations,
      }),
    });
    if (outcome.status !== "complete" || !outcome.interval) continue;
    complete++;
    if (outcome.interval.lower <= 1_000 && (outcome.interval.upper ?? Number.POSITIVE_INFINITY) >= 1_000) covered++;
  }

  const completionRate = complete / RUNS_PER_SCENARIO;
  const coverage = covered / complete;
  expect(completionRate).toBeGreaterThanOrEqual(0.9);
  expect(coverage).toBeGreaterThanOrEqual(0.935);
  expect(coverage).toBeLessThanOrEqual(0.965);
}, 20_000);

test("isolated pause-spike corpus retains every final block and avoids false confidence", async () => {
  let falseComplete = 0;
  let retainedSpike = 0;
  for (let runIndex = 0; runIndex < RUNS_PER_SCENARIO; runIndex++) {
    const outcome = await runAutoMeasurement({
      auto: {
        mode: "auto",
        precisionX: 0.01,
        maxTimeMs: 15_000,
        maxWarmupTimeMs: 5_000,
        minPilotBlocks: 64,
        minEffectiveBlocks: 20,
      },
      clock,
      intervalScale: "inverse-ms",
      runUnit: async (stage, operations, round) => ({
        elapsedMs: 2,
        value: stage === "measurement" && round === 40 ? 10 : 1,
        operations,
      }),
    });
    if (outcome.status === "complete") falseComplete++;
    if (
      outcome.plan !== null &&
      outcome.measurementValues.length === outcome.plan.physicalBlockCount &&
      outcome.measurementValues[40] === 10
    ) {
      retainedSpike++;
    }
  }

  expect(falseComplete / RUNS_PER_SCENARIO).toBeLessThanOrEqual(0.05);
  expect(retainedSpike).toBe(RUNS_PER_SCENARIO);
}, 20_000);

test("stable high-variance corpus rejects locked plans that exceed the measured-task budget", async () => {
  let insufficientBudget = 0;
  let maximumElapsed = 0;
  for (let runIndex = 0; runIndex < RUNS_PER_SCENARIO; runIndex++) {
    const normal = createNormal(createRandom(CORPUS_SEED_OFFSET + 100_001 + runIndex));
    const outcome = await runAutoMeasurement({
      auto: {
        mode: "auto",
        precisionX: 0.01,
        maxTimeMs: 500,
        maxWarmupTimeMs: 100,
        minPilotBlocks: 64,
        minEffectiveBlocks: 20,
      },
      clock,
      intervalScale: "inverse-ms",
      runUnit: async (stage, operations) => ({
        elapsedMs: 2,
        value: stage === "sizing" || stage === "warmup" ? 1 : Math.max(0.001, 1 + normal() * 0.1),
        operations,
      }),
    });
    if (outcome.status === "insufficient-budget") insufficientBudget++;
    maximumElapsed = Math.max(maximumElapsed, outcome.elapsedMs);
  }

  expect(insufficientBudget / RUNS_PER_SCENARIO).toBeGreaterThanOrEqual(0.9);
  expect(maximumElapsed).toBeLessThanOrEqual(502);
}, 20_000);
