// desktop/dictation/mic-discover.ts
//
// Spawn the Core Audio mic-list helper and parse its JSON output for the
// settings dropdown. Pure I/O wrapper — no UI side-effects, no caching.
// Cached at the renderer layer; if the user plugs in a new device the
// settings panel re-invokes this to refresh.
//
// Failure modes (all degrade to an empty list rather than throwing):
//   - binary missing (postbuild skipped on a non-darwin machine)
//   - hang (250 ms timeout, SIGKILL)
//   - non-zero exit (HAL refused — we still try to parse stdout, then bail)
//   - malformed JSON
//
// Result is a flat list; the caller prepends a "System default" entry.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asarUnpacked } from "../utils/asar-paths.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const dictationDistDir = asarUnpacked(path.dirname(currentFilePath));
const DEFAULT_MIC_LIST_BIN = path.join(dictationDistDir, "mic-list");
const MIC_LIST_TIMEOUT_MS = 1_500;

export interface Microphone {
  id: string;
  name: string;
  isDefault: boolean;
  manufacturer: string;
  transportType: string;
}

export function parseMicList(stdout: string): Microphone[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const obj: unknown = JSON.parse(trimmed);
    if (!Array.isArray(obj)) return [];
    const out: Microphone[] = [];
    for (const entry of obj) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : "";
      if (!id) continue;
      out.push({
        id,
        name: typeof rec.name === "string" && rec.name.length > 0 ? rec.name : id,
        isDefault: rec.isDefault === true,
        manufacturer: typeof rec.manufacturer === "string" ? rec.manufacturer : "",
        transportType: typeof rec.transportType === "string" ? rec.transportType : ""
      });
    }
    return out;
  } catch {
    return [];
  }
}

export interface ListMicrophonesOptions {
  binPath?: string;
  timeoutMs?: number;
}

export function listMicrophones(options: ListMicrophonesOptions = {}): Promise<Microphone[]> {
  const binPath = options.binPath ?? DEFAULT_MIC_LIST_BIN;
  const timeoutMs = options.timeoutMs ?? MIC_LIST_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let child;
    try {
      child = spawn(binPath, [], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve([]);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve([]);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve([]);
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(parseMicList(stdout));
    });
  });
}
