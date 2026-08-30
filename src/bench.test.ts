import { expect, test } from "bun:test";
import type {
  BenchmarkOptions,
  BenchmarkResult,
  BenchmarkRunResult,
  CallBenchmarkResult,
  EndToEndBenchmarkResult,
  KernelBenchmarkResult,
  ThroughputBenchmarkResult,
} from "./types";
import { Bench, resolveOptions } from "./bench";
import { global } from "./platform/global";

const requireCallResult = (result: BenchmarkResult | undefined): CallBenchmarkResult => {
  if (result?.taskType !== "call") throw new Error("Expected a call benchmark result.");
  return result;
};

const requireEndToEndResult = (result: BenchmarkResult | undefined): EndToEndBenchmarkResult => {
  if (result?.taskType !== "end-to-end") throw new Error("Expected an end-to-end benchmark result.");
  return result;
};

const requireKernelResult = (result: BenchmarkResult | undefined): KernelBenchmarkResult => {
  if (result?.taskType !== "kernel") throw new Error("Expected a kernel benchmark result.");
  return result;
};

const requireThroughputResult = (result: BenchmarkResult | undefined): ThroughputBenchmarkResult => {
  if (result?.taskType !== "throughput") throw new Error("Expected a throughput benchmark result.");
  return result;
};

test("sets up every task before measurement and tears down once in reverse registration order", async () => {
  const order: string[] = [];
  const completedRuns: BenchmarkRunResult[] = [];
  const bench = new Bench({
    iterations: 1,
    warmup: { enabled: false },
    batching: { enabled: false },
    quiet: true,
  });
  bench.add("a", {
    mode: "call",
    setup: () => {
      order.push("setup:a");
    },
    run: () => order.push("run:a"),
    teardown: () => {
      order.push("teardown:a");
    },
  });
  bench.add("b", {
    mode: "call",
    setup: () => {
      order.push("setup:b");
    },
    run: () => order.push("run:b"),
    teardown: () => {
      order.push("teardown:b");
    },
  });
  bench.on("benchmarkEnd", (result) => {
    completedRuns.push(result);
  });

  const run = await bench.run();
  const { entries, comparisons } = run;

  expect(order.slice(0, 2)).toEqual(["setup:a", "setup:b"]);
  expect(order.slice(-2)).toEqual(["teardown:b", "teardown:a"]);
  expect(order.indexOf("run:a")).toBeGreaterThan(order.indexOf("setup:b"));
  expect(entries.map((entry) => entry.name)).toEqual(["a", "b"]);
  expect(entries.every((entry) => entry.evidence.status === "complete")).toBeTrue();
  expect(comparisons).toEqual([]);
  const completedRun = completedRuns[0];
  if (!completedRun) throw new Error("Expected a benchmarkEnd event.");
  expect(completedRun).toBe(run);
});

test("excludes setup and teardown clock time from task statistics", async () => {
  const originalProcess = global.process;
  let nowNanoseconds = 0n;
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => nowNanoseconds } };
  try {
    const bench = new Bench({
      iterations: 1,
      method: "hrtime",
      warmup: { enabled: false },
      batching: { enabled: false },
      quiet: true,
    });
    bench.add("timed boundary", {
      mode: "call",
      setup: () => {
        nowNanoseconds += 100_000_000n;
      },
      run: () => {
        nowNanoseconds += 2_000_000n;
      },
      teardown: () => {
        nowNanoseconds += 200_000_000n;
      },
    });

    const run = await bench.run();
    const [result] = run.entries;
    const callResult = requireCallResult(result);

    expect(callResult.stats.elapsedMs).toBe(2);
    expect(
      result?.evidence.observations.filter((observation) => observation.phase === "measurement"),
    ).toHaveLength(1);
    expect(run.durationMs).toBe(Number(nowNanoseconds) / 1e6);
  } finally {
    global.process = originalProcess;
  }
});

test("rejects automatic options combined with an exact measurement override", () => {
  type MixedSelectionIsAssignable =
    {
      iterations: 5;
      auto: {};
    } extends BenchmarkOptions ?
      true
    : false;
  const assignable: MixedSelectionIsAssignable = false;
  const mixed = { iterations: 5, auto: {} } as unknown as BenchmarkOptions;

  expect(assignable).toBeFalse();
  expect(() => new Bench(mixed)).toThrow("cannot be combined");
  expect(() => new Bench({ warmup: { enabled: false } } as BenchmarkOptions)).toThrow("available only");
});

test("validates automatic precision and time limits", () => {
  expect(() => new Bench({ auto: { precisionX: 0 } })).toThrow("precisionX");
  expect(() => new Bench({ auto: { maxTimeMs: 100, maxWarmupTimeMs: 100 } })).toThrow("must be less");
});

test("prints to the console only when quiet is false", () => {
  expect(resolveOptions().quiet).toBeTrue();
  expect(resolveOptions({ quiet: false }).quiet).toBeFalse();
});

test("rejects comparative-only schedule fields and non-boolean kernel declarations", () => {
  expect(() => new Bench({ schedule: { mode: "isolated", seed: 1 } } as BenchmarkOptions)).toThrow(
    "available only in comparative mode",
  );
  expect(
    () => new Bench({ schedule: { mode: "comparative" }, sleepBetweenTasksMs: 1 } as BenchmarkOptions),
  ).toThrow("yieldBetweenRounds");
  const bench = new Bench();
  expect(() =>
    bench.add("invalid kernel", {
      mode: "kernel",
      constantResult: "yes",
      run: ({ iterationCount }: { iterationCount: number }) => iterationCount,
    } as never),
  ).toThrow("constantResult must be a boolean");
});

test("uses smart automatic measurement by default", async () => {
  const originalProcess = global.process;
  let nowNanoseconds = 0n;
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => nowNanoseconds } };
  try {
    const bench = new Bench({ quiet: true, method: "hrtime" });
    bench.add("automatic", () => {
      nowNanoseconds += 2_000_000n;
      return 42;
    });

    const { entries: [result] } = await bench.run();

    expect(result?.evidence.measurement).toBe("auto");
    expect(result?.evidence.taskType).toBe("call");
    expect(result?.metadata.plan).not.toBeNull();
    expect(
      result?.evidence.observations.some((observation) => observation.phase === "measurement"),
    ).toBeTrue();
  } finally {
    global.process = originalProcess;
  }
});

test("returns useful automatic statistics when slow code cannot complete the full plan", async () => {
  const originalProcess = global.process;
  let nowNanoseconds = 0n;
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => nowNanoseconds } };
  try {
    const bench = new Bench({ quiet: true, method: "hrtime" });
    bench.add("slow", () => {
      nowNanoseconds += 500_000_000n;
      return 42;
    });

    const { entries: [result] } = await bench.run();
    const callResult = requireCallResult(result);

    expect(result?.evidence.status).toBe("warmup-not-converged");
    expect(result?.evidence.interval).toBeNull();
    expect(callResult.stats.timePerOperationMs.average).toBe(500);
    expect(callResult.stats.operationsPerSecond.average).toBe(2);
  } finally {
    global.process = originalProcess;
  }
});

test("returns raw ordered iteration override evidence and keeps the harness model separate", async () => {
  const bench = new Bench({
    iterations: 4,
    warmup: { enabled: false },
    batching: { enabled: true, operationsPerBlock: 2 },
    quiet: true,
  });
  bench.add("fixed", () => 42);

  const { entries: [result], clock } = await bench.run();
  const callResult = requireCallResult(result);
  const measured =
    result?.evidence.observations.filter((observation) => observation.phase === "measurement") ?? [];

  expect(result?.evidence.measurement).toBe("iterations");
  expect(clock.sampleCount).toBe(2048);
  expect(measured).toHaveLength(2);
  expect(measured.map((observation) => observation.sequence)).toEqual(
    [...measured].map((observation) => observation.sequence).sort((a, b) => a - b),
  );
  expect(callResult.stats.elapsedMs).toBe(
    measured.reduce((total, observation) => total + observation.elapsedMs, 0),
  );
  expect(callResult.stats.harnessOverhead.sampleCount).toBe(5);
  expect(callResult.stats.harnessOverhead.observationSequences).toHaveLength(5);
  expect(Object.isFrozen(result?.evidence.observations)).toBeTrue();
  expect(result?.evidence.interval).toMatchObject({ method: "batch-t", coverage: "nominal" });
});

test("fixed measurement does not require a random-seed provider", async () => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
  try {
    const bench = new Bench({
      iterations: 1,
      quiet: true,
      warmup: { enabled: false },
      batching: { enabled: false },
    });
    bench.add("fixed", () => 1);

    const { entries: [result] } = await bench.run();

    expect(result?.evidence.status).toBe("complete");
    expect(result?.metadata.schedule.seed).toBeNull();
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
});

test("marks a zero-duration iteration override result timer-limited", async () => {
  const originalProcess = global.process;
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => 0n } };
  try {
    const bench = new Bench({
      iterations: 2,
      method: "hrtime",
      warmup: { enabled: false },
      batching: { enabled: false },
      quiet: true,
    });
    bench.add("unresolved", () => 1);

    const { entries: [result] } = await bench.run();

    expect(result?.evidence.status).toBe("timer-limited");
    expect(result?.evidence.interval).toBeNull();
    expect(
      result?.evidence.observations
        .filter((observation) => observation.phase === "measurement")
        .every((observation) => observation.flags.includes("clock-quantized")),
    ).toBeTrue();
  } finally {
    global.process = originalProcess;
  }
});

test("bounds frozen-clock time override calibration and returns timer-limited evidence", async () => {
  const originalProcess = global.process;
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => 0n } };
  try {
    const bench = new Bench({
      timeMs: 1,
      method: "hrtime",
      warmup: { enabled: false },
      quiet: true,
    });
    bench.add("unresolved", () => 1);

    const { entries: [result] } = await bench.run();

    expect(result?.evidence.status).toBe("timer-limited");
    expect(
      result?.evidence.observations.some((observation) => observation.phase === "calibration"),
    ).toBeTrue();
    expect(
      result?.evidence.observations.some((observation) => observation.phase === "measurement"),
    ).toBeFalse();
  } finally {
    global.process = originalProcess;
  }
}, 10_000);

test("bounds nonzero under-floor time override calibration at the operation ceiling", async () => {
  const originalProcess = global.process;
  let nowNanoseconds = 0n;
  global.process = {
    env: originalProcess?.env,
    hrtime: {
      bigint: () => {
        nowNanoseconds += 100_000n;
        return nowNanoseconds;
      },
    },
  };
  try {
    const bench = new Bench({
      timeMs: 1,
      method: "hrtime",
      warmup: { enabled: false },
      quiet: true,
    });
    bench.add("under floor", () => 1);

    const { entries: [result] } = await bench.run();

    expect(result?.evidence.status).toBe("timer-limited");
    expect(
      result?.evidence.observations.some((observation) => observation.phase === "measurement"),
    ).toBeFalse();
  } finally {
    global.process = originalProcess;
  }
}, 10_000);

test("tears down only successfully set up tasks after a later setup failure", async () => {
  const order: string[] = [];
  const bench = new Bench({ iterations: 1, quiet: true });
  bench.add("ready", {
    mode: "call",
    setup: () => {
      order.push("setup:ready");
    },
    run: () => {},
    teardown: () => {
      order.push("teardown:ready");
    },
  });
  bench.add("fails", {
    mode: "call",
    setup: () => {
      order.push("setup:fails");
      throw new Error("setup failed");
    },
    run: () => {},
    teardown: () => {
      order.push("teardown:fails");
    },
  });

  let failure: unknown = null;
  try {
    await bench.run();
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("setup failed");
  expect(order).toEqual(["setup:ready", "setup:fails", "teardown:ready"]);
});

test("keeps a task failure primary and attaches teardown failures in reverse order", async () => {
  const bench = new Bench({ iterations: 1, quiet: true });
  bench.add("primary", {
    mode: "call",
    run: () => {
      throw new Error("task failed");
    },
    teardown: () => {
      throw new Error("teardown primary");
    },
  });
  bench.add("later", {
    mode: "call",
    run: () => {},
    teardown: () => {
      throw new Error("teardown later");
    },
  });

  let failure: (Error & { teardownErrors?: readonly Error[] }) | null = null;
  try {
    await bench.run();
  } catch (error) {
    failure = error as Error & { teardownErrors?: readonly Error[] };
  }

  expect(failure?.message).toBe("task failed");
  expect(failure?.teardownErrors?.map((error) => error.message)).toEqual([
    "teardown later",
    "teardown primary",
  ]);
});

test("aggregates teardown-only failures in reverse registration order", async () => {
  const bench = new Bench({ iterations: 1, quiet: true, warmup: { enabled: false } });
  for (const name of ["first", "second"] as const) {
    bench.add(name, {
      mode: "call",
      run: () => name,
      teardown: () => {
        throw new Error(`teardown ${name}`);
      },
    });
  }

  let failure: AggregateError | null = null;
  try {
    await bench.run();
  } catch (error) {
    if (error instanceof AggregateError) failure = error;
  }

  expect(failure?.message).toBe("One or more benchmark task teardowns failed.");
  expect(failure?.errors.map((error) => (error instanceof Error ? error.message : String(error)))).toEqual([
    "teardown second",
    "teardown first",
  ]);
});

test("runs counted kernels through fresh round-slope measurement evidence", async () => {
  const originalProcess = global.process;
  let nowNanoseconds = 0n;
  global.process = {
    env: originalProcess?.env,
    hrtime: { bigint: () => nowNanoseconds },
  };
  try {
    const bench = new Bench({
      quiet: true,
      method: "hrtime",
      auto: {
        maxTimeMs: 15_000,
        maxWarmupTimeMs: 5000,
      },
    });
    bench.add("linear kernel", {
      mode: "kernel",
      run: ({ iterationCount }) => {
        nowNanoseconds += 1_000_000n + BigInt(iterationCount) * 10_000n;
        return iterationCount;
      },
    });

    const { entries: [result] } = await bench.run();
    const kernelResult = requireKernelResult(result);

    expect(result?.evidence.status).toBe("complete");
    expect(result?.evidence.interval).toMatchObject({
      method: "round-slope-t",
      coverage: "validated-corpus-v1",
    });
    expect(kernelResult.stats.timePerOperationMs.average).toBeCloseTo(0.01, 12);
    expect(kernelResult.metadata.kernel?.operationCountLadder).toEqual([32, 64, 128, 256, 512]);
    expect(kernelResult.metadata.kernel?.rounds).toHaveLength(result?.evidence.interval?.physicalCount ?? 0);
    expect(result?.evidence.interval?.effectiveCount).toBe(20);
    expect(
      result?.evidence.observations.filter((observation) => observation.phase === "measurement"),
    ).toHaveLength((kernelResult.metadata.kernel?.rounds.length ?? 0) * 5);
  } finally {
    global.process = originalProcess;
  }
});

test("advances a one-operation timer-safe kernel to the first valid four-point ladder", async () => {
  const originalProcess = global.process;
  let nowNanoseconds = 0n;
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => nowNanoseconds } };
  try {
    const bench = new Bench({
      quiet: true,
      method: "hrtime",
      auto: { maxTimeMs: 15_000, maxWarmupTimeMs: 5000 },
    });
    bench.add("slow kernel", {
      mode: "kernel",
      run: ({ iterationCount }) => {
        nowNanoseconds += 3_000_000n + BigInt(iterationCount) * 100_000n;
        return iterationCount;
      },
    });

    const { entries: [result] } = await bench.run();
    const kernelResult = requireKernelResult(result);

    expect(result?.evidence.status).toBe("complete");
    expect(kernelResult.metadata.kernel?.baseOperationCount).toBe(2);
    expect(kernelResult.metadata.kernel?.operationCountLadder).toEqual([1, 2, 4, 8]);
    expect(kernelResult.metadata.plan?.operationsPerBlock).toBe(2);
  } finally {
    global.process = originalProcess;
  }
});

test("returns timer-limited evidence when a kernel never clears clock quantization", async () => {
  const originalProcess = global.process;
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => 0n } };
  try {
    const bench = new Bench({
      quiet: true,
      method: "hrtime",
      auto: { maxTimeMs: 15_000, maxWarmupTimeMs: 5000 },
    });
    bench.add("unresolved kernel", {
      mode: "kernel",
      run: ({ iterationCount }) => iterationCount,
    });

    const { entries: [result] } = await bench.run();

    expect(result?.evidence.status).toBe("timer-limited");
    expect(result?.evidence.interval).toBeNull();
    expect(
      result?.evidence.observations.every((observation) => observation.flags.includes("clock-quantized")),
    ).toBeTrue();
  } finally {
    global.process = originalProcess;
  }
});

test("returns optimization-sensitive evidence for an undeclared constant kernel result", async () => {
  const originalProcess = global.process;
  let nowNanoseconds = 0n;
  global.process = {
    env: originalProcess?.env,
    hrtime: { bigint: () => nowNanoseconds },
  };
  try {
    const bench = new Bench({
      quiet: true,
      method: "hrtime",
      auto: { maxTimeMs: 15_000, maxWarmupTimeMs: 5000 },
    });
    bench.add("constant kernel", {
      mode: "kernel",
      run: ({ iterationCount }) => {
        nowNanoseconds += 1_000_000n + BigInt(iterationCount) * 10_000n;
        return 0;
      },
    });

    const { entries: [result] } = await bench.run();
    const measured =
      result?.evidence.observations.filter((observation) => observation.phase === "measurement") ?? [];

    expect(result?.evidence.status).toBe("optimization-sensitive");
    expect(result?.evidence.interval).toBeNull();
    expect(result?.evidence.reasons[0]).toContain("constant");
    expect(measured.every((observation) => observation.flags.includes("constant-result"))).toBeTrue();
  } finally {
    global.process = originalProcess;
  }
});

test("retains an explicitly declared constant result without suppressing its diagnostic flag", async () => {
  const originalProcess = global.process;
  let nowNanoseconds = 0n;
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => nowNanoseconds } };
  try {
    const bench = new Bench({
      quiet: true,
      method: "hrtime",
      auto: { maxTimeMs: 15_000, maxWarmupTimeMs: 5000 },
    });
    bench.add("declared constant", {
      mode: "kernel",
      constantResult: true,
      run: ({ iterationCount }) => {
        nowNanoseconds += 1_000_000n + BigInt(iterationCount) * 10_000n;
        return 0;
      },
    });

    const { entries: [result] } = await bench.run();
    const kernelResult = requireKernelResult(result);

    expect(result?.evidence.status).toBe("complete");
    expect(kernelResult.metadata.kernel?.constantResultDeclared).toBeTrue();
    expect(
      result?.evidence.observations
        .filter((observation) => observation.phase === "measurement")
        .every((observation) => observation.flags.includes("constant-result")),
    ).toBeTrue();
  } finally {
    global.process = originalProcess;
  }
});

test("marks unhashable kernel results without mislabeling them as constant", async () => {
  const originalProcess = global.process;
  let nowNanoseconds = 0n;
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => nowNanoseconds } };
  try {
    const bench = new Bench({
      quiet: true,
      method: "hrtime",
      auto: { maxTimeMs: 15_000, maxWarmupTimeMs: 5000 },
    });
    bench.add("unhashable result", {
      mode: "kernel",
      run: ({ iterationCount }) => {
        nowNanoseconds += 1_000_000n + BigInt(iterationCount) * 10_000n;
        return Symbol(iterationCount);
      },
    });

    const { entries: [result] } = await bench.run();
    const measured =
      result?.evidence.observations.filter((observation) => observation.phase === "measurement") ?? [];

    expect(result?.evidence.status).toBe("optimization-sensitive");
    expect(result?.evidence.reasons).toEqual(["one or more kernel results could not be hashed"]);
    expect(measured.every((observation) => observation.flags.includes("unhashable-result"))).toBeTrue();
    expect(measured.some((observation) => observation.flags.includes("constant-result"))).toBeFalse();
  } finally {
    global.process = originalProcess;
  }
});

test("interleaves comparative measurement exactly as recorded in the balanced schedule", async () => {
  const originalProcess = global.process;
  const clockState = { nowNanoseconds: 0n };
  const lifecycle: string[] = [];
  const progress: { task: string; phase: string; completed: number; planned: number | null }[] = [];
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => clockState.nowNanoseconds } };
  try {
    const bench = new Bench({
      quiet: true,
      method: "hrtime",
      auto: { maxTimeMs: 1000, maxWarmupTimeMs: 300 },
      schedule: { mode: "comparative", seed: 42 },
    });
    bench.on("progress", (event) => {
      if (!("phase" in event)) return;
      progress.push({
        task: event.task,
        phase: event.phase,
        completed: event.physicalBlocksCompleted,
        planned: event.physicalBlocksPlanned,
      });
    });
    for (const name of ["a", "b"] as const) {
      bench.add(name, {
        mode: "call",
        setup: () => {
          lifecycle.push(`setup:${name}`);
        },
        run: () => {
          clockState.nowNanoseconds += 2_000_000n;
          return name;
        },
        teardown: () => {
          lifecycle.push(`teardown:${name}`);
        },
      });
    }

    const { entries: results, comparisons } = await bench.run();
    const callResults = results.map(requireCallResult);
    const [left, right] = callResults;
    const rows = left?.metadata.schedule.rows ?? [];
    const measured = callResults
      .flatMap((result) => result.evidence.observations)
      .filter((observation) => observation.phase === "measurement")
      .sort((leftObservation, rightObservation) => leftObservation.sequence - rightObservation.sequence);

    expect(callResults.map((result) => result.evidence.status)).toEqual(["complete", "complete"]);
    expect(callResults.map((result) => result.evidence.interval?.coverage)).toEqual([
      "validated-corpus-v1",
      "validated-corpus-v1",
    ]);
    expect(rows.flat()).toEqual(measured.map((observation) => observation.task));
    const physicalBlockCounts = callResults.flatMap((result) =>
      result.metadata.plan ? [result.metadata.plan.physicalBlockCount] : [],
    );
    expect(physicalBlockCounts).toHaveLength(callResults.length);
    expect(callResults.map((result) => result.stats.blocks)).toEqual(physicalBlockCounts);
    expect(new Set(rows.flatMap((row) => row.filter((name) => name === "a").length))).toEqual(new Set([2]));
    expect(lifecycle).toEqual(["setup:a", "setup:b", "teardown:b", "teardown:a"]);
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]).toMatchObject({
      left: "a",
      right: "b",
      metric: "time-per-operation",
      unit: "milliseconds-per-operation",
      better: "lower",
    });
    expect(comparisons[0]?.averageRatioX).toBe(1);
    for (const result of callResults) {
      const plannedPhysicalBlocks = result.metadata.plan?.physicalBlockCount;
      if (plannedPhysicalBlocks === undefined) {
        throw new Error("complete comparative result had no locked plan");
      }
      const finalProgress = progress.findLast(
        (event) => event.task === result.name && event.phase === "measurement",
      );
      expect(finalProgress).toEqual({
        task: result.name,
        phase: "measurement",
        completed: plannedPhysicalBlocks,
        planned: plannedPhysicalBlocks,
      });
      expect(
        new Set(progress.filter((event) => event.task === result.name).map((event) => event.phase)),
      ).toEqual(new Set(["measurement", "pilot", "warmup"]));
    }
  } finally {
    global.process = originalProcess;
  }
});

test("rejects a shared comparative plan before final measurement when one task exceeds budget", async () => {
  const originalProcess = global.process;
  let nowNanoseconds = 0n;
  const statuses: string[] = [];
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => nowNanoseconds } };
  try {
    const bench = new Bench({
      quiet: true,
      method: "hrtime",
      auto: { maxTimeMs: 2500, maxWarmupTimeMs: 1000 },
      schedule: { mode: "comparative", seed: 7 },
    });
    bench.on("taskEvidenceStatus", ({ task, status }) => statuses.push(`${task}:${status}`));
    bench.add("fast", () => {
      nowNanoseconds += 2_000_000n;
    });
    bench.add("slow", () => {
      nowNanoseconds += 20_000_000n;
    });

    const { entries: results } = await bench.run();

    expect(results.map((result) => result.evidence.status)).toEqual([
      "insufficient-budget",
      "insufficient-budget",
    ]);
    expect(
      results.every(
        (result) => !result.evidence.observations.some((observation) => observation.phase === "measurement"),
      ),
    ).toBeTrue();
    expect(results.every((result) => result.evidence.interval === null)).toBeTrue();
    expect(statuses).toEqual(["fast:insufficient-budget", "slow:insufficient-budget"]);
  } finally {
    global.process = originalProcess;
  }
});

test("stops comparative measurement after a complete row when the locked plan overruns", async () => {
  const originalProcess = global.process;
  const clockState = { nowNanoseconds: 0n };
  const calls = new Map<string, number>();
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => clockState.nowNanoseconds } };
  try {
    const bench = new Bench({
      quiet: true,
      method: "hrtime",
      auto: { maxTimeMs: 1000, maxWarmupTimeMs: 300 },
      schedule: { mode: "comparative", seed: 99 },
    });
    for (const name of ["a", "b"] as const) {
      bench.add(name, () => {
        const count = (calls.get(name) ?? 0) + 1;
        calls.set(name, count);
        clockState.nowNanoseconds += count > 105 ? 100_000_000n : 2_000_000n;
      });
    }

    const { entries: results } = await bench.run();
    const measured = results.map((result) =>
      result.evidence.observations.filter((observation) => observation.phase === "measurement"),
    );
    const acquiredOrder = measured
      .flat()
      .sort((left, right) => left.sequence - right.sequence)
      .map((observation) => observation.task);
    const plannedRows = results[0]?.metadata.schedule.rows ?? [];

    expect(results.map((result) => result.evidence.status)).toEqual([
      "insufficient-budget",
      "insufficient-budget",
    ]);
    expect(measured[0]?.length).toBe(measured[1]?.length);
    expect((measured[0]?.length ?? 0) % 2).toBe(0);
    expect(plannedRows.flat().slice(0, acquiredOrder.length)).toEqual(acquiredOrder);
    expect(acquiredOrder.length).toBeLessThan(plannedRows.flat().length);
  } finally {
    global.process = originalProcess;
  }
});

test("emits only terminal paired-diagnostic evidence statuses", async () => {
  const originalProcess = global.process;
  const clockState = { measurementStarted: false, nowNanoseconds: 0n };
  const measurementCalls = new Map<string, number>();
  const statuses: string[] = [];
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => clockState.nowNanoseconds } };
  try {
    const bench = new Bench({
      quiet: true,
      method: "hrtime",
      auto: { maxTimeMs: 1500, maxWarmupTimeMs: 300 },
      schedule: { mode: "comparative", seed: 123 },
    });
    bench.on("taskPhaseStart", ({ phase }) => {
      if (phase === "measurement") clockState.measurementStarted = true;
    });
    bench.on("taskEvidenceStatus", ({ task, status }) => statuses.push(`${task}:${status}`));
    for (const name of ["a", "b"] as const) {
      bench.add(name, () => {
        const count = clockState.measurementStarted ? (measurementCalls.get(name) ?? 0) : 0;
        if (clockState.measurementStarted) measurementCalls.set(name, count + 1);
        const drift = name === "a" && clockState.measurementStarted ? 0.04 * (count / 79) : 0;
        clockState.nowNanoseconds += BigInt(Math.round(2_000_000 * (1 + drift)));
        return name;
      });
    }

    const { entries: results } = await bench.run();

    expect(results.map((result) => result.evidence.status)).toEqual(["unstable", "unstable"]);
    expect(statuses).toEqual(["a:unstable", "b:unstable"]);
    expect(
      results.every((result) =>
        result.evidence.observations
          .filter((observation) => observation.phase === "measurement")
          .every(
            (observation) =>
              observation.flags.includes("drift-detected") || observation.flags.includes("change-detected"),
          ),
      ),
    ).toBeTrue();
  } finally {
    global.process = originalProcess;
  }
});

test("reports closed-loop throughput completions and block makespan as distinct quantities", async () => {
  const originalProcess = global.process;
  let nowNanoseconds = 0n;
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => nowNanoseconds } };
  try {
    const bench = new Bench({
      quiet: true,
      method: "hrtime",
      auto: { maxTimeMs: 1000, maxWarmupTimeMs: 300 },
    });
    bench.add("throughput", {
      mode: "throughput",
      concurrency: 3,
      run: async () => {
        nowNanoseconds += 1_000_000n;
        await Promise.resolve();
      },
    });

    const { entries: [result] } = await bench.run();
    const throughputResult = requireThroughputResult(result);

    expect(result?.evidence.status).toBe("complete");
    expect(result?.evidence.taskType).toBe("throughput");
    expect(throughputResult.metadata.concurrency).toBe(3);
    expect(throughputResult.stats.completions).toBe(
      (throughputResult.metadata.plan?.physicalBlockCount ?? 0) * 3,
    );
    const plannedBlocks = throughputResult.metadata.plan?.physicalBlockCount;
    if (plannedBlocks === undefined) throw new Error("Expected a throughput measurement plan.");
    expect(throughputResult.stats.blocks).toBe(plannedBlocks);
    expect(throughputResult.stats.blockDurationMs.average).toBe(3);
    expect(throughputResult.stats.completionsPerSecond.average).toBe(1000);
  } finally {
    global.process = originalProcess;
  }
});

test("returns neutral paired comparisons for end-to-end and throughput tasks", async () => {
  const originalProcess = global.process;
  let nowNanoseconds = 0n;
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => nowNanoseconds } };
  try {
    const bench = new Bench({
      quiet: true,
      method: "hrtime",
      auto: { maxTimeMs: 1000, maxWarmupTimeMs: 300 },
      schedule: { mode: "comparative", seed: 88 },
    });
    const endToEndSeeds = new Map<string, number[]>();
    for (const name of ["end-to-end left", "end-to-end right"] as const) {
      endToEndSeeds.set(name, []);
      bench.add(name, {
        mode: "end-to-end",
        createInput: ({ seed }) => {
          const taskSeeds = endToEndSeeds.get(name);
          if (!taskSeeds) throw new Error(`Missing seed collection for ${name}.`);
          taskSeeds.push(seed);
          return seed;
        },
        run: (seed) => {
          nowNanoseconds += 1_000_000n;
          return seed;
        },
      });
    }
    for (const name of ["throughput left", "throughput right"] as const) {
      bench.add(name, {
        mode: "throughput",
        concurrency: 2,
        run: async () => {
          nowNanoseconds += 1_000_000n;
          await Promise.resolve();
        },
      });
    }

    const { comparisons } = await bench.run();

    expect(comparisons).toHaveLength(2);
    expect(comparisons[0]).toMatchObject({
      left: "end-to-end left",
      right: "end-to-end right",
      taskType: "end-to-end",
      metric: "time-per-operation",
      unit: "milliseconds-per-operation",
      better: "lower",
    });
    expect(comparisons[1]).toMatchObject({
      left: "throughput left",
      right: "throughput right",
      taskType: "throughput",
      metric: "throughput",
      unit: "completions-per-second",
      better: "higher",
    });
    const leftSeeds = endToEndSeeds.get("end-to-end left") ?? [];
    const rightSeeds = endToEndSeeds.get("end-to-end right") ?? [];
    expect(leftSeeds).toEqual(rightSeeds);
    expect(new Set(leftSeeds).size).toBe(leftSeeds.length);
  } finally {
    global.process = originalProcess;
  }
});

test("keeps createInput seeds unique across phases and resets them for the next run", async () => {
  const seedsByRun: number[][] = [];
  let activeSeeds: number[] = [];
  let ready = false;
  const bench = new Bench({
    iterations: 4,
    warmup: { enabled: true, iterations: 2 },
    batching: { enabled: true, operationsPerBlock: 2 },
    quiet: true,
  });
  bench.add("request", {
    mode: "end-to-end",
    setup() {
      ready = true;
      activeSeeds = [];
      seedsByRun.push(activeSeeds);
    },
    createInput({ seed }) {
      if (!ready) throw new Error("setup did not run");
      activeSeeds.push(seed);
      return seed;
    },
    run(seed) {
      return seed;
    },
    teardown() {
      ready = false;
    },
  });

  await bench.run();
  await bench.run();

  expect(seedsByRun).toEqual([
    [0, 1, 2, 3, 4, 5],
    [0, 1, 2, 3, 4, 5],
  ]);
});

test("keeps end-to-end input creation and async execution inside each fixed timed boundary", async () => {
  const originalProcess = global.process;
  let nowNanoseconds = 0n;
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => nowNanoseconds } };
  try {
    const bench = new Bench({
      quiet: true,
      method: "hrtime",
      iterations: 2,
      warmup: { enabled: false },
      batching: { enabled: false },
    });
    bench.add("request", {
      mode: "end-to-end",
      createInput: ({ seed }) => {
        nowNanoseconds += 1_000_000n;
        return seed;
      },
      run: async (seed) => {
        nowNanoseconds += 1_000_000n;
        await Promise.resolve();
        return seed;
      },
    });

    const { entries: [result] } = await bench.run();
    const endToEndResult = requireEndToEndResult(result);

    expect(result?.evidence.taskType).toBe("end-to-end");
    expect(endToEndResult.metadata.executionKind).toBe("async");
    expect(endToEndResult.stats.operations).toBe(2);
    expect(endToEndResult.stats.elapsedMs).toBe(4);
    expect(endToEndResult.stats.timePerOperationMs.average).toBe(2);
  } finally {
    global.process = originalProcess;
  }
});

test("pairs comparative kernels on one shared operation-count ladder and identical round seeds", async () => {
  const originalProcess = global.process;
  const clockState = { nowNanoseconds: 0n };
  global.process = { env: originalProcess?.env, hrtime: { bigint: () => clockState.nowNanoseconds } };
  try {
    const bench = new Bench({
      quiet: true,
      method: "hrtime",
      auto: { maxTimeMs: 15_000, maxWarmupTimeMs: 5000 },
      schedule: { mode: "comparative", seed: 2026 },
    });
    for (const [name, nanosecondsPerOperation] of [
      ["left", 10_000n],
      ["right", 20_000n],
    ] as const) {
      bench.add(name, {
        mode: "kernel",
        run: ({ iterationCount }) => {
          clockState.nowNanoseconds +=
            1_000_000n + BigInt(iterationCount) * nanosecondsPerOperation;
          return iterationCount;
        },
      });
    }

    const { entries: [left, right], comparisons } = await bench.run();
    const leftKernelResult = requireKernelResult(left);
    const rightKernelResult = requireKernelResult(right);
    const leftKernel = leftKernelResult.metadata.kernel;
    const rightKernel = rightKernelResult.metadata.kernel;

    expect([leftKernelResult.evidence.status, rightKernelResult.evidence.status]).toEqual([
      "complete",
      "complete",
    ]);
    expect(leftKernel?.operationCountLadder).toEqual(rightKernel?.operationCountLadder);
    expect(leftKernel?.rounds.map((round) => round.seed)).toEqual(
      rightKernel?.rounds.map((round) => round.seed),
    );
    expect(leftKernel?.rounds.map((round) => round.operationCountOrder)).toEqual(
      rightKernel?.rounds.map((round) => round.operationCountOrder),
    );
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]).toMatchObject({ left: "left", right: "right", taskType: "kernel" });
    expect(comparisons[0]?.averageRatioX).toBeCloseTo(0.5, 12);
  } finally {
    global.process = originalProcess;
  }
});
