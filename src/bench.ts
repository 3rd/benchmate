import type {
  BenchEvents,
  BenchEventSink,
  BenchmarkOptions,
  BenchmarkRunResult,
  ResolvedBenchmarkOptions,
  Task,
  TaskDefinition,
} from "./types";
import { normalizeTaskDefinition, resolveOptions } from "./benchmark-input";
import { runBenchmark } from "./benchmark-run";

type BenchmarkRunPromise = Promise<BenchmarkRunResult>;

class Bench {
  private tasks: Task[] = [];
  private options: ResolvedBenchmarkOptions;
  private running = false;

  private eventListeners: { [Event in keyof BenchEvents]: ((data: BenchEvents[Event]) => void)[] } = {
    benchmarkStart: [],
    taskStart: [],
    taskPhaseStart: [],
    taskPhaseEnd: [],
    taskEvidenceStatus: [],
    setup: [],
    teardown: [],
    taskComplete: [],
    benchmarkEnd: [],
    progress: [],
  };

  constructor(options?: BenchmarkOptions) {
    this.options = resolveOptions(options);
  }

  on<Event extends keyof BenchEvents>(event: Event, handler: (data: BenchEvents[Event]) => void): void {
    this.eventListeners[event].push(handler);
  }

  off<Event extends keyof BenchEvents>(event: Event, handler: (data: BenchEvents[Event]) => void): void {
    const handlers = this.eventListeners[event];
    for (let index = handlers.length - 1; index >= 0; index--) {
      if (handlers[index] === handler) handlers.splice(index, 1);
    }
  }

  private emit<Event extends keyof BenchEvents>(event: Event, data: BenchEvents[Event]): void {
    for (const handler of this.eventListeners[event]) handler(data);
  }

  add<Input>(name: string, input: TaskDefinition<Input> | (() => unknown)): void {
    if (this.running) throw new Error("Cannot add tasks while this Bench is running.");
    if (name.length === 0) throw new TypeError("Task name must not be empty.");
    if (this.tasks.some((task) => task.name === name)) {
      throw new Error(`A task named '${name}' was already added.`);
    }

    const definition = normalizeTaskDefinition(name, input, this.options.run.mode) as TaskDefinition;
    this.tasks.push({ name, definition });
  }

  async run(): BenchmarkRunPromise {
    if (this.running) {
      throw new Error("This Bench is already running: await the previous run() before starting another.");
    }
    if (this.options.schedule.mode === "comparative" && this.tasks.length < 2) {
      throw new Error("Comparative scheduling requires at least two tasks.");
    }
    this.running = true;
    const emit: BenchEventSink = (event, data) => this.emit(event, data);
    try {
      return await runBenchmark(this.tasks, this.options, emit);
    } finally {
      this.running = false;
    }
  }
}

export { Bench, resolveOptions };

export { getCalibrationTarget } from "./execution/isolated";
