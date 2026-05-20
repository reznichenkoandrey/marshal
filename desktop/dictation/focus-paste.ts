// desktop/dictation/focus-paste.ts
//
// After whisper transcription writes to the clipboard, we ask the OS whether
// the user's current focus accepts text. If yes — slip the transcript in via
// a synthetic Cmd+V. If no — leave it on the clipboard so the user can paste
// it deliberately. See #90.
//
// Two collaborators live here so the dictation service only imports a single
// module:
//   - `probeFocusedElement()` spawns focus-probe (Swift, AX-based) and parses
//     its JSON output.
//   - `sendPasteKeystroke()` spawns the existing send-keystroke helper to
//     synthesize Cmd+V — same Swift binary the translator's layout switcher
//     uses.
//
// Both calls have aggressive timeouts (250 ms / 1.5 s) so a hung helper can
// never block the dictation event loop.
//
// The parsing helper is exported separately for unit tests — we don't want to
// spawn real Swift binaries in CI.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { asarUnpacked } from "../utils/asar-paths.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const dictationDistDir = asarUnpacked(path.dirname(currentFilePath));
const translatorDistDir = asarUnpacked(
  path.resolve(path.dirname(currentFilePath), "..", "translator")
);

const DEFAULT_PROBE_BIN = path.join(dictationDistDir, "focus-probe");
const DEFAULT_SEND_KEY_BIN = path.join(translatorDistDir, "send-keystroke");
const PROBE_TIMEOUT_MS = 250;
const PASTE_TIMEOUT_MS = 1_500;

export interface FocusProbeResult {
  isTextInput: boolean;
  role: string;
  subrole: string;
}

const FALLBACK: FocusProbeResult = { isTextInput: false, role: "", subrole: "" };

/**
 * Parse the JSON line emitted by focus-probe. Tolerates whitespace, partial
 * output, and malformed JSON — anything unexpected collapses to "no text
 * input" so the safe default (clipboard-only) wins.
 */
export function parseFocusProbe(stdout: string): FocusProbeResult {
  const trimmed = stdout.trim();
  if (!trimmed) return FALLBACK;
  try {
    const obj: unknown = JSON.parse(trimmed);
    if (typeof obj !== "object" || obj === null) return FALLBACK;
    const record = obj as Record<string, unknown>;
    return {
      isTextInput: record.isTextInput === true,
      role: typeof record.role === "string" ? record.role : "",
      subrole: typeof record.subrole === "string" ? record.subrole : ""
    };
  } catch {
    return FALLBACK;
  }
}

export interface ProbeOptions {
  binPath?: string;
  timeoutMs?: number;
}

/**
 * Spawn focus-probe and resolve with the parsed result. Never rejects — any
 * spawn / timeout / parse failure resolves to FALLBACK so the dictation flow
 * degrades gracefully to clipboard-only.
 */
export function probeFocusedElement(options: ProbeOptions = {}): Promise<FocusProbeResult> {
  const binPath = options.binPath ?? DEFAULT_PROBE_BIN;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let child;
    try {
      child = spawn(binPath, [], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(FALLBACK);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve(FALLBACK);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(FALLBACK);
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(parseFocusProbe(stdout));
    });
  });
}

export interface PasteOptions {
  binPath?: string;
  timeoutMs?: number;
}

/**
 * Spawn send-keystroke with `v` to synthesize Cmd+V into the frontmost app.
 * Rejects on spawn / non-zero exit / timeout — the caller decides whether to
 * surface or swallow the failure (dictation swallows: clipboard fallback
 * remains usable).
 */
export function sendPasteKeystroke(options: PasteOptions = {}): Promise<void> {
  const binPath = options.binPath ?? DEFAULT_SEND_KEY_BIN;
  const timeoutMs = options.timeoutMs ?? PASTE_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binPath, ["v"], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`send-keystroke timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`send-keystroke exited ${code}: ${stderr.slice(0, 200) || "(no stderr)"}`));
      }
    });
  });
}
