import { spawnSync } from "node:child_process";

const AUTO_CORPUS_FILE = "./tests/validation/auto-corpus.ts";
const KERNEL_CORPUS_FILE = "./tests/validation/kernel-corpus.ts";
const RUNTIME_NOISE_CORPUS_FILE = "./tests/validation/runtime-noise-corpus.ts";
const FULL_CORPUS_COUNT = 10_000;
const AR_SHARD_COUNT = 4;
const AR_SHARD_SIZE = FULL_CORPUS_COUNT / AR_SHARD_COUNT;

const createArScenarios = (pattern) =>
  Array.from({ length: AR_SHARD_COUNT }, (_, shardIndex) => [
    AUTO_CORPUS_FILE,
    pattern,
    {
      BENCHMATE_CORPUS_COUNT: String(AR_SHARD_SIZE),
      BENCHMATE_CORPUS_SEED_OFFSET: String(shardIndex * AR_SHARD_SIZE),
    },
  ]);

const scenarios = [
  [AUTO_CORPUS_FILE, "stationary normal"],
  [AUTO_CORPUS_FILE, "stationary lognormal"],
  [AUTO_CORPUS_FILE, "tighter precision"],
  ...createArScenarios("rho 0 corpus"),
  ...createArScenarios("rho 0.5 corpus"),
  ...createArScenarios("rho 0.9 corpus"),
  [AUTO_CORPUS_FILE, "warmup step"],
  [AUTO_CORPUS_FILE, "late final-tier"],
  [AUTO_CORPUS_FILE, "positive and negative"],
  [AUTO_CORPUS_FILE, "quantized clock"],
  [AUTO_CORPUS_FILE, "independent clock-jitter"],
  [AUTO_CORPUS_FILE, "isolated pause-spike"],
  [AUTO_CORPUS_FILE, "stable high-variance"],
  [KERNEL_CORPUS_FILE, "linear counted-kernel"],
  [KERNEL_CORPUS_FILE, "optimization-sensitivity"],
  [RUNTIME_NOISE_CORPUS_FILE, "balanced comparative"],
  [RUNTIME_NOISE_CORPUS_FILE, "paired diagnostics reject"],
  [RUNTIME_NOISE_CORPUS_FILE, "paired-difference interval"],
];

for (const [file, pattern, scenarioEnvironment = {}] of scenarios) {
  const seedLabel = scenarioEnvironment.BENCHMATE_CORPUS_SEED_OFFSET
    ? ` seeds ${scenarioEnvironment.BENCHMATE_CORPUS_SEED_OFFSET}+`
    : "";
  console.log(`\n[validation] ${pattern}${seedLabel}`);
  const result = spawnSync("bun", ["test", file, "-t", pattern], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BENCHMATE_CORPUS_COUNT: String(FULL_CORPUS_COUNT),
      BENCHMATE_CORPUS_SEED_STRIDE: String(FULL_CORPUS_COUNT),
      ...scenarioEnvironment,
    },
    encoding: "utf8",
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`Validation scenario '${pattern}' failed with exit status ${String(result.status)}.`);
  }
}

console.log(`\n${scenarios.length} validation scenarios passed.`);
