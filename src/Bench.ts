/* eslint-disable no-await-in-loop */
import { compileTaskFunction } from "./functions";
import { printResult, printResults } from "./print";
import { computeTaskStats } from "./stats";
import { getNowProvider } from "./time";
import { sleep } from "./utils";

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Record<string, unknown> ? DeepPartial<T[P]> : T[P];
};

type IterationOptions = { iterations: "auto"; time: number } | { iterations: number };
type InternalBenchmarkOptions = IterationOptions & {
  debug: boolean;
  batching: { enabled: boolean; size: "auto" | number };
  warmup: { enabled: boolean; iterations: "auto" | number };
  method: "auto" | "hrtime" | "performance.now";
  testSleepDuration: number;
  quiet: boolean;
  setup?: (task: Task) => Promise<void> | void;
  teardown?: () => Promise<void> | void;
};

type BenchmarkOptions = DeepPartial<Omit<InternalBenchmarkOptions, keyof IterationOptions>> &
  ({ iterations: "auto"; time?: number } | { iterations?: number } | { time?: number });

type Task = {
  name: string;
  fn: () => Promise<void> | void;
  compiledFn: (iterations: number, now: () => number) => Promise<number> | number;
};

type BenchmarkResult = {
  name: string;
  stats: ReturnType<typeof computeTaskStats>;
};

type BenchEvents = {
  benchmarkStart: { tasks: string[] };
  taskStart: { task: string };
  taskWarmupStart: { task: string; iterations: number };
  taskWarmupEnd: { task: string };
  setup: { task: string };
  teardown: { task: string };
  taskComplete: BenchmarkResult;
  benchmarkEnd: { results: BenchmarkResult[] };
  progress: {
    task: string;
    tasksCompleted: number;
    tasksTotal: number;
    iterationsCompleted: number;
    iterationsTotal: number;
    elapsedTime: number;
  };
};

const defaultOptions = {
  debug: false,
  iterations: "auto",
  time: 2000,
  batching: { enabled: true, size: "auto" },
  warmup: { enabled: true, iterations: "auto" },
  method: "auto",
  testSleepDuration: 0,
  quiet: typeof window !== "undefined",
} as const;

class Bench {
  private tasks: Task[] = [];
  private options: InternalBenchmarkOptions = defaultOptions;
  private now: () => number;

  private eventListeners: {
    [K in keyof BenchEvents]?: ((data: BenchEvents[K]) => void)[];
  } = {};

  constructor(options?: BenchmarkOptions) {
    if (options) {
      const { batching, warmup, ...rest } = options;
      if (
        "iterations" in options &&
        options.iterations !== "auto" &&
        "time" in options &&
        typeof options.time === "number"
      ) {
        throw new Error(
          "The 'time' option is only supported when 'iterations' is set to 'auto' as the iteration count is automatically computed for each task based on the target time."
        );
      }

      const iterations = ("iterations" in options && options.iterations) || defaultOptions.iterations;
      const time =
        (iterations === "auto" && ("time" in options && options.time ? options.time : defaultOptions.time)) || -1;

      this.options = {
        ...defaultOptions,
        ...rest,
        batching: { ...defaultOptions.batching, ...batching },
        warmup: { ...defaultOptions.warmup, ...warmup },
        iterations,
        time,
      };
    }
    this.now = getNowProvider(this.options.method);
  }

  on<K extends keyof BenchEvents>(event: K, handler: (data: BenchEvents[K]) => void) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event]!.push(handler);
  }

  off<K extends keyof BenchEvents>(event: K, handler: (data: BenchEvents[K]) => void) {
    const handlers = this.eventListeners[event];
    if (!handlers) return;
    const updatedHandlers = handlers.filter((h) => h !== handler);
    this.eventListeners[event] = updatedHandlers as typeof handlers;
  }

  private emit<K extends keyof BenchEvents>(event: K, data: BenchEvents[K]) {
    const handlers = this.eventListeners[event];
    if (handlers) {
      for (const handler of handlers) {
        handler(data);
      }
    }
  }

  private debug(...args: unknown[]) {
    if (!this.options.debug || this.options.quiet) return;
    console.log(...args);
  }

  private async computeTaskIterationsForDuration(task: Task): Promise<number> {
    if (this.options.iterations === "auto") {
      const measurementTarget = 500;
      this.debug(`[${task.name}] Computing how many iterations should run in ${measurementTarget}ms`);
      let iterations = 1;
      let elapsed = 0;
      while (elapsed < measurementTarget) {
        elapsed = await this.measureTaskBatch(task, iterations);
        if (elapsed < measurementTarget / 2) iterations *= 2;
        else break;
      }
      const targetIterations = Math.floor((this.options.time / elapsed) * iterations);
      this.debug(`[${task.name}] Determined that ${targetIterations} should run in ~${this.options.time}ms`);
      return targetIterations;
    }
    return this.options.iterations;
  }

  private async warmup(task: Task, taskIterations: number) {
    if (!this.options.warmup.enabled) return;
    const warmupIterations =
      this.options.warmup.iterations === "auto" ? Math.floor(taskIterations / 10) : this.options.warmup.iterations;
    this.debug(`[${task.name}] Warming up for ${warmupIterations} iterations`);
    this.emit("taskWarmupStart", { task: task.name, iterations: warmupIterations });
    await this.measureTaskBatch(task, warmupIterations);
    this.emit("taskWarmupEnd", { task: task.name });
  }

  private measureTaskBatch = async (task: Task, size = 1): Promise<number> => {
    return task.compiledFn(Math.floor(size), this.now);
  };

  private async runTask(task: Task, tasksCompletedBeforeThis: number, tasksTotal: number): Promise<BenchmarkResult> {
    this.emit("taskStart", { task: task.name });

    const taskIterations = await this.computeTaskIterationsForDuration(task);

    let batchSize = taskIterations;
    if (this.options.batching.enabled) {
      if (this.options.batching.size === "auto") {
        if (taskIterations < 1000) batchSize = taskIterations / 25;
        else if (taskIterations < 10_000) batchSize = taskIterations / 50;
        else if (taskIterations < 100_000) batchSize = taskIterations / 100;
        else if (taskIterations < 1_000_000) batchSize = taskIterations / 200;
        else batchSize = taskIterations / 500;
      } else batchSize = this.options.batching.size;
    }

    batchSize = Math.max(1, Math.floor(batchSize));
    const batchCount = this.options.batching.enabled ? Math.ceil(taskIterations / batchSize) : 1;
    const batchTimings = new Float64Array(batchCount);
    const batchSizes = new Uint32Array(batchCount);

    this.debug(`[${task.name}] Preparing to run ${taskIterations} iterations in ${batchCount} batches of ${batchSize}`);

    await this.warmup(task, taskIterations);

    if (this.options.setup) {
      this.debug(`[${task.name}] Executing setup() hook`);
      this.emit("setup", { task: task.name });
      await this.options.setup(task);
    }

    this.debug(`[${task.name}] Starting benchmark...`);

    let iterationIndex = 0;

    // throttle emitted progress events
    const start = this.now();
    const minProgressEmitInterval = 1000 / 30;
    let lastProgressEmitTimestamp = start;

    while (iterationIndex < taskIterations) {
      const currentBatchIndex = this.options.batching.enabled ? Math.floor(iterationIndex / batchSize) : 0;
      const currentBatchSize = this.options.batching.enabled
        ? Math.min(batchSize, taskIterations - iterationIndex)
        : taskIterations - iterationIndex;

      const elapsed = await this.measureTaskBatch(task, currentBatchSize);
      batchTimings[currentBatchIndex] = elapsed;
      batchSizes[currentBatchIndex] = currentBatchSize;

      iterationIndex += currentBatchSize;

      // emit progress
      const nowTime = this.now();
      if (nowTime - lastProgressEmitTimestamp >= minProgressEmitInterval) {
        this.emit("progress", {
          task: task.name,
          tasksCompleted: tasksCompletedBeforeThis,
          tasksTotal,
          iterationsCompleted: iterationIndex,
          iterationsTotal: taskIterations,
          elapsedTime: this.now() - start,
        });
        lastProgressEmitTimestamp = nowTime;
      }
    }
    const end = this.now();

    this.debug(`[${task.name}] Benchmark completed ${iterationIndex} iterations in ${end - start}ms`);

    if (this.options.teardown) {
      this.debug(`[${task.name}] Executing teardown() hook`);
      this.emit("teardown", { task: task.name });
      await this.options.teardown();
    }

    const stats = computeTaskStats(batchTimings, batchSizes);
    const result = { name: task.name, stats };

    // final progress emit
    this.emit("progress", {
      task: task.name,
      tasksCompleted: tasksCompletedBeforeThis,
      tasksTotal,
      iterationsCompleted: iterationIndex,
      iterationsTotal: taskIterations,
      elapsedTime: this.now() - start,
    });

    this.emit("taskComplete", result);
    return result;
  }

  add(name: string, fn: () => Promise<void> | void) {
    const isAsync = fn() instanceof Promise;
    const compiledFn = compileTaskFunction(fn);
    const task: Task = { name, fn, compiledFn };

    if (isAsync && !this.options.quiet) {
      console.warn(`Warning: Using asynchronous functions in task '${task.name}' will affect measurement accuracy.`);
    }

    this.tasks.push(task);
  }

  async run(): Promise<BenchmarkResult[]> {
    const results: BenchmarkResult[] = [];

    this.emit("benchmarkStart", { tasks: this.tasks.map((t) => t.name) });
    this.debug(`Starting to benchmark ${this.tasks.length} tasks`);
    this.debug(`Configuration: ${JSON.stringify(this.options, null, 2)}`);

    const tasksTotal = this.tasks.length;
    let tasksCompleted = 0;

    for (const task of this.tasks) {
      const result = await this.runTask(task, tasksCompleted, tasksTotal);
      results.push(result);
      tasksCompleted++;

      if (!this.options.quiet) printResult(result);
      await sleep(this.options.testSleepDuration);
    }

    if (!this.options.quiet) printResults(results);

    this.emit("benchmarkEnd", { results });
    return results;
  }
}

export type { BenchmarkOptions, BenchmarkResult, Task };
export { Bench };
