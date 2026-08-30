import type {
  BenchEventSink,
  Clock,
  ClockProfile,
  IntervalEvidence,
  MeasurementObservation,
  MeasurementPhase,
  ResolvedBenchmarkOptions,
  Task,
  TaskRecord,
  TimedBlock,
} from "../types";
import type { AutoStage, AutoUnit } from "./auto";
import { ObservationCollector } from "../evidence/observations";
import { createRoundSlopeInterval } from "../results/regression";
import { groupMeans, mean, studentTInterval } from "../results/superblocks";
import { runAutoMeasurement } from "./auto";
import { createInputSeedSequence, deriveSeed } from "./schedule";
import { createTaskRunner } from "./task-runner";

const MAX_FIXED_CALIBRATION_OPERATIONS = 0x01_00_00_00;

type FixedTaskInput = {
  task: Task;
  taskIndex: number;
  tasksCompleted: number;
  tasksTotal: number;
  options: ResolvedBenchmarkOptions;
  clock: Clock;
  collector: ObservationCollector;
  runSeed: number;
  emit: BenchEventSink;
};

type AutoTaskInput = {
  task: Task;
  taskIndex: number;
  options: ResolvedBenchmarkOptions;
  clock: Clock;
  clockProfile: ClockProfile;
  collector: ObservationCollector;
  runSeed: number;
  emit: BenchEventSink;
};

type CalibrationTargetResolver = (targetTimeMs: number) => number;

const getCalibrationTarget: CalibrationTargetResolver = (targetTimeMs) =>
  Math.min(350, Math.max(5, targetTimeMs / 10));

const phaseForStage = (stage: AutoStage): Extract<MeasurementPhase, "measurement" | "pilot" | "warmup"> => {
  return stage === "sizing" ? "warmup" : stage;
};

const seedPartForPhase = (phase: "measurement" | "pilot" | "warmup") => {
  if (phase === "warmup") return 1;
  if (phase === "pilot") return 2;
  return 3;
};

const createBatchInterval = (observations: readonly MeasurementObservation[]): IntervalEvidence | null => {
  const measured = observations.filter((observation) => observation.phase === "measurement");
  const perOperation = measured.map((observation) => observation.elapsedMs / observation.operations);
  const interval = studentTInterval(perOperation);
  if (!interval || interval.upper <= 0) return null;
  return {
    confidenceLevelX: 0.95,
    lower: 1000 / interval.upper,
    upper: interval.lower > 0 ? 1000 / interval.lower : null,
    method: "batch-t",
    coverage: "nominal",
    physicalCount: measured.length,
    effectiveCount: measured.length,
    assumptions: Object.freeze([
      "fixed measurement interval is nominal",
      "serial dependence was not assessed",
    ]),
  };
};

const getOperationsPerBlock = (totalIterations: number, options: ResolvedBenchmarkOptions) => {
  if (!options.batching.enabled) return totalIterations;
  if (options.batching.operationsPerBlock !== "auto") return options.batching.operationsPerBlock;
  if (totalIterations < 1000) return Math.max(1, totalIterations / 25);
  if (totalIterations < 10_000) return Math.max(1, totalIterations / 50);
  if (totalIterations < 100_000) return Math.max(1, totalIterations / 100);
  if (totalIterations < 1_000_000) return Math.max(1, totalIterations / 200);
  return Math.max(1, totalIterations / 500);
};

const acquireFixedTask = async (input: FixedTaskInput): Promise<TaskRecord> => {
  const { task, taskIndex, tasksCompleted, tasksTotal, options, clock, collector, runSeed, emit } = input;
  const definition = task.definition;
  if (definition.mode === "kernel" || definition.mode === "throughput") {
    throw new Error(`${definition.mode} tasks require automatic measurement.`);
  }
  emit("taskStart", { task: task.name });
  const runner = await createTaskRunner({
    task,
    clock,
    collector,
    quiet: options.quiet,
    precisionX: options.run.mode === "auto" ? options.run.precisionX : 0.01,
  });
  const inputSeedSequence = definition.mode === "end-to-end" ? createInputSeedSequence() : null;

  const runBlock = async (
    phase: MeasurementPhase,
    operations: number,
    round: number,
  ): Promise<TimedBlock> => {
    const observationSeed = deriveSeed(runSeed, taskIndex, round);
    const firstInputSeed = inputSeedSequence?.reserve(operations) ?? null;
    return runner.runFixed({ phase, operations, round, observationSeed, firstInputSeed });
  };

  let iterationsTotal: number;
  let calibrationTimerLimited = false;
  if (options.run.mode === "count") {
    iterationsTotal = options.run.iterations;
  } else if (options.run.mode === "time") {
    const targetTimeMs = getCalibrationTarget(options.run.timeMs);
    let iterations = 1;
    let elapsedMs = 0;
    let round = 0;
    for (;;) {
      const attempts = [await runBlock("calibration", iterations, round++)];
      attempts.push(await runBlock("calibration", iterations, round++));
      attempts.push(await runBlock("calibration", iterations, round++));
      elapsedMs = mean(attempts.slice(1).map((block) => block.elapsedMs));
      if (elapsedMs >= targetTimeMs) break;
      if (iterations >= MAX_FIXED_CALIBRATION_OPERATIONS) {
        calibrationTimerLimited = true;
        break;
      }
      const iterationsPerMs = iterations / (elapsedMs || 1);
      iterations = Math.min(
        MAX_FIXED_CALIBRATION_OPERATIONS,
        Math.max(iterations + 1, Math.ceil(iterationsPerMs * targetTimeMs * 1.1)),
      );
    }
    iterationsTotal =
      calibrationTimerLimited ?
        0
      : Math.max(1, Math.floor((options.run.timeMs / elapsedMs) * iterations));
  } else {
    throw new Error("Fixed task measurement received automatic options.");
  }

  if (options.warmup.enabled) {
    const warmupIterations =
      options.warmup.iterations === "auto" ? Math.floor(iterationsTotal / 10) : options.warmup.iterations;
    if (warmupIterations > 0) {
      emit("taskPhaseStart", { task: task.name, phase: "warmup" });
      await runBlock("warmup", warmupIterations, 0);
      emit("taskPhaseEnd", { task: task.name, phase: "warmup" });
    }
  }

  emit("taskPhaseStart", { task: task.name, phase: "measurement" });
  const operationsPerBlock = Math.floor(getOperationsPerBlock(iterationsTotal, options));
  let iterationsCompleted = 0;
  let lastReportedPercent = 0;
  const startedAtMs = clock.now();
  let round = 0;
  while (iterationsCompleted < iterationsTotal) {
    const operations =
      options.batching.enabled ?
        Math.min(operationsPerBlock, iterationsTotal - iterationsCompleted)
      : iterationsTotal - iterationsCompleted;
    await runBlock("measurement", operations, round++);
    iterationsCompleted += operations;
    const completedPercent = Math.floor((iterationsCompleted / iterationsTotal) * 100);
    if (iterationsCompleted < iterationsTotal && completedPercent > lastReportedPercent) {
      lastReportedPercent = completedPercent;
      emit("progress", {
        task: task.name,
        tasksCompleted,
        tasksTotal,
        iterationsCompleted,
        iterationsTotal,
        elapsedTimeMs: clock.now() - startedAtMs,
      });
    }
  }
  emit("taskPhaseEnd", { task: task.name, phase: "measurement" });
  emit("progress", {
    task: task.name,
    tasksCompleted,
    tasksTotal,
    iterationsCompleted,
    iterationsTotal,
    elapsedTimeMs: clock.now() - startedAtMs,
  });

  const observations = collector.snapshot().filter((observation) => observation.task === task.name);
  const measuredElapsedMs = observations
    .filter((observation) => observation.phase === "measurement")
    .reduce((total, observation) => total + observation.elapsedMs, 0);
  const timerLimited = calibrationTimerLimited || measuredElapsedMs === 0;
  const record = runner.record;
  record.status = timerLimited ? "timer-limited" : "complete";
  record.reasons = Object.freeze(
    timerLimited ? ["fixed measurement produced no measurable elapsed time"] : [],
  );
  record.interval = timerLimited ? null : createBatchInterval(observations);
  record.schedule = Object.freeze({ seed: null, yieldBetweenRounds: false, rows: Object.freeze([]) });
  return record;
};

const acquireAutoTask = async (input: AutoTaskInput): Promise<TaskRecord> => {
  const { task, taskIndex, options, clock, clockProfile, collector, runSeed, emit } = input;
  if (options.run.mode !== "auto") throw new Error("Automatic task received fixed measurement options.");
  const auto = options.run;
  emit("taskStart", { task: task.name });
  const runner = await createTaskRunner({
    task,
    clock,
    collector,
    quiet: options.quiet,
    precisionX: auto.precisionX,
  });
  const inputSeedSequence = task.definition.mode === "end-to-end" ? createInputSeedSequence() : null;
  let activePhase: "measurement" | "pilot" | "warmup" | null = null;
  let plannedPhysicalBlocks: number | null = null;
  let phaseBlocks = 0;
  let phaseOperations = 0;
  let phaseElapsedMs = 0;
  const runUnit = async (stage: AutoStage, operations: number, round: number): Promise<AutoUnit> => {
    const phase = phaseForStage(stage);
    if (phase !== activePhase) {
      if (activePhase) emit("taskPhaseEnd", { task: task.name, phase: activePhase });
      activePhase = phase;
      phaseBlocks = 0;
      phaseOperations = 0;
      phaseElapsedMs = 0;
      emit("taskPhaseStart", { task: task.name, phase });
    }
    const observationSeed = deriveSeed(runSeed, taskIndex, seedPartForPhase(phase), round);
    const firstInputSeed = inputSeedSequence?.reserve(operations) ?? null;
    const unit = await runner.runAuto({
      stage,
      operations,
      round,
      observationSeed,
      firstInputSeed,
    });
    phaseBlocks++;
    phaseOperations += unit.operations;
    phaseElapsedMs += unit.elapsedMs;
    emit("progress", {
      task: task.name,
      phase,
      physicalBlocksCompleted: phaseBlocks,
      physicalBlocksPlanned: phase === "measurement" ? plannedPhysicalBlocks : null,
      operationsCompleted: phaseOperations,
      elapsedTimeMs: phaseElapsedMs,
      maxTimeMs: auto.maxTimeMs,
    });
    return unit;
  };
  const intervalScale =
    task.definition.mode === "throughput" || task.definition.mode === "kernel" ? "identity" : "inverse-ms";
  const outcome = await runAutoMeasurement({
    auto,
    clock: clockProfile,
    runUnit,
    intervalScale,
    coverage: "validated-corpus-v1",
    onPlan: (plan) => {
      plannedPhysicalBlocks = plan.physicalBlockCount;
    },
  });
  if (activePhase) emit("taskPhaseEnd", { task: task.name, phase: activePhase });
  emit("taskPhaseStart", { task: task.name, phase: "assessment" });
  emit("taskPhaseEnd", { task: task.name, phase: "assessment" });

  const record = runner.record;
  record.status = outcome.status;
  record.reasons = outcome.reasons;
  record.interval = outcome.interval;
  record.plan =
    outcome.plan && task.definition.mode === "kernel" && record.kernelBaseCount !== null ?
      Object.freeze({ ...outcome.plan, operationsPerBlock: record.kernelBaseCount })
    : outcome.plan;
  record.schedule = Object.freeze({ seed: runSeed, yieldBetweenRounds: false, rows: Object.freeze([]) });
  if (task.definition.mode === "kernel" && outcome.status === "complete" && outcome.plan) {
    const slopes = groupMeans(
      outcome.measurementValues,
      outcome.plan.physicalBlocksPerSuperblock,
    );
    record.interval = createRoundSlopeInterval(
      slopes,
      outcome.plan.physicalBlockCount,
      "validated-corpus-v1",
    );
  }
  runner.finishKernelDiagnostics();
  return record;
};

export { acquireAutoTask, acquireFixedTask, getCalibrationTarget };
export type { AutoTaskInput, FixedTaskInput };
