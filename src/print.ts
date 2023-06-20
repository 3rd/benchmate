import type { BenchmarkResult } from ".";

const formatMS = (ms: number, decimals = 4): string => {
  const ns = ms * 1_000_000;
  if (ns < 1000) return `${ns.toFixed(decimals)}ns`;
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(decimals)}µs`;
  if (ms < 1_000) return `${ms.toFixed(decimals)}ms`;
  return `${(ms / 1000).toFixed(decimals)}s`;
};

export const printResult = (result: BenchmarkResult) => {
  console.log(`[${result.name}] completed`, result.stats.samples, "iterations in", formatMS(result.stats.time.total));
  console.log("  ops/sec:", Math.floor(result.stats.opsPerSecond.average));
  console.log(
    "  avg:",
    formatMS(result.stats.time.average),
    "min:",
    formatMS(result.stats.time.min),
    "max:",
    formatMS(result.stats.time.max)
  );
  console.log(
    "  p50:",
    formatMS(result.stats.time.percentile50),
    "p90:",
    formatMS(result.stats.time.percentile90),
    "p95:",
    formatMS(result.stats.time.percentile95)
  );
  console.log("");
};

export const printResults = (results: BenchmarkResult[]) => {
  results.sort((a, b) => b.stats.opsPerSecond.average - a.stats.opsPerSecond.average);
  const table = results.reduce((acc, result) => {
    acc[result.name] = {
      "ops/sec": Math.round(result.stats.opsPerSecond.average),
      avg: formatMS(result.stats.time.average),
      min: formatMS(result.stats.time.min),
      max: formatMS(result.stats.time.max),
      p50: formatMS(result.stats.time.percentile50),
      p90: formatMS(result.stats.time.percentile90),
      p95: formatMS(result.stats.time.percentile95),
      samples: result.stats.samples,
      time: formatMS(result.stats.time.total),
    };

    return acc;
  }, {} as Record<string, Record<string, string | number>>);
  console.table(table);
};
