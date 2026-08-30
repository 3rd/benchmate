import { expect, test } from "bun:test";
import {
  assessStability,
  findDependencePlan,
  groupMeans,
  lagOneCorrelation,
  planEffectiveCount,
  sampleVariance,
  studentTCritical95,
  studentTInterval,
} from "./superblocks";

test("uses Student-t inference to plan and assess a fixed effective horizon", () => {
  expect(studentTCritical95(19)).toBeCloseTo(2.093_024, 6);
  expect(planEffectiveCount(10, 0, 0.01, 20)).toBe(20);
  expect(studentTInterval([10, 10, 10, 10])).toEqual({ mean: 10, lower: 10, upper: 10, halfWidth: 0 });
});

test("confirms a variance plateau at the next complete power-of-two grouping without dropping values", () => {
  const values = Array.from({ length: 64 }, () => 3);
  const plan = findDependencePlan(values);

  expect(plan?.superblockSize).toBe(4);
  expect(plan?.estimates.slice(0, 3)).toEqual([
    { blockSize: 1, groupCount: 64, longRunVariance: 0 },
    { blockSize: 2, groupCount: 32, longRunVariance: 0 },
    { blockSize: 4, groupCount: 16, longRunVariance: 0 },
  ]);
  expect(groupMeans(values, 8)).toHaveLength(8);
  expect(() => groupMeans(values.slice(0, 63), 8)).toThrow("complete groups");
});

test("rejects chronological drift and quantized values without deleting them", () => {
  expect(
    assessStability(
      Array.from({ length: 30 }, () => 2),
      0.01,
    ).stable,
  ).toBeTrue();
  expect(
    assessStability(
      Array.from({ length: 30 }, (_, index) => 2 + index * 0.01),
      0.01,
    ).stable,
  ).toBeFalse();
  expect(assessStability([...Array.from({ length: 29 }, () => 2), 0], 0.01)).toMatchObject({
    stable: false,
    quantized: true,
  });
});

test("does not turn floating timestamp subtraction noise into synthetic variance", () => {
  expect(sampleVariance([0.01, 0.010_000_000_000_001, 0.009_999_999_999_999_5])).toBe(0);
  expect(sampleVariance([0.01, 0.0101, 0.0099])).toBeGreaterThan(0);
});

test("raises the selected block floor when pilot values retain material lag-one correlation", () => {
  let state = 0;
  let seed = 42;
  const values = Array.from({ length: 1024 }, () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const innovation = seed / 0x1_00_00_00_00 - 0.5;
    state = 0.9 * state + innovation;
    return 10 + state * 0.01;
  });

  expect(lagOneCorrelation(values)).toBeGreaterThan(0.7);
  expect(findDependencePlan(values)?.superblockSize).toBeGreaterThanOrEqual(64);
});
