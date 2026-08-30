import type { IntervalEvidence } from "../types";

const T_CRITICAL_95 = [
  12.706_204_736, 4.302_652_73, 3.182_446_305, 2.776_445_105, 2.570_581_836, 2.446_911_851, 2.364_624_252,
  2.306_004_135, 2.262_157_163, 2.228_138_852, 2.200_985_16, 2.178_812_83, 2.160_368_656, 2.144_786_688,
  2.131_449_546, 2.119_905_299, 2.109_815_578, 2.100_922_04, 2.093_024_054, 2.085_963_447, 2.079_613_845,
  2.073_873_068, 2.068_657_61, 2.063_898_562, 2.059_538_553, 2.055_529_439, 2.051_830_516, 2.048_407_142,
  2.045_229_642, 2.042_272_456,
] as const;

type VarianceEstimate = {
  blockSize: number;
  groupCount: number;
  longRunVariance: number;
};

type DependencePlan = {
  superblockSize: number;
  estimates: readonly VarianceEstimate[];
};

type ScalarInterval = {
  mean: number;
  lower: number;
  upper: number;
  halfWidth: number;
};

type StabilityAssessment = {
  stable: boolean;
  relativeMedianChange: number;
  relativeSlopeChange: number;
  quantized: boolean;
};

type IntervalEvidenceInput = {
  interval: ScalarInterval;
  method: IntervalEvidence["method"];
  coverage: IntervalEvidence["coverage"];
  physicalCount: number;
  effectiveCount: number;
  assumptions: readonly string[];
};

type EffectiveCountPlanner = (
  pilotMean: number,
  pilotStandardDeviation: number,
  targetRelativeHalfWidth: number,
  minimumCount: number,
) => number | null;
type NumericSeriesStatistic = (values: readonly number[]) => number;
type StudentTCriticalValue = (degreesOfFreedom: number) => number;

const sum = (values: readonly number[]) => {
  let total = 0;
  for (const value of values) total += value;
  return total;
};

const mean: NumericSeriesStatistic = (values) => (values.length === 0 ? 0 : sum(values) / values.length);

const median: NumericSeriesStatistic = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  if (lower === undefined) return upper;
  return (lower + upper) / 2;
};

const sampleVariance: NumericSeriesStatistic = (values) => {
  if (values.length < 2) return 0;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const scale = Math.max(Math.abs(minimum), Math.abs(maximum));
  if (scale > 0 && (maximum - minimum) / scale <= 1e-12) return 0;
  const average = mean(values);
  return sum(values.map((value) => (value - average) ** 2)) / (values.length - 1);
};

const lagOneCorrelation: NumericSeriesStatistic = (values) => {
  if (values.length < 3) return 0;
  const average = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === undefined) continue;
    const centered = value - average;
    denominator += centered * centered;
    const next = values[index + 1];
    if (next !== undefined) numerator += centered * (next - average);
  }
  if (denominator === 0) return 0;
  return Math.max(-0.999, Math.min(0.999, numerator / denominator));
};

const correlationBlockFloor = (values: readonly number[]) => {
  const correlation = Math.max(0, lagOneCorrelation(values));
  if (correlation <= 0.1) return 1;
  const conservativeCorrelation = Math.min(0.9, correlation + 2 / Math.sqrt(values.length));
  const correlationSpan = 8 * ((1 + conservativeCorrelation) / (1 - conservativeCorrelation));
  let blockSize = 1;
  while (blockSize < correlationSpan && blockSize < 128) blockSize *= 2;
  return blockSize;
};

const studentTCritical95: StudentTCriticalValue = (degreesOfFreedom) => {
  if (!Number.isSafeInteger(degreesOfFreedom) || degreesOfFreedom <= 0) {
    throw new RangeError(`'degreesOfFreedom' must be a positive safe integer, got ${degreesOfFreedom}`);
  }
  const tabulated = T_CRITICAL_95[degreesOfFreedom - 1];
  if (tabulated !== undefined) return tabulated;

  const z = 1.959_963_984_540_054;
  const inverseDf = 1 / degreesOfFreedom;
  const z2 = z * z;
  const z3 = z2 * z;
  const z5 = z3 * z2;
  const z7 = z5 * z2;
  const z9 = z7 * z2;
  return (
    z +
    ((z3 + z) / 4) * inverseDf +
    ((5 * z5 + 16 * z3 + 3 * z) / 96) * inverseDf ** 2 +
    ((3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / 384) * inverseDf ** 3 +
    ((79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / 92_160) * inverseDf ** 4
  );
};

const groupMeans = (values: readonly number[], blockSize: number): readonly number[] => {
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) {
    throw new RangeError(`'blockSize' must be a positive safe integer, got ${blockSize}`);
  }
  if (values.length % blockSize !== 0) {
    throw new Error(`Cannot form complete groups of ${blockSize} from ${values.length} values.`);
  }
  const groups: number[] = [];
  for (let index = 0; index < values.length; index += blockSize) {
    let total = 0;
    for (let offset = 0; offset < blockSize; offset++) {
      const value = values[index + offset];
      if (value !== undefined) total += value;
    }
    groups.push(total / blockSize);
  }
  return Object.freeze(groups);
};

const findDependencePlan = (values: readonly number[], plateauTolerance = 0.1): DependencePlan | null => {
  const estimates: VarianceEstimate[] = [];
  for (let blockSize = 1; Math.floor(values.length / blockSize) >= 8; blockSize *= 2) {
    if (values.length % blockSize !== 0) continue;
    const groups = groupMeans(values, blockSize);
    estimates.push({
      blockSize,
      groupCount: groups.length,
      longRunVariance: blockSize * sampleVariance(groups),
    });
  }

  for (let index = 1; index < estimates.length; index++) {
    const previous = estimates[index - 1];
    const current = estimates[index];
    if (!previous || !current) continue;
    const scale = Math.max(previous.longRunVariance, current.longRunVariance);
    const relativeDifference =
      scale === 0 ? 0 : Math.abs(previous.longRunVariance - current.longRunVariance) / scale;
    if (relativeDifference <= plateauTolerance) {
      const confirmation = estimates[index + 1];
      if (!confirmation) return null;
      const selectedBlockSize = Math.max(confirmation.blockSize, correlationBlockFloor(values));
      if (!estimates.some((estimate) => estimate.blockSize === selectedBlockSize)) return null;
      return Object.freeze({
        superblockSize: selectedBlockSize,
        estimates: Object.freeze(estimates.map((estimate) => Object.freeze({ ...estimate }))),
      });
    }
  }
  return null;
};

const planEffectiveCount: EffectiveCountPlanner = (
  pilotMean,
  pilotStandardDeviation,
  targetRelativeHalfWidth,
  minimumCount,
) => {
  if (!Number.isFinite(pilotMean) || !Number.isFinite(pilotStandardDeviation) || pilotStandardDeviation < 0) {
    return null;
  }
  if (pilotMean === 0) return null;
  for (let count = minimumCount; count <= 1_000_000; count++) {
    const halfWidth = (studentTCritical95(count - 1) * pilotStandardDeviation) / Math.sqrt(count);
    if (halfWidth <= targetRelativeHalfWidth * Math.abs(pilotMean)) return count;
  }
  return null;
};

const studentTInterval = (values: readonly number[]): ScalarInterval | null => {
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return null;
  const average = mean(values);
  const halfWidth =
    (studentTCritical95(values.length - 1) * Math.sqrt(sampleVariance(values))) / Math.sqrt(values.length);
  return { mean: average, lower: average - halfWidth, upper: average + halfWidth, halfWidth };
};

const theilSenRelativeChange: NumericSeriesStatistic = (values) => {
  if (values.length < 2 || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return Number.POSITIVE_INFINITY;
  }
  const logs = values.map(Math.log);
  const slopes: number[] = [];
  for (let start = 0; start < logs.length - 1; start++) {
    const startValue = logs[start];
    if (startValue === undefined) continue;
    for (let end = start + 1; end < logs.length; end++) {
      const endValue = logs[end];
      if (endValue !== undefined) slopes.push((endValue - startValue) / (end - start));
    }
  }
  return Math.abs(Math.exp(median(slopes) * (values.length - 1)) - 1);
};

const assessStability = (values: readonly number[], tolerance: number): StabilityAssessment => {
  if (values.length < 2) {
    return {
      stable: false,
      relativeMedianChange: Number.POSITIVE_INFINITY,
      relativeSlopeChange: Number.POSITIVE_INFINITY,
      quantized: true,
    };
  }
  const midpoint = Math.floor(values.length / 2);
  const firstMedian = median(values.slice(0, midpoint));
  const secondMedian = median(values.slice(midpoint));
  const scale = Math.max(Math.abs(firstMedian), Math.abs(secondMedian));
  const relativeMedianChange =
    scale === 0 ? Number.POSITIVE_INFINITY : Math.abs(firstMedian - secondMedian) / scale;
  const relativeSlopeChange = theilSenRelativeChange(values);
  const quantized = values.some((value) => value <= 0 || !Number.isFinite(value));
  return {
    stable: !quantized && relativeMedianChange <= tolerance && relativeSlopeChange <= tolerance,
    relativeMedianChange,
    relativeSlopeChange,
    quantized,
  };
};

const createIntervalEvidence = (input: IntervalEvidenceInput): IntervalEvidence => ({
  confidenceLevelX: 0.95,
  lower: input.interval.lower,
  upper: input.interval.upper,
  method: input.method,
  coverage: input.coverage,
  physicalCount: input.physicalCount,
  effectiveCount: input.effectiveCount,
  assumptions: Object.freeze([...input.assumptions]),
});

export {
  assessStability,
  createIntervalEvidence,
  findDependencePlan,
  groupMeans,
  lagOneCorrelation,
  mean,
  median,
  planEffectiveCount,
  sampleVariance,
  studentTCritical95,
  studentTInterval,
  theilSenRelativeChange,
};
export type { DependencePlan, IntervalEvidenceInput, ScalarInterval, StabilityAssessment, VarianceEstimate };
