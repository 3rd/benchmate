import type {
  BenchmarkOptions,
  ResolvedAutoOptions,
  ResolvedBenchmarkOptions,
  TaskDefinition,
} from "./types";

const CLOCK_METHODS = ["auto", "hrtime", "performance.now"] as const;
const AUTO_DEFAULTS = {
  precisionX: 0.01,
  maxTimeMs: 15_000,
  maxWarmupTimeMs: 5000,
  minPilotBlocks: 64,
  minEffectiveBlocks: 20,
} as const;

const defaultOptions = {
  batching: { enabled: true, operationsPerBlock: "auto" },
  warmup: { enabled: true, iterations: "auto" },
  method: "auto",
  sleepBetweenTasksMs: 0,
  quiet: true,
} as const;

type UntypedAutoOptions = {
  precisionX?: unknown;
  maxTimeMs?: unknown;
  maxWarmupTimeMs?: unknown;
};

type UntypedScheduleOptions = {
  mode?: unknown;
  seed?: unknown;
  yieldBetweenRounds?: unknown;
};

type UntypedBenchmarkOptions = BenchmarkOptions & {
  auto?: UntypedAutoOptions;
  schedule?: UntypedScheduleOptions;
  timeMs?: number;
  iterations?: number;
};

const assertPositiveInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`'${name}' must be a positive safe integer, got ${value}`);
  }
};

const assertPositiveFinite = (value: number, name: string) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`'${name}' must be a positive finite number, got ${value}`);
  }
};

const resolveRunOptions = (
  auto: UntypedAutoOptions | undefined,
  iterations: number | undefined,
  timeMs: number | undefined,
): ResolvedBenchmarkOptions["run"] => {
  if (iterations !== undefined) return { mode: "count", iterations };
  if (timeMs !== undefined) return { mode: "time", timeMs };
  if (auto !== undefined && (typeof auto !== "object" || auto === null || Array.isArray(auto))) {
    throw new TypeError("'auto' must be an options object.");
  }
  const resolved: ResolvedAutoOptions = {
    mode: "auto",
    ...AUTO_DEFAULTS,
    precisionX:
      auto?.precisionX === undefined ? AUTO_DEFAULTS.precisionX : (auto.precisionX as number),
    maxTimeMs:
      auto?.maxTimeMs === undefined ? AUTO_DEFAULTS.maxTimeMs : (auto.maxTimeMs as number),
    maxWarmupTimeMs:
      auto?.maxWarmupTimeMs === undefined ?
        AUTO_DEFAULTS.maxWarmupTimeMs
      : (auto.maxWarmupTimeMs as number),
  };
  assertPositiveFinite(resolved.precisionX, "auto.precisionX");
  assertPositiveFinite(resolved.maxTimeMs, "auto.maxTimeMs");
  assertPositiveFinite(resolved.maxWarmupTimeMs, "auto.maxWarmupTimeMs");
  if (resolved.maxWarmupTimeMs >= resolved.maxTimeMs) {
    throw new RangeError("'auto.maxWarmupTimeMs' must be less than 'auto.maxTimeMs'.");
  }
  return resolved;
};

const resolveScheduleOptions = (
  schedule: UntypedScheduleOptions | undefined,
  run: ResolvedBenchmarkOptions["run"],
  sleepBetweenTasksMs: number | undefined,
): ResolvedBenchmarkOptions["schedule"] => {
  const mode = schedule?.mode ?? "isolated";
  if (mode !== "isolated" && mode !== "comparative") {
    throw new TypeError("'schedule.mode' must be 'isolated' or 'comparative'.");
  }
  if (mode === "comparative" && run.mode !== "auto") {
    throw new Error("Comparative scheduling requires automatic measurement.");
  }
  if (mode === "comparative" && sleepBetweenTasksMs !== undefined) {
    throw new Error("'sleepBetweenTasksMs' is unavailable in comparative mode; use 'yieldBetweenRounds'.");
  }
  const requestedSeed = schedule?.seed;
  if (mode === "isolated" && requestedSeed !== undefined) {
    throw new Error("'schedule.seed' is available only in comparative mode.");
  }
  if (mode === "isolated" && schedule?.yieldBetweenRounds !== undefined) {
    throw new Error("'schedule.yieldBetweenRounds' is available only in comparative mode.");
  }
  if (
    mode === "comparative" &&
    requestedSeed !== undefined &&
    (typeof requestedSeed !== "number" ||
      !Number.isInteger(requestedSeed) ||
      requestedSeed < 0 ||
      requestedSeed > 0xFF_FF_FF_FF)
  ) {
    throw new RangeError(`'schedule.seed' must be an unsigned 32-bit integer, got ${String(requestedSeed)}`);
  }
  if (schedule?.yieldBetweenRounds !== undefined && typeof schedule.yieldBetweenRounds !== "boolean") {
    throw new TypeError("'schedule.yieldBetweenRounds' must be a boolean.");
  }
  if (mode === "isolated") return { mode: "isolated" };
  return {
    mode: "comparative",
    seed: typeof requestedSeed === "number" ? requestedSeed : null,
    yieldBetweenRounds: schedule?.yieldBetweenRounds ?? false,
  };
};

const resolveOptions = (options: BenchmarkOptions = {}): ResolvedBenchmarkOptions => {
  const untyped = options as UntypedBenchmarkOptions;
  const { auto, batching, warmup, iterations, timeMs, schedule, ...rest } = untyped;
  const selectionCount = Number(iterations !== undefined) + Number(timeMs !== undefined);
  if (selectionCount > 1) throw new Error("Provide either 'timeMs' or 'iterations', not both.");
  if (auto !== undefined && selectionCount > 0) {
    throw new Error("'auto' cannot be combined with 'timeMs' or 'iterations'.");
  }
  if (selectionCount === 0 && (batching !== undefined || warmup !== undefined)) {
    throw new Error("'batching' and 'warmup' are available only with 'timeMs' or 'iterations'.");
  }
  if (iterations !== undefined) assertPositiveInteger(iterations, "iterations");
  if (timeMs !== undefined) assertPositiveFinite(timeMs, "timeMs");
  if (typeof batching?.operationsPerBlock === "number") {
    assertPositiveInteger(batching.operationsPerBlock, "batching.operationsPerBlock");
  }
  if (
    typeof warmup?.iterations === "number" &&
    (!Number.isSafeInteger(warmup.iterations) || warmup.iterations < 0)
  ) {
    throw new RangeError(`'warmup.iterations' must be a non-negative safe integer, got ${warmup.iterations}`);
  }
  if (
    rest.sleepBetweenTasksMs !== undefined &&
    (!Number.isFinite(rest.sleepBetweenTasksMs) || rest.sleepBetweenTasksMs < 0)
  ) {
    throw new RangeError(
      `'sleepBetweenTasksMs' must be a non-negative number, got ${rest.sleepBetweenTasksMs}`,
    );
  }
  if (rest.method !== undefined && !(CLOCK_METHODS as readonly unknown[]).includes(rest.method)) {
    throw new TypeError("'method' must be 'auto', 'hrtime', or 'performance.now'.");
  }

  const run = resolveRunOptions(auto, iterations, timeMs);
  const resolvedSchedule = resolveScheduleOptions(schedule, run, rest.sleepBetweenTasksMs);

  return {
    ...defaultOptions,
    ...rest,
    batching: { ...defaultOptions.batching, ...batching },
    warmup: { ...defaultOptions.warmup, ...warmup },
    run,
    schedule: resolvedSchedule,
  };
};

const normalizeTaskDefinition = <Input>(
  name: string,
  input: TaskDefinition<Input> | (() => unknown),
  runMode: ResolvedBenchmarkOptions["run"]["mode"],
): TaskDefinition<Input> => {
  const definition = (
    typeof input === "function" ?
      { mode: "call", run: input }
    : input) as TaskDefinition<Input>;
  if (typeof definition !== "object" || definition === null) {
    throw new TypeError("Task definition must be an object.");
  }
  if (
    definition.mode !== "call" &&
    definition.mode !== "kernel" &&
    definition.mode !== "throughput" &&
    definition.mode !== "end-to-end"
  ) {
    throw new TypeError("Task mode must be 'call', 'kernel', 'throughput', or 'end-to-end'.");
  }
  if (typeof definition.run !== "function") throw new TypeError(`Task '${name}' run must be callable.`);
  if (definition.setup !== undefined && typeof definition.setup !== "function") {
    throw new TypeError(`Task '${name}' setup must be callable.`);
  }
  if (definition.teardown !== undefined && typeof definition.teardown !== "function") {
    throw new TypeError(`Task '${name}' teardown must be callable.`);
  }
  if ((definition.mode === "kernel" || definition.mode === "throughput") && runMode !== "auto") {
    throw new Error(`${definition.mode} tasks require automatic measurement.`);
  }
  if (
    definition.mode === "kernel" &&
    definition.constantResult !== undefined &&
    typeof definition.constantResult !== "boolean"
  ) {
    throw new TypeError(`Task '${name}' constantResult must be a boolean.`);
  }
  if (definition.mode === "throughput") {
    assertPositiveInteger(definition.concurrency, `task '${name}' concurrency`);
  }
  if (definition.mode === "end-to-end" && typeof definition.createInput !== "function") {
    throw new TypeError(`Task '${name}' createInput must be callable.`);
  }
  return definition;
};

export { normalizeTaskDefinition, resolveOptions };
