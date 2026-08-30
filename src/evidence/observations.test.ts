import { expect, test } from "bun:test";
import { ObservationCollector } from "./observations";

test("records chronological immutable observations with deterministic flags", () => {
  const collector = new ObservationCollector();
  const first = collector.record({
    task: "map.get",
    phase: "measurement",
    startedAtMs: 1,
    elapsedMs: 0,
    operations: 4,
    round: 0,
    seed: 12,
    resultHash: null,
    flags: ["pause-like", "zero-duration", "pause-like"],
  });
  collector.record({
    task: "map.get",
    phase: "measurement",
    startedAtMs: 2,
    elapsedMs: 1,
    operations: 4,
    round: 1,
    seed: 13,
    resultHash: null,
  });

  const snapshot = collector.snapshot();
  expect(snapshot.map((observation) => observation.sequence)).toEqual([0, 1]);
  expect(first.flags).toEqual(["zero-duration", "clock-quantized", "pause-like"]);
  expect(Object.isFrozen(snapshot)).toBeTrue();
  expect(Object.isFrozen(snapshot[0])).toBeTrue();
  expect(Object.isFrozen(snapshot[0]?.flags)).toBeTrue();
  expect(() => (snapshot as MeasurementObservation[]).reverse()).toThrow();
});

test("rejects non-finite and out-of-range public observation fields", () => {
  const collector = new ObservationCollector();
  const valid = {
    task: "task",
    phase: "measurement" as const,
    startedAtMs: 1,
    elapsedMs: 1,
    operations: 1,
    round: 0,
    seed: 0,
    resultHash: null,
  };

  expect(() => collector.record({ ...valid, startedAtMs: Number.NaN })).toThrow("'startedAtMs'");
  expect(() => collector.record({ ...valid, elapsedMs: Number.POSITIVE_INFINITY })).toThrow("'elapsedMs'");
  expect(() => collector.record({ ...valid, operations: 0 })).toThrow("'operations'");
  expect(() => collector.record({ ...valid, round: -1 })).toThrow("'round'");
  expect(() => collector.record({ ...valid, seed: 0x1_00_00_00_00 })).toThrow("'seed'");
  expect(collector.snapshot()).toEqual([]);
});

test("serializes equivalent snapshots deterministically without exposing collector storage", () => {
  const createSnapshot = () => {
    const collector = new ObservationCollector();
    collector.record({
      task: "task",
      phase: "measurement",
      startedAtMs: 1,
      elapsedMs: 2,
      operations: 3,
      round: 4,
      seed: 5,
      resultHash: "hash:result",
      flags: ["change-detected", "pause-like"],
    });
    return { collector, snapshot: collector.snapshot() };
  };
  const first = createSnapshot();
  const second = createSnapshot();

  expect(JSON.stringify(first.snapshot)).toBe(JSON.stringify(second.snapshot));
  first.collector.addFlags(0, ["drift-detected"]);
  expect(first.snapshot[0]?.flags).toEqual(["pause-like", "change-detected"]);
  expect(first.collector.snapshot()[0]?.flags).toEqual(["pause-like", "drift-detected", "change-detected"]);
});

type MeasurementObservation = import("../types").MeasurementObservation;
