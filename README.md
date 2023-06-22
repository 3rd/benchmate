# benchmate

Benchmate is a small but mighty benchmarking library for JavaScript.

- Comes with sensible defaults and tries to figure out the best parameters on its own.
- Supports duration and iteration count targeting.
- Works with both `process.hrtime` and `performance.now`.
- Has hooks for `setup` and `teardown` (before and after the entire test, not each execution).
- Has `async` support, but you really shouldn't benchmark async functions.
- Returns the metrics and prints the output nicely (optional).

## Demo

[![benchmate on asciicast](https://asciinema.org/a/TCvVvn8qELEeQpflETsnoj64C.svg)](https://asciinema.org/a/TCvVvn8qELEeQpflETsnoj64C)

## Installation

Benchmate is published on the NPM registry: [https://npmjs.com/package/benchmate](https://npmjs.com/package/benchmate)

```sh
npm install -D benchmate
pnpm install -D benchmate
yarn add -D benchmate
```

## Usage

**Notes:**

- **Don't disable batching** if you want accurate measurements. Metrics like `min`, `max`, and percentiles will me meaningless, as you get a single measurement.
- **Don't expect accurate timings for fast async functions**, but you can compare their performance.

```ts
import { Bench } from "benchmate";

// The default options are sensible,
const bench = new Bench({
  iterations: "auto", // number of iterations, must be "auto" when using time ╷
  time: 1000, // target running time for tasks                              ⮜─╯
  batching: { // batching improves accuracy by a <lot>
    enabled: true,
    size: "auto" // number of iterations per batch or "auto"
  },
  warmup: {
    enabled: true,
    size: "auto", // number of warmup iterations or "auto" for (iterations / 10)
  },
  method: "auto", // "auto" | "hrtime" | "performance.now" - measurement method, defaults to best available
  testSleepDuration: 0, // how long to sleep between tasks (ms)
  quiet: false, // don't print anything, defaults to `true` in browsers, `false` in Node
  setup: () => Promise<void> | void, // function to run before each test
  teardown: () => Promise<void> | void, // function to run after each test
});

bench.add("RegExp#test", () => {
  if (!/o/.test("Hello World!")) console.log("nop");
});

bench.add("String#indexOf", () => {
  if ("Hello World!".indexOf("o") === -1) console.log("nop");
});

await bench.run();
// ^ returns an array of benchmark results:
// type BenchmarkResult = {
//   name: string;
//   stats: {
//     samples: number;
//     batches: number;
//     time: { // all timings are in milliseconds
//       total: number;
//       min: number;
//       max: number;
//       average: number;
//       percentile50: number;
//       percentile90: number;
//       percentile95: number;
//     };
//     opsPerSecond: {
//       average: number;
//       max: number;
//       min: number;
//       margin: number; // percentage
//     };
```

## Acknowledgements

- [Mathias Bynens](https://mathiasbynens.be) and [Benchmark.js](https://github.com/bestiejs/benchmark.js)
- [mitata](https://github.com/evanwashere/mitata)
- [tinybench](https://github.com/tinylibs/tinybench)
