import type { Clock, KernelTaskDefinition, TimedBlock } from "../types";
import { blackhole } from "./blackhole";
import { isPromiseLike } from "./compile";
import { deriveSeed, shuffle } from "./schedule";

const MAX_KERNEL_OPERATIONS = 0x40_00_00_00;

type KernelRoundPoint = {
  iterations: number;
};

type KernelRoundPlan = {
  seed: number;
  points: readonly KernelRoundPoint[];
};

const createKernelLadder = (baseCount: number): readonly number[] => {
  if (!Number.isSafeInteger(baseCount) || baseCount <= 0 || baseCount > MAX_KERNEL_OPERATIONS / 4) {
    throw new RangeError(
      `Kernel base count must be a positive safe integer no larger than ${MAX_KERNEL_OPERATIONS / 4}.`,
    );
  }
  const counts = [
    Math.ceil(baseCount / 4),
    Math.ceil(baseCount / 2),
    baseCount,
    baseCount * 2,
    baseCount * 4,
  ];
  const unique = [...new Set(counts)];
  if (unique.length < 4) throw new Error("A kernel ladder requires at least four distinct operation counts.");
  if (unique.some((count) => count > MAX_KERNEL_OPERATIONS || !Number.isSafeInteger(count))) {
    throw new RangeError(`Kernel ladder counts must not exceed ${MAX_KERNEL_OPERATIONS}.`);
  }
  return Object.freeze(unique);
};

const createKernelRoundPlan = (
  baseCount: number,
  runSeed: number,
  taskIndex: number,
  round: number,
): KernelRoundPlan => {
  const ladder = createKernelLadder(baseCount);
  const roundSeed = deriveSeed(runSeed, taskIndex, round, 0x4B_45_52_4E);
  const points = ladder.map((iterations) => ({ iterations }));
  return Object.freeze({
    seed: roundSeed,
    points: Object.freeze(
      shuffle(points, deriveSeed(roundSeed, 0x4F_52_44_52)).map((point) => Object.freeze(point)),
    ),
  });
};

const stableResultText = (value: unknown, seen: Set<object>): string | null => {
  if (value === null) return "null";
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number") return Number.isFinite(value) ? `number:${value}` : null;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (value === undefined) return "undefined";
  if (typeof value === "symbol" || typeof value === "function") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  try {
    const tag = Object.prototype.toString.call(value);
    if (Array.isArray(value)) {
      const items = value.map((item) => stableResultText(item, seen));
      return items.includes(null) ? null : `array:[${items.join(",")}]`;
    }
    if (tag === "[object Date]") {
      const timestamp = Date.prototype.getTime.call(value);
      return Number.isFinite(timestamp) ? `date:${timestamp}` : null;
    }
    if (tag === "[object RegExp]") {
      return `regexp:${RegExp.prototype.toString.call(value)}`;
    }
    if (tag === "[object Map]") {
      const entries: string[] = [];
      for (const [key, item] of Map.prototype.entries.call(value) as IterableIterator<[unknown, unknown]>) {
        const keyText = stableResultText(key, seen);
        const itemText = stableResultText(item, seen);
        if (keyText === null || itemText === null) return null;
        entries.push(`${keyText}=>${itemText}`);
      }
      return `map:{${entries.sort().join(",")}}`;
    }
    if (tag === "[object Set]") {
      const items: string[] = [];
      for (const item of Set.prototype.values.call(value) as IterableIterator<unknown>) {
        const itemText = stableResultText(item, seen);
        if (itemText === null) return null;
        items.push(itemText);
      }
      return `set:{${items.sort().join(",")}}`;
    }
    if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") {
      const bytes = new Uint8Array(value as ArrayBufferLike);
      return `${tag}:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return `${tag}:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    }
    const entries: string[] = [];
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) return null;
    for (const key of (keys as string[]).sort()) {
      const item = stableResultText((value as Record<string, unknown>)[key], seen);
      if (item === null) return null;
      entries.push(`${JSON.stringify(key)}:${item}`);
    }
    return `object:{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
};

const hashText = (text: string) => {
  let hash = 0x81_1C_9D_C5;
  for (const codeUnit of text) {
    if (codeUnit !== undefined) hash ^= codeUnit.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return `hash:${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

type ResultHasher = (value: unknown) => string | null;

const hashResult: ResultHasher = (value) => {
  const text = stableResultText(value, new Set());
  return text === null ? null : hashText(text);
};

const runKernelInvocation = (
  task: KernelTaskDefinition,
  iterationCount: number,
  clock: Clock,
): TimedBlock => {
  const startedAtMs = clock.now();
  const result = task.run({ iterationCount });
  const elapsedMs = clock.now() - startedAtMs;
  if (isPromiseLike(result)) {
    throw new TypeError("Kernel mode is synchronous-only and must not return a Promise-like value.");
  }
  blackhole(result);
  return { startedAtMs, elapsedMs, operations: iterationCount, resultHash: hashResult(result) };
};

export {
  createKernelLadder,
  createKernelRoundPlan,
  hashResult,
  MAX_KERNEL_OPERATIONS,
  runKernelInvocation,
};
export type { KernelRoundPlan, KernelRoundPoint };
