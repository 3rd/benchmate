import { expect, test } from "bun:test";
import type { CallBenchmarkResult, KernelBenchmarkResult, MeasurementObservation } from "../types";
import { areResultsComparable } from "./finalize";
import { printResults } from "./print";
import { computeCallStats } from "./stats";

const callResult = (name: string): CallBenchmarkResult => {
  const observation: MeasurementObservation = {
    sequence: 0,
    task: name,
    phase: "measurement",
    startedAtMs: 0,
    elapsedMs: 1,
    operations: 1,
    round: 0,
    seed: 1,
    resultHash: null,
    flags: [],
  };
  return {
    name,
    taskType: "call",
    stats: computeCallStats([observation]),
    evidence: {
      schemaVersion: 5,
      taskType: "call",
      measurement: "auto",
      schedule: "isolated",
      status: "complete",
      reasons: [],
      observations: [observation],
      interval: null,
    },
    metadata: {
      executionKind: "sync",
      schedule: { seed: null, yieldBetweenRounds: false, rows: [] },
      plan: null,
    },
  };
};

const kernelResult = (name: string): KernelBenchmarkResult => {
  const summary = {
    min: 1,
    max: 1,
    average: 1,
    median: 1,
    percentile50: 1,
    percentile90: 1,
    percentile95: 1,
  };
  return {
    name,
    taskType: "kernel",
    stats: {
      operations: 1,
      rounds: 1,
      elapsedMs: 1,
      timePerOperationMs: summary,
      operationsPerSecond: { min: 1000, max: 1000, average: 1000 },
    },
    evidence: {
      schemaVersion: 5,
      taskType: "kernel",
      measurement: "auto",
      schedule: "isolated",
      status: "complete",
      reasons: [],
      observations: [],
      interval: null,
    },
    metadata: {
      executionKind: "sync",
      schedule: { seed: null, yieldBetweenRounds: false, rows: [] },
      kernel: null,
      plan: null,
    },
  };
};

test("compares only complete results with the same task type, measurement, schedule, and interval semantics", () => {
  const left = callResult("left");
  const right = callResult("right");
  expect(areResultsComparable(left, right)).toBeTrue();
  expect(
    areResultsComparable(left, { ...right, evidence: { ...right.evidence, status: "unstable" } }),
  ).toBeFalse();
  expect(areResultsComparable(left, kernelResult("kernel"))).toBeFalse();
  expect(
    areResultsComparable(left, { ...right, evidence: { ...right.evidence, measurement: "iterations" } }),
  ).toBeFalse();
  expect(
    areResultsComparable(left, { ...right, evidence: { ...right.evidence, schedule: "comparative" } }),
  ).toBeFalse();
  expect(
    areResultsComparable(left, { ...right, metadata: { ...right.metadata, executionKind: "async" } }),
  ).toBeFalse();
});

test("prints paired ratio, raw difference, and interval evidence", () => {
  const createComparativeResult = (name: string, elapsedMs: readonly number[]): CallBenchmarkResult => {
    const base = callResult(name);
    const observations = elapsedMs.map(
      (value, round): MeasurementObservation => ({
        ...base.evidence.observations[0]!,
        sequence: round,
        task: name,
        elapsedMs: value,
        round,
      }),
    );
    return {
      ...base,
      stats: computeCallStats(observations),
      evidence: {
        ...base.evidence,
        schedule: "comparative",
        observations,
        interval: {
          confidenceLevelX: 0.95,
          lower: 1,
          upper: 2,
          method: "superblock-t",
          coverage: "validated-corpus-v1",
          physicalCount: 2,
          effectiveCount: 2,
          assumptions: [],
        },
      },
      metadata: {
        ...base.metadata,
        schedule: {
          seed: 42,
          yieldBetweenRounds: false,
          rows: [
            ["left", "right"],
            ["right", "left"],
          ],
        },
      },
    };
  };
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values) => lines.push(values.join(" "));
  try {
    printResults([createComparativeResult("left", [1, 1]), createComparativeResult("right", [2, 2])]);
  } finally {
    console.log = originalLog;
  }

  const output = lines.join("\n");
  expect(output).toContain("ratio 0.5000");
  expect(output).toContain("difference -1.00ms");
  expect(output).toContain("superblock-t, validated-corpus-v1");
});
