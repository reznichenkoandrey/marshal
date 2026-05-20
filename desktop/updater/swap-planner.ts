// desktop/updater/swap-planner.ts
//
// Pure helper that figures out whether (and where) we are allowed to swap the
// running Marshal.app bundle. Kept dependency-free so the rules are unit-
// testable without spinning up Electron.
//
// The single export `planSwap` answers two questions:
//
//   1. Is the currently running process inside a real, writable .app bundle
//      that lives somewhere we can replace? (i.e. NOT dev-mode Electron, NOT
//      a read-only `/Volumes/` mount.)
//   2. If yes, what are the paths the post-quit shell script needs?
//
// The installer (`./update-installer.ts`) calls this once, refuses on a `no`,
// and feeds the plan into the detached swap script otherwise.

import path from "node:path";

export interface SwapPlan {
  /** Absolute path to the running .app bundle (e.g. /Applications/Marshal.app). */
  currentAppPath: string;
  /** Parent directory of the .app bundle — the script swaps inside this dir. */
  installDir: string;
  /** Bundle filename (`Marshal.app`) — pinned so the new bundle lands at the same name. */
  appName: string;
}

export interface SwapRefusal {
  reason:
    | "not-packaged"
    | "read-only-volume"
    | "unknown-layout";
  detail: string;
}

export type SwapDecision =
  | { ok: true; plan: SwapPlan }
  | { ok: false; refusal: SwapRefusal };

export interface PlanInput {
  /** `process.execPath` from the main process. */
  execPath: string;
  /** Set this to skip the "dev mode" check during automated tests. */
  bypassDevCheck?: boolean;
}

/**
 * Decide whether we can swap the current bundle.
 *
 * `execPath` is expected to look like:
 *   /Applications/Marshal.app/Contents/MacOS/Marshal
 *
 * We walk parents looking for a `*.app` segment, then refuse if the bundle is
 * Electron itself (dev) or lives on a `/Volumes/` mount (DMG / external).
 */
export function planSwap(input: PlanInput): SwapDecision {
  const execPath = input.execPath;
  const appBundlePath = findAppBundleAncestor(execPath);
  if (!appBundlePath) {
    return {
      ok: false,
      refusal: {
        reason: "not-packaged",
        detail: `execPath has no .app ancestor (running in dev mode?): ${execPath}`
      }
    };
  }

  const appName = path.basename(appBundlePath);
  if (!input.bypassDevCheck && /^Electron(\b|\.app$)/u.test(appName)) {
    return {
      ok: false,
      refusal: {
        reason: "not-packaged",
        detail: `Running inside Electron.app — auto-install is only for packaged Marshal builds`
      }
    };
  }

  if (appBundlePath.startsWith("/Volumes/")) {
    return {
      ok: false,
      refusal: {
        reason: "read-only-volume",
        detail: `Running from a DMG / external mount: ${appBundlePath}. Drag Marshal into /Applications first, then check for updates again.`
      }
    };
  }

  const installDir = path.dirname(appBundlePath);
  if (!installDir || installDir === "/" || installDir === ".") {
    return {
      ok: false,
      refusal: {
        reason: "unknown-layout",
        detail: `Cannot resolve install dir from: ${appBundlePath}`
      }
    };
  }

  return {
    ok: true,
    plan: {
      currentAppPath: appBundlePath,
      installDir,
      appName
    }
  };
}

/**
 * Walk up `execPath` to the nearest `*.app` ancestor. Returns `null` when there
 * is no `.app` in the chain (dev mode, plain `node`-driven scripts, etc.).
 *
 * Exported for tests so we can pin the traversal behaviour without going
 * through the full `planSwap`.
 */
export function findAppBundleAncestor(execPath: string): string | null {
  const segments = execPath.split(path.sep);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i].toLowerCase().endsWith(".app")) {
      return segments.slice(0, i + 1).join(path.sep);
    }
  }
  return null;
}
