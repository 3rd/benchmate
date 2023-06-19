/* eslint-disable no-await-in-loop */
import { computeTaskStats } from "./stats";
import { getNowProvider } from "./time";
import { sleep, noop } from "./utils";

type BenchmarkOptions = {
  iterations: number;
  batching: { enabled: boolean; size: number };
  warmupIterations: number;
  method: "auto" | "hrtime" | "performance.now";
  testSleepDuration: number;
  quiet: boolean;
  setup: () => Promise<void> | void;
  teardown: () => Promise<void> | void;
};

const defaultOptions: BenchmarkOptions = {
  iterations: 200_0000,
  batching: { enabled: true, size: 10_000 },
  warmupIterations: 10_000,
  method: "auto",
  testSleepDuration: 0,
  quiet: false,
  setup: noop,
  teardown: noop,
};

type Task = {
  name: string;
  fn: () => Promise<void> | void;
  isAsync: boolean;
};

type BenchmarkResult = {
  name: string;
  stats: ReturnType<typeof computeTaskStats>;
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
    for (let i = 0; i < this.options.warmupIterations; i++) {
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
    await this.warmup(task);
    await this.options.setup();

    const batchSize = this.options.batching.enabled ? this.options.batching.size : 1;
    const batchCount = this.options.batching.enabled ? Math.ceil(this.options.iterations / batchSize) : 1;
    const batchTimings = new Float64Array(batchCount);
    const batchSizes = new Uint32Array(batchCount);

    const measure = task.isAsync ? this.measureTaskBatchAsync : this.measureTaskBatchSync;

    let iterationIndex = 0;
    while (iterationIndex < this.options.iterations) {
      const currentBatchIndex = this.options.batching.enabled
        ? Math.floor(iterationIndex / this.options.batching.size)
        : 0;
      const currentBatchSize = this.options.batching.enabled
        ? Math.min(this.options.batching.size, this.options.iterations - iterationIndex)
        : this.options.iterations - iterationIndex;

      const elapsed = await measure(task, currentBatchSize);
      iterationIndex += currentBatchSize;

      batchTimings[currentBatchIndex] = elapsed;
      batchSizes[currentBatchIndex] = currentBatchSize;
    }

    await this.options.teardown();

    const stats = computeTaskStats(batchTimings, batchSizes);
    return { name: task.name, stats };
  }

  async run(): Promise<BenchmarkResult[]> {
    const results: BenchmarkResult[] = [];

    for (let i = 0; i < this.options.warmupIterations; i++) {
      noop();
    }

    for (const task of this.tasks) {
      const result = await this.runTask(task);
      results.push(result);
      if (!this.options.quiet) this.printResult(result);
      await sleep(this.options.testSleepDuration);
    }

    if (!this.options.quiet) this.printResults(results);

    return results;
  }

  private printResult(result: BenchmarkResult) {
    console.table({
      [result.name]: result.stats,
    });
  }

  printResults(results: BenchmarkResult[]) {
    const table = results.reduce((acc, result) => {
      acc[result.name] = {
        "ops/sec": Math.round(result.stats.opsPerSecond.average),
        "avg (ns)": result.stats.time.average.ns,
        "min (ns)": result.stats.time.min.ns,
        "max (ns)": result.stats.time.max.ns,
      };

      return acc;
    }, {} as Record<string, Record<string, string | number>>);
    console.table(table);
  }
}

export { Bench };
