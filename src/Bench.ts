/* eslint-disable no-await-in-loop */
import { compileTaskFunction } from "./functions";
import { printResult, printResults } from "./print";
import { computeTaskStats } from "./stats";
import { getNowProvider } from "./time";
import { sleep } from "./utils";

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Record<string, unknown> ? DeepPartial<T[P]> : T[P];
};

type IterationOptions = { iterations: number } | { iterations: "auto"; time: number };
type InternalBenchmarkOptions = {
  debug: boolean;
  batching: { enabled: boolean; size: number | "auto" };
  warmup: { enabled: boolean; iterations: number | "auto" };
  method: "auto" | "hrtime" | "performance.now";
  testSleepDuration: number;
  quiet: boolean;
  setup?: () => Promise<void> | void;
  teardown?: () => Promise<void> | void;
} & IterationOptions;

export type BenchmarkOptions = DeepPartial<Omit<InternalBenchmarkOptions, keyof IterationOptions>> &
  ({ iterations?: number } | { iterations: "auto"; time?: number } | { time?: number });

export type Task = {
  name: string;
  fn: () => Promise<void> | void;
  compiledFn: (iterations: number, now: () => number) => Promise<number> | number;
};

export type BenchmarkResult = {
  name: string;
  stats: ReturnType<typeof computeTaskStats>;
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
  tasks: Task[] = [];
  options: InternalBenchmarkOptions = defaultOptions;
  now: () => number;

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

  private debug(...args: unknown[]) {
    if (!this.options.debug) return;
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
        if (elapsed < measurementTarget / 2) {
          iterations *= 2;
        } else {
          break;
        }
      }
      const targetIterations = Math.floor((this.options.time / elapsed) * iterations);
      this.debug(`[${task.name}] Determined that ${targetIterations} should run in ~${this.options.time}ms`);
      return targetIterations;
    }
    return this.options.iterations;
  }

  private async warmup(task: Task, taskIterations: number) {
    const warmupIterations =
      this.options.warmup.iterations === "auto" ? Math.floor(taskIterations / 10) : this.options.warmup.iterations;
    this.debug(`[${task.name}] Warming up for ${warmupIterations} iterations`);
    await this.measureTaskBatch(task, warmupIterations);
  }

  private measureTaskBatch = async (task: Task, size: number = 1): Promise<number> => {
    return await task.compiledFn(Math.floor(size), this.now);
  };

  private async runTask(task: Task): Promise<BenchmarkResult> {
    const taskIterations = await this.computeTaskIterationsForDuration(task);

    let batchSize = taskIterations;
    if (this.options.batching.enabled) {
      if (this.options.batching.size === "auto") {
        if (taskIterations < 1000) batchSize = taskIterations / 25;
        else if (taskIterations < 10000) batchSize = taskIterations / 50;
        else if (taskIterations < 100000) batchSize = taskIterations / 100;
        else if (taskIterations < 1000000) batchSize = taskIterations / 200;
        else batchSize = taskIterations / 500;
      } else {
        batchSize = this.options.batching.size;
      }
    }
    batchSize = Math.max(1, Math.floor(batchSize));
    const batchCount = this.options.batching.enabled ? Math.ceil(taskIterations / batchSize) : 1;
    const batchTimings = new Float64Array(batchCount);
    const batchSizes = new Uint32Array(batchCount);

    this.debug(`[${task.name}] Preparing to run ${taskIterations} iterations in ${batchCount} batches of ${batchSize}`);

    if (this.options.warmup) await this.warmup(task, taskIterations);

    if (this.options.setup) {
      this.debug(`[${task.name}] Executing setup() hook`);
      await this.options.setup();
    }

    this.debug(`[${task.name}] Starting benchmark...`);

    const start = this.now();
    let iterationIndex = 0;
    while (iterationIndex < taskIterations) {
      const currentBatchIndex = this.options.batching.enabled ? Math.floor(iterationIndex / batchSize) : 0;
      const currentBatchSize = this.options.batching.enabled
        ? Math.min(batchSize, taskIterations - iterationIndex)
        : taskIterations - iterationIndex;

      const elapsed = await this.measureTaskBatch(task, currentBatchSize);
      batchTimings[currentBatchIndex] = elapsed;
      batchSizes[currentBatchIndex] = currentBatchSize;

      iterationIndex += currentBatchSize;
    }
    const end = this.now();

    this.debug(`[${task.name}] Benchmark completed ${iterationIndex} iterations in ${end - start}ms`);

    if (this.options.teardown) {
      this.debug(`[${task.name}] Executing teardown() hook`);
      await this.options.teardown();
    }

    const stats = computeTaskStats(batchTimings, batchSizes);
    return { name: task.name, stats };
  }

  add(name: string, fn: () => Promise<void> | void) {
    const isAsync = fn() instanceof Promise;
    const compiledFn = compileTaskFunction(fn);
    const task: Task = { name, fn, compiledFn };

    if (isAsync) {
      console.warn(`Warning: Using asynchronous functions in task '${task.name}' will affect measurement accuracy.`);
    }
    this.tasks.push(task);
  }

  async run(): Promise<BenchmarkResult[]> {
    const results: BenchmarkResult[] = [];

    this.debug(`Starting to benchmark ${this.tasks.length} tasks`);
    this.debug(`Configuration: ${JSON.stringify(this.options, null, 2)}`);

    for (const task of this.tasks) {
      const result = await this.runTask(task);
      results.push(result);
      if (!this.options.quiet) printResult(result);
      await sleep(this.options.testSleepDuration);
    }

    if (!this.options.quiet) printResults(results);

    return results;
  }
}

export { Bench };
