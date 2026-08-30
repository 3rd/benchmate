import { expect, test } from "bun:test";
import type { Clock, KernelInvocation, KernelTaskDefinition } from "../types";
import { createKernelLadder, createKernelRoundPlan, hashResult, runKernelInvocation } from "./kernel";

const fakeClock = (): Clock => {
  let tick = 0;
  return { provider: "performance.now", now: () => tick++ };
};

test("builds a geometric operation-count ladder and reproducible randomized round plan", () => {
  expect(createKernelLadder(16)).toEqual([4, 8, 16, 32, 64]);
  expect(createKernelRoundPlan(16, 42, 1, 3)).toEqual(createKernelRoundPlan(16, 42, 1, 3));
  expect(createKernelRoundPlan(16, 42, 1, 3)).not.toEqual(createKernelRoundPlan(16, 42, 1, 4));
  expect(new Set(createKernelRoundPlan(16, 42, 1, 3).points.map((point) => point.iterations))).toEqual(
    new Set([16, 32, 4, 64, 8]),
  );
});

test("passes the total iteration count and reports it as operations", () => {
  const invocations: KernelInvocation[] = [];
  const block = runKernelInvocation(
    {
      mode: "kernel",
      run: (input) => {
        invocations.push(input);
        return input.iterationCount;
      },
    },
    8,
    fakeClock(),
  );

  expect(invocations).toEqual([{ iterationCount: 8 }]);
  expect(block.operations).toBe(8);
  expect(block.resultHash).toBe(hashResult(8));
});

test("ends kernel timing before consuming and hashing the returned result", () => {
  const order: string[] = [];
  const timestamps = [10, 15];
  const clock: Clock = {
    provider: "performance.now",
    now: () => {
      order.push(order.length === 0 ? "start" : "end");
      return timestamps.shift() ?? 15;
    },
  };
  const block = runKernelInvocation(
    {
      mode: "kernel",
      run: () => {
        order.push("run");
        return {
          get value() {
            order.push("result");
            return { value: 42 };
          },
        };
      },
    },
    8,
    clock,
  );

  expect(order).toEqual(["start", "run", "end", "result"]);
  expect(block).toEqual({
    startedAtMs: 10,
    elapsedMs: 5,
    operations: 8,
    resultHash: hashResult({ value: { value: 42 } }),
  });
});

test("rejects Promise-like kernel results as synchronous-only", () => {
  const task = {
    mode: "kernel",
    run: () => Promise.resolve(1),
  } as unknown as KernelTaskDefinition;

  expect(() => runKernelInvocation(task, 1, fakeClock())).toThrow("synchronous-only");
});

test("hashes non-scalar results deterministically and represents cycles as unavailable", () => {
  expect(hashResult({ beta: [2, 3], alpha: 1 })).toBe(hashResult({ alpha: 1, beta: [2, 3] }));
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(hashResult(cyclic)).toBeNull();
});

test("structurally hashes portable collections and binary views without collapsing their contents", () => {
  expect(
    hashResult(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    ),
  ).toBe(
    hashResult(
      new Map([
        ["b", 2],
        ["a", 1],
      ]),
    ),
  );
  expect(hashResult(new Set([1, 2, 3]))).toBe(hashResult(new Set([1, 2, 3])));
  expect(hashResult(new Uint8Array([1, 2, 3]))).not.toBe(hashResult(new Uint8Array([1, 2, 4])));
  expect(hashResult({ [Symbol("private")]: 1 })).toBeNull();
});
