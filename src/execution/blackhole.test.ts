import { describe, expect, test } from "bun:test";
import { blackhole } from "./blackhole";

const blackholeGlobal = globalThis as { __benchmateBlackhole?: unknown } & typeof globalThis;

describe("blackhole", () => {
  test("stores the consumed value where the engine must keep it observable", () => {
    blackhole(42);
    expect(blackholeGlobal.__benchmateBlackhole).toBe(42);
    blackhole("next");
    expect(blackholeGlobal.__benchmateBlackhole).toBe("next");
  });

  test("accepts any value and returns nothing", () => {
    expect(blackhole(undefined)).toBeUndefined();
    expect(blackhole(null)).toBeUndefined();
    expect(blackhole({ nested: [1, 2, 3] })).toBeUndefined();
  });
});
