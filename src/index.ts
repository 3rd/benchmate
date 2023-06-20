/* eslint-disable no-await-in-loop */
import { printResult, printResults } from "./print";
import { computeTaskStats } from "./stats";
import { getNowProvider } from "./time";
import { sleep, noop } from "./utils";

export type BenchmarkOptions = {
  batching?: { enabled?: boolean; size?: number | "auto" };
  warmup?: { enabled?: boolean; iterations?: number | "auto" };
  method: "auto" | "hrtime" | "performance.now";
  testSleepDuration?: number;
  quiet?: boolean;
  setup?: () => Promise<void> | void;
  teardown?: () => Promise<void> | void;
} & ({ iterations?: number } | { iterations: "auto"; time?: number });

type InternalBenchmarkOptions = {
  batching: { enabled: boolean; size: number | "auto" };
  warmup: { enabled: boolean; iterations: number | "auto" };
  method: "auto" | "hrtime" | "performance.now";
  testSleepDuration: number;
  quiet: boolean;
  setup: () => Promise<void> | void;
  teardown: () => Promise<void> | void;
} & ({ iterations: number } | { iterations: "auto"; time: number });

export type Task = {
  name: string;
  fn: () => Promise<void> | void;
  compiledFn: (iterations: number, now: () => number) => Promise<number> | number;
  isAsync: boolean;
};

export type BenchmarkResult = {
  name: string;
  stats: ReturnType<typeof computeTaskStats>;
};

const defaultOptions = {
  iterations: "auto",
  time: 1000,
  batching: { enabled: true, size: "auto" },
  warmup: { enabled: true, iterations: "auto" },
  method: "auto",
  testSleepDuration: 0,
  quiet: false,
  setup: noop,
  teardown: noop,
} as const;

class Bench {
  tasks: Task[] = [];
  options: InternalBenchmarkOptions = defaultOptions;
  now: () => number;

  constructor(options?: BenchmarkOptions) {
    if (options) {
      const { iterations, batching, warmup, ...rest } = options;
      if ("iterations" in options && iterations !== "auto" && "time" in options && typeof options.time === "number") {
        throw new Error(
          "The 'time' option is only supported when 'iterations' is set to 'auto' as the iteration count is automatically computed for each task based on the target time."
        );
      }
      this.options = {
        ...defaultOptions,
        ...rest,
        batching: { ...defaultOptions.batching, ...batching },
        warmup: { ...defaultOptions.warmup, ...warmup },
      };
    }
    this.now = getNowProvider(this.options.method);
  }

  private compileTaskFunction(fn: () => Promise<void> | void): () => Promise<number> | number {
    const isAsync = fn() instanceof Promise;
    const body = [
      isAsync ? `async function (iterations, now) {` : `function (iterations, now) {`,
      `
      let remainingIterations = iterations;
      const start = now();
      while (remainingIterations--) {
        ${isAsync ? "await " : ""}fn();
      }
      return now() - start;
    }`,
    ];
    return new Function(`return (function(fn) { return ${body.join("\n")} });`)()(fn);
  }

  add(name: string, fn: () => Promise<void> | void) {
    const isAsync = fn() instanceof Promise;
    const compiledFn = this.compileTaskFunction(fn);
    const task: Task = { name, fn, compiledFn, isAsync };

    if (task.isAsync) {
      console.warn(`Warning: Using asynchronous functions in task '${task.name}' will affect measurement accuracy.`);
    }
    this.tasks.push(task);
  }

  private async computeTaskIterationsForDuration(task: Task): Promise<number> {
    const measurementTarget = 500;
    if (this.options.iterations === "auto") {
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
      return targetIterations;
    }
    return this.options.iterations;
  }

  private async warmup(task: Task, taskIterations: number) {
    const warmupIterations =
      this.options.warmup.iterations === "auto" ? taskIterations / 10 : this.options.warmup.iterations;
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

    let iterationIndex = 0;
    if (this.options.warmup) await this.warmup(task, taskIterations);

    await this.options.setup();

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
