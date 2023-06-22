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
    cyan(formatMS(result.stats.time.total))
  );
  console.log(
    "  ops/sec:",
    yellow(formatIterations(result.stats.opsPerSecond.average)),
    magenta(`±${result.stats.opsPerSecond.margin.toFixed(2)}%`)
  );
  console.log(
    "  avg:",
    cyan(formatMS(result.stats.time.average)),
    "min:",
    cyan(formatMS(result.stats.time.min)),
    "max:",
    cyan(formatMS(result.stats.time.max))
  );
  console.log(
    "  p50:",
    cyan(formatMS(result.stats.time.percentile50)),
    "p90:",
    cyan(formatMS(result.stats.time.percentile90)),
    "p95:",
    cyan(formatMS(result.stats.time.percentile95))
  );
  console.log("");
};

export const printResults = (results: BenchmarkResult[]) => {
  results.sort((a, b) => b.stats.opsPerSecond.average - a.stats.opsPerSecond.average);

  // stats table
  const table = results.reduce((acc, result) => {
    acc[result.name] = {
      Summary: {
        raw: result.name,
        formatted: bold(blue(result.name)),
      },
      "ops/sec": {
        raw: formatIterations(result.stats.opsPerSecond.average),
        formatted: yellow(formatIterations(result.stats.opsPerSecond.average)),
      },
      margin: {
        raw: `±${result.stats.opsPerSecond.margin.toFixed(2)}%`,
        formatted: magenta(`±${result.stats.opsPerSecond.margin.toFixed(2)}%`),
      },
      avg: {
        raw: formatMS(result.stats.time.average),
        formatted: cyan(formatMS(result.stats.time.average)),
      },
      min: {
        raw: formatMS(result.stats.time.min),
        formatted: cyan(formatMS(result.stats.time.min)),
      },
      max: {
        raw: formatMS(result.stats.time.max),
        formatted: cyan(formatMS(result.stats.time.max)),
      },
      p50: {
        raw: formatMS(result.stats.time.percentile50),
        formatted: cyan(formatMS(result.stats.time.percentile50)),
      },
      p90: {
        raw: formatMS(result.stats.time.percentile90),
        formatted: cyan(formatMS(result.stats.time.percentile90)),
      },
      p95: {
        raw: formatMS(result.stats.time.percentile95),
        formatted: cyan(formatMS(result.stats.time.percentile95)),
      },
      samples: {
        raw: formatIterations(result.stats.samples),
        formatted: yellow(formatIterations(result.stats.samples)),
      },
      time: {
        raw: formatMS(result.stats.time.total),
        formatted: cyan(formatMS(result.stats.time.total)),
      },
    };
    return acc;
  }, {} as Record<string, Record<string, { raw: string; formatted: string }>>);

  // columns and header
  const columns = Object.keys(table).reduce((acc, name) => {
    for (const [key, value] of Object.entries(table[name])) {
      if (acc[key] === undefined) acc[key] = key.length;
      acc[key] = Math.max(acc[key], value.raw.length);
    }
    return acc;
  }, {} as Record<string, number>);
  let headerLength = 0;
  const header = Object.keys(columns)
    .map((key, index) => {
      headerLength += columns[key] + 2;
      if (index === 0) return key.padEnd(columns[key] + 2);
      return key.padStart(columns[key] + 2);
    })
    .join("");

  // comparisons
  const baseline = results[0].stats.opsPerSecond.average;
  const comparisons: [string, number][] = [];
  for (let i = 1; i < results.length; i++) {
    const ratio = (baseline / results[i].stats.opsPerSecond.average).toFixed(2);
    comparisons.push([results[i].name, Number(ratio)]);
  }

  // print header
  console.log(gray("-".repeat(headerLength)));
  console.log(header);
  console.log(gray("-".repeat(headerLength)));

  // print metrics table
  for (const name of Object.keys(table)) {
    const row = Object.keys(columns)
      .map((key, index) => {
        const item = table[name][key];
        const padDifference = columns[key] - item.raw.length + 2;
        const padding = " ".repeat(padDifference);
        if (index === 0) return item.formatted + padding;
        return padding + item.formatted;
      })
      .join("");
    console.log(row);
  }
  console.log(gray("-".repeat(headerLength)));
  console.log("");

  // print comparisons
  console.log(
    `Fastest is ${bold(blue(results[0].name))} with`,
    yellow(formatIterations(baseline)),
    magenta(`±${results[0].stats.opsPerSecond.margin.toFixed(2)}%`),
    "ops/sec"
  );
  for (const [name, ratio] of comparisons) {
    console.log(`  ${green(ratio)}${gray("x")} faster than ${blue(name)}`);
  }
};
