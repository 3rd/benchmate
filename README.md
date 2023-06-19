# benchmate

Benchmate is a super-small but mighty benchmarking library for JavaScript.

- iteration count driven
- supports (and recommends) batching iterations to offset the overhead errors
- works with both `process.hrtime` and `performance.now`
- sensible defaults for batch size and warmup iterations
- pre-task and post-task hooks
- async support
- metrics: ops/sec, min/max/avg (ns), percentiles

> This is very much WIP, if you're looking for something stable I'd probably recommend [mitata](https://github.com/evanwashere/mitata).

## Installation

Benchmate is published on the NPM registry: [https://npmjs.com/package/benchmate](https://npmjs.com/package/benchmate)

```sh
npm install -D benchmate
pnpm install -D benchmate
yarn add -D benchmate
```

## Usage

```ts
import { Bench } from "benchmate";

const bench = new Bench({
  iterations: 100_000, // number of iterations
  batching: { // batching improves accuracy by a <lot>
    enabled: true,
    size: "auto" // number of iterations per batch or "auto" for (iterations / 100)
  },
  warmupIterations: "auto", // number of warmup iterations or "auto" for (iterations / 10)
  method: "auto", // "auto" | "hrtime" | "performance.now" - measurement method, defaults to best available
  testSleepDuration: 0, // how long to sleep between tasks (ms)
  quiet: false, // don't print anything
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
```

## Notes

- **Don't disable batching** if you want accurate measurements.
- **Don't benchmark really fast async functions**, there's a lot of overhead and it messes up the measurements.
- If you're testing really fast code make sure to **increase the iteration count** until the ops/sec value stabilizes.

## Acknowledgements

- [Benchmark.js](https://github.com/bestiejs/benchmark.js) (abandoned)
- [mitata](https://github.com/evanwashere/mitata)
- [tinybench](https://github.com/tinylibs/tinybench)
