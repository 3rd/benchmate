import { expect, test } from "bun:test";
import {
  createBalancedIndexRows,
  createBalancedSchedule,
  createInputSeedSequence,
  createPhaseSchedule,
} from "./schedule";

test("reserves non-overlapping createInput seed ranges", () => {
  const sequence = createInputSeedSequence();

  expect(sequence.reserve(2)).toBe(0);
  expect(sequence.reserve(3)).toBe(2);
  expect(sequence.reserve(1)).toBe(5);
});

test("allows the final safe integer seed and rejects the next range", () => {
  const sequence = createInputSeedSequence();

  expect(sequence.reserve(Number.MAX_SAFE_INTEGER)).toBe(0);
  expect(sequence.reserve(1)).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => sequence.reserve(1)).toThrow(
    "End-to-end createInput seed sequence exceeded Number.MAX_SAFE_INTEGER.",
  );
});

test("uses alternating ABBA and BAAB rows for two tasks", () => {
  expect(createBalancedIndexRows(2)).toEqual([
    [0, 1, 1, 0],
    [1, 0, 0, 1],
  ]);
});

test("balances positions and directed carryover for three through sixteen tasks", () => {
  for (let taskCount = 3; taskCount <= 16; taskCount++) {
    const rows = createBalancedIndexRows(taskCount);
    const positionCounts = Array.from({ length: taskCount }, () =>
      Array.from({ length: taskCount }, () => 0),
    );
    const carryoverCounts = Array.from({ length: taskCount }, () =>
      Array.from({ length: taskCount }, () => 0),
    );

    for (const row of rows) {
      for (let position = 0; position < row.length; position++) {
        const task = row[position];
        if (task === undefined) throw new Error("missing task");
        positionCounts[task]![position] = (positionCounts[task]?.[position] ?? 0) + 1;
        const next = row[position + 1];
        if (next !== undefined) carryoverCounts[task]![next] = (carryoverCounts[task]?.[next] ?? 0) + 1;
      }
    }

    for (const counts of positionCounts) expect(new Set(counts).size).toBe(1);
    const directed = carryoverCounts.flatMap((counts, from) => counts.filter((_, to) => from !== to));
    expect(Math.max(...directed) - Math.min(...directed)).toBeLessThanOrEqual(1);
  }

  const names = ["A", "B", "C", "D"];
  expect(createBalancedSchedule(names, 42)).toEqual(createBalancedSchedule(names, 42));
  expect(createBalancedSchedule(names, 42).rows).not.toEqual(createBalancedSchedule(names, 43).rows);
});

test("preserves balance and reproducibility for one thousand seeds at every supported task count", () => {
  let validatedSchedules = 0;
  for (let taskCount = 2; taskCount <= 16; taskCount++) {
    const names = Array.from({ length: taskCount }, (_, index) => `task-${index}`);
    for (let seed = 0; seed < 1000; seed++) {
      const plan = createBalancedSchedule(names, seed);
      const repeated = createBalancedSchedule(names, seed);
      if (JSON.stringify(plan) !== JSON.stringify(repeated)) {
        throw new Error(`seed ${seed} was not reproducible`);
      }
      const rowLength = plan.rows[0]?.length ?? 0;
      const positionCounts = new Map(names.map((name) => [name, Array.from({ length: rowLength }, () => 0)]));
      for (const row of plan.rows) {
        for (const [position, name] of row.entries()) {
          const counts = name === undefined ? undefined : positionCounts.get(name);
          if (!counts) throw new Error(`seed ${seed} lost a task label`);
          counts[position] = (counts[position] ?? 0) + 1;
        }
      }
      const first = positionCounts.get(names[0] ?? "");
      for (const counts of positionCounts.values()) {
        if (JSON.stringify(counts) !== JSON.stringify(first)) {
          throw new Error(`seed ${seed} changed position balance`);
        }
      }
      validatedSchedules++;
    }
  }

  expect(validatedSchedules).toBe(15_000);
});

test("derives distinct reproducible balanced schedules for every automatic measurement phase", () => {
  const names = ["a", "b", "c", "d"];
  const phases = ["warmup", "pilot", "measurement"] as const;
  const plans = phases.map((phase) => createPhaseSchedule(names, 42, phase, 2));

  expect(new Set(plans.map((plan) => plan.seed)).size).toBe(phases.length);
  for (const [index, phase] of phases.entries()) {
    const plan = plans[index];
    if (!phase || !plan) throw new Error("phase schedule invariant failed");
    expect(plan).toEqual(createPhaseSchedule(names, 42, phase, 2));
    const counts = new Map(
      names.map((name) => [name, plan.rows.flat().filter((entry) => entry === name).length]),
    );
    expect(new Set(counts.values()).size).toBe(1);
  }
});
