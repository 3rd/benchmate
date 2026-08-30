import type {
  Clock,
  CompiledTaskFunction,
  EndToEndTaskDefinition,
  ThroughputTaskDefinition,
  TimedBlock,
} from "../types";
import { blackhole } from "./blackhole";

type CallProbe = {
  block: TimedBlock;
  isAsync: boolean;
};

type EndToEndBlock = TimedBlock & {
  isAsync: boolean;
};

type EndToEndBlockInput<Input> = {
  task: EndToEndTaskDefinition<Input>;
  operations: number;
  firstInputSeed: number;
  clock: Clock;
};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  return typeof (value as { then?: unknown }).then === "function";
};

const normalizeFailure = (error: unknown): Error => {
  return error instanceof Error ? error : (
      new Error("Throughput task failed with a non-Error value.", { cause: error })
    );
};

const compileTaskFunction = (run: () => unknown, isAsync: boolean): CompiledTaskFunction => {
  if (isAsync) {
    return async (iterations, clock) => {
      let remainingIterations = iterations;
      const startedAtMs = clock.now();
      while (remainingIterations--) {
        const value = run();
        if (!isPromiseLike(value)) {
          throw new TypeError("Call task changed from asynchronous to synchronous execution.");
        }
        blackhole(await value);
      }
      return {
        startedAtMs,
        elapsedMs: clock.now() - startedAtMs,
        operations: iterations,
        resultHash: null,
      };
    };
  }

  return (iterations, clock) => {
    let remainingIterations = iterations;
    const startedAtMs = clock.now();
    while (remainingIterations--) {
      const value = run();
      if (isPromiseLike(value)) {
        throw new TypeError("Call task changed from synchronous to asynchronous execution.");
      }
      blackhole(value);
    }
    return {
      startedAtMs,
      elapsedMs: clock.now() - startedAtMs,
      operations: iterations,
      resultHash: null,
    };
  };
};

const probeCallTask = async (run: () => unknown, clock: Clock): Promise<CallProbe> => {
  const startedAtMs = clock.now();
  const value = run();
  const isAsync = isPromiseLike(value);
  blackhole(isAsync ? await value : value);
  return {
    block: { startedAtMs, elapsedMs: clock.now() - startedAtMs, operations: 1, resultHash: null },
    isAsync,
  };
};

const runThroughputBlock = async (
  task: ThroughputTaskDefinition,
  operationsPerLane: number,
  clock: Clock,
): Promise<TimedBlock> => {
  if (!Number.isSafeInteger(operationsPerLane) || operationsPerLane <= 0) {
    throw new RangeError(`'operationsPerLane' must be a positive safe integer, got ${operationsPerLane}`);
  }
  const startedAtMs = clock.now();
  const state: { primaryError: Error | null } = { primaryError: null };
  const lanes = Array.from({ length: task.concurrency }, async () => {
    for (let operation = 0; operation < operationsPerLane; operation++) {
      if (state.primaryError !== null) return;
      try {
        const value = task.run();
        if (!isPromiseLike(value)) {
          throw new TypeError("Throughput mode run() must return a Promise-like value.");
        }
        blackhole(await value);
      } catch (error) {
        if (state.primaryError === null) state.primaryError = normalizeFailure(error);
        return;
      }
    }
  });
  await Promise.all(lanes);
  const failure = state.primaryError;
  if (failure !== null) throw failure;
  return {
    startedAtMs,
    elapsedMs: clock.now() - startedAtMs,
    operations: operationsPerLane * task.concurrency,
    resultHash: null,
  };
};

const runEndToEndBlock = async <Input>(input: EndToEndBlockInput<Input>): Promise<EndToEndBlock> => {
  const { task, operations, firstInputSeed, clock } = input;
  let isAsync = false;
  const startedAtMs = clock.now();
  for (let operation = 0; operation < operations; operation++) {
    const operationInput = task.createInput({ seed: firstInputSeed + operation });
    const value = task.run(operationInput);
    if (isPromiseLike(value)) {
      isAsync = true;
      blackhole(await value);
    } else {
      blackhole(value);
    }
  }
  return {
    startedAtMs,
    elapsedMs: clock.now() - startedAtMs,
    operations,
    resultHash: null,
    isAsync,
  };
};

export { compileTaskFunction, isPromiseLike, probeCallTask, runEndToEndBlock, runThroughputBlock };
export type { CallProbe, EndToEndBlock };
