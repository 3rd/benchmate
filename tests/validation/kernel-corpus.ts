import { expect, test } from "bun:test";
import { createKernelRoundPlan } from "../../src/execution/kernel";
import { createRoundSlopeInterval, diagnoseKernelResults, fitKernelRound } from "../../src/results/regression";
import type { MeasurementObservation } from "../../src/types";

const RUNS_PER_SCENARIO = Number(process.env.BENCHMATE_CORPUS_COUNT ?? 10_000);
const CORPUS_SEED_OFFSET = Number(process.env.BENCHMATE_CORPUS_SEED_OFFSET ?? 0);
const TRUE_SLOPE = 0.01;

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

test("linear counted-kernel corpus meets slope-bias and round-slope coverage gates", () => {
  let covered = 0;
  let complete = 0;
  let estimateTotal = 0;
  for (let run = 0; run < RUNS_PER_SCENARIO; run++) {
    const normal = createNormal(createRandom(CORPUS_SEED_OFFSET + 120_001 + run));
    const models = Array.from({ length: 20 }, (_, round) => {
      const plan = createKernelRoundPlan(64, run + 1, 0, round);
      const slope = TRUE_SLOPE * (1 + normal() * 0.02);
      const observations = plan.points.map(
        (point, sequence): MeasurementObservation => ({
          sequence,
          task: "linear-kernel",
          phase: "measurement",
          startedAtMs: sequence,
          elapsedMs: 0.5 + slope * point.iterations,
          operations: point.iterations,
          round,
          seed: plan.seed,
          resultHash: `hash:${point.iterations}`,
          flags: [],
        })
      );
      return fitKernelRound(round, plan.seed, observations, 0.01);
    });
    if (
      models.some(
        (model) =>
          model.slopeMsPerOperation <= 0 || model.flags.includes("nonlinear-scaling"),
      )
    ) {
      continue;
    }
    const slopes = models.map((model) => model.slopeMsPerOperation);
    const interval = createRoundSlopeInterval(slopes, slopes.length * 5, "nominal");
    if (!interval || interval.upper === null) continue;
    complete++;
    estimateTotal += slopes.reduce((total, slope) => total + slope, 0) / slopes.length;
    if (interval.lower <= TRUE_SLOPE && interval.upper >= TRUE_SLOPE) covered++;
  }

  const coverage = covered / complete;
  const relativeBias = Math.abs(estimateTotal / complete / TRUE_SLOPE - 1);
  expect(complete).toBe(RUNS_PER_SCENARIO);
  expect(relativeBias).toBeLessThan(0.02);
  expect(coverage).toBeGreaterThanOrEqual(0.935);
  expect(coverage).toBeLessThanOrEqual(0.965);
}, 30_000);

test("optimization-sensitivity corpus flags constant results and nonlinear count ranges", () => {
  const runs = 1_000;
  let constantResultsFlagged = 0;
  let nonlinearFixturesFlagged = 0;
  let linearControlsAccepted = 0;
  for (let run = 0; run < runs; run++) {
    const constantResults = ["ignored-output", "constant-input", "loop-invariant"].every((resultHash, fixture) => {
      const observations = [16, 32, 64].map(
        (operations, sequence): MeasurementObservation => ({
          sequence,
          task: `result-${fixture}`,
          phase: "pilot",
          startedAtMs: sequence,
          elapsedMs: 1,
          operations,
          round: sequence,
          seed: run * 3 + sequence,
          resultHash,
          flags: [],
        })
      );
      return diagnoseKernelResults(observations).constantAcrossOperationCounts;
    });
    if (constantResults) constantResultsFlagged++;

    const plan = createKernelRoundPlan(64, run + 1, 0, 0);
    const fitFixture = (elapsedFor: (operations: number) => number) =>
      fitKernelRound(
        0,
        plan.seed,
        plan.points.map(
          (point, sequence): MeasurementObservation => ({
            sequence,
            task: "fixture",
            phase: "measurement",
            startedAtMs: sequence,
            elapsedMs: elapsedFor(point.iterations),
            operations: point.iterations,
            round: 0,
            seed: plan.seed,
            resultHash: `hash:${point.iterations}`,
            flags: [],
          })
        ),
        0.01
      );
    const cacheTransition = fitFixture(
      (operations) => 0.5 + 0.01 * Math.min(operations, 64) + 0.014 * Math.max(0, operations - 64)
    );
    const allocationTransition = fitFixture(
      (operations) => 0.5 + 0.01 * operations + (operations >= 128 ? 0.004 * (operations - 64) : 0)
    );
    if (
      cacheTransition.flags.includes("nonlinear-scaling") &&
      allocationTransition.flags.includes("nonlinear-scaling")
    ) {
      nonlinearFixturesFlagged++;
    }

    const monomorphic = fitFixture((operations) => 0.5 + 0.01 * operations);
    const polymorphic = fitFixture((operations) => 0.7 + 0.012 * operations);
    if (monomorphic.flags.length === 0 && polymorphic.flags.length === 0) linearControlsAccepted++;
  }

  expect(constantResultsFlagged / runs).toBeGreaterThanOrEqual(0.99);
  expect(nonlinearFixturesFlagged / runs).toBeGreaterThanOrEqual(0.95);
  expect(linearControlsAccepted).toBe(runs);
});
