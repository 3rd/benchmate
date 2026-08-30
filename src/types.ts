type ClockMethod = "auto" | "hrtime" | "performance.now";

type TaskType = "call" | "end-to-end" | "kernel" | "throughput";

type MeasurementMode = "auto" | "iterations" | "time";

type MeasurementPhase =
  | "assessment"
  | "calibration"
  | "measurement"
  | "overhead"
  | "pilot"
  | "probe"
  | "warmup";

type EvidenceStatus =
  | "complete"
  | "dependence-unresolved"
  | "failed"
  | "insufficient-budget"
  | "optimization-sensitive"
  | "precision-missed"
  | "timer-limited"
  | "unidentifiable"
  | "unstable"
  | "warmup-not-converged";

type ObservationFlag =
  | "change-detected"
  | "clock-quantized"
  | "constant-result"
  | "drift-detected"
  | "nonlinear-scaling"
  | "pause-like"
  | "unhashable-result"
  | "zero-duration";

type MeasurementObservation = {
  sequence: number;
  task: string;
  phase: MeasurementPhase;
  startedAtMs: number;
  elapsedMs: number;
  operations: number;
  round: number | null;
  seed: number | null;
  resultHash: string | null;
  flags: readonly ObservationFlag[];
};

type ClockProfile = {
  provider: "hrtime" | "performance.now";
  method: ClockMethod;
  monotonic: boolean;
  sampleCount: number;
  minimumPositiveTickMs: number;
  zeroDeltaRateX: number;
  readPairCostMs: {
    p50: number;
    p99: number;
  };
};

type Clock = {
  provider: ClockProfile["provider"];
  now: () => number;
};

type IntervalEvidence = {
  confidenceLevelX: 0.95;
  lower: number;
  upper: number | null;
  method: "batch-t" | "round-slope-t" | "superblock-t";
  coverage: "nominal" | "validated-corpus-v1";
  physicalCount: number;
  effectiveCount: number;
  assumptions: readonly string[];
};

type MeasurementEvidence<Type extends TaskType = TaskType> = {
  schemaVersion: 5;
  taskType: Type;
  measurement: MeasurementMode;
  schedule: "comparative" | "isolated";
  status: EvidenceStatus;
  reasons: readonly string[];
  observations: readonly MeasurementObservation[];
  interval: IntervalEvidence | null;
};

type HarnessOverhead = {
  perInvocationMs: number;
  sampleCount: number;
  observationSequences: readonly number[];
  modeledRemainderMs: {
    total: number;
    average: number;
  };
};

type TimeSummary = {
  min: number;
  max: number;
  average: number;
  median: number;
  percentile50: number;
  percentile90: number;
  percentile95: number;
};

type RateSummary = {
  min: number | null;
  max: number | null;
  average: number | null;
};

type LatencyStats = {
  operations: number;
  blocks: number;
  elapsedMs: number;
  timePerOperationMs: TimeSummary;
  operationsPerSecond: RateSummary;
};

type CallStats = LatencyStats & {
  harnessOverhead: HarnessOverhead;
};

type EndToEndStats = LatencyStats;

type KernelStats = {
  operations: number;
  rounds: number;
  elapsedMs: number;
  timePerOperationMs: TimeSummary;
  operationsPerSecond: RateSummary;
};

type ThroughputStats = {
  completions: number;
  blocks: number;
  elapsedMs: number;
  blockDurationMs: TimeSummary;
  completionsPerSecond: RateSummary;
};

type TaskStats = CallStats | EndToEndStats | KernelStats | ThroughputStats;

type KernelInvocation = {
  iterationCount: number;
};

type EndToEndInvocation = {
  seed: number;
};

type TaskHooks = {
  setup?: () => Promise<void> | void;
  teardown?: () => Promise<void> | void;
};

type CallTaskDefinition = TaskHooks & {
  mode: "call";
  run: () => unknown;
};

type KernelTaskDefinition = TaskHooks & {
  mode: "kernel";
  run: (invocation: KernelInvocation) => unknown;
  constantResult?: boolean;
};

type ThroughputTaskDefinition = TaskHooks & {
  mode: "throughput";
  concurrency: number;
  run: () => PromiseLike<unknown>;
};

type EndToEndTaskDefinition<Input> = TaskHooks & {
  mode: "end-to-end";
  createInput: (invocation: EndToEndInvocation) => Input;
  run: (input: Input) => unknown;
};

type TaskDefinition<Input = unknown> =
  | CallTaskDefinition
  | EndToEndTaskDefinition<Input>
  | KernelTaskDefinition
  | ThroughputTaskDefinition;

type Task = {
  name: string;
  definition: TaskDefinition;
};

type AutoOptions = {
  precisionX?: number;
  maxTimeMs?: number;
  maxWarmupTimeMs?: number;
};

type ResolvedAutoOptions = {
  mode: "auto";
  precisionX: number;
  maxTimeMs: number;
  maxWarmupTimeMs: number;
  minPilotBlocks: number;
  minEffectiveBlocks: number;
};

type MeasurementSchedule =
  | {
      mode: "comparative";
      seed?: number;
      yieldBetweenRounds?: boolean;
    }
  | { mode: "isolated" };

type ResolvedMeasurementSchedule =
  | {
      mode: "comparative";
      seed: number | null;
      yieldBetweenRounds: boolean;
    }
  | { mode: "isolated" };

type BenchmarkRunSelection =
  | {
      iterations: number;
      timeMs?: never;
      auto?: never;
      schedule?: { mode: "isolated" };
      batching?: { enabled?: boolean; operationsPerBlock?: "auto" | number };
      warmup?: { enabled?: boolean; iterations?: "auto" | number };
    }
  | {
      timeMs: number;
      iterations?: never;
      auto?: never;
      schedule?: { mode: "isolated" };
      batching?: { enabled?: boolean; operationsPerBlock?: "auto" | number };
      warmup?: { enabled?: boolean; iterations?: "auto" | number };
    }
  | {
      timeMs?: never;
      iterations?: never;
      auto?: AutoOptions;
      schedule?: MeasurementSchedule;
      batching?: never;
      warmup?: never;
    };

type BenchmarkCommonOptions = {
  method?: ClockMethod;
  sleepBetweenTasksMs?: number;
  quiet?: boolean;
};

type BenchmarkOptions = BenchmarkCommonOptions & BenchmarkRunSelection;

type ResolvedBenchmarkOptions = {
  run: ResolvedAutoOptions | { mode: "count"; iterations: number } | { mode: "time"; timeMs: number };
  batching: { enabled: boolean; operationsPerBlock: "auto" | number };
  warmup: { enabled: boolean; iterations: "auto" | number };
  method: ClockMethod;
  sleepBetweenTasksMs: number;
  quiet: boolean;
  schedule: ResolvedMeasurementSchedule;
};

type ScheduleSnapshot = {
  seed: number | null;
  yieldBetweenRounds: boolean;
  rows: readonly (readonly string[])[];
};

type KernelRoundModel = {
  round: number;
  seed: number;
  operationCountOrder: readonly number[];
  interceptMs: number;
  slopeMsPerOperation: number;
  residualsMs: readonly number[];
  fittedMs: readonly number[];
  rSquaredX: number;
  lowRangeSlopeMsPerOperation: number;
  highRangeSlopeMsPerOperation: number;
  resultHashes: readonly (string | null)[];
  flags: readonly ObservationFlag[];
};

type KernelMeasurement = {
  baseOperationCount: number;
  operationCountLadder: readonly number[];
  measuredOperationCountRange: readonly [number, number];
  constantResultDeclared: boolean;
  rounds: readonly KernelRoundModel[];
};

type MeasurementPlan = {
  operationsPerBlock: number;
  physicalBlocksPerSuperblock: number;
  physicalBlockCount: number;
  effectiveBlockCount: number;
  plannedDurationMs: number;
  remainingBudgetMs: number;
  precisionX: number;
  pilotMean: number;
  pilotStandardDeviation: number;
};

type TaskRecord = {
  task: Task;
  groupKey: string;
  status: EvidenceStatus;
  reasons: readonly string[];
  interval: IntervalEvidence | null;
  executionKind: "async" | "sync";
  overhead: Pick<HarnessOverhead, "observationSequences" | "perInvocationMs" | "sampleCount">;
  schedule: ScheduleSnapshot;
  kernelModels: KernelRoundModel[];
  kernelFallbackModels: KernelRoundModel[];
  kernelBaseCount: number | null;
  kernelLadder: readonly number[];
  plan: MeasurementPlan | null;
};

type BenchmarkMetadataBase = {
  schedule: ScheduleSnapshot;
  plan: MeasurementPlan | null;
};

type CallBenchmarkMetadata = BenchmarkMetadataBase & {
  executionKind: "async" | "sync";
};

type EndToEndBenchmarkMetadata = BenchmarkMetadataBase & {
  executionKind: "async" | "sync";
};

type KernelBenchmarkMetadata = BenchmarkMetadataBase & {
  executionKind: "sync";
  kernel: KernelMeasurement | null;
};

type ThroughputBenchmarkMetadata = BenchmarkMetadataBase & {
  executionKind: "async";
  concurrency: number;
};

type BenchmarkMetadata =
  | CallBenchmarkMetadata
  | EndToEndBenchmarkMetadata
  | KernelBenchmarkMetadata
  | ThroughputBenchmarkMetadata;

type BenchmarkResultBase<
  Type extends TaskType,
  Stats extends TaskStats,
  Metadata extends BenchmarkMetadata,
> = {
  name: string;
  taskType: Type;
  stats: Stats;
  evidence: MeasurementEvidence<Type>;
  metadata: Metadata;
};

type CallBenchmarkResult = BenchmarkResultBase<"call", CallStats, CallBenchmarkMetadata>;
type EndToEndBenchmarkResult = BenchmarkResultBase<
  "end-to-end",
  EndToEndStats,
  EndToEndBenchmarkMetadata
>;
type KernelBenchmarkResult = BenchmarkResultBase<"kernel", KernelStats, KernelBenchmarkMetadata>;
type ThroughputBenchmarkResult = BenchmarkResultBase<
  "throughput",
  ThroughputStats,
  ThroughputBenchmarkMetadata
>;

type BenchmarkResult =
  | CallBenchmarkResult
  | EndToEndBenchmarkResult
  | KernelBenchmarkResult
  | ThroughputBenchmarkResult;

type BenchmarkRunResult = {
  entries: BenchmarkResult[];
  clock: ClockProfile;
  durationMs: number;
  comparisons: readonly PairedComparison[];
};

type PairedRoundComparison = {
  round: number;
  difference: number;
  ratioX: number | null;
  order: readonly [string, string];
  elapsedSinceRunStartMs: number;
  flags: readonly ObservationFlag[];
};

type PairedComparisonBase = {
  left: string;
  right: string;
  rounds: readonly PairedRoundComparison[];
  averageDifference: number;
  averageRatioX: number | null;
  interval: IntervalEvidence | null;
};

type TimePairedComparison = PairedComparisonBase & {
  taskType: "call" | "end-to-end" | "kernel";
  metric: "time-per-operation";
  unit: "milliseconds-per-operation";
  better: "lower";
};

type ThroughputPairedComparison = PairedComparisonBase & {
  taskType: "throughput";
  metric: "throughput";
  unit: "completions-per-second";
  better: "higher";
};

type PairedComparison = TimePairedComparison | ThroughputPairedComparison;

type CompiledTaskFunction = (iterations: number, clock: Clock) => Promise<TimedBlock> | TimedBlock;

type TimedBlock = {
  startedAtMs: number;
  elapsedMs: number;
  operations: number;
  resultHash: string | null;
};

type AutoProgress = {
  task: string;
  phase: "assessment" | "measurement" | "pilot" | "warmup";
  physicalBlocksCompleted: number;
  physicalBlocksPlanned: number | null;
  operationsCompleted: number;
  elapsedTimeMs: number;
  maxTimeMs: number;
};

type FixedProgress = {
  task: string;
  tasksCompleted: number;
  tasksTotal: number;
  iterationsCompleted: number;
  iterationsTotal: number;
  elapsedTimeMs: number;
};

type BenchEvents = {
  benchmarkStart: { tasks: string[] };
  taskStart: { task: string };
  taskPhaseStart: { task: string; phase: "assessment" | "measurement" | "pilot" | "warmup" };
  taskPhaseEnd: { task: string; phase: "assessment" | "measurement" | "pilot" | "warmup" };
  taskEvidenceStatus: { task: string; status: EvidenceStatus; reasons: readonly string[] };
  setup: { task: string };
  teardown: { task: string };
  taskComplete: BenchmarkResult;
  benchmarkEnd: BenchmarkRunResult;
  progress: AutoProgress | FixedProgress;
};

type BenchEventSink = <Event extends keyof BenchEvents>(event: Event, data: BenchEvents[Event]) => void;

export type {
  AutoOptions,
  AutoProgress,
  BenchEvents,
  BenchEventSink,
  CallBenchmarkMetadata,
  CallBenchmarkResult,
  CallStats,
  BenchmarkMetadata,
  BenchmarkOptions,
  BenchmarkResult,
  BenchmarkRunResult,
  BenchmarkRunSelection,
  CallTaskDefinition,
  Clock,
  ClockMethod,
  ClockProfile,
  CompiledTaskFunction,
  EndToEndBenchmarkMetadata,
  EndToEndBenchmarkResult,
  EndToEndInvocation,
  EndToEndStats,
  EndToEndTaskDefinition,
  EvidenceStatus,
  FixedProgress,
  HarnessOverhead,
  IntervalEvidence,
  KernelBenchmarkMetadata,
  KernelBenchmarkResult,
  KernelInvocation,
  KernelMeasurement,
  KernelRoundModel,
  KernelStats,
  KernelTaskDefinition,
  LatencyStats,
  MeasurementEvidence,
  MeasurementMode,
  MeasurementObservation,
  MeasurementPhase,
  MeasurementPlan,
  MeasurementSchedule,
  ObservationFlag,
  PairedComparison,
  PairedRoundComparison,
  RateSummary,
  ResolvedAutoOptions,
  ResolvedBenchmarkOptions,
  ResolvedMeasurementSchedule,
  ScheduleSnapshot,
  Task,
  TaskDefinition,
  TaskRecord,
  TaskStats,
  TaskType,
  ThroughputBenchmarkMetadata,
  ThroughputBenchmarkResult,
  ThroughputPairedComparison,
  ThroughputStats,
  ThroughputTaskDefinition,
  TimePairedComparison,
  TimeSummary,
  TimedBlock,
};
