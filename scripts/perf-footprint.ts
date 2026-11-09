// Prints the memory footprint of every Marshal process against the idle
// budget (#281). Run it idle, then right after a dictation, and paste both
// into the feature PR.
//   npm run perf:footprint            # installed Marshal.app
//   npm run perf:footprint -- --pid N # any root, e.g. a dev Electron
import { execFileSync } from "node:child_process";

import { formatMegabytes, IDLE_BUDGET_BYTES, measureFootprint } from "../desktop/perf/footprint.ts";

function findMarshalPid(): number {
  const pidFlag = process.argv.indexOf("--pid");
  if (pidFlag !== -1) return Number(process.argv[pidFlag + 1]);
  try {
    return Number(execFileSync("pgrep", ["-x", "Marshal"], { encoding: "utf8" }).trim().split("\n")[0]);
  } catch {
    throw new Error("Marshal is not running. Start it, or pass --pid <main process pid>.");
  }
}

const summary = await measureFootprint(findMarshalPid());
for (const entry of summary.processes) {
  console.log(`${formatMegabytes(entry.bytes).padStart(9)}  ${entry.name} [${entry.pid}]`);
}
console.log("");
console.log(`Marshal: ${formatMegabytes(summary.appBytes)} of ${formatMegabytes(IDLE_BUDGET_BYTES)} idle budget${summary.overBudget ? " — OVER BUDGET" : ""}`);
console.log(`Speech model: ${summary.modelBytes === null ? "not loaded" : formatMegabytes(summary.modelBytes)}`);
process.exitCode = summary.overBudget ? 1 : 0;
