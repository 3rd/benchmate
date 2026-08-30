import type { BenchEventSink, BenchmarkRunResult, ResolvedBenchmarkOptions, Task, TaskRecord } from "./types";
import { profileClock } from "./evidence/clock-profile";
import { ObservationCollector } from "./evidence/observations";
import { acquireComparativeGroup } from "./execution/comparative";
import { acquireAutoTask, acquireFixedTask } from "./execution/isolated";
import { getRandomSeed } from "./execution/schedule";
import { getTaskMeasurementGroupKey } from "./execution/task-runner";
import { sleep } from "./platform/sleep";
import { getClock } from "./platform/time";
import {
  applyNoiseDiagnostics,
  buildBenchmarkComparisons,
  buildBenchmarkResults,
} from "./results/finalize";
import { printResult, printResults } from "./results/print";

type BenchmarkRunner = (
  tasks: readonly Task[],
  options: ResolvedBenchmarkOptions,
  emit: BenchEventSink,
) => Promise<BenchmarkRunResult>;

const teardownTasks = async (tasks: readonly Task[], emit: BenchEventSink) => {
  const failures: unknown[] = [];
  for (const task of [...tasks].reverse()) {
    if (!task.definition.teardown) continue;
    emit("teardown", { task: task.name });
    try {
      await task.definition.teardown();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
};

const getRunSeed = (options: ResolvedBenchmarkOptions) => {
  if (options.run.mode !== "auto") return 0;
  if (options.schedule.mode === "comparative") return options.schedule.seed ?? getRandomSeed();
  return getRandomSeed();
};

const normalizeFailure = (error: unknown): Error => {
  return error instanceof Error ? error : (
      new Error("Benchmark failed with a non-Error value.", { cause: error })
    );
};

const runBenchmark: BenchmarkRunner = async (tasks, options, emit) => {
  const successfullySetUp: Task[] = [];
  let primaryError: Error | null = null;
  const records: TaskRecord[] = [];

  emit("benchmarkStart", { tasks: tasks.map((task) => task.name) });
  const clock = getClock(options.method);
  const startedAtMs = clock.now();
  const clockProfile = profileClock(clock, options.method);
  const collector = new ObservationCollector();
  const runSeed = getRunSeed(options);

  try {
    for (const task of tasks) {
      if (task.definition.setup) {
        emit("setup", { task: task.name });
        await task.definition.setup();
      }
      successfullySetUp.push(task);
    }

    if (options.run.mode === "auto" && options.schedule.mode === "comparative") {
      const groups = new Map<string, Task[]>();
      for (const task of tasks) {
        const key = getTaskMeasurementGroupKey(task);
        const group = groups.get(key) ?? [];
        group.push(task);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        records.push(
          ...(await acquireComparativeGroup({
            tasks: group,
            allTasks: tasks,
            options,
            clock,
            clockProfile,
            collector,
            runSeed,
            emit,
          })),
        );
      }
      records.sort((left, right) => tasks.indexOf(left.task) - tasks.indexOf(right.task));
    } else {
      for (let index = 0; index < tasks.length; index++) {
        const task = tasks[index];
        if (!task) continue;
        records.push(
          options.run.mode === "auto" ?
            await acquireAutoTask({
              task,
              taskIndex: index,
              options,
              clock,
              clockProfile,
              collector,
              runSeed,
              emit,
            })
          : await acquireFixedTask({
              task,
              taskIndex: index,
              tasksCompleted: records.length,
              tasksTotal: tasks.length,
              options,
              clock,
              collector,
              runSeed,
              emit,
            }),
        );
        await sleep(options.sleepBetweenTasksMs);
      }
    }
  } catch (error) {
    primaryError = normalizeFailure(error);
  }

  if (primaryError === null) {
    applyNoiseDiagnostics(records, collector, clockProfile, options.run);
    for (const record of records) {
      emit("taskEvidenceStatus", { task: record.task.name, status: record.status, reasons: record.reasons });
    }
  }

  const teardownFailures = await teardownTasks(successfullySetUp, emit);
  if (primaryError !== null) {
    if (primaryError instanceof Error && teardownFailures.length > 0) {
      Object.defineProperty(primaryError, "teardownErrors", {
        value: Object.freeze([...teardownFailures]),
        enumerable: false,
      });
    }
    throw primaryError;
  }
  if (teardownFailures.length > 0) {
    throw new AggregateError(teardownFailures, "One or more benchmark task teardowns failed.");
  }

  const entries = buildBenchmarkResults(records, collector, options.run.mode);
  const comparisons = buildBenchmarkComparisons(entries);
  const durationMs = clock.now() - startedAtMs;
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(`Clock produced an invalid benchmark duration: ${durationMs}.`);
  }
  const result: BenchmarkRunResult = Object.freeze({
    entries,
    clock: clockProfile,
    durationMs,
    comparisons,
  });
  for (const entry of entries) {
    emit("taskComplete", entry);
    if (!options.quiet) printResult(entry, clockProfile);
  }
  if (!options.quiet) printResults(entries);
  emit("benchmarkEnd", result);
  return result;
};

export { runBenchmark };
