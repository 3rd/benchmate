import type { BenchmarkResult } from ".";

const formatMS = (ms: number, decimalPlaces = 2): string => {
  const ns = ms * 1_000_000;
  if (ns < 1000) return `${ns.toFixed(decimalPlaces)}ns`;
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(decimalPlaces)}µs`;
  if (ms < 1_000) return `${ms.toFixed(decimalPlaces)}ms`;
  return `${(ms / 1000).toFixed(decimalPlaces)}s`;
};

export const printResult = (result: BenchmarkResult) => {
  console.log(`[${result.name}] completed`, result.stats.samples, "iterations in", formatMS(result.stats.time.total));
  console.log(
    "  ops/sec:",
    Math.floor(result.stats.opsPerSecond.average),
    `±${result.stats.opsPerSecond.margin.toFixed(2)}%`
  );
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

  // stats table
  const table = results.reduce((acc, result) => {
    acc[result.name] = {
      "ops/sec": Math.round(result.stats.opsPerSecond.average),
      margin: `±${result.stats.opsPerSecond.margin.toFixed(2)}%`,
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

  // comparisons
  const baseline = results[0].stats.opsPerSecond.average;
  const comparisons: [string, number][] = [];
  for (let i = 1; i < results.length; i++) {
    const ratio = (baseline / results[i].stats.opsPerSecond.average).toFixed(2);
    comparisons.push([results[i].name, Number(ratio)]);
  }
  console.log(
    `Fastest is ${results[0].name} with`,
    Math.round(baseline),
    "ops/sec",
    `(±${results[0].stats.opsPerSecond.margin.toFixed(2)}%)`
  );
  for (const [name, ratio] of comparisons) {
    console.log(`  ${ratio}x faster than ${name}`);
  }
};
