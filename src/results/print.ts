import type { BenchmarkResult, ClockProfile, IntervalEvidence } from "../types";
import { global } from "../platform/global";
import { areResultsComparable, getPairedComparison } from "./finalize";

type IntervalFormatter = (
  interval: IntervalEvidence | null,
  taskType: BenchmarkResult["evidence"]["taskType"],
) => string;
type ResultPrinter = (result: BenchmarkResult, clock: ClockProfile) => void;
type ResultsPrinter = (results: readonly BenchmarkResult[]) => void;

const noColor = Boolean(global.process?.env?.NO_COLOR);

const colorize =
  (colorCode: string) =>
  (text: number | string) => {
    return noColor ? text.toString() : `\u001b[${colorCode}m${text}\u001b[0m`;
  };

const bold = colorize("1");
const green = colorize("32");
const yellow = colorize("33");
const blue = colorize("34");
const magenta = colorize("35");
const cyan = colorize("36");
const gray = colorize("90");

const formatMS = (milliseconds: number, decimalPlaces = 2) => {
  const nanoseconds = milliseconds * 1_000_000;
  if (Math.abs(nanoseconds) < 1000) return `${nanoseconds.toFixed(decimalPlaces)}ns`;
  if (Math.abs(nanoseconds) < 1_000_000) return `${(nanoseconds / 1000).toFixed(decimalPlaces)}us`;
  if (Math.abs(milliseconds) < 1000) return `${milliseconds.toFixed(decimalPlaces)}ms`;
  return `${(milliseconds / 1000).toFixed(decimalPlaces)}s`;
};

const formatRate = (rate: number | null) => {
  if (rate === null) return "unmeasurable";
  if (!Number.isFinite(rate)) return rate.toString();
  return Math.floor(rate).toLocaleString("en-US");
};

const formatInterval: IntervalFormatter = (interval, taskType) => {
  if (interval === null) return "unavailable";
  const format = taskType === "kernel" ? formatMS : formatRate;
  const upper = interval.upper === null ? "unbounded" : format(interval.upper);
  return `[${format(interval.lower)}, ${upper}] ${interval.method}, ${interval.coverage}`;
};

const printResult: ResultPrinter = (result, clock) => {
  console.log(
    bold(blue(result.name)),
    gray(`[${result.taskType}]`),
    result.evidence.status === "complete" ? green(result.evidence.status) : yellow(result.evidence.status),
  );
  console.log(
    "  clock:",
    cyan(clock.provider),
    `min tick ${formatMS(clock.minimumPositiveTickMs)}, p99 read pair ${formatMS(clock.readPairCostMs.p99)}`,
  );
  if (result.evidence.status !== "complete") {
    const { observationPhase, modelPhase } = result.evidence.statsProvenance;
    let statisticsSource = `${observationPhase} observations`;
    if (result.taskType === "kernel") {
      statisticsSource +=
        modelPhase === null ? ", no kernel regression model" : `, ${modelPhase} kernel regression models`;
    }
    console.log("  descriptive statistics:", yellow(statisticsSource));
  }

  if (result.taskType === "kernel") {
    const range = result.metadata.kernel?.measuredOperationCountRange;
    console.log(
      "  kernel slope:",
      cyan(formatMS(result.stats.timePerOperationMs.average)),
      "per declared operation",
    );
    if (range) {
      console.log(
        "  measured range:",
        `${range[0].toLocaleString("en-US")}..${range[1].toLocaleString("en-US")}`,
      );
    }
  } else if (result.taskType === "throughput") {
    console.log("  completions/sec:", yellow(formatRate(result.stats.completionsPerSecond.average)));
    console.log("  block makespan average:", cyan(formatMS(result.stats.blockDurationMs.average)));
  } else {
    console.log("  ops/sec:", yellow(formatRate(result.stats.operationsPerSecond.average)));
    console.log("  raw average:", cyan(formatMS(result.stats.timePerOperationMs.average)));
  }

  console.log("  95% interval:", magenta(formatInterval(result.evidence.interval, result.taskType)));
  if (result.taskType === "call" && result.stats.harnessOverhead.sampleCount > 0) {
    console.log(
      "  harness floor model:",
      cyan(formatMS(result.stats.harnessOverhead.perInvocationMs)),
      "per invocation",
    );
    console.log(
      "  modeled body remainder:",
      cyan(formatMS(result.stats.harnessOverhead.modeledRemainderMs.average)),
    );
  }
  for (const reason of result.evidence.reasons) console.log("  reason:", reason);
  console.log("");
};

const primaryValue = (result: BenchmarkResult) => {
  if (result.taskType === "kernel") {
    const value = result.stats.timePerOperationMs.average;
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const value =
    result.taskType === "throughput" ?
      result.stats.completionsPerSecond.average
    : result.stats.operationsPerSecond.average;
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
};

const printResults: ResultsPrinter = (results) => {
  if (results.length === 0) return;
  console.log(gray("-".repeat(88)));
  console.log("Summary".padEnd(28), "type".padEnd(14), "status".padEnd(24), "primary".padStart(18));
  console.log(gray("-".repeat(88)));
  for (const result of results) {
    const value = primaryValue(result);
    let primary = "unmeasurable";
    if (value !== null) primary = result.taskType === "kernel" ? formatMS(value) : formatRate(value);
    console.log(
      result.name.padEnd(28),
      result.evidence.taskType.padEnd(14),
      result.evidence.status.padEnd(24),
      primary.padStart(18),
    );
  }
  console.log(gray("-".repeat(88)));

  const visited = new Set<BenchmarkResult>();
  for (const result of results) {
    if (visited.has(result)) continue;
    const group = results.filter((member) => areResultsComparable(result, member));
    for (const member of group) visited.add(member);
    if (group.length < 2) continue;
    if (group.some((member) => primaryValue(member) === null)) continue;

    const sorted = [...group].sort((left, right) => {
      const leftValue = primaryValue(left) ?? 0;
      const rightValue = primaryValue(right) ?? 0;
      return result.taskType === "kernel" ? leftValue - rightValue : rightValue - leftValue;
    });
    const fastest = sorted[0];
    if (!fastest) continue;
    console.log(`Fastest compatible ${fastest.taskType} result: ${bold(blue(fastest.name))}.`);
    for (const other of sorted.slice(1)) {
      if (fastest.evidence.schedule === "comparative") {
        const paired = getPairedComparison(fastest, other);
        if (paired) {
          const pairedInterval = paired.interval;
          const formatDifference = paired.unit === "completions-per-second" ? formatRate : formatMS;
          const intervalText =
            pairedInterval === null ? "unavailable" : (
              `[${formatDifference(pairedInterval.lower)}, ${
                pairedInterval.upper === null ? "unbounded" : formatDifference(pairedInterval.upper)
              }] ${pairedInterval.method}, ${pairedInterval.coverage}`
            );
          console.log(
            `  paired ${fastest.name}/${other.name}: ratio ${paired.averageRatioX?.toFixed(4) ?? "unavailable"}, difference ${formatDifference(
              paired.averageDifference,
            )}, ${paired.better} is better, 95% ${intervalText}`,
          );
        }
      }
    }
  }

  const complete = results.filter((result) => result.evidence.status === "complete");
  if (
    complete.length < results.length ||
    (results.length > 1 &&
      !results.some((left) => results.some((right) => left !== right && areResultsComparable(left, right))))
  ) {
    console.log("No ranking is shown for incompatible or inconclusive evidence.");
  }
};

export { formatInterval, printResult, printResults };
