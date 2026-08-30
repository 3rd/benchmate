import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const runContract = (runtime) => {
  const result = spawnSync(runtime, ["tests/validation/runtime-contract.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${runtime} runtime contract failed:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
};

const bun = runContract("bun");
const node = runContract("node");
assert.deepEqual(bun, node);
console.log("Node and Bun runtime contracts match.");
