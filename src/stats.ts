export const msToNs = (ms: number) => Number((ms * 1e6).toPrecision(2));

export const computeTaskStats = (timings: Float64Array, batchSizes: Uint32Array) => {
  const data = Array.from(timings, (timing, index) => ({ timing, batchSize: batchSizes[index] }));
  data.sort((a, b) => a.timing - b.timing);

  const min = data[0].timing / data[0].batchSize;
  const max = data[data.length - 1].timing / data[data.length - 1].batchSize;

  // filter outliers -- TODO: is this ok to use?
  // https://en.wikipedia.org/wiki/Interquartile_range
  const q1 = data[Math.floor(data.length / 4)].timing;
  const q3 = data[Math.floor((3 * data.length) / 4)].timing;
  const iqr = q3 - q1;
  const lowerLimit = q1 - 1.5 * iqr;
  const upperLimit = q3 + 1.5 * iqr;
  const filteredData = data.filter((item) => item.timing >= lowerLimit && item.timing <= upperLimit);

  const sum = filteredData.reduce((acc, item) => acc + item.timing, 0);
  const average = sum / filteredData.length;
  const averageBatchSize = filteredData.reduce((acc, item) => acc + item.batchSize, 0) / filteredData.length;

  const opsPerSecond = filteredData.map((item) => (1000 / item.timing) * item.batchSize);
  const minOpsPerSecond = Math.min(...opsPerSecond);
  const maxOpsPerSecond = Math.max(...opsPerSecond);
  const averageOpsPerSecond = opsPerSecond.reduce((a, b) => a + b, 0) / opsPerSecond.length;

  const samples = data.reduce((acc, item) => acc + item.batchSize, 0);
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
        ns: msToNs(average / averageBatchSize),
      },
    },
    opsPerSecond: {
      min: minOpsPerSecond,
      max: maxOpsPerSecond,
      average: averageOpsPerSecond,
    },
  };
};
