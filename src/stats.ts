export const msToNs = (ms: number) => Number((ms * 1e6).toPrecision(8));

export const computeTaskStats = (timings: Float64Array, batchSizes: Uint32Array) => {
  const data = Array.from(timings).map((timing, index) => timing / batchSizes[index]);
  data.sort((a, b) => a - b);
  batchSizes.sort((a, b) => data[a] - data[b]);

  // filter outliers -- TODO: is this ok to use?
  // https://en.wikipedia.org/wiki/Interquartile_range
  const q1 = data[Math.floor(data.length / 4)];
  const q3 = data[Math.floor((3 * data.length) / 4)];
  const iqr = q3 - q1;
  const lowerLimit = q1 - 1.5 * iqr;
  const upperLimit = q3 + 1.5 * iqr;
  const filteredData = data.filter((timing) => timing >= lowerLimit && timing <= upperLimit);

  const min = filteredData[0];
  const max = filteredData[filteredData.length - 1];
  const sum = filteredData.reduce((acc, item) => acc + item, 0);
  const average = sum / filteredData.length;

  const percentile50 = filteredData[Math.floor(filteredData.length / 2)];
  const percentile90 = filteredData[Math.floor((9 * filteredData.length) / 10)];
  const percentile95 = filteredData[Math.floor((19 * filteredData.length) / 20)];

  const opsPerSecond = filteredData.map((item) => 1000 / item);
  const minOpsPerSecond = Math.min(...opsPerSecond);
  const maxOpsPerSecond = Math.max(...opsPerSecond);
  const averageOpsPerSecond = opsPerSecond.reduce((a, b) => a + b, 0) / opsPerSecond.length;

  const samples = batchSizes.reduce((acc, item) => acc + item, 0);
  const batches = data.length;

  return {
    samples,
    batches,
    time: {
      min: {
        ms: min,
        ns: msToNs(min),
      },
      max: {
        ms: max,
        ns: msToNs(max),
      },
      average: {
        ms: average,
        ns: msToNs(average),
      },
      percentile50: {
        ms: percentile50,
        ns: msToNs(percentile50),
      },
      percentile90: {
        ms: percentile90,
        ns: msToNs(percentile90),
      },
      percentile95: {
        ms: percentile95,
        ns: msToNs(percentile95),
      },
    },
    opsPerSecond: {
      min: minOpsPerSecond,
      max: maxOpsPerSecond,
      average: averageOpsPerSecond,
    },
  };
};
