import { Bench } from "../../dist/index.js";

const originalHrtimeBigint = process.hrtime.bigint;
const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
let nowNanoseconds = 0n;
Object.defineProperty(process.hrtime, "bigint", { configurable: true, value: () => nowNanoseconds });
Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: {
    getRandomValues(values) {
      values[0] = 0x1234_5678;
      return values;
    },
  },
});

const measurementPhases = (result) => [...new Set(result.evidence.observations.map((observation) => observation.phase))];
const roundTiming = (value) => (typeof value === "number" ? Number(value.toFixed(12)) : value);
const normalizePlan = (plan) =>
  plan === null
    ? null
    : Object.fromEntries(Object.entries(plan).map(([key, value]) => [key, roundTiming(value)]));

try {
  const lifecycle = [];
  const comparative = new Bench({
    quiet: true,
    method: "hrtime",
    auto: { maxTimeMs: 2_000, maxWarmupTimeMs: 300 },
    schedule: { mode: "comparative", seed: 42 },
  });
  for (const name of ["a", "b"]) {
    comparative.add(name, {
      mode: "call",
      setup() {
        lifecycle.push(`setup:${name}`);
      },
      run() {
        nowNanoseconds += 2_000_000n;
        return name;
      },
      teardown() {
        lifecycle.push(`teardown:${name}`);
      },
    });
  }
  const comparativeResult = await comparative.run();
  const comparativeEntries = comparativeResult.entries;

  const throughput = new Bench({
    quiet: true,
    method: "hrtime",
    auto: { maxTimeMs: 2_000, maxWarmupTimeMs: 300 },
  });
  throughput.add("throughput", {
    mode: "throughput",
    concurrency: 3,
    async run() {
      nowNanoseconds += 1_000_000n;
      await Promise.resolve();
    },
  });
  const { entries: [throughputResult] } = await throughput.run();

  const endToEnd = new Bench({
    quiet: true,
    method: "hrtime",
    iterations: 2,
    warmup: { enabled: false },
    batching: { enabled: false },
  });
  endToEnd.add("request", {
    mode: "end-to-end",
    createInput({ seed }) {
      nowNanoseconds += 1_000_000n;
      return seed;
    },
    async run(seed) {
      nowNanoseconds += 1_000_000n;
      await Promise.resolve();
      return seed;
    },
  });
  const { entries: [endToEndResult] } = await endToEnd.run();

  const kernel = new Bench({
    quiet: true,
    method: "hrtime",
    auto: { maxTimeMs: 15_000, maxWarmupTimeMs: 5_000 },
  });
  kernel.add("kernel", {
    mode: "kernel",
    run({ iterationCount }) {
      nowNanoseconds += 1_000_000n + BigInt(iterationCount) * 10_000n;
      return iterationCount;
    },
  });
  const { entries: [kernelResult] } = await kernel.run();
  if (comparativeEntries.length !== 2 || !throughputResult || !endToEndResult || !kernelResult) {
    throw new Error("Runtime contract did not produce every required result.");
  }

  const normalized = {
    comparative: {
      statuses: comparativeEntries.map((result) => result.evidence.status),
      rows: comparativeEntries[0].metadata.schedule.rows,
      blocks: comparativeEntries.map((result) => result.stats.blocks),
      plans: comparativeEntries.map((result) => normalizePlan(result.metadata.plan)),
      lifecycle,
      phases: comparativeEntries.map(measurementPhases),
      clock: comparativeResult.clock.provider,
      durationValid:
        Number.isFinite(comparativeResult.durationMs) && comparativeResult.durationMs >= 0,
      comparisonCount: comparativeResult.comparisons.length,
      averageRatio: roundTiming(comparativeResult.comparisons[0]?.averageRatioX),
      comparisonMetric: comparativeResult.comparisons[0]?.metric,
      comparisonUnit: comparativeResult.comparisons[0]?.unit,
    },
    throughput: {
      status: throughputResult.evidence.status,
      concurrency: throughputResult.metadata.concurrency,
      completions: throughputResult.stats.completions,
      blocks: throughputResult.stats.blocks,
      makespan: roundTiming(throughputResult.stats.blockDurationMs.average),
      rate: roundTiming(throughputResult.stats.completionsPerSecond.average),
      phases: measurementPhases(throughputResult),
    },
    endToEnd: {
      status: endToEndResult.evidence.status,
      kind: endToEndResult.metadata.executionKind,
      total: roundTiming(endToEndResult.stats.elapsedMs),
      average: roundTiming(endToEndResult.stats.timePerOperationMs.average),
      phases: measurementPhases(endToEndResult),
    },
    kernel: {
      status: kernelResult.evidence.status,
      intervalMethod: kernelResult.evidence.interval?.method,
      ladder: kernelResult.metadata.kernel?.operationCountLadder,
      slope: roundTiming(kernelResult.stats.timePerOperationMs.average),
      rounds: kernelResult.metadata.kernel?.rounds.length,
      plan: normalizePlan(kernelResult.metadata.plan),
      phases: measurementPhases(kernelResult),
    },
  };

  console.log(JSON.stringify(normalized));
} finally {
  Object.defineProperty(process.hrtime, "bigint", { configurable: true, value: originalHrtimeBigint });
  if (originalCryptoDescriptor) Object.defineProperty(globalThis, "crypto", originalCryptoDescriptor);
  else Reflect.deleteProperty(globalThis, "crypto");
}
