import type {
  Clock,
  KernelRoundModel,
  MeasurementObservation,
  MeasurementPhase,
  ObservationFlag,
  Task,
  TaskRecord,
  TimedBlock,
} from "../types";
import type { AutoStage, AutoUnit } from "./auto";
import { ObservationCollector } from "../evidence/observations";
import { diagnoseKernelResults, fitKernelRound } from "../results/regression";
import { median } from "../results/superblocks";
import { compileTaskFunction, probeCallTask, runEndToEndBlock, runThroughputBlock } from "./compile";
import { createKernelLadder, createKernelRoundPlan, runKernelInvocation } from "./kernel";

type TaskRunnerInput = {
  task: Task;
  clock: Clock;
  collector: ObservationCollector;
  quiet: boolean;
  precisionX: number;
};

type TaskMeasurementGroupKeyResolver = (task: Task) => string;

type FixedTaskRunInput = {
  phase: MeasurementPhase;
  operations: number;
  round: number;
  observationSeed: number;
  firstInputSeed: number | null;
};

type AutoTaskRunInput = {
  stage: AutoStage;
  operations: number;
  round: number;
  observationSeed: number;
  firstInputSeed: number | null;
};

type TaskRunner = {
  record: TaskRecord;
  runFixed: (input: FixedTaskRunInput) => Promise<TimedBlock>;
  runAuto: (input: AutoTaskRunInput) => Promise<AutoUnit>;
  finishKernelDiagnostics: () => void;
};

type RecordedBlockInput = {
  task: string;
  phase: MeasurementPhase;
  block: TimedBlock;
  round: number | null;
  seed: number | null;
  flags?: readonly ObservationFlag[];
};

const emptyOverhead = (): TaskRecord["overhead"] => ({
  perInvocationMs: 0,
  sampleCount: 0,
  observationSequences: [],
});

const phaseForStage = (stage: AutoStage): Extract<MeasurementPhase, "measurement" | "pilot" | "warmup"> => {
  return stage === "sizing" ? "warmup" : stage;
};

const recordBlock = (collector: ObservationCollector, input: RecordedBlockInput): MeasurementObservation => {
  return collector.record({
    task: input.task,
    phase: input.phase,
    ...input.block,
    round: input.round,
    seed: input.seed,
    flags: input.flags,
  });
};

const measureHarnessOverhead = async (
  taskName: string,
  isAsync: boolean,
  clock: Clock,
  collector: ObservationCollector,
): Promise<TaskRecord["overhead"]> => {
  const noop = compileTaskFunction(isAsync ? async () => {} : () => {}, isAsync);
  const iterations = 10_000;
  recordBlock(collector, {
    task: taskName,
    phase: "overhead",
    block: await noop(iterations, clock),
    round: null,
    seed: null,
  });
  const values: number[] = [];
  const observationSequences: number[] = [];
  for (let sample = 0; sample < 5; sample++) {
    const block = await noop(iterations, clock);
    const observation = recordBlock(collector, {
      task: taskName,
      phase: "overhead",
      block,
      round: null,
      seed: null,
    });
    values.push(block.elapsedMs / iterations);
    observationSequences.push(observation.sequence);
  }
  return {
    perInvocationMs: median(values),
    sampleCount: values.length,
    observationSequences: Object.freeze(observationSequences),
  };
};

const getTaskMeasurementGroupKey: TaskMeasurementGroupKeyResolver = (task) => {
  if (task.definition.mode === "throughput") return `throughput:${task.definition.concurrency}`;
  return task.definition.mode;
};

const createTaskRunner = async (input: TaskRunnerInput): Promise<TaskRunner> => {
  const { task, clock, collector, quiet, precisionX } = input;
  const definition = task.definition;
  const record: TaskRecord = {
    task,
    groupKey: getTaskMeasurementGroupKey(task),
    status: "failed",
    reasons: Object.freeze([]),
    interval: null,
    executionKind: definition.mode === "throughput" ? "async" : "sync",
    overhead: emptyOverhead(),
    schedule: Object.freeze({ seed: null, yieldBetweenRounds: false, rows: Object.freeze([]) }),
    kernelModels: [],
    kernelFallbackModels: [],
    kernelBaseCount: null,
    kernelLadder: Object.freeze([]),
    plan: null,
  };
  let compiledCall: ReturnType<typeof compileTaskFunction> | null = null;

  if (definition.mode === "call") {
    const probe = await probeCallTask(definition.run, clock);
    recordBlock(collector, {
      task: task.name,
      phase: "probe",
      block: probe.block,
      round: null,
      seed: null,
    });
    record.executionKind = probe.isAsync ? "async" : "sync";
    if (probe.isAsync && !quiet) {
      console.warn(
        `Warning: Using asynchronous functions in task '${task.name}' will affect measurement accuracy.`,
      );
    }
    compiledCall = compileTaskFunction(definition.run, probe.isAsync);
    record.overhead = await measureHarnessOverhead(task.name, probe.isAsync, clock, collector);
  }

  const runFixed = async (runInput: FixedTaskRunInput): Promise<TimedBlock> => {
    const { phase, operations, round, observationSeed, firstInputSeed } = runInput;
    if (definition.mode === "kernel" || definition.mode === "throughput") {
      throw new Error(`${definition.mode} tasks require automatic measurement.`);
    }
    let block: TimedBlock | undefined;
    if (definition.mode === "call") {
      block = await compiledCall?.(operations, clock);
    } else {
      if (firstInputSeed === null) {
        throw new Error("End-to-end task execution requires a createInput seed range.");
      }
      block = await runEndToEndBlock({ task: definition, operations, firstInputSeed, clock });
    }
    if (!block) throw new Error("Task execution runner was not initialized.");
    if (definition.mode === "end-to-end" && "isAsync" in block && block.isAsync) {
      record.executionKind = "async";
    }
    recordBlock(collector, {
      task: task.name,
      phase,
      block,
      round,
      seed: definition.mode === "call" ? null : observationSeed,
    });
    return block;
  };

  const runAuto = async (runInput: AutoTaskRunInput): Promise<AutoUnit> => {
    const { stage, operations, round, observationSeed, firstInputSeed } = runInput;
    const phase = phaseForStage(stage);
    if (definition.mode === "call") {
      const block = await compiledCall?.(operations, clock);
      if (!block) throw new Error("Call task runner was not initialized.");
      recordBlock(collector, { task: task.name, phase, block, round, seed: observationSeed });
      return {
        elapsedMs: block.elapsedMs,
        value: block.elapsedMs / block.operations,
        operations: block.operations,
      };
    }
    if (definition.mode === "throughput") {
      const block = await runThroughputBlock(definition, operations, clock);
      recordBlock(collector, { task: task.name, phase, block, round, seed: observationSeed });
      return {
        elapsedMs: block.elapsedMs,
        value: block.elapsedMs > 0 ? (block.operations / block.elapsedMs) * 1000 : 0,
        operations: block.operations,
      };
    }
    if (definition.mode === "end-to-end") {
      if (firstInputSeed === null) {
        throw new Error("End-to-end task execution requires a createInput seed range.");
      }
      const block = await runEndToEndBlock({ task: definition, operations, firstInputSeed, clock });
      if (block.isAsync) record.executionKind = "async";
      recordBlock(collector, { task: task.name, phase, block, round, seed: observationSeed });
      return {
        elapsedMs: block.elapsedMs,
        value: block.elapsedMs / block.operations,
        operations: block.operations,
      };
    }

    if (stage === "sizing") {
      const block = runKernelInvocation(definition, operations, clock);
      recordBlock(collector, {
        task: task.name,
        phase: "warmup",
        block,
        round,
        seed: null,
      });
      return {
        elapsedMs: block.elapsedMs,
        value: block.elapsedMs / block.operations,
        operations: block.operations,
      };
    }

    const baseCount = Math.max(2, operations);
    record.kernelBaseCount = baseCount;
    record.kernelLadder = createKernelLadder(baseCount);
    const plan = createKernelRoundPlan(baseCount, observationSeed, 0, round);
    const roundObservations: MeasurementObservation[] = [];
    let elapsed = 0;
    let totalOperations = 0;
    for (const point of plan.points) {
      const block = runKernelInvocation(definition, point.iterations, clock);
      const observation = recordBlock(collector, {
        task: task.name,
        phase,
        block,
        round,
        seed: plan.seed,
      });
      roundObservations.push(observation);
      elapsed += block.elapsedMs;
      totalOperations += block.operations;
    }
    const model = fitKernelRound(round, plan.seed, roundObservations, precisionX);
    if (stage === "measurement") record.kernelModels.push(model);
    if (stage === "pilot") record.kernelFallbackModels.push(model);
    if (model.flags.length > 0) {
      for (const observation of roundObservations) collector.addFlags(observation.sequence, model.flags);
    }
    return { elapsedMs: elapsed, value: model.slopeMsPerOperation, operations: totalOperations };
  };

  const finishKernelDiagnostics = () => {
    if (record.task.definition.mode !== "kernel") return;
    const observations = collector.snapshot().filter((observation) => observation.task === record.task.name);
    const diagnostics = diagnoseKernelResults(observations);
    for (const sequence of diagnostics.constantResultSequences) {
      collector.addFlags(sequence, ["constant-result"]);
    }
    for (const sequence of diagnostics.unhashableResultSequences) {
      collector.addFlags(sequence, ["unhashable-result"]);
    }
    if (record.status !== "complete") return;
    if (
      record.kernelModels.some(
        (model: KernelRoundModel) =>
          !Number.isFinite(model.slopeMsPerOperation) || model.slopeMsPerOperation <= 0,
      )
    ) {
      record.status = "unidentifiable";
      record.reasons = Object.freeze([
        "one or more final kernel rounds produced a non-positive or non-finite slope",
      ]);
      record.interval = null;
      return;
    }
    if (record.kernelModels.some((model: KernelRoundModel) => model.flags.includes("nonlinear-scaling"))) {
      record.status = "optimization-sensitive";
      record.reasons = Object.freeze([
        "low and high kernel operation-count ranges produced incompatible slopes",
      ]);
      record.interval = null;
      return;
    }
    if (diagnostics.hasUnhashableResults) {
      record.status = "optimization-sensitive";
      record.reasons = Object.freeze(["one or more kernel results could not be hashed"]);
      record.interval = null;
      return;
    }
    if (diagnostics.nondeterministic) {
      record.status = "optimization-sensitive";
      record.reasons = Object.freeze([
        "identical kernel iteration counts produced different result hashes",
      ]);
      record.interval = null;
      return;
    }
    if (diagnostics.constantAcrossOperationCounts && !record.task.definition.constantResult) {
      record.status = "optimization-sensitive";
      record.reasons = Object.freeze([
        "kernel results were constant across at least three operation counts",
      ]);
      record.interval = null;
    }
  };

  return { record, runFixed, runAuto, finishKernelDiagnostics };
};

export { createTaskRunner, getTaskMeasurementGroupKey };
export type { TaskRunner, TaskRunnerInput };
