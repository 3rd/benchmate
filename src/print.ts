import type { BenchmarkResult } from ".";
import { global } from "./global";

// https://no-color.org/
const noColor = Boolean(global.process?.env?.NO_COLOR);

const createDecorator = (ansiCode: string) => (text: string | number) => {
  return `\x1b[${ansiCode}m${text}\x1b[0m`;
};
const colorize = (colorCode: string) => (text: string | number) => {
  return noColor ? text.toString() : `\x1b[${colorCode}m${text}\x1b[0m`;
};

const bold = createDecorator("1");
const underline = colorize("4");

const black = colorize("30");
const red = colorize("31");
const green = colorize("32");
const yellow = colorize("33");
const blue = colorize("34");
const magenta = colorize("35");
const cyan = colorize("36");
const white = colorize("37");
const gray = colorize("90");

const formatMS = (ms: number, decimalPlaces = 2): string => {
  const ns = ms * 1_000_000;
  if (ns < 1000) return `${ns.toFixed(decimalPlaces)}ns`;
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(decimalPlaces)}µs`;
  if (ms < 1_000) return `${ms.toFixed(decimalPlaces)}ms`;
  return `${(ms / 1000).toFixed(decimalPlaces)}s`;
};

const formatIterations = (opsPerSecond: number): string => {
  let value = Math.floor(opsPerSecond);
  const parts = [];
  while (value > 0) {
    parts.unshift(value % 1000);
    value = Math.floor(value / 1000);
  }
  return parts.map((part, index) => (index === 0 ? part : part.toString().padStart(3, "0"))).join(",");
};

export const printResult = (result: BenchmarkResult) => {
  console.log(
    bold(blue(result.name)),
    `completed`,
    yellow(formatIterations(result.stats.samples)),
    "iterations in",
    yellow(formatMS(result.stats.time.total))
  );
  console.log(
    "  ops/sec:",
    cyan(formatIterations(result.stats.opsPerSecond.average)),
    yellow(`±${result.stats.opsPerSecond.margin.toFixed(2)}%`)
  );
  console.log(
    "  avg:",
    yellow(formatMS(result.stats.time.average)),
    "min:",
    yellow(formatMS(result.stats.time.min)),
    "max:",
    yellow(formatMS(result.stats.time.max))
  );
  console.log(
    "  p50:",
    yellow(formatMS(result.stats.time.percentile50)),
    "p90:",
    yellow(formatMS(result.stats.time.percentile90)),
    "p95:",
    yellow(formatMS(result.stats.time.percentile95))
  );
  console.log("");
};

export const printResults = (results: BenchmarkResult[]) => {
  results.sort((a, b) => b.stats.opsPerSecond.average - a.stats.opsPerSecond.average);

  // stats table
  const table = results.reduce((acc, result) => {
    acc[result.name] = {
      "ops/sec": result.stats.opsPerSecond.average,
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
    `Fastest is ${bold(cyan(results[0].name))} with`,
    cyan(formatIterations(baseline)),
    yellow(`±${results[0].stats.opsPerSecond.margin.toFixed(2)}%`),
    "ops/sec"
  );
  for (const [name, ratio] of comparisons) {
    console.log(`  ${green(ratio)}x faster than ${blue(name)}`);
  }
};
