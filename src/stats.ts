import {
  sum as simpleStatisticsSum,
  mean as simpleStatisticsMean,
  median as simpleStatisticsMedian,
  standardDeviation as simpleStatisticsStandardDeviation,
} from "simple-statistics";

// https://en.wikipedia.org/wiki/Interquartile_range
const filterOutliers = (data: number[]) => {
  const q1 = data[Math.floor(data.length / 4)];
  const q3 = data[Math.floor((3 * data.length) / 4)];
  const iqr = q3 - q1;
  const lowerLimit = q1 - 1.5 * iqr;
  const upperLimit = q3 + 1.5 * iqr;
  return data.filter((item) => item >= lowerLimit && item <= upperLimit);
};

const getMarginPercentage = (data: number[], mean: number) => {
  const standardDeviation = simpleStatisticsStandardDeviation(data);
  return (standardDeviation / mean) * 100;
};

export const computeTaskStats = (timings: Float64Array, batchSizes: Uint32Array) => {
  if (timings.length !== batchSizes.length) throw new Error("timings and batchSizes must have the same length");

  const totalBatches = timings.length;
  const totalSamples = simpleStatisticsSum(Array.from(batchSizes));
  const totalTime = simpleStatisticsSum(Array.from(timings));

  let data = Array.from(timings).map((timing, index) => timing / batchSizes[index]);
  data.sort((a, b) => a - b); // batchSizes cannot be used below this point
  data = filterOutliers(data);

  const min = data[0];
  const max = data[data.length - 1];
  const mean = simpleStatisticsMean(data);
  const median = simpleStatisticsMedian(data);

  const percentile50 = data[Math.floor(data.length / 2)];
  const percentile90 = data[Math.floor((9 * data.length) / 10)];
  const percentile95 = data[Math.floor((19 * data.length) / 20)];

  const opsPerSecond = data.map((item) => 1000 / item);
  const minOpsPerSecond = Math.min(...opsPerSecond);
  const maxOpsPerSecond = Math.max(...opsPerSecond);
  const averageOpsPerSecond = simpleStatisticsSum(opsPerSecond) / opsPerSecond.length;

  const marginOpsPerSecond = getMarginPercentage(opsPerSecond, averageOpsPerSecond);

  return {
    samples: totalSamples,
    batches: totalBatches,
    time: {
      total: totalTime,
      min,
      max,
      average: mean,
      median,
      percentile50,
      percentile90,
      percentile95,
    },
    opsPerSecond: {
      min: minOpsPerSecond,
      max: maxOpsPerSecond,
      average: averageOpsPerSecond,
      margin: marginOpsPerSecond,
    },
  };
};
