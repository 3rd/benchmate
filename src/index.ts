/* eslint-disable no-await-in-loop */
import { printResult, printResults } from "./print";
import { computeTaskStats } from "./stats";
import { getNowProvider } from "./time";
import { sleep, noop } from "./utils";

export type BenchmarkOptions = {
  iterations: number;
  batching: { enabled: boolean; size: number | "auto" };
  warmupIterations: number | "auto";
  method: "auto" | "hrtime" | "performance.now";
  testSleepDuration: number;
  quiet: boolean;
  setup: () => Promise<void> | void;
  teardown: () => Promise<void> | void;
};

export type Task = {
  name: string;
  fn: () => Promise<void> | void;
  isAsync: boolean;
};

export type BenchmarkResult = {
  name: string;
  stats: ReturnType<typeof computeTaskStats>;
};

const defaultOptions: BenchmarkOptions = {
  iterations: 100_000,
  batching: { enabled: true, size: "auto" },
  warmupIterations: "auto",
  method: "auto",
  testSleepDuration: 0,
  quiet: false,
  setup: noop,
  teardown: noop,
};

class Bench {
  tasks: Task[] = [];
  options: BenchmarkOptions = defaultOptions;
  now: () => number;

  constructor(options?: Partial<BenchmarkOptions>) {
    if (options)
      this.options = { ...defaultOptions, ...options, batching: { ...defaultOptions.batching, ...options.batching } };
    this.now = getNowProvider(this.options.method);
  }

  add(name: string, fn: () => Promise<void> | void) {
    const task: Task = { name, fn, isAsync: fn() instanceof Promise };
    if (task.isAsync) {
      console.warn(`Warning: Using asynchronous functions in task '${task.name}' will affect measurement accuracy.`);
    }
    this.tasks.push(task);
  }

  private async warmup(task: Task) {
    const warmupIterations =
      this.options.warmupIterations === "auto" ? this.options.iterations / 10 : this.options.warmupIterations;
    for (let i = 0; i < warmupIterations; i++) {
      if (task.isAsync) await task.fn();
      else task.fn();
    }
  }

  private measureTaskBatchSync = (task: Task, size: number = 1): number => {
    const start = this.now();
    for (let i = 0; i < size; i++) {
      task.fn();
    }
    return this.now() - start;
  };

  private measureTaskBatchAsync = async (task: Task, size: number = 1): Promise<number> => {
    const start = this.now();
    for (let i = 0; i < size; i++) {
      await task.fn();
    }
    return this.now() - start;
  };

  private async runTask(task: Task): Promise<BenchmarkResult> {
    await this.options.setup();

    let batchSize = this.options.iterations;
    if (this.options.batching.enabled) {
      if (this.options.batching.size === "auto") {
        batchSize = Math.max(1, Math.floor(this.options.iterations / 100));
      } else {
        batchSize = this.options.batching.size;
      }
    }
    const batchCount = this.options.batching.enabled ? Math.ceil(this.options.iterations / batchSize) : 1;
    const batchTimings = new Float64Array(batchCount);
    const batchSizes = new Uint32Array(batchCount);

    const measure = task.isAsync ? this.measureTaskBatchAsync : this.measureTaskBatchSync;

    let iterationIndex = 0;
    await this.warmup(task);
    while (iterationIndex < this.options.iterations) {
      const currentBatchIndex = this.options.batching.enabled ? Math.floor(iterationIndex / batchSize) : 0;
      const currentBatchSize = this.options.batching.enabled
        ? Math.min(batchSize, this.options.iterations - iterationIndex)
        : this.options.iterations - iterationIndex;

      const elapsed = await measure(task, currentBatchSize);
      batchTimings[currentBatchIndex] = elapsed;
      batchSizes[currentBatchIndex] = currentBatchSize;

      iterationIndex += currentBatchSize;
    }

    await this.options.teardown();

    const stats = computeTaskStats(batchTimings, batchSizes);
    return { name: task.name, stats };
  }

  async run(): Promise<BenchmarkResult[]> {
    const results: BenchmarkResult[] = [];

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
