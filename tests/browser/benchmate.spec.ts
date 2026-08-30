import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const ORIGIN = "https://benchmate.test";
const CSP = "default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'";

test("runs host-provided source in a module Worker without unsafe-eval", async ({ context, page }) => {
  const library = await readFile(new URL("../../dist/index.js", import.meta.url), "utf8");
  const main = `
    const worker = new Worker("/worker.js", { type: "module" });
    worker.addEventListener("message", (event) => {
      globalThis.__benchmateResult = event.data;
    });
    worker.addEventListener("error", (event) => {
      globalThis.__benchmateResult = { error: event.message };
    });
  `;
  const worker = `
    import { Bench } from "/index.js";

    let unsafeEvalAllowed = true;
    try {
      Function("return true")();
    } catch {
      unsafeEvalAllowed = false;
    }

    const source = \`
      export const state = { calls: 0, completions: 0 };
      export const syncTask = () => {
        state.calls++;
        return 42;
      };
      export const thenableTask = () => {
        state.calls++;
        return {
          then(resolve) {
            queueMicrotask(() => {
              state.completions++;
              resolve(7);
            });
          },
        };
      };
    \`;
    const sourceUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));

    try {
      const tasks = await import(sourceUrl);
      let initialNow = 0;
      Object.defineProperty(performance, "now", {
        configurable: true,
        value: () => {
          initialNow += 0.01;
          return initialNow;
        },
      });
      const bench = new Bench({
        iterations: 3,
        warmup: { enabled: false },
        batching: { enabled: false },
        quiet: true,
      });
      bench.add("sync", tasks.syncTask);
      bench.add("thenable", tasks.thenableTask);
      const benchmarkResult = await bench.run();
      const results = benchmarkResult.entries;

      let fakeNow = 0;
      Object.defineProperty(performance, "now", { configurable: true, value: () => fakeNow });
      const comparativeLifecycle = [];
      const comparativeStarted = new Set();
      const comparative = new Bench({
        quiet: true,
        method: "performance.now",
        auto: { maxTimeMs: 2_000, maxWarmupTimeMs: 300 },
        schedule: { mode: "comparative", seed: 42 },
      });
      for (const name of ["a", "b"]) {
        comparative.add(name, {
          mode: "call",
          setup() {
            comparativeLifecycle.push("setup:" + name);
          },
          run() {
            if (!comparativeStarted.has(name)) {
              comparativeStarted.add(name);
              comparativeLifecycle.push("first:" + name);
            }
            fakeNow += 2;
            return name;
          },
          teardown() {
            comparativeLifecycle.push("teardown:" + name);
          },
        });
      }
      const comparativeResult = await comparative.run();
      const comparativeEntries = comparativeResult.entries;
      const comparativeMeasured = comparativeEntries
        .flatMap((result) => result.evidence.observations)
        .filter((observation) => observation.phase === "measurement")
        .sort((left, right) => left.sequence - right.sequence);

      const throughput = new Bench({
        quiet: true,
        method: "performance.now",
        auto: { maxTimeMs: 2_000, maxWarmupTimeMs: 300 },
      });
      throughput.add("throughput", {
        mode: "throughput",
        concurrency: 3,
        async run() {
          fakeNow += 1;
          await Promise.resolve();
        },
      });
      const { entries: [throughputResult] } = await throughput.run();

      const endToEnd = new Bench({
        quiet: true,
        method: "performance.now",
        iterations: 2,
        warmup: { enabled: false },
        batching: { enabled: false },
      });
      endToEnd.add("request", {
        mode: "end-to-end",
        createInput({ seed }) {
          fakeNow += 1;
          return seed;
        },
        async run(seed) {
          fakeNow += 1;
          await Promise.resolve();
          return seed;
        },
      });
      const { entries: [endToEndResult] } = await endToEnd.run();

      const kernel = new Bench({
        quiet: true,
        method: "performance.now",
        auto: { maxTimeMs: 15_000, maxWarmupTimeMs: 5_000 },
      });
      kernel.add("kernel", {
        mode: "kernel",
        run({ iterationCount }) {
          fakeNow += 1 + iterationCount / 128;
          return iterationCount;
        },
      });
      const { entries: [kernelResult] } = await kernel.run();

      postMessage({
        names: results.map((result) => result.name),
        calls: tasks.state.calls,
        completions: tasks.state.completions,
        unsafeEvalAllowed,
        run: {
          provider: benchmarkResult.clock.provider,
          durationValid:
            Number.isFinite(benchmarkResult.durationMs) && benchmarkResult.durationMs >= 0,
          comparisonCount: benchmarkResult.comparisons.length,
        },
        contracts: results.map((result) => {
          const measured = result.evidence.observations.filter((observation) => observation.phase === "measurement");
          return {
            schemaVersion: result.evidence.schemaVersion,
            status: result.evidence.status,
            taskType: result.taskType,
            measurement: result.evidence.measurement,
            schedule: result.evidence.schedule,
            statsProvenance: result.evidence.statsProvenance,
            provider: benchmarkResult.clock.provider,
            phases: [...new Set(result.evidence.observations.map((observation) => observation.phase))],
            operations: result.stats.operations,
            totalMatches: result.stats.elapsedMs === measured.reduce((total, observation) => total + observation.elapsedMs, 0),
            frozen: Object.isFrozen(result.evidence.observations),
          };
        }),
        portableModes: {
          comparative: {
            statuses: comparativeEntries.map((result) => result.evidence.status),
            blocks: comparativeEntries.map((result) => result.stats.blocks),
            coverage: comparativeEntries.map((result) => result.evidence.interval?.coverage ?? null),
            rowCount: comparativeEntries[0].metadata.schedule.rows.length,
            rowsMatch:
              comparativeEntries[0].metadata.schedule.rows.flat().join(",") ===
              comparativeMeasured.map((observation) => observation.task).join(","),
            comparisonCount: comparativeResult.comparisons.length,
            averageRatioX: comparativeResult.comparisons[0]?.averageRatioX,
            comparisonMetric: comparativeResult.comparisons[0]?.metric,
            lifecycleValid:
              comparativeLifecycle[0] === "setup:a" &&
              comparativeLifecycle[1] === "setup:b" &&
              comparativeLifecycle.indexOf("first:a") > 1 &&
              comparativeLifecycle.indexOf("first:b") > 1 &&
              comparativeLifecycle.at(-2) === "teardown:b" &&
              comparativeLifecycle.at(-1) === "teardown:a",
          },
          throughput: {
            status: throughputResult.evidence.status,
            completions: throughputResult.stats.completions,
            blocks: throughputResult.stats.blocks,
            makespan: throughputResult.stats.blockDurationMs.average,
            rate: throughputResult.stats.completionsPerSecond.average,
          },
          endToEnd: {
            status: endToEndResult.evidence.status,
            kind: endToEndResult.metadata.executionKind,
            total: endToEndResult.stats.elapsedMs,
            average: endToEndResult.stats.timePerOperationMs.average,
          },
          kernel: {
            status: kernelResult.evidence.status,
            intervalMethod: kernelResult.evidence.interval?.method ?? null,
            operationCountLadder: kernelResult.metadata.kernel.operationCountLadder,
            rounds: kernelResult.metadata.kernel.rounds.length,
          },
        },
      });
    } catch (error) {
      postMessage({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  `;

  await context.route(`${ORIGIN}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const headers = { "Content-Security-Policy": CSP };
    if (pathname === "/index.js") {
      await route.fulfill({ status: 200, contentType: "text/javascript", headers, body: library });
      return;
    }
    if (pathname === "/main.js") {
      await route.fulfill({ status: 200, contentType: "text/javascript", headers, body: main });
      return;
    }
    if (pathname === "/worker.js") {
      await route.fulfill({ status: 200, contentType: "text/javascript", headers, body: worker });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      headers,
      body: '<!doctype html><script type="module" src="/main.js"></script>',
    });
  });

  await page.goto(ORIGIN);
  await page.waitForFunction(() => Reflect.has(globalThis, "__benchmateResult"));
  const result = await page.evaluate(() => Reflect.get(globalThis, "__benchmateResult"));

  expect(result).toEqual({
    names: ["sync", "thenable"],
    calls: 8,
    completions: 4,
    unsafeEvalAllowed: false,
    run: {
      provider: "performance.now",
      durationValid: true,
      comparisonCount: 0,
    },
    contracts: ["complete", "complete"].map((status) => ({
      schemaVersion: 6,
      status,
      taskType: "call",
      measurement: "iterations",
      schedule: "isolated",
      statsProvenance: { observationPhase: "measurement", modelPhase: null },
      provider: "performance.now",
      phases: ["probe", "overhead", "measurement"],
      operations: 3,
      totalMatches: true,
      frozen: true,
    })),
    portableModes: {
      comparative: {
        statuses: ["complete", "complete"],
        blocks: [80, 80],
        coverage: ["validated-corpus-v1", "validated-corpus-v1"],
        rowCount: 40,
        rowsMatch: true,
        comparisonCount: 1,
        averageRatioX: 1,
        comparisonMetric: "time-per-operation",
        lifecycleValid: true,
      },
      throughput: {
        status: "complete",
        completions: 240,
        blocks: 80,
        makespan: 3,
        rate: 1_000,
      },
      endToEnd: {
        status: "complete",
        kind: "async",
        total: 4,
        average: 2,
      },
      kernel: {
        status: "complete",
        intervalMethod: "round-slope-t",
        operationCountLadder: [32, 64, 128, 256, 512],
        rounds: 80,
      },
    },
  });
});
