import type { ClockProfile, EvidenceStatus, IntervalEvidence, ResolvedAutoOptions } from "../types";
import {
  assessStability,
  createIntervalEvidence,
  findDependencePlan,
  groupMeans,
  mean,
  median,
  planEffectiveCount,
  sampleVariance,
  studentTInterval,
} from "../results/superblocks";

type AutoUnit = {
  elapsedMs: number;
  value: number;
  operations: number;
};

type AutoStage = "measurement" | "pilot" | "sizing" | "warmup";

type AutoUnitRunner = (stage: AutoStage, operations: number, round: number) => Promise<AutoUnit>;

type AutoPlan = {
  operationsPerBlock: number;
  physicalBlocksPerSuperblock: number;
  physicalBlockCount: number;
  effectiveBlockCount: number;
  plannedDurationMs: number;
  remainingBudgetMs: number;
  precisionX: number;
  pilotMean: number;
  pilotStandardDeviation: number;
};

type AutoPlanInput = {
  auto: ResolvedAutoOptions;
  elapsedMs: number;
  operationsPerBlock: number;
  pilotDurations: readonly number[];
  pilotValues: readonly number[];
  physicalBlocksPerSuperblock: number;
};

type AutoOutcome = {
  status: EvidenceStatus;
  reasons: readonly string[];
  interval: IntervalEvidence | null;
  plan: AutoPlan | null;
  elapsedMs: number;
  measurementValues: readonly number[];
};

type AutoRunOptions = {
  auto: ResolvedAutoOptions;
  clock: ClockProfile;
  runUnit: AutoUnitRunner;
  intervalScale: "identity" | "inverse-ms";
  coverage?: IntervalEvidence["coverage"];
  onPlan?: (plan: AutoPlan) => void;
};

type MinimumBlockDurationResolver = (clock: ClockProfile, precisionX: number) => number;

const MINIMUM_BLOCK_DURATION = 2;
const MAX_OPERATIONS_PER_BLOCK = 0x40_00_00_00;

const getMinimumBlockDuration: MinimumBlockDurationResolver = (clock, precisionX) => {
  const errorAllocation = precisionX * 0.1;
  const quantizationFloor = (2 * clock.minimumPositiveTickMs) / errorAllocation;
  const readCostFloor = clock.readPairCostMs.p99 / errorAllocation;
  return Math.max(MINIMUM_BLOCK_DURATION, quantizationFloor, readCostFloor);
};

const incomplete = (
  status: EvidenceStatus,
  reason: string,
  elapsedMs: number,
  measurementValues: readonly number[] = [],
  plan: AutoPlan | null = null,
): AutoOutcome => ({
  status,
  reasons: Object.freeze([reason]),
  interval: null,
  plan,
  elapsedMs,
  measurementValues: Object.freeze([...measurementValues]),
});

const createAutoInterval = (
  values: readonly number[],
  physicalBlocksPerSuperblock: number,
  intervalScale: AutoRunOptions["intervalScale"],
  coverage: IntervalEvidence["coverage"],
): IntervalEvidence | null => {
  const superblocks = groupMeans(values, physicalBlocksPerSuperblock);
  const scalar = studentTInterval(superblocks);
  if (!scalar) return null;
  const assumptions = Object.freeze([
    "final measurement passed the specified drift assessment",
    "pilot reblocking found the specified variance plateau",
    "final superblock means are treated as weakly dependent",
    "the task and runtime stayed within the validated corpus envelope",
  ]);
  if (intervalScale === "identity") {
    return createIntervalEvidence({
      interval: scalar,
      method: "superblock-t",
      coverage,
      physicalCount: values.length,
      effectiveCount: superblocks.length,
      assumptions,
    });
  }
  const lower = scalar.upper > 0 ? 1000 / scalar.upper : 0;
  const upper = scalar.lower > 0 ? 1000 / scalar.lower : null;
  return {
    confidenceLevelX: 0.95,
    lower,
    upper,
    method: "superblock-t",
    coverage,
    physicalCount: values.length,
    effectiveCount: superblocks.length,
    assumptions,
  };
};

const createAutoPlan = (input: AutoPlanInput): AutoPlan | null => {
  const pilotSuperblocks = groupMeans(input.pilotValues, input.physicalBlocksPerSuperblock);
  const pilotMean = mean(pilotSuperblocks);
  const pilotStandardDeviation = Math.sqrt(sampleVariance(pilotSuperblocks));
  const effectiveBlockCount = planEffectiveCount(
    pilotMean,
    pilotStandardDeviation,
    input.auto.precisionX,
    input.auto.minEffectiveBlocks,
  );
  if (effectiveBlockCount === null) return null;
  const physicalBlockCount = effectiveBlockCount * input.physicalBlocksPerSuperblock;
  return Object.freeze({
    operationsPerBlock: input.operationsPerBlock,
    physicalBlocksPerSuperblock: input.physicalBlocksPerSuperblock,
    physicalBlockCount,
    effectiveBlockCount,
    plannedDurationMs: median(input.pilotDurations) * physicalBlockCount * 1.2,
    remainingBudgetMs: input.auto.maxTimeMs - input.elapsedMs,
    precisionX: input.auto.precisionX,
    pilotMean,
    pilotStandardDeviation,
  });
};

const runAutoMeasurement = async (options: AutoRunOptions): Promise<AutoOutcome> => {
  const { auto, clock, runUnit, intervalScale } = options;
  const coverage = options.coverage ?? "nominal";
  const minimumBlockDuration = getMinimumBlockDuration(clock, auto.precisionX);
  let elapsedMs = 0;
  let warmupElapsed = 0;
  let operationsPerBlock = 1;
  let warmupRound = 0;

  for (;;) {
    const durations: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      if (elapsedMs >= auto.maxTimeMs || warmupElapsed >= auto.maxWarmupTimeMs) {
        return incomplete(
          "timer-limited",
          "timer-safe block sizing exhausted the warmup or task budget",
          elapsedMs,
        );
      }
      const unit = await runUnit("sizing", operationsPerBlock, warmupRound++);
      elapsedMs += unit.elapsedMs;
      warmupElapsed += unit.elapsedMs;
      if (attempt > 0) durations.push(unit.elapsedMs);
    }
    if (median(durations) >= minimumBlockDuration) break;
    if (operationsPerBlock > MAX_OPERATIONS_PER_BLOCK / 2) {
      return incomplete(
        "timer-limited",
        "task could not reach the timer-safe minimum block duration",
        elapsedMs,
      );
    }
    operationsPerBlock *= 2;
  }

  const warmupValues: number[] = [];
  let consecutiveStableChecks = 0;
  while (consecutiveStableChecks < 2) {
    if (elapsedMs >= auto.maxTimeMs || warmupElapsed >= auto.maxWarmupTimeMs) {
      return incomplete(
        "warmup-not-converged",
        "warmup did not pass two consecutive stability checks",
        elapsedMs,
      );
    }
    const unit = await runUnit("warmup", operationsPerBlock, warmupRound++);
    elapsedMs += unit.elapsedMs;
    warmupElapsed += unit.elapsedMs;
    warmupValues.push(unit.value);
    if (warmupValues.length < 30 || warmupValues.length % 5 !== 0) continue;
    const stability = assessStability(warmupValues.slice(-30), Math.max(0.01, auto.precisionX));
    consecutiveStableChecks = stability.stable ? consecutiveStableChecks + 1 : 0;
  }

  const pilotValues: number[] = [];
  const pilotDurations: number[] = [];
  let pilotRound = 0;
  let dependencePlan = null;
  while (dependencePlan === null) {
    const targetCount = pilotValues.length + auto.minPilotBlocks;
    while (pilotValues.length < targetCount) {
      if (elapsedMs >= auto.maxTimeMs) {
        return incomplete(
          "dependence-unresolved",
          "pilot budget ended before a variance plateau was established",
          elapsedMs,
        );
      }
      const unit = await runUnit("pilot", operationsPerBlock, pilotRound++);
      elapsedMs += unit.elapsedMs;
      pilotValues.push(unit.value);
      pilotDurations.push(unit.elapsedMs);
    }
    dependencePlan = findDependencePlan(pilotValues);
  }

  const plan = createAutoPlan({
    auto,
    elapsedMs,
    operationsPerBlock,
    pilotDurations,
    pilotValues,
    physicalBlocksPerSuperblock: dependencePlan.superblockSize,
  });
  if (plan === null) {
    return incomplete(
      "unidentifiable",
      "pilot mean or variance could not support a finite confirmation plan",
      elapsedMs,
    );
  }
  options.onPlan?.(plan);
  if (plan.plannedDurationMs > plan.remainingBudgetMs) {
    return incomplete(
      "insufficient-budget",
      "locked confirmation plan exceeds the remaining measured-task budget",
      elapsedMs,
      [],
      plan,
    );
  }

  const measurementValues: number[] = [];
  for (let round = 0; round < plan.physicalBlockCount; round++) {
    if (elapsedMs >= auto.maxTimeMs) {
      return incomplete(
        "insufficient-budget",
        "measured-task budget ended before the locked confirmation plan completed",
        elapsedMs,
        measurementValues,
        plan,
      );
    }
    const unit = await runUnit("measurement", operationsPerBlock, round);
    elapsedMs += unit.elapsedMs;
    measurementValues.push(unit.value);
  }

  const finalSuperblocks = groupMeans(measurementValues, dependencePlan.superblockSize);
  const scalarInterval = studentTInterval(finalSuperblocks);
  if (!scalarInterval) {
    return incomplete("failed", "final interval could not be calculated", elapsedMs, measurementValues, plan);
  }
  const relativeHalfWidth =
    scalarInterval.mean === 0 ?
      Number.POSITIVE_INFINITY
    : scalarInterval.halfWidth / Math.abs(scalarInterval.mean);
  if (relativeHalfWidth > auto.precisionX) {
    return incomplete(
      "precision-missed",
      "final interval exceeded the requested relative half-width",
      elapsedMs,
      measurementValues,
      plan,
    );
  }
  const stability = assessStability(finalSuperblocks, Math.max(0.01, auto.precisionX));
  if (stability.quantized) {
    return incomplete(
      "timer-limited",
      "final confirmation stream was dominated by clock quantization",
      elapsedMs,
      measurementValues,
      plan,
    );
  }
  if (!stability.stable) {
    return incomplete(
      "unstable",
      "final superblock drift exceeded the stability tolerance",
      elapsedMs,
      measurementValues,
      plan,
    );
  }
  const interval = createAutoInterval(
    measurementValues,
    dependencePlan.superblockSize,
    intervalScale,
    coverage,
  );
  if (!interval) {
    return incomplete(
      "failed",
      "final evidence interval could not be constructed",
      elapsedMs,
      measurementValues,
      plan,
    );
  }

  return {
    status: "complete",
    reasons: Object.freeze([]),
    interval,
    plan,
    elapsedMs,
    measurementValues: Object.freeze(measurementValues),
  };
};

export { createAutoInterval, createAutoPlan, getMinimumBlockDuration, runAutoMeasurement };
export type { AutoOutcome, AutoPlan, AutoPlanInput, AutoRunOptions, AutoStage, AutoUnit, AutoUnitRunner };
