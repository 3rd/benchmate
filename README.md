# benchmate

Benchmate benchmarks JavaScript and TypeScript tasks in Node, Bun, and Chromium.

## Install

```sh
npm install benchmate
```

## Quick start

```ts
import { Bench } from "benchmate";

const bench = new Bench();

bench.add("RegExp#test", () => /o/.test("Hello World!"));
bench.add("String#indexOf", () => "Hello World!".indexOf("o"));

const result = await bench.run();

for (const entry of result.entries) {
  console.log(entry.name, entry.stats);
}
```

Passing a callback to `add()` is shorthand for `{ mode: "call", run: callback }`. Call mode is the default.

Benchmate consumes each return value. Return a value produced by the work that you want to measure.

A call task must stay synchronous or asynchronous for the entire run. It cannot switch between values and Promise-like values.

Set `quiet: false` if you want Benchmate to print its built-in summary with `console.log`.

## Automatic measurement

Automatic measurement is the default. Benchmate warms each task, chooses a measurable block size, and then records a separate final measurement.

```ts
const bench = new Bench({
  auto: {
    precisionX: 0.01,
    maxTimeMs: 15_000,
    maxWarmupTimeMs: 5_000,
  },
});
```

These values are the defaults:

- `precisionX: 0.01` requests a confidence interval with a relative half-width of 1%.
- `maxTimeMs: 15_000` limits the full measurement process for each task.
- `maxWarmupTimeMs: 5_000` limits warmup within that time.

`maxTimeMs` is a limit, not a target. A stable task can finish earlier.

Tasks run separately by default. Use [comparative measurement](#compare-tasks) when you want Benchmate to alternate compatible tasks.

## Run result

`run()` returns one object for the entire benchmark:

```ts
type BenchmarkRunResult = {
  entries: BenchmarkResult[];
  clock: ClockProfile;
  durationMs: number;
  comparisons: readonly PairedComparison[];
};
```

- `entries` contains one result for each task.
- `clock` contains measured properties of the runtime timer that Benchmate selected.
- `durationMs` is the elapsed time from timer checks through teardown and result construction.
- `comparisons` contains compatible task pairs from comparative measurement.

`durationMs` is a number of milliseconds. It includes setup and teardown time, but task statistics do not.

Benchmate calculates `durationMs` before it emits `taskComplete` and `benchmarkEnd` or prints the summary.

Each entry has a `taskType`. Check it before you read fields that belong to one task mode:

```ts
for (const entry of result.entries) {
  if (entry.taskType === "call") {
    console.log(entry.stats.timePerOperationMs.average);
    console.log(entry.stats.operationsPerSecond.average);
  }
}
```

## Task modes

### Call

Call mode is the default for synchronous and asynchronous callbacks:

```ts
bench.add("map.get", () => map.get(key));
```

Benchmate calls the callback once per operation. It waits for each Promise-like result before it starts the next operation.

Use the full definition when you want hooks or an explicit mode:

```ts
bench.add("map.get", {
  mode: "call",
  run: () => map.get(key),
});
```

### Kernel

Use kernel mode for tiny synchronous work. Your callback runs the loop, and Benchmate changes the loop size between measurements.

```ts
bench.add("map lookup kernel", {
  mode: "kernel",
  run: ({ iterationCount }) => {
    let total = 0;

    for (let iterationIndex = 0; iterationIndex < iterationCount; iterationIndex++) {
      total += map.get(keys[iterationIndex & 1023]) ?? 0;
    }

    return total;
  },
});
```

`iterationCount` is the total number of operations requested for that callback call. `iterationIndex` is the current position in your loop.

Benchmate measures several operation counts. It uses the change in total time to estimate `timePerOperationMs`.

```ts
for (const entry of result.entries) {
  if (entry.taskType !== "kernel") continue;

  const kernel = entry.metadata.kernel;
  if (kernel === null) continue;

  console.log(entry.stats.timePerOperationMs.average);
  console.log(kernel.measuredOperationCountRange);
}
```

Kernel tasks must be synchronous. Benchmate rejects a Promise-like result.

Benchmate flags a kernel when its time does not grow with `iterationCount`. It also flags results that stay constant or cannot be inspected.

Set `constantResult: true` only when the kernel intentionally returns the same value for every operation count.

### Throughput

Use throughput mode to measure completed asynchronous operations at a fixed concurrency:

```ts
bench.add("cached fetch", {
  mode: "throughput",
  concurrency: 8,
  run: async () => {
    await cache.get("answer");
  },
});
```

Each lane starts its next operation after its previous operation settles.

`completionsPerSecond` is the completion rate. `blockDurationMs` is the duration of a full concurrent block, not serial request latency.

### End-to-end

Use end-to-end mode when input creation is part of the work that you want to measure:

```ts
bench.add("encode and send", {
  mode: "end-to-end",
  createInput: ({ seed }) => encodeRequest(seed),
  run: async (request) => transport.send(request),
});
```

Benchmate times `createInput` and `run` together for each operation. Task-level `setup` and `teardown` remain outside task statistics.

Each `seed` is a nonnegative safe integer. Every `createInput` call for one task in one `run()` gets a unique seed.

The sequence starts at `0` and continues across warmup, pilot, and final measurement. A later `run()` starts the sequence at `0` again.

Corresponding comparative blocks use matching seed prefixes. `schedule.seed` controls task order, not `createInput` seeds.

## Setup and teardown

Every task mode supports `setup` and `teardown`. Values declared outside the callbacks are available through normal JavaScript closures:

```ts
const cache = new Map<string, number>();

bench.add("prepared lookup", {
  mode: "call",
  setup: () => {
    cache.set("answer", 42);
  },
  run: () => cache.get("answer"),
  teardown: () => {
    cache.clear();
  },
});
```

All three callbacks use the same `cache` object. Benchmate runs setup once before it measures the tasks.

Benchmate sets up tasks in registration order. It tears them down in reverse order after measurement.

Hook time is not part of task statistics. `durationMs` includes it.

## Fixed runs

Call and end-to-end tasks can use a fixed duration or operation count:

```ts
new Bench({ timeMs: 1_000 });
new Bench({ iterations: 50_000 });
```

Do not combine `auto`, `timeMs`, and `iterations`. Kernel and throughput tasks require automatic measurement.

Fixed runs also support `batching` and `warmup`:

```ts
const bench = new Bench({
  iterations: 50_000,
  batching: { operationsPerBlock: 500 },
  warmup: { iterations: 5_000 },
});
```

`operationsPerBlock` and both `iterations` fields are item counts, so their names do not contain a unit suffix.

## Compare tasks

Comparative measurement alternates compatible tasks in a balanced order. This avoids always measuring one task before another.

```ts
const bench = new Bench({
  schedule: {
    mode: "comparative",
    seed: 42,
    yieldBetweenRounds: false,
  },
});

bench.add("map.get", () => map.get(key));
bench.add("object lookup", () => object[key]);

const result = await bench.run();

for (const comparison of result.comparisons) {
  console.log(comparison.left, comparison.right);
  console.log(comparison.averageRatioX);
  console.log(comparison.metric, comparison.unit, comparison.better);
}
```

`left` and `right` follow registration order. `averageRatioX` is the average of `left / right` for the paired rounds.

`metric`, `unit`, and `better` tell you what Benchmate compared and which direction is faster.

Benchmate compares only complete, compatible results. Compatibility includes task mode, async behavior, concurrency, kernel operation counts, and interval method.

An explicit `schedule.seed` repeats the task order. It must be an unsigned 32-bit integer.

A comparative group with more than two tasks can produce one comparison for each compatible pair.

## Statistics

`taskType` narrows `stats` to one of these shapes:

```ts
type CallStats = {
  operations: number;
  blocks: number;
  elapsedMs: number;
  timePerOperationMs: TimeSummary;
  operationsPerSecond: RateSummary;
  harnessOverhead: HarnessOverhead;
};

type EndToEndStats = {
  operations: number;
  blocks: number;
  elapsedMs: number;
  timePerOperationMs: TimeSummary;
  operationsPerSecond: RateSummary;
};

type KernelStats = {
  operations: number;
  rounds: number;
  elapsedMs: number;
  timePerOperationMs: TimeSummary;
  operationsPerSecond: RateSummary;
};

type ThroughputStats = {
  completions: number;
  blocks: number;
  elapsedMs: number;
  blockDurationMs: TimeSummary;
  completionsPerSecond: RateSummary;
};
```

Each time summary has `min`, `max`, `average`, `median`, and percentile fields. The parent field names show that these values use milliseconds.

`elapsedMs` is the sum of the measured block durations. Count fields contain item counts, and rate fields contain items per second.

Call results also include a harness model:

```ts
type HarnessOverhead = {
  perInvocationMs: number;
  sampleCount: number;
  observationSequences: readonly number[];
  modeledRemainderMs: {
    total: number;
    average: number;
  };
};
```

Benchmate does not subtract this model from the measured time or use it for task ranking.

## Clock

Benchmate profiles the selected timer at the start of each run:

```ts
type ClockProfile = {
  provider: "hrtime" | "performance.now";
  method: "auto" | "hrtime" | "performance.now";
  monotonic: boolean;
  sampleCount: number;
  minimumPositiveTickMs: number;
  zeroDeltaRateX: number;
  readPairCostMs: {
    p50: number;
    p99: number;
  };
};
```

`minimumPositiveTickMs` is the smallest positive change that Benchmate observed. `zeroDeltaRateX` is the fraction of read pairs with no timer change.

`readPairCostMs` estimates the cost of reading the timer twice. Benchmate uses these values to reject work that the timer cannot measure clearly.

## Evidence

Check `evidence.status` before you compare or publish a result:

```ts
for (const entry of result.entries) {
  if (entry.evidence.status === "complete") {
    console.log(entry.evidence.interval);
  } else {
    console.log(entry.evidence.status);
    console.log(entry.evidence.reasons);
  }
}
```

`complete` means that the checks for that task mode passed. Benchmate does not rank results with another status.

The other statuses state why Benchmate could not produce a complete result:

- `timer-limited`: the timer could not measure the work clearly.
- `warmup-not-converged`: task speed did not settle before `maxWarmupTimeMs`.
- `dependence-unresolved`: consecutive readings affected each other too much for a final measurement plan.
- `insufficient-budget`: `maxTimeMs` ended before Benchmate collected the planned readings.
- `precision-missed`: the final interval was wider than `precisionX` requested.
- `unstable`: task speed changed during the final measurement.
- `optimization-sensitive`: a kernel's timing or returned values did not support a reliable estimate.
- `unidentifiable`: Benchmate could not calculate a positive, finite estimate.
- `failed`: Benchmate could not create a valid result.

A complete result can include `evidence.interval`. Call, end-to-end, and throughput intervals contain rates per second.

Kernel intervals contain milliseconds per operation. The `method` and `coverage` fields state how Benchmate calculated the interval.

### Observations and flags

`evidence.observations` keeps every timed block in its original order. Benchmate does not discard a slow block.

Each observation contains `startedAtMs`, `elapsedMs`, an operation count, and any flags that apply:

- `zero-duration`: the timer reported no elapsed time.
- `clock-quantized`: the timer steps were too large for the measured block.
- `pause-like`: one block was much slower than nearby blocks.
- `drift-detected`: readings moved steadily during the run.
- `change-detected`: readings jumped to a different level during the run.
- `constant-result`: a kernel returned the same result at several operation counts.
- `unhashable-result`: Benchmate could not create a stable summary of a kernel result.
- `nonlinear-scaling`: a kernel's time did not grow consistently with its operation count.

These flags are warnings, not diagnoses. For example, `pause-like` does not identify garbage collection as the cause.

Benchmate does not control garbage collection, CPU placement, temperature, or process isolation. Add those controls in the program that runs Benchmate.

## Events

Use `on` and `off` to receive progress and lifecycle events:

```ts
bench.on("progress", (event) => {
  console.log(event.task, event.elapsedTimeMs);
});

bench.on("benchmarkEnd", (result) => {
  console.log(result.entries);
});
```

The public events are `benchmarkStart`, `taskStart`, `taskPhaseStart`, `taskPhaseEnd`, `taskEvidenceStatus`, `setup`, `teardown`, `progress`, `taskComplete`, and `benchmarkEnd`.

`taskComplete` receives one `BenchmarkResult`. `benchmarkEnd` receives the same object that `run()` returns.

## Keep measured work observable

JavaScript engines can remove work when its result has no effect. Return a value produced by the measured work when possible.

Use `blackhole(value)` when you must consume an intermediate value:

```ts
import { Bench, blackhole } from "benchmate";

bench.add("map.get", () => {
  for (let index = 0; index < 100; index++) {
    blackhole(map.get(keys[index]));
  }
});
```

`blackhole` adds work to the task. It cannot prove that every overwritten value stayed observable.

Use kernel mode for tiny synchronous loops when possible.

## Browser use

Benchmate uses `performance.now()` when `process.hrtime.bigint()` is not available. Its measurement code does not require `unsafe-eval`.

Run untrusted tasks in a Worker that your application owns. Benchmate does not create Workers or rewrite user source.

Chromium is the browser release target. See the [browser host guide](./benchmate-web.md) for Worker and CSP integration.

Benchmate does not claim release validation for Firefox or WebKit.

## Validation

The repository checks the measurement code with unit tests and deterministic data sets. It also compares Node and Bun output and tests package types.

The browser test covers Chromium, module Workers, and a CSP without `unsafe-eval`.

## Acknowledgements

- [Mathias Bynens](https://mathiasbynens.be) and [Benchmark.js](https://github.com/bestiejs/benchmark.js)
- [mitata](https://github.com/evanwashere/mitata)
- [tinybench](https://github.com/tinylibs/tinybench)
