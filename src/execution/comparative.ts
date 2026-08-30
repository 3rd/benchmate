import type {
  BenchEventSink,
  Clock,
  ClockProfile,
  EvidenceStatus,
  ResolvedAutoOptions,
  ResolvedBenchmarkOptions,
  Task,
  TaskRecord,
} from "../types";
import type { AutoStage, AutoUnit } from "./auto";
import type { InputSeedSequence } from "./schedule";
import type { TaskRunner } from "./task-runner";
import { ObservationCollector } from "../evidence/observations";
import { sleep } from "../platform/sleep";
import { createRoundSlopeInterval } from "../results/regression";
import {
  assessStability,
  findDependencePlan,
  groupMeans,
  mean,
  median,
  planEffectiveCount,
  sampleVariance,
  studentTInterval,
} from "../results/superblocks";
import { createAutoInterval, getMinimumBlockDuration } from "./auto";
import { acquireAutoTask } from "./isolated";
import {
  createBalancedSchedule,
  createInputSeedSequence,
  createPhaseSchedule,
  deriveSeed,
} from "./schedule";
import { createTaskRunner } from "./task-runner";

type ComparativeInput = {
  tasks: readonly Task[];
  allTasks: readonly Task[];
  options: ResolvedBenchmarkOptions;
  clock: Clock;
  clockProfile: ClockProfile;
  collector: ObservationCollector;
  runSeed: number;
  emit: BenchEventSink;
};

type ComparativeProgress = {
  blocks: number;
  operations: number;
  elapsedMs: number;
};

type ComparativeState = {
  runner: TaskRunner;
  operations: number;
  sizingDurationsMs: number[];
  sized: boolean;
  warmupValues: number[];
  stableChecks: number;
  pilotValues: number[];
  pilotDurationsMs: number[];
  measurementValues: number[];
  elapsedMs: number;
  warmupElapsedMs: number;
  physicalBlocksPerSuperblock: number | null;
  pilotMean: number | null;
  pilotStandardDeviation: number | null;
  progress: Record<"measurement" | "pilot" | "warmup", ComparativeProgress>;
};

type ComparativeSchedule = Extract<ResolvedBenchmarkOptions["schedule"], { mode: "comparative" }>;

type ComparativeContext = {
  tasks: readonly Task[];
  auto: ResolvedAutoOptions;
  schedule: ComparativeSchedule;
  clockProfile: ClockProfile;
  runSeed: number;
  emit: BenchEventSink;
  states: Map<string, ComparativeState>;
  names: readonly string[];
  inputSeedSequence: InputSeedSequence | null;
};

type MeasurementPlan = ReturnType<typeof createPhaseSchedule>;

type MeasurementSetup = {
  measurementPlan: MeasurementPlan;
  sharedPhysicalCount: number;
};

type MeasurementSetupResult = MeasurementSetup | { failure: TaskRecord[] };

type WarmupRowInput = {
  context: ComparativeContext;
  row: readonly string[];
  rowIndex: number;
  warmupCycles: number;
  warmupCycleLength: number;
  warmupSeed: number;
  minimumDurationMs: number;
};

const getRecords = (states: ReadonlyMap<string, ComparativeState>): TaskRecord[] => {
  return [...states.values()].map((state) => state.runner.record);
};

const setFailure = (
  states: ReadonlyMap<string, ComparativeState>,
  status: EvidenceStatus,
  reason: string,
) => {
  for (const state of states.values()) {
    state.runner.record.status = status;
    state.runner.record.reasons = Object.freeze([reason]);
  }
};

const getFirstInputSeed = (
  context: ComparativeContext,
  ranges: Map<number, number>,
  occurrence: number,
) => {
  if (context.inputSeedSequence === null) return null;
  const existing = ranges.get(occurrence);
  if (existing !== undefined) return existing;
  const maximumOperationCount = Math.max(
    ...[...context.states.values()].map((state) => state.operations),
  );
  const firstInputSeed = context.inputSeedSequence.reserve(maximumOperationCount);
  ranges.set(occurrence, firstInputSeed);
  return firstInputSeed;
};

const emitProgress = (
  context: ComparativeContext,
  state: ComparativeState,
  phase: "measurement" | "pilot" | "warmup",
  unit: AutoUnit,
  physicalBlocksPlanned: number | null,
) => {
  const progress = state.progress[phase];
  progress.blocks++;
  progress.operations += unit.operations;
  progress.elapsedMs += unit.elapsedMs;
  context.emit("progress", {
    task: state.runner.record.task.name,
    phase,
    physicalBlocksCompleted: progress.blocks,
    physicalBlocksPlanned,
    operationsCompleted: progress.operations,
    elapsedTimeMs: progress.elapsedMs,
    maxTimeMs: context.auto.maxTimeMs,
  });
};

const initializeStates = async (
  input: ComparativeInput,
  auto: ResolvedAutoOptions,
  schedule: ComparativeSchedule,
): Promise<Map<string, ComparativeState>> => {
  const states = new Map<string, ComparativeState>();
  for (const task of input.tasks) {
    input.emit("taskStart", { task: task.name });
    const runner = await createTaskRunner({
      task,
      clock: input.clock,
      collector: input.collector,
      quiet: input.options.quiet,
      precisionX: auto.precisionX,
    });
    states.set(task.name, {
      runner,
      operations: 1,
      sizingDurationsMs: [],
      sized: false,
      warmupValues: [],
      stableChecks: 0,
      pilotValues: [],
      pilotDurationsMs: [],
      measurementValues: [],
      elapsedMs: 0,
      warmupElapsedMs: 0,
      physicalBlocksPerSuperblock: null,
      pilotMean: null,
      pilotStandardDeviation: null,
      progress: {
        warmup: { blocks: 0, operations: 0, elapsedMs: 0 },
        pilot: { blocks: 0, operations: 0, elapsedMs: 0 },
        measurement: { blocks: 0, operations: 0, elapsedMs: 0 },
      },
    });
    runner.record.schedule = Object.freeze({
      seed: input.runSeed,
      yieldBetweenRounds: schedule.yieldBetweenRounds,
      rows: Object.freeze([]),
    });
    input.emit("taskPhaseStart", { task: task.name, phase: "warmup" });
  }
  return states;
};

const runPilotRows = async (
  context: ComparativeContext,
  plan: ReturnType<typeof createBalancedSchedule>,
  roundOffset: number,
) => {
  for (let rowIndex = 0; rowIndex < plan.rows.length; rowIndex++) {
    const row = plan.rows[rowIndex];
    if (!row) continue;
    const occurrences = new Map<string, number>();
    const inputSeedRanges = new Map<number, number>();
    for (const name of row) {
      if (name === undefined) throw new Error("Comparative schedule contained an empty position.");
      const state = context.states.get(name);
      if (!state) throw new Error("Comparative schedule referenced an unknown task.");
      const occurrence = occurrences.get(name) ?? 0;
      occurrences.set(name, occurrence + 1);
      const round = roundOffset + rowIndex;
      const unit = await state.runner.runAuto({
        stage: "pilot",
        operations: state.operations,
        round,
        observationSeed: deriveSeed(plan.seed, round, occurrence),
        firstInputSeed: getFirstInputSeed(context, inputSeedRanges, occurrence),
      });
      state.elapsedMs += unit.elapsedMs;
      state.pilotValues.push(unit.value);
      state.pilotDurationsMs.push(unit.elapsedMs);
      emitProgress(context, state, "pilot", unit, null);
    }
    if (context.schedule.yieldBetweenRounds) await sleep(0);
  }
};

const runWarmupRow = async (input: WarmupRowInput) => {
  const {
    context,
    row,
    rowIndex,
    warmupCycles,
    warmupCycleLength,
    warmupSeed,
    minimumDurationMs,
  } = input;
  const occurrences = new Map<string, number>();
  const inputSeedRanges = new Map<number, number>();
  for (const name of row) {
    if (name === undefined) throw new Error("Warmup schedule contained an empty position.");
    const state = context.states.get(name);
    if (!state) throw new Error("Warmup schedule referenced an unknown task.");
    const stage: AutoStage = state.sized ? "warmup" : "sizing";
    const occurrence = occurrences.get(name) ?? 0;
    occurrences.set(name, occurrence + 1);
    const round = warmupCycles * warmupCycleLength + rowIndex;
    const unit = await state.runner.runAuto({
      stage,
      operations: state.operations,
      round,
      observationSeed: deriveSeed(warmupSeed, round, occurrence),
      firstInputSeed: getFirstInputSeed(context, inputSeedRanges, occurrence),
    });
    state.elapsedMs += unit.elapsedMs;
    state.warmupElapsedMs += unit.elapsedMs;
    emitProgress(context, state, "warmup", unit, null);
    if (
      state.elapsedMs >= context.auto.maxTimeMs ||
      state.warmupElapsedMs >= context.auto.maxWarmupTimeMs
    ) {
      return true;
    }
    if (state.sized) {
      state.warmupValues.push(unit.value);
      if (state.warmupValues.length >= 30 && state.warmupValues.length % 5 === 0) {
        const stable = assessStability(
          state.warmupValues.slice(-30),
          Math.max(0.01, context.auto.precisionX),
        ).stable;
        state.stableChecks = stable ? state.stableChecks + 1 : 0;
      }
      continue;
    }
    state.sizingDurationsMs.push(unit.elapsedMs);
    if (state.sizingDurationsMs.length !== 4) continue;
    if (median(state.sizingDurationsMs.slice(1)) >= minimumDurationMs) {
      state.sized = true;
      continue;
    }
    state.operations *= 2;
    state.sizingDurationsMs = [];
  }
  if (context.schedule.yieldBetweenRounds) await sleep(0);
  return false;
};

const normalizeKernelOperations = (states: ReadonlyMap<string, ComparativeState>) => {
  const sharedOperations = Math.max(2, ...[...states.values()].map((state) => state.operations));
  for (const state of states.values()) {
    state.operations = sharedOperations;
    state.warmupValues = [];
    state.stableChecks = 0;
  }
};

const runWarmup = async (context: ComparativeContext): Promise<TaskRecord[] | null> => {
  const warmupSeed = deriveSeed(context.runSeed, 0x57_A2_1D_91);
  const warmupCycle = createBalancedSchedule(context.names, warmupSeed);
  const minimumDurationMs = getMinimumBlockDuration(
    context.clockProfile,
    context.auto.precisionX,
  );
  let warmupCycles = 0;
  let kernelOperationsNormalized = context.tasks[0]?.definition.mode !== "kernel";
  while ([...context.states.values()].some((state) => state.stableChecks < 2)) {
    for (let rowIndex = 0; rowIndex < warmupCycle.rows.length; rowIndex++) {
      const row = warmupCycle.rows[rowIndex];
      if (!row) continue;
      const budgetExhausted = await runWarmupRow({
        context,
        row,
        rowIndex,
        warmupCycles,
        warmupCycleLength: warmupCycle.rows.length,
        warmupSeed,
        minimumDurationMs,
      });
      if (budgetExhausted) {
        setFailure(
          context.states,
          "warmup-not-converged",
          "comparative warmup did not converge within the shared budget",
        );
        for (const task of context.tasks) context.emit("taskPhaseEnd", { task: task.name, phase: "warmup" });
        return getRecords(context.states);
      }
    }
    if (!kernelOperationsNormalized && [...context.states.values()].every((state) => state.sized)) {
      normalizeKernelOperations(context.states);
      kernelOperationsNormalized = true;
    }
    warmupCycles++;
  }
  for (const task of context.tasks) {
    context.emit("taskPhaseEnd", { task: task.name, phase: "warmup" });
    context.emit("taskPhaseStart", { task: task.name, phase: "pilot" });
  }
  return null;
};

const runPilot = async (context: ComparativeContext): Promise<TaskRecord[] | null> => {
  const pilotSeed = deriveSeed(context.runSeed, 0x91_E1_0D_A5);
  const pilotCycle = createBalancedSchedule(context.names, pilotSeed);
  let pilotRowsCompleted = 0;
  while (
    [...context.states.values()].some((state) => state.physicalBlocksPerSuperblock === null)
  ) {
    await runPilotRows(context, pilotCycle, pilotRowsCompleted);
    pilotRowsCompleted += pilotCycle.rows.length;
    for (const state of context.states.values()) {
      if (state.elapsedMs >= context.auto.maxTimeMs) {
        setFailure(
          context.states,
          "dependence-unresolved",
          "comparative pilot budget ended before every variance plateau was established",
        );
        for (const task of context.tasks) context.emit("taskPhaseEnd", { task: task.name, phase: "pilot" });
        return getRecords(context.states);
      }
      if (state.pilotValues.length < context.auto.minPilotBlocks) continue;
      const plan = findDependencePlan(state.pilotValues);
      if (plan) state.physicalBlocksPerSuperblock = plan.superblockSize;
    }
  }
  for (const task of context.tasks) context.emit("taskPhaseEnd", { task: task.name, phase: "pilot" });
  return null;
};

const createMeasurementSetup = (context: ComparativeContext): MeasurementSetupResult => {
  const pilotCycle = createBalancedSchedule(context.names, deriveSeed(context.runSeed, 0x91_E1_0D_A5));
  const occurrencesPerCycle = pilotCycle.rows.reduce(
    (count, row) => count + row.filter((name) => name === context.names[0]).length,
    0,
  );
  let sharedCycles = 1;
  for (const state of context.states.values()) {
    const physicalBlocksPerSuperblock = state.physicalBlocksPerSuperblock;
    if (physicalBlocksPerSuperblock === null) {
      throw new Error("Comparative dependence plan invariant failed.");
    }
    const pilotSuperblocks = groupMeans(state.pilotValues, physicalBlocksPerSuperblock);
    state.pilotMean = mean(pilotSuperblocks);
    state.pilotStandardDeviation = Math.sqrt(sampleVariance(pilotSuperblocks));
    const requiredEffective = planEffectiveCount(
      state.pilotMean,
      state.pilotStandardDeviation,
      context.auto.precisionX,
      context.auto.minEffectiveBlocks,
    );
    if (requiredEffective === null) {
      setFailure(
        context.states,
        "unidentifiable",
        "comparative pilot could not support a finite shared plan",
      );
      return { failure: getRecords(context.states) };
    }
    const requiredPhysicalBlocks = requiredEffective * physicalBlocksPerSuperblock;
    sharedCycles = Math.max(sharedCycles, Math.ceil(requiredPhysicalBlocks / occurrencesPerCycle));
  }

  const measurementPlan = createPhaseSchedule(context.names, context.runSeed, "measurement", sharedCycles);
  const sharedPhysicalCount = sharedCycles * occurrencesPerCycle;
  for (const state of context.states.values()) {
    const predictedDurationMs = median(state.pilotDurationsMs) * sharedPhysicalCount * 1.2;
    const physicalBlocksPerSuperblock = state.physicalBlocksPerSuperblock;
    if (
      physicalBlocksPerSuperblock === null ||
      state.pilotMean === null ||
      state.pilotStandardDeviation === null
    ) {
      throw new Error("Comparative plan snapshot invariant failed.");
    }
    state.runner.record.plan = Object.freeze({
      operationsPerBlock: state.operations,
      physicalBlocksPerSuperblock,
      physicalBlockCount: sharedPhysicalCount,
      effectiveBlockCount: sharedPhysicalCount / physicalBlocksPerSuperblock,
      plannedDurationMs: predictedDurationMs,
      remainingBudgetMs: context.auto.maxTimeMs - state.elapsedMs,
      precisionX: context.auto.precisionX,
      pilotMean: state.pilotMean,
      pilotStandardDeviation: state.pilotStandardDeviation,
    });
    if (predictedDurationMs > context.auto.maxTimeMs - state.elapsedMs) {
      for (const current of context.states.values()) {
        current.runner.record.status = "insufficient-budget";
        current.runner.record.reasons = Object.freeze([
          "shared comparative confirmation plan exceeds a task budget",
        ]);
        current.runner.record.schedule = Object.freeze({
          seed: context.runSeed,
          yieldBetweenRounds: context.schedule.yieldBetweenRounds,
          rows: measurementPlan.rows,
        });
      }
      return { failure: getRecords(context.states) };
    }
  }
  return { measurementPlan, sharedPhysicalCount };
};

const runMeasurement = async (
  context: ComparativeContext,
  measurementPlan: MeasurementPlan,
  sharedPhysicalCount: number,
) => {
  for (const task of context.tasks) context.emit("taskPhaseStart", { task: task.name, phase: "measurement" });
  let completedRows = 0;
  for (let rowIndex = 0; rowIndex < measurementPlan.rows.length; rowIndex++) {
    const row = measurementPlan.rows[rowIndex];
    if (!row) continue;
    const occurrences = new Map<string, number>();
    const inputSeedRanges = new Map<number, number>();
    for (const name of row) {
      if (name === undefined) throw new Error("Measurement schedule contained an empty position.");
      const state = context.states.get(name);
      if (!state) throw new Error("Measurement schedule referenced an unknown task.");
      const occurrence = occurrences.get(name) ?? 0;
      occurrences.set(name, occurrence + 1);
      const unit = await state.runner.runAuto({
        stage: "measurement",
        operations: state.operations,
        round: rowIndex,
        observationSeed: deriveSeed(measurementPlan.seed, rowIndex, occurrence),
        firstInputSeed: getFirstInputSeed(context, inputSeedRanges, occurrence),
      });
      state.elapsedMs += unit.elapsedMs;
      state.measurementValues.push(unit.value);
      emitProgress(context, state, "measurement", unit, sharedPhysicalCount);
    }
    completedRows++;
    if (context.schedule.yieldBetweenRounds) await sleep(0);
    if (
      [...context.states.values()].some((state) => state.elapsedMs >= context.auto.maxTimeMs)
    ) {
      break;
    }
  }
  for (const task of context.tasks) context.emit("taskPhaseEnd", { task: task.name, phase: "measurement" });
  return completedRows;
};

const assessState = (
  context: ComparativeContext,
  state: ComparativeState,
  completeSchedule: boolean,
  sharedPhysicalCount: number,
) => {
  const record = state.runner.record;
  if (!completeSchedule || state.measurementValues.length !== sharedPhysicalCount) {
    record.status = "insufficient-budget";
    record.reasons = Object.freeze(["comparative task budget ended before the locked row set completed"]);
    return;
  }
  const physicalBlocksPerSuperblock = state.physicalBlocksPerSuperblock;
  if (
    physicalBlocksPerSuperblock === null ||
    state.measurementValues.length % physicalBlocksPerSuperblock !== 0
  ) {
    record.status = "failed";
    record.reasons = Object.freeze(["comparative superblock plan invariant failed"]);
    return;
  }
  const finalSuperblocks = groupMeans(state.measurementValues, physicalBlocksPerSuperblock);
  const interval = studentTInterval(finalSuperblocks);
  const relativeHalfWidth =
    !interval || interval.mean === 0 ?
      Number.POSITIVE_INFINITY
    : interval.halfWidth / Math.abs(interval.mean);
  const stability = assessStability(finalSuperblocks, Math.max(0.01, context.auto.precisionX));
  if (!interval || relativeHalfWidth > context.auto.precisionX) {
    record.status = "precision-missed";
    record.reasons = Object.freeze(["final comparative interval exceeded the requested relative half-width"]);
    return;
  }
  if (stability.quantized) {
    record.status = "timer-limited";
    record.reasons = Object.freeze(["final comparative stream was dominated by clock quantization"]);
    return;
  }
  record.status = "complete";
  record.reasons = Object.freeze([]);
  const scale =
    record.task.definition.mode === "throughput" || record.task.definition.mode === "kernel" ?
      "identity"
    : "inverse-ms";
  record.interval = createAutoInterval(
    state.measurementValues,
    physicalBlocksPerSuperblock,
    scale,
    "validated-corpus-v1",
  );
  if (record.task.definition.mode === "kernel") {
    record.interval = createRoundSlopeInterval(
      finalSuperblocks,
      state.measurementValues.length,
      "validated-corpus-v1",
    );
  }
};

const assessMeasurement = (
  context: ComparativeContext,
  measurementPlan: MeasurementPlan,
  sharedPhysicalCount: number,
  completedRows: number,
): TaskRecord[] => {
  const completeSchedule = completedRows === measurementPlan.rows.length;
  for (const state of context.states.values()) {
    const record = state.runner.record;
    record.schedule = Object.freeze({
      seed: context.runSeed,
      yieldBetweenRounds: context.schedule.yieldBetweenRounds,
      rows: measurementPlan.rows,
    });
    context.emit("taskPhaseStart", { task: record.task.name, phase: "assessment" });
    assessState(context, state, completeSchedule, sharedPhysicalCount);
    state.runner.finishKernelDiagnostics();
    context.emit("taskPhaseEnd", { task: record.task.name, phase: "assessment" });
  }
  return getRecords(context.states);
};

const acquireComparativeGroup = async (input: ComparativeInput): Promise<TaskRecord[]> => {
  const { tasks, allTasks, options, clock, clockProfile, collector, runSeed, emit } = input;
  if (options.run.mode !== "auto" || options.schedule.mode !== "comparative") {
    throw new Error("Comparative group received incompatible options.");
  }
  if (tasks.length < 2) {
    const task = tasks[0];
    if (!task) return [];
    return [
      await acquireAutoTask({
        task,
        taskIndex: allTasks.indexOf(task),
        options,
        clock,
        clockProfile,
        collector,
        runSeed,
        emit,
      }),
    ];
  }

  const states = await initializeStates(input, options.run, options.schedule);
  const context: ComparativeContext = {
    tasks,
    auto: options.run,
    schedule: options.schedule,
    clockProfile,
    runSeed,
    emit,
    states,
    names: tasks.map((task) => task.name),
    inputSeedSequence:
      tasks[0]?.definition.mode === "end-to-end" ? createInputSeedSequence() : null,
  };
  const warmupFailure = await runWarmup(context);
  if (warmupFailure) return warmupFailure;
  const pilotFailure = await runPilot(context);
  if (pilotFailure) return pilotFailure;
  const setup = createMeasurementSetup(context);
  if ("failure" in setup) return setup.failure;
  const completedRows = await runMeasurement(context, setup.measurementPlan, setup.sharedPhysicalCount);
  return assessMeasurement(context, setup.measurementPlan, setup.sharedPhysicalCount, completedRows);
};

export { acquireComparativeGroup };
