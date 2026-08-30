import type { ObservationCollector } from "../evidence/observations";
import type {
  BenchmarkResult,
  CallBenchmarkResult,
  ClockProfile,
  EndToEndBenchmarkResult,
  IntervalEvidence,
  KernelBenchmarkResult,
  KernelMeasurement,
  MeasurementEvidence,
  MeasurementMode,
  MeasurementObservation,
  PairedComparison,
  ResolvedBenchmarkOptions,
  TaskRecord,
  TaskType,
  ThroughputBenchmarkResult,
} from "../types";
import { createPairedComparison } from "./regression";
import {
  computeCallStats,
  computeEndToEndStats,
  computeKernelStats,
  computeThroughputStats,
  diagnoseNoiseFlags,
  diagnosePairedNoiseFlags,
  diagnosePauseFlags,
} from "./stats";

type NoiseDiagnosticsApplier = (
  records: readonly TaskRecord[],
  collector: ObservationCollector,
  clock: ClockProfile,
  runOptions: ResolvedBenchmarkOptions["run"],
) => void;
type ResultComparator = (left: BenchmarkResult, right: BenchmarkResult) => boolean;
type PairedComparisonResolver = (
  left: BenchmarkResult,
  right: BenchmarkResult,
) => PairedComparison | null;
type BenchmarkComparisonsBuilder = (entries: readonly BenchmarkResult[]) => readonly PairedComparison[];
type BenchmarkResultsBuilder = (
  records: readonly TaskRecord[],
  collector: ObservationCollector,
  runMode: ResolvedBenchmarkOptions["run"]["mode"],
) => BenchmarkResult[];
type MeasurementEvidenceInput<Type extends TaskType> = {
  taskType: Type;
  record: TaskRecord;
  observations: readonly MeasurementObservation[];
  measurement: MeasurementMode;
};
type MeasurementEvidenceBuilder = <Type extends TaskType>(
  input: MeasurementEvidenceInput<Type>,
) => MeasurementEvidence<Type>;

const createMeasurementEvidence: MeasurementEvidenceBuilder = (input) => {
  return Object.freeze({
    schemaVersion: 5,
    taskType: input.taskType,
    measurement: input.measurement,
    schedule: input.record.schedule.rows.length > 0 ? "comparative" : "isolated",
    status: input.record.status,
    reasons: Object.freeze([...input.record.reasons]),
    observations: input.observations,
    interval: input.record.interval,
  });
};

const applyNoiseDiagnostics: NoiseDiagnosticsApplier = (records, collector, clock, runOptions) => {
  const target = runOptions.mode === "auto" ? runOptions.precisionX : 0.01;
  const snapshot = collector.snapshot();
  const observationsByTask = new Map(
    records.map((record) => [
      record.task.name,
      snapshot.filter((observation) => observation.task === record.task.name),
    ]),
  );
  const pairedTrendTasks = new Set<string>();
  for (const record of records) {
    const observations = observationsByTask.get(record.task.name) ?? [];
    const assignments =
      record.schedule.rows.length === 0 ?
        diagnoseNoiseFlags(observations, clock, target)
      : diagnosePauseFlags(observations, clock);
    for (const assignment of assignments) collector.addFlags(assignment.sequence, assignment.flags);
    if (
      record.schedule.rows.length > 0 ||
      runOptions.mode !== "auto" ||
      record.task.definition.mode === "kernel"
    ) {
      continue;
    }
    const finalFlags = new Set(assignments.flatMap((assignment) => assignment.flags));
    if (
      record.status === "complete" &&
      (finalFlags.has("drift-detected") || finalFlags.has("change-detected"))
    ) {
      record.status = "unstable";
      record.reasons = Object.freeze(["final measurement contained portable drift or change diagnostics"]);
      record.interval = null;
    }
  }

  const groups = new Map<string, TaskRecord[]>();
  for (const record of records) {
    if (record.schedule.rows.length === 0 || record.task.definition.mode === "kernel") continue;
    const group = groups.get(record.groupKey) ?? [];
    group.push(record);
    groups.set(record.groupKey, group);
  }
  for (const group of groups.values()) {
    for (let leftIndex = 0; leftIndex < group.length; leftIndex++) {
      const left = group[leftIndex];
      if (!left) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex++) {
        const right = group[rightIndex];
        if (!right) continue;
        const assignments = diagnosePairedNoiseFlags({
          leftObservations: observationsByTask.get(left.task.name) ?? [],
          rightObservations: observationsByTask.get(right.task.name) ?? [],
          metric: left.task.definition.mode === "throughput" ? "throughput" : "time-per-operation",
          targetRelativeHalfWidth: target,
        });
        for (const assignment of assignments) collector.addFlags(assignment.sequence, assignment.flags);
        if (
          assignments.some((assignment) =>
            assignment.flags.some((flag) => flag === "drift-detected" || flag === "change-detected"),
          )
        ) {
          pairedTrendTasks.add(left.task.name);
          pairedTrendTasks.add(right.task.name);
        }
      }
    }
  }
  for (const record of records) {
    if (!pairedTrendTasks.has(record.task.name) || record.status !== "complete") continue;
    record.status = "unstable";
    record.reasons = Object.freeze([
      "paired comparative rounds contained portable drift or change diagnostics",
    ]);
    record.interval = null;
  }
};

const equalRows = (left: BenchmarkResult, right: BenchmarkResult) => {
  const leftRows = left.metadata.schedule.rows;
  const rightRows = right.metadata.schedule.rows;
  if (leftRows.length !== rightRows.length) return false;
  return leftRows.every((row, rowIndex) => {
    const other = rightRows[rowIndex];
    return (
      other !== undefined && row.length === other.length && row.every((name, index) => name === other[index])
    );
  });
};

const intervalsCompatible = (left: IntervalEvidence | null, right: IntervalEvidence | null) => {
  if (left === null || right === null) return left === right;
  return left.method === right.method && left.coverage === right.coverage;
};

const areResultsComparable: ResultComparator = (left, right) => {
  if (left.evidence.status !== "complete" || right.evidence.status !== "complete") return false;
  if (left.taskType !== right.taskType) return false;
  if (left.evidence.measurement !== right.evidence.measurement) return false;
  if (left.evidence.schedule !== right.evidence.schedule) return false;
  if (!intervalsCompatible(left.evidence.interval, right.evidence.interval)) return false;
  if (
    left.taskType === "throughput" &&
    right.taskType === "throughput" &&
    left.metadata.concurrency !== right.metadata.concurrency
  ) {
    return false;
  }
  if (
    (left.taskType === "call" || left.taskType === "end-to-end") &&
    left.metadata.executionKind !== right.metadata.executionKind
  ) {
    return false;
  }
  if (left.taskType === "kernel" && right.taskType === "kernel") {
    const leftKernel = left.metadata.kernel;
    const rightKernel = right.metadata.kernel;
    if (
      !leftKernel ||
      !rightKernel ||
      leftKernel.operationCountLadder.length !== rightKernel.operationCountLadder.length
    ) {
      return false;
    }
    if (
      !leftKernel.operationCountLadder.every(
        (count, index) => count === rightKernel.operationCountLadder[index],
      )
    ) {
      return false;
    }
    if (leftKernel.rounds.length !== rightKernel.rounds.length) return false;
    if (
      !leftKernel.rounds.every((round, index) => {
        const other = rightKernel.rounds[index];
        return (
          other !== undefined &&
          round.seed === other.seed &&
          round.operationCountOrder.length === other.operationCountOrder.length &&
          round.operationCountOrder.every(
            (count, countIndex) => count === other.operationCountOrder[countIndex],
          )
        );
      })
    ) {
      return false;
    }
  }
  if (left.evidence.schedule === "comparative") {
    if (left.metadata.schedule.seed !== right.metadata.schedule.seed) return false;
    if (!equalRows(left, right)) return false;
  }
  return true;
};

const measurementValueByRound = (result: BenchmarkResult): Map<number, number> => {
  if (result.taskType === "kernel") {
    const grouped = new Map<number, number[]>();
    for (const model of result.metadata.kernel?.rounds ?? []) {
      const slopes = grouped.get(model.round) ?? [];
      slopes.push(model.slopeMsPerOperation);
      grouped.set(model.round, slopes);
    }
    return new Map(
      [...grouped].map(([round, slopes]) => [
        round,
        slopes.reduce((total, slope) => total + slope, 0) / slopes.length,
      ]),
    );
  }
  const grouped = new Map<number, { elapsedMs: number; operations: number }>();
  for (const observation of result.evidence.observations) {
    if (observation.phase !== "measurement" || observation.round === null) continue;
    const current = grouped.get(observation.round) ?? { elapsedMs: 0, operations: 0 };
    current.elapsedMs += observation.elapsedMs;
    current.operations += observation.operations;
    grouped.set(observation.round, current);
  }
  const measurementValue = (value: { elapsedMs: number; operations: number }) => {
    if (result.taskType !== "throughput") return value.elapsedMs / value.operations;
    return value.elapsedMs > 0 ? (value.operations / value.elapsedMs) * 1000 : 0;
  };
  return new Map([...grouped].map(([round, value]) => [round, measurementValue(value)]));
};

const getPairedComparison: PairedComparisonResolver = (left, right) => {
  if (!areResultsComparable(left, right) || left.evidence.schedule !== "comparative") return null;
  const leftRounds = measurementValueByRound(left);
  const rightRounds = measurementValueByRound(right);
  const rounds = [...leftRounds.keys()]
    .filter((round) => rightRounds.has(round))
    .sort((left, right) => left - right);
  if (rounds.length === 0 || rounds.length !== leftRounds.size || rounds.length !== rightRounds.size) {
    return null;
  }
  const leftValues = rounds.map((round) => leftRounds.get(round) ?? 0);
  const rightValues = rounds.map((round) => rightRounds.get(round) ?? 0);
  const orders = rounds.map((round): readonly [string, string] => {
    const row = left.metadata.schedule.rows[round] ?? [];
    return row.indexOf(left.name) <= row.indexOf(right.name) ?
        [left.name, right.name]
      : [right.name, left.name];
  });
  const elapsedSinceRunStartMs = rounds.map((round) => {
    const observation = left.evidence.observations.find(
      (entry) => entry.phase === "measurement" && entry.round === round,
    );
    return observation?.startedAtMs ?? 0;
  });
  const flags = rounds.map((round) => {
    const combined = [left, right].flatMap((result) =>
      result.evidence.observations
        .filter((observation) => observation.phase === "measurement" && observation.round === round)
        .flatMap((observation) => observation.flags),
    );
    return [...new Set(combined)];
  });
  return createPairedComparison({
    left: left.name,
    right: right.name,
    taskType: left.taskType,
    leftValues,
    rightValues,
    orders,
    elapsedSinceRunStartMs,
    flags,
    coverage: left.evidence.interval?.coverage ?? "nominal",
  });
};

const buildBenchmarkComparisons: BenchmarkComparisonsBuilder = (entries) => {
  const comparisons: PairedComparison[] = [];
  for (const [leftIndex, left] of entries.entries()) {
    for (const right of entries.slice(leftIndex + 1)) {
      const comparison = getPairedComparison(left, right);
      if (comparison !== null) comparisons.push(comparison);
    }
  }
  return Object.freeze(comparisons);
};

const buildBenchmarkResults: BenchmarkResultsBuilder = (records, collector, runMode) => {
  const snapshot = collector.snapshot();
  return records.map((record) => {
    const observations = Object.freeze(
      snapshot.filter((observation) => observation.task === record.task.name),
    );
    const definition = record.task.definition;
    const summaryPhase =
      (["measurement", "pilot", "warmup", "calibration", "probe"] as const).find((phase) =>
        observations.some((observation) => observation.phase === phase && observation.elapsedMs > 0),
      ) ?? "measurement";
    const kernelModels = record.kernelModels.length > 0 ? record.kernelModels : record.kernelFallbackModels;
    let measurement: MeasurementMode = "auto";
    if (runMode === "time") measurement = "time";
    else if (runMode === "count") measurement = "iterations";
    if (definition.mode === "call") {
      const result: CallBenchmarkResult = {
        name: record.task.name,
        taskType: definition.mode,
        stats: computeCallStats(observations, record.overhead, summaryPhase),
        evidence: createMeasurementEvidence({
          taskType: definition.mode,
          record,
          observations,
          measurement,
        }),
        metadata: Object.freeze({
          executionKind: record.executionKind,
          schedule: record.schedule,
          plan: record.plan,
        }),
      };
      return Object.freeze(result);
    }
    if (definition.mode === "end-to-end") {
      const result: EndToEndBenchmarkResult = {
        name: record.task.name,
        taskType: definition.mode,
        stats: computeEndToEndStats(observations, summaryPhase),
        evidence: createMeasurementEvidence({
          taskType: definition.mode,
          record,
          observations,
          measurement,
        }),
        metadata: Object.freeze({
          executionKind: record.executionKind,
          schedule: record.schedule,
          plan: record.plan,
        }),
      };
      return Object.freeze(result);
    }
    if (definition.mode === "throughput") {
      const result: ThroughputBenchmarkResult = {
        name: record.task.name,
        taskType: definition.mode,
        stats: computeThroughputStats(observations, summaryPhase),
        evidence: createMeasurementEvidence({
          taskType: definition.mode,
          record,
          observations,
          measurement,
        }),
        metadata: Object.freeze({
          executionKind: "async",
          schedule: record.schedule,
          concurrency: definition.concurrency,
          plan: record.plan,
        }),
      };
      return Object.freeze(result);
    }

    let kernel: KernelMeasurement | null = null;
    if (record.kernelBaseCount !== null && record.kernelLadder.length >= 4) {
      const measuredOperationCountRange: readonly [number, number] = Object.freeze([
        record.kernelLadder[0] ?? 0,
        record.kernelLadder.at(-1) ?? 0,
      ]);
      kernel = Object.freeze({
        baseOperationCount: record.kernelBaseCount,
        operationCountLadder: Object.freeze([...record.kernelLadder]),
        measuredOperationCountRange,
        constantResultDeclared: definition.constantResult ?? false,
        rounds: Object.freeze([...kernelModels]),
      });
    }
    const result: KernelBenchmarkResult = {
      name: record.task.name,
      taskType: definition.mode,
      stats: computeKernelStats(observations, kernelModels),
      evidence: createMeasurementEvidence({
        taskType: definition.mode,
        record,
        observations,
        measurement,
      }),
      metadata: Object.freeze({
        executionKind: "sync",
        schedule: record.schedule,
        kernel,
        plan: record.plan,
      }),
    };
    return Object.freeze(result);
  });
};

export {
  applyNoiseDiagnostics,
  areResultsComparable,
  buildBenchmarkComparisons,
  buildBenchmarkResults,
  getPairedComparison,
};
