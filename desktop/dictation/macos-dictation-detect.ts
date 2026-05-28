// desktop/dictation/macos-dictation-detect.ts
//
// Detects whether macOS system Dictation is enabled. When it is, the user's
// chosen activation shortcut (default: double-press Right Command) lives at
// the CGEventTap layer below uiohook, which means it can silently steal the
// key Marshal's push-to-talk relies on. Surfacing this at boot — with a
// one-click path to System Settings — saves users from chasing a
// "push-to-talk doesn't work" ghost. See issue #97.
//
// We deliberately keep the detector cheap and tolerant: it spawns `defaults
// read` with a hard timeout, never throws, and treats every parse failure as
// "unknown" so the caller can decide policy. Spawning `defaults` is fine on
// macOS sandboxes — the binary is in $PATH and the preference domain is
// world-readable.

import { execFile } from "node:child_process";

const DEFAULTS_BIN = "/usr/bin/defaults";
const DEFAULTS_TIMEOUT_MS = 800;

export interface MacOSDictationStatus {
  /** Whether the helper finished successfully. False = unknown / errored. */
  ok: boolean;
  /** True when macOS Dictation is enabled in System Settings. */
  enabled: boolean;
}

/**
 * Read `com.apple.assistant.support "Dictation Enabled"`. Returns
 * `{ok: false, enabled: false}` on any error so callers can treat the
 * uncertainty as "don't warn" instead of crashing.
 */
export function detectMacOSDictationEnabled(): Promise<MacOSDictationStatus> {
  if (process.platform !== "darwin") {
    return Promise.resolve({ ok: true, enabled: false });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: MacOSDictationStatus): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, enabled: false });
    }, DEFAULTS_TIMEOUT_MS);

    execFile(
      DEFAULTS_BIN,
      ["read", "com.apple.assistant.support", "Dictation Enabled"],
      { timeout: DEFAULTS_TIMEOUT_MS },
      (err, stdout) => {
        clearTimeout(timer);
        if (err) {
          // `defaults read` exits non-zero when the key is missing — that's
          // "Dictation has never been enabled", which is a clean "no".
          finish({ ok: true, enabled: false });
          return;
        }
        const value = stdout.trim();
        // `defaults read` returns "1" or "0" for boolean prefs. Accept any
        // truthy spelling defensively.
        const enabled = value === "1" || value.toLowerCase() === "true";
        finish({ ok: true, enabled });
      }
    );
  });
}
