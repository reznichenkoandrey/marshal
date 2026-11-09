// Resource budget tooling (#281): parsing `ps` / `footprint`, the idle budget
// that excludes the on-demand speech model, and the Setup health row.

import { describe, expect, it } from "vitest";

import {
  IDLE_BUDGET_BYTES,
  parseFootprintOutput,
  parsePsOutput,
  processTree,
  summarizeFootprint
} from "../desktop/perf/footprint.ts";
import { buildSetupHealth } from "../desktop/setup-health.ts";

const MB = 1024 ** 2;

describe("process tree", () => {
  it("keeps the root and all descendants, nothing else", () => {
    const rows = parsePsOutput([
      "    1     0 /sbin/launchd",
      "  100     1 /Applications/Marshal.app/Contents/MacOS/Marshal",
      "  101   100 /Applications/Marshal.app/Contents/Frameworks/Marshal Helper (Renderer).app/Contents/MacOS/Marshal Helper (Renderer)",
      "  102   100 /Applications/Marshal.app/Contents/Resources/app.asar.unpacked/dist/desktop/dictation/ptt-monitor",
      "  103   102 /x/whisper-server",
      "  200     1 /Applications/Safari.app/Contents/MacOS/Safari"
    ].join("\n"));
    const tree = processTree(rows, 100);
    expect(tree.map((row) => row.pid).sort()).toEqual([100, 101, 102, 103]);
    expect(tree.find((row) => row.pid === 101)?.name).toBe("Marshal Helper (Renderer)");
    expect(processTree(rows, 999)).toEqual([]);
  });
});

describe("parseFootprintOutput", () => {
  it("reads phys_footprint per pid from `footprint -f bytes`", () => {
    const text = [
      "======================================================================",
      "Marshal [19824]: 64-bit    Footprint: 92080144 B (16384 bytes per page)",
      "======================================================================",
      "    phys_footprint: 92080144 B",
      "ptt-monitor [19882]: 64-bit    Footprint: 13681384 B (16384 bytes per page)",
      "Summary Footprint: 105614072 B"
    ].join("\n");
    expect([...parseFootprintOutput(text)]).toEqual([[19824, 92080144], [19882, 13681384]]);
  });
});

describe("summarizeFootprint", () => {
  it("keeps the speech model out of the idle budget", () => {
    const summary = summarizeFootprint([
      { pid: 1, name: "Marshal", bytes: 90 * MB },
      { pid: 2, name: "whisper-server", bytes: 1600 * MB },
      { pid: 3, name: "ptt-monitor", bytes: 13 * MB }
    ]);
    expect(summary.appBytes).toBe(103 * MB);
    expect(summary.modelBytes).toBe(1600 * MB);
    expect(summary.overBudget).toBe(false);
    expect(summary.processes[0].name).toBe("whisper-server");
  });

  it("flags an app over budget and a model that is not loaded", () => {
    const summary = summarizeFootprint([{ pid: 1, name: "Marshal", bytes: IDLE_BUDGET_BYTES + 1 }]);
    expect(summary.overBudget).toBe(true);
    expect(summary.modelBytes).toBeNull();
  });
});

describe("Setup health memory row", () => {
  const base = {
    platform: "darwin" as const,
    dictationEnabled: true,
    dictationBackend: "hybrid" as const,
    apiKeyPresent: true,
    whisperBinPath: "/whisper-cli",
    whisperModelPath: "/model.bin",
    launchAtLogin: false,
    exists: () => true
  };

  function memoryRow(memory: Parameters<typeof buildSetupHealth>[0]["memory"]) {
    return buildSetupHealth({ ...base, memory }).items.find((item) => item.id === "memory");
  }

  it("shows the total against the budget and whether the model is loaded", () => {
    const row = memoryRow(summarizeFootprint([
      { pid: 1, name: "Marshal", bytes: 88 * MB },
      { pid: 2, name: "whisper-server", bytes: 1600 * MB }
    ]));
    expect(row?.status).toBe("ok");
    expect(row?.detail).toContain("Marshal 88 MB of 300 MB budget");
    expect(row?.detail).toContain("Speech model loaded: 1.56 GB");
  });

  it("warns over budget, is unknown when measuring failed, and absent when not measured", () => {
    expect(memoryRow(summarizeFootprint([{ pid: 1, name: "Marshal", bytes: 400 * MB }]))?.status).toBe("warn");
    expect(memoryRow(null)?.status).toBe("unknown");
    expect(memoryRow(undefined)).toBeUndefined();
  });
});
