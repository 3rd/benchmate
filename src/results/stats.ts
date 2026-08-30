import type {
  CallStats,
  ClockProfile,
  EndToEndStats,
  HarnessOverhead,
  KernelStats,
  KernelRoundModel,
  MeasurementObservation,
  MeasurementPhase,
  ObservationFlag,
  PairedComparison,
  ThroughputStats,
  TimeSummary,
} from "../types";
import { assessStability } from "./superblocks";

type HarnessOverheadInput = Pick<
  HarnessOverhead,
  "observationSequences" | "perInvocationMs" | "sampleCount"
>;

type NoiseFlagAssignment = {
  sequence: number;
  flags: readonly ObservationFlag[];
};

type FlagAssignments = Map<number, Set<ObservationFlag>>;

type PairedNoiseDiagnosticsInput = {
  leftObservations: readonly MeasurementObservation[];
  rightObservations: readonly MeasurementObservation[];
  metric: PairedComparison["metric"];
  targetRelativeHalfWidth: number;
};

type PairedNoiseDiagnostics = (
  input: PairedNoiseDiagnosticsInput,
) => readonly NoiseFlagAssignment[];

const EMPTY_OVERHEAD: HarnessOverheadInput = {
  perInvocationMs: 0,
  sampleCount: 0,
  observationSequences: [],
};

const sum = (values: readonly number[]) => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

const mean = (values: readonly number[]) => (values.length === 0 ? 0 : sum(values) / values.length);

const quantileSorted = (sortedValues: readonly number[], probability: number) => {
  const position = (sortedValues.length - 1) * probability;
  const lower = sortedValues[Math.floor(position)];
  const upper = sortedValues[Math.ceil(position)];
  if (lower === undefined || upper === undefined) return 0;
  return lower + (upper - lower) * (position - Math.floor(position));
};

type TimeSummaryBuilder = (sortedValues: readonly number[], average: number) => TimeSummary;
type EndToEndStatsComputer = (
  observations: readonly MeasurementObservation[],
  phase?: MeasurementPhase,
) => EndToEndStats;

const createTimeSummary: TimeSummaryBuilder = (sortedValues, average) => {
  const median = quantileSorted(sortedValues, 0.5);
  return {
    min: sortedValues[0] ?? 0,
    max: sortedValues.at(-1) ?? 0,
    average,
    median,
    percentile50: median,
    percentile90: quantileSorted(sortedValues, 0.9),
    percentile95: quantileSorted(sortedValues, 0.95),
  };
};

const addFlag = (assigned: FlagAssignments, sequence: number, flag: ObservationFlag) => {
  const flags = assigned.get(sequence) ?? new Set<ObservationFlag>();
  flags.add(flag);
  assigned.set(sequence, flags);
};

const snapshotAssignments = (assigned: FlagAssignments): readonly NoiseFlagAssignment[] => {
  return Object.freeze(
    [...assigned]
      .sort(([left], [right]) => left - right)
      .map(([sequence, flags]) => Object.freeze({ sequence, flags: Object.freeze([...flags]) })),
  );
};

const computeLatencyStats = (
  observations: readonly MeasurementObservation[],
  phase: MeasurementPhase = "measurement",
): EndToEndStats => {
  const measured = observations.filter((observation) => observation.phase === phase);
  const operations = sum(measured.map((observation) => observation.operations));
  const elapsedMs = sum(measured.map((observation) => observation.elapsedMs));
  const timePerOperationMs = measured
    .map((observation) => observation.elapsedMs / observation.operations)
    .sort((a, b) => a - b);
  const min = timePerOperationMs[0] ?? 0;
  const max = timePerOperationMs.at(-1) ?? 0;
  const average = operations > 0 ? elapsedMs / operations : 0;

  return {
    operations,
    blocks: measured.length,
    elapsedMs,
    timePerOperationMs: createTimeSummary(timePerOperationMs, average),
    operationsPerSecond: {
      min: max > 0 ? 1000 / max : null,
      max: min > 0 ? 1000 / min : null,
      average: elapsedMs > 0 ? (operations / elapsedMs) * 1000 : null,
    },
  };
};

const computeCallStats = (
  observations: readonly MeasurementObservation[],
  overheadInput: HarnessOverheadInput = EMPTY_OVERHEAD,
  phase: MeasurementPhase = "measurement",
): CallStats => {
  const stats = computeLatencyStats(observations, phase);
  const modeledTotalMs = stats.elapsedMs - overheadInput.perInvocationMs * stats.operations;
  return {
    ...stats,
    harnessOverhead: {
      perInvocationMs: overheadInput.perInvocationMs,
      sampleCount: overheadInput.sampleCount,
      observationSequences: Object.freeze([...overheadInput.observationSequences]),
      modeledRemainderMs: {
        total: modeledTotalMs,
        average: stats.operations > 0 ? modeledTotalMs / stats.operations : 0,
      },
    },
  };
};

const computeEndToEndStats: EndToEndStatsComputer = computeLatencyStats;

const computeThroughputStats = (
  observations: readonly MeasurementObservation[],
  phase: MeasurementPhase = "measurement",
): ThroughputStats => {
  const measured = observations.filter((observation) => observation.phase === phase);
  const completions = sum(measured.map((observation) => observation.operations));
  const elapsedMs = sum(measured.map((observation) => observation.elapsedMs));
  const makespansMs = measured.map((observation) => observation.elapsedMs).sort((a, b) => a - b);
  const rates = measured
    .flatMap((observation) =>
      observation.elapsedMs > 0 ? [(observation.operations / observation.elapsedMs) * 1000] : [],
    )
    .sort((a, b) => a - b);
  return {
    completions,
    blocks: measured.length,
    elapsedMs,
    blockDurationMs: createTimeSummary(
      makespansMs,
      measured.length > 0 ? elapsedMs / measured.length : 0,
    ),
    completionsPerSecond: {
      min: rates[0] ?? null,
      max: rates.at(-1) ?? null,
      average: elapsedMs > 0 ? (completions / elapsedMs) * 1000 : null,
    },
  };
};

const computeKernelStats = (
  observations: readonly MeasurementObservation[],
  roundModels: readonly KernelRoundModel[],
): KernelStats => {
  const measured = observations.filter((observation) => observation.phase === "measurement");
  const operations = sum(measured.map((observation) => observation.operations));
  const elapsedMs = sum(measured.map((observation) => observation.elapsedMs));
  const slopesMsPerOperation = roundModels
    .map((model) => model.slopeMsPerOperation)
    .sort((a, b) => a - b);
  const average = mean(slopesMsPerOperation);
  const positiveSlopes = slopesMsPerOperation.filter((slope) => slope > 0);
  return {
    operations,
    rounds: roundModels.length,
    elapsedMs,
    timePerOperationMs: createTimeSummary(slopesMsPerOperation, average),
    operationsPerSecond: {
      min:
        positiveSlopes.length === slopesMsPerOperation.length && slopesMsPerOperation.length > 0 ?
          1000 / (slopesMsPerOperation.at(-1) ?? 1)
        : null,
      max:
        positiveSlopes.length === slopesMsPerOperation.length && slopesMsPerOperation.length > 0 ?
          1000 / (slopesMsPerOperation[0] ?? 1)
        : null,
      average: average > 0 ? 1000 / average : null,
    },
  };
};

const diagnosePauseFlags = (
  observations: readonly MeasurementObservation[],
  clock: ClockProfile,
): readonly NoiseFlagAssignment[] => {
  const assigned: FlagAssignments = new Map();
  const groups = new Map<string, MeasurementObservation[]>();
  for (const observation of observations) {
    const key = `${observation.task}\u0000${observation.phase}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const positive = group.filter((observation) => observation.elapsedMs > 0);
    if (positive.length >= 3) {
      const logs = positive.map((observation) =>
        Math.log(observation.elapsedMs / observation.operations),
      );
      const sortedLogs = [...logs].sort((left, right) => left - right);
      const medianLog = quantileSorted(sortedLogs, 0.5);
      const deviations = logs.map((value) => Math.abs(value - medianLog)).sort((left, right) => left - right);
      const medianAbsoluteDeviation = quantileSorted(deviations, 0.5) * 1.4826;
      const medianPerOperation = Math.exp(medianLog);
      const clockFloor = Math.max(clock.minimumPositiveTickMs, clock.readPairCostMs.p99);
      const minimumScale = Math.log1p(clockFloor / medianPerOperation);
      const scale = Math.max(medianAbsoluteDeviation, minimumScale);
      for (const [index, observation] of positive.entries()) {
        const value = logs[index];
        if (observation !== undefined && value !== undefined && value > medianLog + 6 * scale) {
          addFlag(assigned, observation.sequence, "pause-like");
        }
      }
    }
  }

  return snapshotAssignments(assigned);
};

const diagnoseTrendFlags = (
  values: readonly number[],
  targetRelativeHalfWidth: number,
): readonly ObservationFlag[] => {
  if (values.length < 2) return Object.freeze([]);
  const flags: ObservationFlag[] = [];
  const stability = assessStability(values, Math.max(0.01, targetRelativeHalfWidth));
  if (stability.relativeSlopeChange > Math.max(0.01, targetRelativeHalfWidth)) {
    flags.push("drift-detected");
  }
  const midpoint = Math.floor(values.length / 2);
  const first = values.slice(0, midpoint).sort((left, right) => left - right);
  const second = values.slice(midpoint).sort((left, right) => left - right);
  const firstMedian = quantileSorted(first, 0.5);
  const secondMedian = quantileSorted(second, 0.5);
  const changeScale = Math.max(Math.abs(firstMedian), Math.abs(secondMedian));
  const relativeChange =
    changeScale === 0 ? Number.POSITIVE_INFINITY : Math.abs(firstMedian - secondMedian) / changeScale;
  if (relativeChange > Math.max(0.02, 2 * targetRelativeHalfWidth)) {
    flags.push("change-detected");
  }
  return Object.freeze(flags);
};

const diagnoseNoiseFlags = (
  observations: readonly MeasurementObservation[],
  clock: ClockProfile,
  targetRelativeHalfWidth: number,
): readonly NoiseFlagAssignment[] => {
  const assigned: FlagAssignments = new Map();
  for (const assignment of diagnosePauseFlags(observations, clock)) {
    for (const flag of assignment.flags) addFlag(assigned, assignment.sequence, flag);
  }
  const groups = new Map<string, MeasurementObservation[]>();
  for (const observation of observations) {
    const key = `${observation.task}\u0000${observation.phase}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group[0]?.phase !== "measurement" || group.length < 2) continue;
    const values = group.map((observation) => observation.elapsedMs / observation.operations);
    const trendFlags = diagnoseTrendFlags(values, targetRelativeHalfWidth);
    for (const observation of group) {
      for (const flag of trendFlags) addFlag(assigned, observation.sequence, flag);
    }
  }

  return snapshotAssignments(assigned);
};

const diagnosePairedNoiseFlags: PairedNoiseDiagnostics = (input) => {
  const { leftObservations, rightObservations, metric, targetRelativeHalfWidth } = input;
  const measurementValue = (operations: number, elapsedMs: number) => {
    if (metric === "throughput") return elapsedMs > 0 ? (operations / elapsedMs) * 1000 : 0;
    return operations > 0 ? elapsedMs / operations : 0;
  };
  const byRound = (
    observations: readonly MeasurementObservation[],
  ): Map<number, MeasurementObservation[]> => {
    const rounds = new Map<number, MeasurementObservation[]>();
    for (const observation of observations) {
      if (observation.phase !== "measurement" || observation.round === null) continue;
      const round = rounds.get(observation.round) ?? [];
      round.push(observation);
      rounds.set(observation.round, round);
    }
    return rounds;
  };
  const leftRounds = byRound(leftObservations);
  const rightRounds = byRound(rightObservations);
  const rounds = [...leftRounds.keys()]
    .filter((round) => rightRounds.has(round))
    .sort((left, right) => left - right);
  const pairedObservations: MeasurementObservation[] = [];
  const ratios: number[] = [];
  for (const round of rounds) {
    const left = leftRounds.get(round) ?? [];
    const right = rightRounds.get(round) ?? [];
    const leftOperations = sum(left.map((observation) => observation.operations));
    const rightOperations = sum(right.map((observation) => observation.operations));
    const leftElapsed = sum(left.map((observation) => observation.elapsedMs));
    const rightElapsed = sum(right.map((observation) => observation.elapsedMs));
    const leftValue = measurementValue(leftOperations, leftElapsed);
    const rightValue = measurementValue(rightOperations, rightElapsed);
    if (leftValue <= 0 || rightValue <= 0) return Object.freeze([]);
    pairedObservations.push(...left, ...right);
    ratios.push(leftValue / rightValue);
  }
  if (ratios.length < 2) return Object.freeze([]);

  const assigned: FlagAssignments = new Map();
  const trendFlags = diagnoseTrendFlags(ratios, targetRelativeHalfWidth);
  for (const observation of pairedObservations) {
    for (const flag of trendFlags) addFlag(assigned, observation.sequence, flag);
  }
  return snapshotAssignments(assigned);
};

export {
  computeCallStats,
  computeEndToEndStats,
  computeKernelStats,
  computeThroughputStats,
  diagnoseNoiseFlags,
  diagnosePairedNoiseFlags,
  diagnosePauseFlags,
};
export type { HarnessOverheadInput, NoiseFlagAssignment };
