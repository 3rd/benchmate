import type { BenchmarkResult } from ".";

export const printResult = (result: BenchmarkResult) => {
  console.table({
    [result.name]: {
      "ops/sec": Math.round(result.stats.opsPerSecond.average),
      "avg (ns)": result.stats.time.average.ns,
      "min (ns)": result.stats.time.min.ns,
      "max (ns)": result.stats.time.max.ns,
      "p50 (ns)": result.stats.time.percentile50.ns,
      "p90 (ns)": result.stats.time.percentile90.ns,
      "p95 (ns)": result.stats.time.percentile95.ns,
      grouping: `samples: ${result.stats.samples} batches: ${result.stats.batches}`,
    },
  });
};

export const printResults = (results: BenchmarkResult[]) => {
  const table = results.reduce((acc, result) => {
    acc[result.name] = {
      "ops/sec": Math.round(result.stats.opsPerSecond.average),
      "avg (ns)": result.stats.time.average.ns,
      "min .. max (ns)": `${result.stats.time.min.ns} .. ${result.stats.time.max.ns}`,
      "p50 (ns)": result.stats.time.percentile50.ns,
      "p90 (ns)": result.stats.time.percentile90.ns,
      "p95 (ns)": result.stats.time.percentile95.ns,
      grouping: `samples: ${result.stats.samples} batches: ${result.stats.batches}`,
    };

    return acc;
  }, {} as Record<string, Record<string, string | number>>);
  console.table(table);
};
