import { expect, test } from "bun:test";
import type { Clock } from "../types";
import { compileTaskFunction, runEndToEndBlock, runThroughputBlock } from "./compile";

const fakeClock = (): Clock => {
  let tick = 0;
  return { provider: "performance.now", now: () => tick++ };
};

test("sync call harness returns one raw timed block for the requested operations", () => {
  let calls = 0;
  const compiled = compileTaskFunction(() => {
    calls++;
    return calls;
  }, false);

  expect(compiled(5, fakeClock())).toEqual({ startedAtMs: 0, elapsedMs: 1, operations: 5, resultHash: null });
  expect(calls).toBe(5);
});

test("async call harness awaits and consumes every operation inside the timed block", async () => {
  let calls = 0;
  const compiled = compileTaskFunction(async () => {
    await Promise.resolve();
    return ++calls;
  }, true);

  expect(await compiled(3, fakeClock())).toEqual({ startedAtMs: 0, elapsedMs: 1, operations: 3, resultHash: null });
  expect(calls).toBe(3);
});

test("sync call harness rejects a later Promise-like result", () => {
  let calls = 0;
  const compiled = compileTaskFunction(() => {
    calls++;
    return calls === 1 ? 1 : Promise.resolve(2);
  }, false);

  expect(() => compiled(2, fakeClock())).toThrow(
    "Call task changed from synchronous to asynchronous execution.",
  );
});

test("async call harness rejects a later synchronous result", async () => {
  let calls = 0;
  const compiled = compileTaskFunction(() => {
    calls++;
    return calls === 1 ? Promise.resolve(1) : 2;
  }, true);
  let failure: unknown = null;

  try {
    await compiled(2, fakeClock());
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(TypeError);
  if (!(failure instanceof Error)) throw new Error("Expected call execution to fail.");
  expect(failure.message).toBe(
    "Call task changed from asynchronous to synchronous execution.",
  );
});

test("throughput blocks keep every lane closed-loop and report wall-clock makespan", async () => {
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  const block = await runThroughputBlock(
    {
      mode: "throughput",
      concurrency: 3,
      run: async () => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active--;
        calls++;
      },
    },
    4,
    fakeClock(),
  );

  expect(calls).toBe(12);
  expect(maximumActive).toBe(3);
  expect(block).toEqual({ startedAtMs: 0, elapsedMs: 1, operations: 12, resultHash: null });
});

test("throughput rejection waits for in-flight lanes and prevents later launches", async () => {
  let calls = 0;
  let inFlight = 0;
  const task = {
    mode: "throughput" as const,
    concurrency: 3,
    run: async () => {
      const call = ++calls;
      inFlight++;
      try {
        await Promise.resolve();
        if (call === 2) throw new Error("lane failed");
      } finally {
        inFlight--;
      }
    },
  };

  let failure: unknown = null;
  try {
    await runThroughputBlock(task, 5, fakeClock());
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe("lane failed");
  const callsAtRejection = calls;
  await Promise.resolve();

  expect(inFlight).toBe(0);
  expect(calls).toBe(callsAtRejection);
  expect(calls).toBeLessThan(15);
});

test("end-to-end blocks create unique inputs and run them inside the timed boundary", async () => {
  const order: string[] = [];
  let tick = 0;
  const clock: Clock = {
    provider: "performance.now",
    now: () => {
      order.push(tick === 0 ? "start" : "end");
      return tick++;
    },
  };
  const block = await runEndToEndBlock({
    task: {
      mode: "end-to-end",
      createInput: ({ seed }) => {
        order.push(`createInput:${seed}`);
        return seed;
      },
      run: async (input) => {
        order.push(`run:${input}`);
        await Promise.resolve();
        return input;
      },
    },
    operations: 2,
    firstInputSeed: 42,
    clock,
  });

  expect(order[0]).toBe("start");
  expect(order.at(-1)).toBe("end");
  expect(order.filter((entry) => entry.startsWith("createInput"))).toEqual([
    "createInput:42",
    "createInput:43",
  ]);
  expect(order.filter((entry) => entry.startsWith("run"))).toHaveLength(2);
  expect(block).toMatchObject({ startedAtMs: 0, elapsedMs: 1, operations: 2, isAsync: true });
});
