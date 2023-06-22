// TODO: is this needed? is this correct?
// https://en.wikipedia.org/wiki/Interquartile_range
const filterOutliers = (data: number[]) => {
  const q1 = data[Math.floor(data.length / 4)];
  const q3 = data[Math.floor((3 * data.length) / 4)];
  const iqr = q3 - q1;
  const lowerLimit = q1 - 1.5 * iqr;
  const upperLimit = q3 + 1.5 * iqr;
  return data.filter((item) => item >= lowerLimit && item <= upperLimit);
};

const getVariance = (data: number[], average: number) => {
  const squaredDiffs = data.map((item) => Math.pow(item - average, 2));
  return squaredDiffs.reduce((a, b) => a + b, 0) / squaredDiffs.length;
};

const getMarginPercentage = (data: number[], average: number) => {
  const varValue = getVariance(data, average);
  const stdDev = Math.sqrt(varValue);
  return (stdDev / average) * 100;
};

export const computeTaskStats = (timings: Float64Array, batchSizes: Uint32Array) => {
  if (timings.length !== batchSizes.length) throw new Error("timings and batchSizes must have the same length");

  const batches = timings.length;
  const samples = batchSizes.reduce((acc, item) => acc + item, 0);
  const time = timings.reduce((acc, item) => acc + item, 0);

  let data = Array.from(timings).map((timing, index) => timing / batchSizes[index]);
  data.sort((a, b) => a - b); // batchSizes cannot be used below this point
  data = filterOutliers(data);

  const min = data[0];
  const max = data[data.length - 1];
  const sum = data.reduce((acc, item) => acc + item, 0);
  const average = sum / data.length;

  const percentile50 = data[Math.floor(data.length / 2)];
  const percentile90 = data[Math.floor((9 * data.length) / 10)];
  const percentile95 = data[Math.floor((19 * data.length) / 20)];

  const opsPerSecond = data.map((item) => 1000 / item);
  const minOpsPerSecond = Math.min(...opsPerSecond);
  const maxOpsPerSecond = Math.max(...opsPerSecond);
  const averageOpsPerSecond = opsPerSecond.reduce((a, b) => a + b, 0) / opsPerSecond.length;

  const marginOpsPerSecond = getMarginPercentage(opsPerSecond, averageOpsPerSecond);

  return {
    samples: samples,
    batches: batches,
    time: {
      total: time,
      min,
      max,
      average,
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
