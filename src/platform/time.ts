import type { Clock, ClockMethod } from "../types";
import { global } from "./global";

const createRelativeClock = (provider: Clock["provider"], read: () => number): Clock => {
  const origin = read();
  return { provider, now: () => read() - origin };
};

const getClock = (method: ClockMethod): Clock => {
  const hrtimeBigint = global.process?.hrtime?.bigint;
  if (method === "hrtime" && !hrtimeBigint) throw new Error("'hrtime' is unavailable in this runtime.");

  if (hrtimeBigint && method !== "performance.now") {
    const origin = hrtimeBigint();
    return { provider: "hrtime", now: () => Number(hrtimeBigint() - origin) / 1e6 };
  }

  const performanceNow = globalThis.performance?.now.bind(globalThis.performance);
  if (!performanceNow) throw new Error("'performance.now' is unavailable in this runtime.");
  return createRelativeClock("performance.now", performanceNow);
};

export { getClock };
