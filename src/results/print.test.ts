import { expect, test } from "bun:test";
import type {
  CallBenchmarkResult,
  ClockProfile,
  KernelBenchmarkResult,
  MeasurementObservation,
} from "../types";
import { areResultsComparable } from "./finalize";
import { printResult, printResults } from "./print";
import { computeCallStats } from "./stats";

const clock: ClockProfile = {
  provider: "performance.now",
  method: "auto",
  monotonic: true,
  sampleCount: 2048,
  minimumPositiveTickMs: 0.001,
  zeroDeltaRateX: 0,
  readPairCostMs: { p50: 0.001, p99: 0.001 },
};

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
      schemaVersion: 6,
      taskType: "call",
      measurement: "auto",
      schedule: "isolated",
      status: "complete",
      reasons: [],
      statsProvenance: { observationPhase: "measurement", modelPhase: null },
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
      schemaVersion: 6,
      taskType: "kernel",
      measurement: "auto",
      schedule: "isolated",
      status: "complete",
      reasons: [],
      statsProvenance: { observationPhase: "measurement", modelPhase: "measurement" },
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

test("labels incomplete descriptive statistics by observation and kernel model provenance", () => {
  const call = callResult("call");
  const kernel = kernelResult("kernel");
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values) => lines.push(values.join(" "));
  try {
    printResult(
      {
        ...call,
        evidence: {
          ...call.evidence,
          status: "warmup-not-converged",
          statsProvenance: { observationPhase: "warmup", modelPhase: null },
        },
      },
      clock,
    );
    printResult(
      {
        ...kernel,
        evidence: {
          ...kernel.evidence,
          status: "dependence-unresolved",
          statsProvenance: { observationPhase: "measurement", modelPhase: "pilot" },
        },
      },
      clock,
    );
  } finally {
    console.log = originalLog;
  }

  const output = lines.join("\n");
  expect(output).toContain("descriptive statistics:");
  expect(output).toContain("warmup observations");
  expect(output).toContain("measurement observations, pilot kernel regression models");
});
