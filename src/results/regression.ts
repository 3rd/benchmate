import type {
  IntervalEvidence,
  KernelRoundModel,
  MeasurementObservation,
  ObservationFlag,
  PairedComparison,
  PairedRoundComparison,
  TaskType,
} from "../types";
import { createIntervalEvidence, mean, studentTInterval } from "./superblocks";

type LinearModel = {
  intercept: number;
  slope: number;
  residuals: readonly number[];
  fitted: readonly number[];
  rSquared: number;
};

type KernelResultDiagnostics = {
  constantAcrossOperationCounts: boolean;
  constantResultSequences: readonly number[];
  hasUnhashableResults: boolean;
  nondeterministic: boolean;
  unhashableResultSequences: readonly number[];
  reasons: readonly string[];
};

type PairedComparisonInput = {
  left: string;
  right: string;
  taskType: TaskType;
  leftValues: readonly number[];
  rightValues: readonly number[];
  orders: readonly (readonly [string, string])[];
  elapsedSinceRunStartMs: readonly number[];
  flags: readonly (readonly ObservationFlag[])[];
  coverage?: IntervalEvidence["coverage"];
};

const diagnoseKernelResults = (
  observations: readonly MeasurementObservation[],
): KernelResultDiagnostics => {
  const byInput = new Map<string, string>();
  const resultHashes: string[] = [];
  const unhashableResultSequences: number[] = [];
  let nondeterministic = false;
  for (const observation of observations) {
    const resultHash = observation.resultHash;
    if (resultHash === null) {
      unhashableResultSequences.push(observation.sequence);
      continue;
    }
    resultHashes.push(resultHash);
    const key = String(observation.operations);
    const previous = byInput.get(key);
    if (previous !== undefined && previous !== resultHash) nondeterministic = true;
    else byInput.set(key, resultHash);
  }
  const hasUnhashableResults = unhashableResultSequences.length > 0;
  const constantAcrossOperationCounts =
    !hasUnhashableResults &&
    new Set(observations.map((observation) => observation.operations)).size >= 3 &&
    new Set(resultHashes).size === 1;
  const reasons: string[] = [];
  if (hasUnhashableResults) {
    reasons.push("one or more kernel results could not be hashed");
  }
  if (nondeterministic) {
    reasons.push("identical kernel iteration counts produced different result hashes");
  }
  if (constantAcrossOperationCounts) {
    reasons.push("kernel results were constant across at least three operation counts");
  }
  return Object.freeze({
    constantAcrossOperationCounts,
    constantResultSequences: Object.freeze(
      constantAcrossOperationCounts ? observations.map((observation) => observation.sequence) : [],
    ),
    hasUnhashableResults,
    nondeterministic,
    unhashableResultSequences: Object.freeze(unhashableResultSequences),
    reasons: Object.freeze(reasons),
  });
};

const fitLinearModel = (xValues: readonly number[], yValues: readonly number[]): LinearModel => {
  if (xValues.length !== yValues.length) {
    throw new Error("Regression x and y values must have the same length.");
  }
  if (xValues.length < 2) throw new Error("Regression requires at least two points.");
  if (xValues.some((value) => !Number.isFinite(value)) || yValues.some((value) => !Number.isFinite(value))) {
    throw new Error("Regression points must be finite.");
  }

  const ordered = xValues
    .map((x, index) => {
      const y = yValues[index];
      if (y === undefined) throw new Error("Regression point invariant failed.");
      return { x, y };
    })
    .sort((left, right) => left.x - right.x);
  const xMean = mean(ordered.map((point) => point.x));
  const yMean = mean(ordered.map((point) => point.y));
  let covariance = 0;
  let xVariance = 0;
  for (const point of ordered) {
    covariance += (point.x - xMean) * (point.y - yMean);
    xVariance += (point.x - xMean) ** 2;
  }
  if (xVariance === 0) throw new Error("Regression operation counts must not all be equal.");

  const slope = covariance / xVariance;
  const intercept = yMean - slope * xMean;
  const fitted = xValues.map((x) => intercept + slope * x);
  const residuals = yValues.map((y, index) => y - (fitted[index] ?? 0));
  const residualSumSquares = residuals.reduce((total, residual) => total + residual ** 2, 0);
  const totalSumSquares = ordered.reduce((total, point) => total + (point.y - yMean) ** 2, 0);
  let rSquared: number;
  if (totalSumSquares === 0) rSquared = residualSumSquares === 0 ? 1 : 0;
  else rSquared = 1 - residualSumSquares / totalSumSquares;

  return Object.freeze({
    intercept,
    slope,
    residuals: Object.freeze(residuals),
    fitted: Object.freeze(fitted),
    rSquared,
  });
};

const fitKernelRound = (
  round: number,
  roundSeed: number,
  observations: readonly MeasurementObservation[],
  targetRelativeHalfWidth: number,
): KernelRoundModel => {
  if (observations.length < 4) throw new Error("A kernel round requires at least four ladder points.");
  const distinctCounts = new Set(observations.map((observation) => observation.operations));
  if (distinctCounts.size < 4) {
    throw new Error("A kernel round requires at least four distinct operation counts.");
  }

  const counts = observations.map((observation) => observation.operations);
  const elapsedMs = observations.map((observation) => observation.elapsedMs);
  const model = fitLinearModel(counts, elapsedMs);
  const ordered = [...observations].sort((left, right) => left.operations - right.operations);
  const low = ordered.slice(0, 3);
  const high = ordered.slice(-3);
  const lowRangeSlopeMsPerOperation = fitLinearModel(
    low.map((observation) => observation.operations),
    low.map((observation) => observation.elapsedMs),
  ).slope;
  const highRangeSlopeMsPerOperation = fitLinearModel(
    high.map((observation) => observation.operations),
    high.map((observation) => observation.elapsedMs),
  ).slope;
  const slopeScale = Math.max(
    Math.abs(lowRangeSlopeMsPerOperation),
    Math.abs(highRangeSlopeMsPerOperation),
  );
  const relativeRangeDifference =
    slopeScale === 0 ?
      Number.POSITIVE_INFINITY
    : Math.abs(lowRangeSlopeMsPerOperation - highRangeSlopeMsPerOperation) / slopeScale;
  const flags: ObservationFlag[] = [];
  if (relativeRangeDifference > Math.max(0.05, 2 * targetRelativeHalfWidth)) flags.push("nonlinear-scaling");

  return Object.freeze({
    round,
    seed: roundSeed >>> 0,
    operationCountOrder: Object.freeze([...counts]),
    interceptMs: model.intercept,
    slopeMsPerOperation: model.slope,
    residualsMs: model.residuals,
    fittedMs: model.fitted,
    rSquaredX: model.rSquared,
    lowRangeSlopeMsPerOperation,
    highRangeSlopeMsPerOperation,
    resultHashes: Object.freeze(observations.map((observation) => observation.resultHash)),
    flags: Object.freeze(flags),
  });
};

const createRoundSlopeInterval = (
  slopes: readonly number[],
  physicalCount: number,
  coverage: IntervalEvidence["coverage"],
): IntervalEvidence | null => {
  const interval = studentTInterval(slopes);
  if (!interval) return null;
  return createIntervalEvidence({
    interval,
    method: "round-slope-t",
    coverage,
    physicalCount,
    effectiveCount: slopes.length,
    assumptions: [
      "final measurement passed the specified drift assessment",
      "pilot reblocking found the specified variance plateau",
      "final round slopes are treated as weakly dependent",
      "the task and runtime stayed within the validated corpus envelope",
    ],
  });
};

const createPairedComparison = (input: PairedComparisonInput): PairedComparison => {
  const {
    left,
    right,
    taskType,
    leftValues,
    rightValues,
    orders,
    elapsedSinceRunStartMs,
    flags,
    coverage = "nominal",
  } = input;
  if (
    leftValues.length !== rightValues.length ||
    leftValues.length !== orders.length ||
    leftValues.length !== elapsedSinceRunStartMs.length ||
    leftValues.length !== flags.length
  ) {
    throw new Error("Paired comparison inputs must have the same length.");
  }
  const rounds: PairedRoundComparison[] = leftValues.map((leftValue, round) => {
    const rightValue = rightValues[round];
    const order = orders[round];
    const elapsedMs = elapsedSinceRunStartMs[round];
    const roundFlags = flags[round];
    if (
      rightValue === undefined ||
      order === undefined ||
      elapsedMs === undefined ||
      roundFlags === undefined
    ) {
      throw new Error("Paired comparison input invariant failed.");
    }
    return Object.freeze({
      round,
      difference: leftValue - rightValue,
      ratioX: rightValue > 0 ? leftValue / rightValue : null,
      order: Object.freeze([...order]) as readonly [string, string],
      elapsedSinceRunStartMs: elapsedMs,
      flags: Object.freeze([...roundFlags]),
    });
  });
  const ratios = rounds.flatMap((round) => (round.ratioX === null ? [] : [round.ratioX]));
  const interval = studentTInterval(rounds.map((round) => round.difference));
  const comparison = {
    left,
    right,
    rounds: Object.freeze(rounds),
    averageDifference: mean(rounds.map((round) => round.difference)),
    averageRatioX: ratios.length === rounds.length ? mean(ratios) : null,
    interval:
      interval === null ? null : (
        createIntervalEvidence({
          interval,
          method: taskType === "kernel" ? "round-slope-t" : "superblock-t",
          coverage,
          physicalCount: rounds.length,
          effectiveCount: rounds.length,
          assumptions: [
            "paired differences use the locked comparative round set",
            "paired round differences are treated as weakly dependent",
          ],
        })
      ),
  };
  if (taskType === "throughput") {
    return Object.freeze({
      ...comparison,
      taskType,
      metric: "throughput",
      unit: "completions-per-second",
      better: "higher",
    });
  }
  return Object.freeze({
    ...comparison,
    taskType,
    metric: "time-per-operation",
    unit: "milliseconds-per-operation",
    better: "lower",
  });
};

export {
  createPairedComparison,
  createRoundSlopeInterval,
  diagnoseKernelResults,
  fitKernelRound,
  fitLinearModel,
};
export type { KernelResultDiagnostics, LinearModel, PairedComparisonInput };
