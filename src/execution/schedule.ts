import type { MeasurementPhase } from "../types";

type SchedulePlan = {
  seed: number;
  rows: readonly (readonly string[])[];
};

type RandomSeedProvider = () => number;
type SeedDeriver = (seed: number, ...parts: readonly number[]) => number;
type Uint32Mixer = (value: number) => number;
type InputSeedSequence = {
  reserve: (operationCount: number) => number;
};

const PHASE_SALTS: Readonly<Record<"measurement" | "pilot" | "warmup", number>> = {
  warmup: 0x57_A2_1D_91,
  pilot: 0x91_E1_0D_A5,
  measurement: 0xD1_B5_4A_35,
};

const mixUint32: Uint32Mixer = (value) => {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21_F0_AA_AD);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x73_5A_2D_97);
  return (mixed ^ (mixed >>> 15)) >>> 0;
};

const deriveSeed: SeedDeriver = (seed, ...parts) => {
  let mixed = seed >>> 0;
  for (const part of parts) mixed = mixUint32(mixed ^ mixUint32(part));
  return mixed;
};

const createInputSeedSequence = (): InputSeedSequence => {
  let nextSeed: number | null = 0;

  return {
    reserve(operationCount) {
      if (!Number.isSafeInteger(operationCount) || operationCount <= 0) {
        throw new RangeError(`'operationCount' must be a positive safe integer, got ${operationCount}`);
      }
      if (
        nextSeed === null ||
        operationCount - 1 > Number.MAX_SAFE_INTEGER - nextSeed
      ) {
        throw new RangeError("End-to-end createInput seed sequence exceeded Number.MAX_SAFE_INTEGER.");
      }

      const firstSeed = nextSeed;
      const lastSeed = firstSeed + operationCount - 1;
      nextSeed = lastSeed === Number.MAX_SAFE_INTEGER ? null : lastSeed + 1;
      return firstSeed;
    },
  };
};

const createRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D_2B_79_F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_00_00_00_00;
  };
};

const shuffle = <Value>(values: readonly Value[], seed: number): Value[] => {
  const shuffled = [...values];
  const random = createRandom(seed);
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    const replacement = shuffled[swapIndex];
    if (current === undefined || replacement === undefined) {
      throw new Error("Schedule shuffle invariant failed.");
    }
    shuffled[index] = replacement;
    shuffled[swapIndex] = current;
  }
  return shuffled;
};

const buildBaseRow = (taskCount: number) => {
  const row = [0];
  let low = 1;
  let high = taskCount - 1;
  let takeLow = true;
  while (row.length < taskCount) {
    row.push(takeLow ? low++ : high--);
    takeLow = !takeLow;
  }
  return row;
};

const createBalancedIndexRows = (taskCount: number): readonly (readonly number[])[] => {
  if (!Number.isSafeInteger(taskCount) || taskCount < 2) {
    throw new RangeError(`'taskCount' must be a safe integer of at least 2, got ${taskCount}`);
  }
  if (taskCount === 2) return Object.freeze([Object.freeze([0, 1, 1, 0]), Object.freeze([1, 0, 0, 1])]);

  const base = buildBaseRow(taskCount);
  const rotations: number[][] = [];
  for (let offset = 0; offset < taskCount; offset++) {
    rotations.push(base.map((index) => (index + offset) % taskCount));
  }
  const rows =
    taskCount % 2 === 0 ? rotations : [...rotations, ...rotations.map((row) => [...row].reverse())];
  return Object.freeze(rows.map((row) => Object.freeze(row)));
};

const createBalancedSchedule = (taskNames: readonly string[], seed: number): SchedulePlan => {
  const indexRows = createBalancedIndexRows(taskNames.length);
  const labelIndexes = shuffle(
    Array.from({ length: taskNames.length }, (_, index) => index),
    deriveSeed(seed, 0x4C_41_42_4C),
  );
  const permutedRows = indexRows.map((row) =>
    row.map((index) => {
      const labelIndex = labelIndexes[index];
      const name = labelIndex === undefined ? undefined : taskNames[labelIndex];
      if (name === undefined) throw new Error("Schedule label invariant failed.");
      return name;
    }),
  );
  const rows = shuffle(permutedRows, deriveSeed(seed, 0x52_4F_57_53));
  return Object.freeze({ seed: seed >>> 0, rows: Object.freeze(rows.map((row) => Object.freeze(row))) });
};

const createPhaseSchedule = (
  taskNames: readonly string[],
  runSeed: number,
  phase: Extract<MeasurementPhase, "measurement" | "pilot" | "warmup">,
  cycles: number,
): SchedulePlan => {
  if (!Number.isSafeInteger(cycles) || cycles <= 0) {
    throw new RangeError(`'cycles' must be a positive safe integer, got ${cycles}`);
  }
  const seed = deriveSeed(runSeed, PHASE_SALTS[phase]);
  const cycle = createBalancedSchedule(taskNames, seed);
  const rows: (readonly string[])[] = [];
  for (let index = 0; index < cycles; index++) rows.push(...cycle.rows);
  return Object.freeze({ seed, rows: Object.freeze(rows) });
};

const getRandomSeed: RandomSeedProvider = () => {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) {
    throw new Error("Automatic measurement requires crypto.getRandomValues in this runtime.");
  }
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  const seed = values[0];
  if (seed === undefined) throw new Error("crypto.getRandomValues returned no seed.");
  return seed;
};

export {
  createBalancedIndexRows,
  createBalancedSchedule,
  createInputSeedSequence,
  createPhaseSchedule,
  deriveSeed,
  getRandomSeed,
  mixUint32,
  shuffle,
};
export type { InputSeedSequence, SchedulePlan };
