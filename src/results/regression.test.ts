import { expect, test } from "bun:test";
import type { MeasurementObservation } from "../types";
import {
  createPairedComparison,
  diagnoseKernelResults,
  fitKernelRound,
  fitLinearModel,
} from "./regression";

test("fits an exact elapsed-time intercept and marginal operation slope", () => {
  const model = fitLinearModel([1, 2, 4, 8], [5, 7, 11, 19]);

  expect(model.intercept).toBeCloseTo(3, 12);
  expect(model.slope).toBeCloseTo(2, 12);
  expect(model.fitted).toEqual([5, 7, 11, 19]);
  expect(model.residuals).toEqual([0, 0, 0, 0]);
  expect(model.rSquared).toBe(1);
});

test("retains randomized operation-count order while fitting one complete kernel round", () => {
  const observations: MeasurementObservation[] = [4, 1, 8, 2].map((operations, sequence) => ({
    sequence,
    task: "kernel",
    phase: "measurement",
    startedAtMs: sequence,
    elapsedMs: 3 + 2 * operations,
    operations,
    round: 0,
    seed: sequence,
    resultHash: `hash:${operations}`,
    flags: [],
  }));

  const model = fitKernelRound(0, 42, observations, 0.01);

  expect(model.operationCountOrder).toEqual([4, 1, 8, 2]);
  expect(model.interceptMs).toBeCloseTo(3, 12);
  expect(model.slopeMsPerOperation).toBeCloseTo(2, 12);
  expect(model.lowRangeSlopeMsPerOperation).toBeCloseTo(2, 12);
  expect(model.highRangeSlopeMsPerOperation).toBeCloseTo(2, 12);
  expect(model.flags).toEqual([]);
});

test("flags incompatible low and high operation-count slopes without dropping the round", () => {
  const elapsedMs = new Map([
    [1, 1],
    [2, 2],
    [4, 4],
    [8, 16],
    [16, 32],
  ]);
  const observations: MeasurementObservation[] = [8, 1, 16, 4, 2].map((operations, sequence) => ({
    sequence,
    task: "kernel",
    phase: "measurement",
    startedAtMs: sequence,
    elapsedMs: elapsedMs.get(operations) ?? 0,
    operations,
    round: 0,
    seed: sequence,
    resultHash: `hash:${operations}`,
    flags: [],
  }));

  const model = fitKernelRound(0, 42, observations, 0.01);

  expect(model.flags).toContain("nonlinear-scaling");
  expect(model.operationCountOrder).toEqual([8, 1, 16, 4, 2]);
  expect(model.residualsMs).toHaveLength(5);
});

test("preserves negative paired differences without subtraction clamps", () => {
  const comparison = createPairedComparison({
    left: "left",
    right: "right",
    taskType: "kernel",
    leftValues: [2, 2.2],
    rightValues: [3, 3.2],
    orders: [
      ["left", "right"],
      ["right", "left"],
    ],
    elapsedSinceRunStartMs: [10, 20],
    flags: [[], []],
  });

  expect(comparison.rounds.map((round) => round.difference)).toEqual([-1, -1]);
  expect(comparison.averageDifference).toBe(-1);
  expect(comparison.averageRatioX).toBeCloseTo((2 / 3 + 2.2 / 3.2) / 2, 12);
  expect(comparison).toMatchObject({
    left: "left",
    right: "right",
    metric: "time-per-operation",
    unit: "milliseconds-per-operation",
    better: "lower",
  });
  expect(comparison.interval).toMatchObject({
    lower: -1,
    upper: -1,
    method: "round-slope-t",
    coverage: "nominal",
    physicalCount: 2,
    effectiveCount: 2,
  });
});

test("describes throughput comparisons with explicit units and direction", () => {
  const comparison = createPairedComparison({
    left: "left",
    right: "right",
    taskType: "throughput",
    leftValues: [200, 220],
    rightValues: [100, 110],
    orders: [
      ["left", "right"],
      ["right", "left"],
    ],
    elapsedSinceRunStartMs: [10, 20],
    flags: [[], []],
  });

  expect(comparison).toMatchObject({
    metric: "throughput",
    unit: "completions-per-second",
    better: "higher",
    averageDifference: 105,
    averageRatioX: 2,
  });
});

test("detects result non-determinism for repeated kernel iteration counts", () => {
  const observations: MeasurementObservation[] = ["hash:1", "hash:2"].map((resultHash, sequence) => ({
    sequence,
    task: "kernel",
    phase: "pilot",
    startedAtMs: sequence,
    elapsedMs: 1,
    operations: 8,
    round: sequence,
    seed: 42,
    resultHash,
    flags: [],
  }));

  expect(diagnoseKernelResults(observations)).toMatchObject({
    nondeterministic: true,
    constantAcrossOperationCounts: false,
    reasons: ["identical kernel iteration counts produced different result hashes"],
  });
});

test("distinguishes unhashable kernel results from constant results", () => {
  const observations: MeasurementObservation[] = [1, 2, 4].map((operations, sequence) => ({
    sequence,
    task: "kernel",
    phase: "pilot",
    startedAtMs: sequence,
    elapsedMs: 1,
    operations,
    round: sequence,
    seed: 42,
    resultHash: null,
    flags: [],
  }));

  expect(diagnoseKernelResults(observations)).toMatchObject({
    constantAcrossOperationCounts: false,
    hasUnhashableResults: true,
    unhashableResultSequences: [0, 1, 2],
    reasons: ["one or more kernel results could not be hashed"],
  });
});
