import { describe, expect, test } from "bun:test";
import { global } from "./global";
import { getClock } from "./time";

describe("getClock", () => {
  test("performance.now clock is labeled and returns non-decreasing numbers", () => {
    const clock = getClock("performance.now");
    const first = clock.now();
    const second = clock.now();
    expect(clock.provider).toBe("performance.now");
    expect(typeof first).toBe("number");
    expect(second).toBeGreaterThanOrEqual(first);
  });

  test("hrtime provider measures relative to a per-provider origin", () => {
    const clock = getClock("hrtime");
    const first = clock.now();
    expect(clock.provider).toBe("hrtime");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1000);
    expect(clock.now()).toBeGreaterThanOrEqual(first);
  });

  test("auto prefers hrtime when process.hrtime exists", () => {
    const clock = getClock("auto");
    expect(clock.provider).toBe("hrtime");
    expect(clock.now()).toBeGreaterThanOrEqual(0);
    expect(clock.now()).toBeLessThan(1000);
  });

  test("explicit hrtime fails when the provider is unavailable", () => {
    const originalProcess = global.process;
    global.process = undefined;

    try {
      expect(() => getClock("hrtime")).toThrow("'hrtime' is unavailable in this runtime.");
    } finally {
      global.process = originalProcess;
    }
  });

  test("auto tolerates a process shim without hrtime", () => {
    const originalProcess = global.process;
    global.process = { env: {} } as unknown as NonNullable<typeof global.process>;

    try {
      expect(getClock("auto").now()).toBeGreaterThanOrEqual(0);
    } finally {
      global.process = originalProcess;
    }
  });
});
