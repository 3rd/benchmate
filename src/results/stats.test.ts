import { expect, test } from "bun:test";
import type { MeasurementObservation, MeasurementPhase } from "../types";
import {
  computeCallStats,
  computeThroughputStats,
  diagnoseNoiseFlags,
  diagnosePairedNoiseFlags,
} from "./stats";

const observation = (
  sequence: number,
  elapsedMs: number,
  operations: number,
  phase: MeasurementPhase = "measurement",
): MeasurementObservation => ({
  sequence,
  task: "task",
  phase,
  startedAtMs: sequence,
  elapsedMs,
  operations,
  round: null,
  seed: null,
  resultHash: null,
  flags: [],
});

test("summarizes only raw measurement observations without reordering the trace", () => {
  const observations = [observation(0, 9, 3), observation(1, 100, 1, "pilot"), observation(2, 4, 2)];
  const result = computeCallStats(observations);

  expect(result.operations).toBe(5);
  expect(result.blocks).toBe(2);
  expect(result.elapsedMs).toBe(13);
  expect(result.timePerOperationMs.average).toBe(2.6);
  expect(result.timePerOperationMs.min).toBe(2);
  expect(result.timePerOperationMs.max).toBe(3);
  expect(observations.map(({ sequence }) => sequence)).toEqual([0, 1, 2]);
});

test("keeps raw totals canonical when the harness model is negative", () => {
  const result = computeCallStats([observation(4, 1, 10)], {
    perInvocationMs: 0.2,
    sampleCount: 5,
    observationSequences: [0, 1, 2, 3, 4],
  });

  expect(result.elapsedMs).toBe(1);
  expect(result.timePerOperationMs.average).toBe(0.1);
  expect(result.harnessOverhead.modeledRemainderMs.total).toBe(-1);
  expect(result.harnessOverhead.modeledRemainderMs.average).toBe(-0.1);
  expect(result.harnessOverhead.observationSequences).toEqual([0, 1, 2, 3, 4]);
  expect(Object.isFrozen(result.harnessOverhead.observationSequences)).toBeTrue();
});

test("reports throughput block makespan without presenting divided serial latency", () => {
  const result = computeThroughputStats([observation(0, 10, 20), observation(1, 20, 20)]);

  expect(result.completions).toBe(40);
  expect(result.elapsedMs).toBe(30);
  expect(result.blockDurationMs.average).toBe(15);
  expect(result.blockDurationMs.min).toBe(10);
  expect(result.blockDurationMs.max).toBe(20);
  expect(result.completionsPerSecond.average).toBeCloseTo(1333.333_333, 6);
});

test("flags pause-like blocks while retaining their sequence in the raw trace", () => {
  const observations = Array.from({ length: 20 }, (_, sequence) =>
    observation(sequence, sequence === 12 ? 100 : 1, 1),
  );
  const assignments = diagnoseNoiseFlags(
    observations,
    {
      provider: "performance.now",
      method: "auto",
      monotonic: true,
      sampleCount: 2048,
      minimumPositiveTickMs: 0.0001,
      zeroDeltaRateX: 0,
      readPairCostMs: { p50: 0.0001, p99: 0.0001 },
    },
    0.01,
  );

  expect(assignments.find((assignment) => assignment.sequence === 12)?.flags).toContain("pause-like");
  expect(observations).toHaveLength(20);
  expect(observations[12]?.elapsedMs).toBe(100);
});

test("flags deterministic final drift and step changes without removing any block", () => {
  const observations = Array.from({ length: 40 }, (_, sequence) =>
    observation(sequence, sequence < 20 ? 1 : 1.1, 1),
  );
  const assignments = diagnoseNoiseFlags(
    observations,
    {
      provider: "performance.now",
      method: "auto",
      monotonic: true,
      sampleCount: 2048,
      minimumPositiveTickMs: 0.0001,
      zeroDeltaRateX: 0,
      readPairCostMs: { p50: 0.0001, p99: 0.0001 },
    },
    0.01,
  );

  expect(assignments).toHaveLength(40);
  expect(assignments.every((assignment) => assignment.flags.includes("drift-detected"))).toBeTrue();
  expect(assignments.every((assignment) => assignment.flags.includes("change-detected"))).toBeTrue();
  expect(observations).toHaveLength(40);
});

test("paired diagnostics ignore common drift and retain task-specific change evidence", () => {
  const createSeries = (
    task: string,
    sequenceOffset: number,
    taskChange: boolean,
  ): MeasurementObservation[] =>
    Array.from({ length: 40 }, (_, round) => ({
      ...observation(
        sequenceOffset + round,
        (1 + 0.1 * (round / 39)) * (taskChange && round >= 20 ? 1.1 : 1),
        1,
      ),
      task,
      round,
    }));
  const left = createSeries("left", 0, false);
  const commonDriftRight = createSeries("right", 100, false).map((entry) => ({
    ...entry,
    elapsedMs: entry.elapsedMs * 1.05,
  }));
  const changedRight = createSeries("right", 100, true).map((entry) => ({
    ...entry,
    elapsedMs: entry.elapsedMs * 1.05,
  }));

  expect(
    diagnosePairedNoiseFlags({
      leftObservations: left,
      rightObservations: commonDriftRight,
      metric: "time-per-operation",
      targetRelativeHalfWidth: 0.01,
    }),
  ).toEqual([]);
  const changed = diagnosePairedNoiseFlags({
    leftObservations: left,
    rightObservations: changedRight,
    metric: "time-per-operation",
    targetRelativeHalfWidth: 0.01,
  });
  expect(changed).toHaveLength(80);
  expect(changed.every((assignment) => assignment.flags.includes("change-detected"))).toBeTrue();
});

test("paired throughput diagnostics use completion rates", () => {
  const ratios = Array.from({ length: 8 }, (_, round) =>
    Math.exp((Math.log(1.010_05) * round) / 7),
  );
  const left = ratios.map((ratio, round) => ({
    ...observation(round, 100 / ratio, 100),
    task: "left",
    round,
  }));
  const right = ratios.map((_, round) => ({
    ...observation(100 + round, 100, 100),
    task: "right",
    round,
  }));

  const assignments = diagnosePairedNoiseFlags({
    leftObservations: left,
    rightObservations: right,
    metric: "throughput",
    targetRelativeHalfWidth: 0.01,
  });

  expect(assignments).toHaveLength(16);
  expect(assignments.every((assignment) => assignment.flags.includes("drift-detected"))).toBeTrue();
});
