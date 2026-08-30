import { expect, test } from "bun:test";
import { createPhaseSchedule } from "../../src/execution/schedule";
import { createPairedComparison } from "../../src/results/regression";
import { diagnosePairedNoiseFlags, diagnosePauseFlags } from "../../src/results/stats";
import type { MeasurementObservation } from "../../src/types";

const CANDIDATE_TIME = 1;
const CONTROL_TIME = 1.05;
const TRUE_RATIO = CANDIDATE_TIME / CONTROL_TIME;

type Effect = (period: number, periodCount: number, task: string, previousTask: string | null) => number;

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

const baseTime = (task: string) => (task === "candidate" ? CANDIDATE_TIME : CONTROL_TIME);

const acquireBalanced = (seed: number, effect: Effect) => {
  const plan = createPhaseSchedule(["candidate", "control"], seed, "measurement", 20);
  const periodCount = plan.rows.reduce((total, row) => total + row.length, 0);
  const observations: MeasurementObservation[] = [];
  let period = 0;
  let previousTask: string | null = null;
  for (let round = 0; round < plan.rows.length; round++) {
    const row = plan.rows[round] ?? [];
    for (const task of row) {
      observations.push({
        sequence: period,
        task,
        phase: "measurement",
        startedAtMs: period,
        elapsedMs: baseTime(task) * effect(period, periodCount, task, previousTask),
        operations: 1,
        round,
        seed,
        resultHash: null,
        flags: [],
      });
      previousTask = task;
      period++;
    }
  }
  const byRound = new Map<number, Map<string, number[]>>();
  for (const observation of observations) {
    const tasks = byRound.get(observation.round ?? 0) ?? new Map<string, number[]>();
    const values = tasks.get(observation.task) ?? [];
    values.push(observation.elapsedMs);
    tasks.set(observation.task, values);
    byRound.set(observation.round ?? 0, tasks);
  }
  const ratios = [...byRound.values()].map((tasks) => {
    const candidate = tasks.get("candidate") ?? [];
    const control = tasks.get("control") ?? [];
    return candidate.reduce((total, value) => total + value, 0) / candidate.length /
      (control.reduce((total, value) => total + value, 0) / control.length);
  });
  return { ratio: ratios.reduce((total, ratio) => total + ratio, 0) / ratios.length, observations };
};

const acquireRegistrationOrder = (effect: Effect) => {
  const taskBlocks = 80;
  const tasks = [...Array.from({ length: taskBlocks }, () => "candidate"), ...Array.from({ length: taskBlocks }, () => "control")];
  const values = new Map<string, number[]>();
  let previousTask: string | null = null;
  for (let period = 0; period < tasks.length; period++) {
    const task = tasks[period] ?? "";
    const taskValues = values.get(task) ?? [];
    taskValues.push(baseTime(task) * effect(period, tasks.length, task, previousTask));
    values.set(task, taskValues);
    previousTask = task;
  }
  const candidate = values.get("candidate") ?? [];
  const control = values.get("control") ?? [];
  return candidate.reduce((total, value) => total + value, 0) / candidate.length /
    (control.reduce((total, value) => total + value, 0) / control.length);
};

test("balanced comparative measurement beats registration order across deterministic period effects", () => {
  const balancedErrors: number[] = [];
  const registrationErrors: number[] = [];
  let maximumLinearDifferenceBias = 0;
  for (let seed = 0; seed < 1_000; seed++) {
    const direction = seed % 2 === 0 ? 1 : -1;
    const effects: Effect[] = [
      (period, count) => 1 + direction * 0.1 * (period / (count - 1)),
      (period, count) => 1 + 0.1 * Math.sin((period / count) * Math.PI * 2 + (seed / 1_000) * Math.PI * 2),
      (period, count) => (period >= count * (0.35 + (seed % 30) / 100) ? 1 + direction * 0.1 : 1),
      (period) => 1 + (period % 2 === 0 ? -0.05 : 0.05),
      (_period, _count, _task, previousTask) =>
        previousTask === null ? 1 : previousTask === "candidate" ? 1.05 : 0.95,
    ];
    for (let effectIndex = 0; effectIndex < effects.length; effectIndex++) {
      const effect = effects[effectIndex];
      if (!effect) continue;
      const balanced = acquireBalanced(seed, effect).ratio;
      const registration = acquireRegistrationOrder(effect);
      balancedErrors.push(Math.abs(balanced / TRUE_RATIO - 1));
      registrationErrors.push(Math.abs(registration / TRUE_RATIO - 1));
      if (effectIndex === 0) {
        const estimatedDifference = 1 - balanced;
        const trueDifference = 1 - TRUE_RATIO;
        maximumLinearDifferenceBias = Math.max(maximumLinearDifferenceBias, Math.abs(estimatedDifference - trueDifference));
      }
    }
  }

  expect(maximumLinearDifferenceBias).toBeLessThan(0.005);
  expect(median(balancedErrors)).toBeLessThan(median(registrationErrors));
});

test("paired diagnostics reject task-period interaction and retain every injected pause", () => {
  let falseComplete = 0;
  let retainedAndFlaggedPauses = 0;
  const clock = {
    provider: "performance.now" as const,
    method: "auto" as const,
    monotonic: true,
    sampleCount: 2048,
    minimumPositiveTickMs: 0.0001,
    zeroDeltaRateX: 0,
    readPairCostMs: { p50: 0.0001, p99: 0.0001 },
  };
  for (let seed = 0; seed < 1_000; seed++) {
    const interaction = acquireBalanced(
      seed,
      (period, count, task) => (task === "candidate" ? 1 + 0.1 * (period / (count - 1)) : 1)
    ).observations;
    const candidate = interaction.filter((observation) => observation.task === "candidate");
    const control = interaction.filter((observation) => observation.task === "control");
    const assignments = diagnosePairedNoiseFlags({
      leftObservations: candidate,
      rightObservations: control,
      metric: "time-per-operation",
      targetRelativeHalfWidth: 0.01,
    });
    if (!assignments.some((assignment) => assignment.flags.includes("drift-detected"))) falseComplete++;

    if (seed >= 100) continue;
    const pauseIndex = seed % candidate.length;
    const paused = candidate.map((observation, index) =>
      index === pauseIndex ? { ...observation, elapsedMs: observation.elapsedMs * 10 } : observation
    );
    const injected = paused[pauseIndex];
    const pauseAssignments = diagnosePauseFlags(paused, clock);
    if (
      injected !== undefined &&
      paused.length === candidate.length &&
      injected.elapsedMs === candidate[pauseIndex]!.elapsedMs * 10 &&
      pauseAssignments.some(
        (assignment) => assignment.sequence === injected.sequence && assignment.flags.includes("pause-like")
      )
    ) {
      retainedAndFlaggedPauses++;
    }
  }

  expect(falseComplete / 1_000).toBeLessThanOrEqual(0.05);
  expect(retainedAndFlaggedPauses).toBe(100);
});

test("paired-difference interval corpus meets 95% coverage", () => {
  const runs = Number(process.env.BENCHMATE_CORPUS_COUNT ?? 10_000);
  let covered = 0;
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

  for (let run = 0; run < runs; run++) {
    const normal = createNormal(createRandom(200_001 + run));
    const left: number[] = [];
    const right: number[] = [];
    for (let round = 0; round < 20; round++) {
      const commonNoise = normal() * 0.01;
      left.push(1 + commonNoise + normal() * 0.002);
      right.push(1.05 + commonNoise + normal() * 0.002);
    }
    const comparison = createPairedComparison({
      left: "left",
      right: "right",
      taskType: "call",
      leftValues: left,
      rightValues: right,
      orders: Array.from({ length: 20 }, (_, round) =>
        round % 2 === 0
          ? (["left", "right"] as const)
          : (["right", "left"] as const)
      ),
      elapsedSinceRunStartMs: Array.from({ length: 20 }, (_, round) => round),
      flags: Array.from({ length: 20 }, () => []),
      coverage: "validated-corpus-v1",
    });
    const interval = comparison.interval;
    if (interval && interval.upper !== null && interval.lower <= -0.05 && interval.upper >= -0.05) covered++;
  }

  const coverage = covered / runs;
  expect(coverage).toBeGreaterThanOrEqual(0.935);
  expect(coverage).toBeLessThanOrEqual(0.965);
});
