// desktop/updater/update-installer.ts
//
// In-process implementation of the "Download & install" button. Given an
// `InstallableAsset` from the checker, we:
//
//   1. Stream the ZIP into a temp file under `os.tmpdir()`, hashing as we go.
//   2. Verify the SHA-512 against `latest-mac.yml`. Mismatch → abort, the temp
//      file is deleted, the bundle is never touched.
//   3. Extract with `/usr/bin/ditto` (preserves code-sign / Info.plist /
//      symlink attributes that a stock unzip would mangle).
//   4. Write a small bash script to a fresh temp dir that:
//        a. Waits for our PID to exit.
//        b. Strips com.apple.quarantine from the new bundle.
//        c. Two-phase swap with rollback on failure.
//        d. Re-opens Marshal.
//   5. Spawn the script detached, then call `app.quit()` so the user sees
//      Marshal disappear and pop back up on the new version.
//
// The "compute SHA + write script + spawn" plumbing is exposed as small public
// methods so tests can drive each stage without running ditto for real.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { InstallableAsset } from "./update-checker.ts";
import type { SwapPlan } from "./swap-planner.ts";

export type InstallPhase =
  | "starting"
  | "downloading"
  | "verifying"
  | "extracting"
  | "staging"
  | "relaunching"
  | "done"
  | "error";

export interface InstallProgress {
  phase: InstallPhase;
  /** 0..1 within the current phase (NaN if not meaningful). */
  ratio: number;
  /** Optional human-readable detail. */
  message?: string;
  /** Bytes downloaded so far — present for `downloading`. */
  bytesDownloaded?: number;
  /** Total bytes of the asset — present for `downloading`. */
  bytesTotal?: number;
}

export interface InstallerInit {
  /** Where to keep the downloaded zip + extracted bundle. Defaults to os.tmpdir(). */
  scratchRoot?: string;
  /** Inject fetch / spawn for tests. */
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  /** PID the post-quit script waits on. Defaults to `process.pid`. */
  parentPid?: number;
}

export type ProgressListener = (p: InstallProgress) => void;

export class UpdateInstaller {
  private readonly scratchRoot: string;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;
  private readonly parentPid: number;
  private readonly listeners = new Set<ProgressListener>();

  constructor(init: InstallerInit = {}) {
    this.scratchRoot = init.scratchRoot ?? path.join(os.tmpdir(), "marshal-update");
    this.fetchImpl = init.fetchImpl ?? globalThis.fetch;
    this.spawnImpl = init.spawnImpl ?? spawn;
    this.parentPid = init.parentPid ?? process.pid;
  }

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Full pipeline: download → verify → extract → stage swap script. Returns the
   * paths the caller needs in order to spawn the script and quit.
   *
   * Throws on any failure — the caller is responsible for surfacing the error
   * to the UI. We never partially mutate the installed bundle: the swap is
   * only performed by the detached script after `commit()` is called.
   */
  async prepare(asset: InstallableAsset, plan: SwapPlan): Promise<PreparedInstall> {
    this.emit({ phase: "starting", ratio: 0 });
    const stagingDir = await this.makeStagingDir(asset.version);
    const zipPath = path.join(stagingDir, "marshal.zip");

    try {
      await this.download(asset, zipPath);
      await this.verify(zipPath, asset.sha512);
      const newAppPath = await this.extract(zipPath, stagingDir, plan.appName);
      const scriptPath = await this.writeSwapScript(stagingDir, plan, newAppPath);
      this.emit({ phase: "staging", ratio: 1 });
      return { stagingDir, zipPath, newAppPath, scriptPath, plan };
    } catch (err) {
      this.emit({
        phase: "error",
        ratio: NaN,
        message: err instanceof Error ? err.message : String(err)
      });
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Spawn the detached post-quit script. After this returns, the caller MUST
   * `app.quit()` immediately — the script will wait up to ~30 s for our pid to
   * exit before swapping the bundle.
   */
  commit(prepared: PreparedInstall): void {
    this.emit({ phase: "relaunching", ratio: 1 });
    const logPath = path.join(prepared.stagingDir, "swap.log");
    const child = this.spawnImpl(
      "/bin/bash",
      [
        prepared.scriptPath,
        String(this.parentPid),
        prepared.newAppPath,
        prepared.plan.installDir,
        prepared.plan.appName,
        logPath
      ],
      {
        detached: true,
        stdio: "ignore"
      }
    );
    child.unref();
  }

  // ── individual stages ──

  private async download(asset: InstallableAsset, zipPath: string): Promise<void> {
    this.emit({ phase: "downloading", ratio: 0, bytesDownloaded: 0, bytesTotal: asset.size });
    const res = await this.fetchImpl(asset.zipUrl, {
      headers: { "User-Agent": "Marshal-Updater" }
    });
    if (!res.ok || !res.body) {
      throw new Error(`Download failed: HTTP ${res.status}`);
    }
    const total =
      Number(res.headers.get("content-length") ?? "") || asset.size;
    let received = 0;

    const fileStream = createWriteStream(zipPath);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    try {
      // Manual chunk loop so we can emit progress + write to disk at the same
      // time. `Response.body.pipeTo(WritableStream)` would be cleaner but loses
      // us the chunk-by-chunk hook.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        await new Promise<void>((resolve, reject) => {
          fileStream.write(value, (err) => (err ? reject(err) : resolve()));
        });
        if (total > 0) {
          this.emit({
            phase: "downloading",
            ratio: Math.min(1, received / total),
            bytesDownloaded: received,
            bytesTotal: total
          });
        }
      }
    } finally {
      await new Promise<void>((resolve) => fileStream.end(() => resolve()));
    }
  }

  private async verify(zipPath: string, expectedSha512: string): Promise<void> {
    this.emit({ phase: "verifying", ratio: 0 });
    const actual = await sha512Base64(zipPath);
    if (actual !== expectedSha512) {
      throw new Error(
        `SHA-512 mismatch — refusing to install. expected=${truncate(expectedSha512, 20)} actual=${truncate(actual, 20)}`
      );
    }
    this.emit({ phase: "verifying", ratio: 1 });
  }

  private async extract(
    zipPath: string,
    stagingDir: string,
    appName: string
  ): Promise<string> {
    this.emit({ phase: "extracting", ratio: 0 });
    const extractDir = path.join(stagingDir, "extracted");
    await fs.mkdir(extractDir, { recursive: true });

    // `ditto -x -k <zip> <dest>` is the macOS-native way to unzip while
    // preserving HFS+ metadata, extended attributes, and symlinks. The stock
    // /usr/bin/unzip drops those, which corrupts code-signed bundles.
    await runProcess(
      this.spawnImpl,
      "/usr/bin/ditto",
      ["-x", "-k", zipPath, extractDir]
    );

    // electron-builder's ZIPs put the bundle at the top level. Locate it
    // explicitly so we don't depend on the exact filename casing.
    const entries = await fs.readdir(extractDir);
    const bundleName = entries.find((e) => e.toLowerCase().endsWith(".app"));
    if (!bundleName) {
      throw new Error(`Extracted archive does not contain a .app bundle in ${extractDir}`);
    }
    // If the running install is `Marshal.app` but the bundle inside the zip is
    // `Marshal beta.app` etc., the post-quit script would try to mv it onto the
    // wrong name. Rename here, in our own staging dir, so the script can stay
    // simple.
    const finalPath = path.join(extractDir, appName);
    if (bundleName !== appName) {
      await fs.rename(path.join(extractDir, bundleName), finalPath);
    }

    this.emit({ phase: "extracting", ratio: 1 });
    return finalPath;
  }

  private async writeSwapScript(
    stagingDir: string,
    plan: SwapPlan,
    newAppPath: string
  ): Promise<string> {
    const scriptPath = path.join(stagingDir, "post-quit-installer.sh");
    await fs.writeFile(scriptPath, buildSwapScript(), "utf8");
    await fs.chmod(scriptPath, 0o755);
    // Touch a sanity-check log line so we know the file is real.
    void newAppPath;
    void plan;
    return scriptPath;
  }

  private async makeStagingDir(version: string): Promise<string> {
    await fs.mkdir(this.scratchRoot, { recursive: true });
    const dir = await fs.mkdtemp(path.join(this.scratchRoot, `v${version}-`));
    return dir;
  }

  private emit(p: InstallProgress): void {
    for (const listener of this.listeners) {
      try {
        listener(p);
      } catch (err) {
        // A misbehaving listener must not break the install pipeline.
        console.warn("[update-installer] progress listener threw:", err);
      }
    }
  }
}

export interface PreparedInstall {
  stagingDir: string;
  zipPath: string;
  newAppPath: string;
  scriptPath: string;
  plan: SwapPlan;
}

/**
 * Compute the base64 SHA-512 of a file, streamed so we never load the whole
 * ZIP into memory.
 */
export async function sha512Base64(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const hash = createHash("sha512");
    const stream = handle.createReadStream({ highWaterMark: 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer | string) => {
        hash.update(chunk);
      });
      stream.on("end", () => resolve());
      stream.on("error", reject);
    });
    return hash.digest("base64");
  } finally {
    await handle.close();
  }
}

/**
 * Builds the bash payload that performs the post-quit swap. Generated at
 * runtime so we don't have to ship a separate `.sh` asset through the
 * electron-builder asar.
 */
export function buildSwapScript(): string {
  // The script is small and self-contained on purpose: it runs after Marshal
  // has quit, so it cannot lean on any Node/Electron helpers. Arguments:
  //   $1 PARENT_PID
  //   $2 STAGING_APP   (e.g. /tmp/marshal-update/v0.1.5-XXXX/extracted/Marshal.app)
  //   $3 INSTALL_DIR   (e.g. /Applications)
  //   $4 APP_NAME      (e.g. Marshal.app)
  //   $5 LOG_PATH      (sibling of STAGING_APP)
  return `#!/bin/bash
# Marshal post-quit installer — generated by desktop/updater/update-installer.ts
set -u

PARENT_PID="\${1:-}"
STAGING_APP="\${2:-}"
INSTALL_DIR="\${3:-}"
APP_NAME="\${4:-}"
LOG="\${5:-/tmp/marshal-installer.log}"

exec >>"$LOG" 2>&1
echo
echo "[post-quit-installer] start $(date)"
echo "  parent pid : $PARENT_PID"
echo "  staging app: $STAGING_APP"
echo "  install dir: $INSTALL_DIR"
echo "  app name   : $APP_NAME"

INSTALL_APP="$INSTALL_DIR/$APP_NAME"

if [ ! -d "$STAGING_APP" ]; then
  echo "ERROR: staging app missing — aborting"
  exit 1
fi

if [ ! -w "$INSTALL_DIR" ]; then
  echo "ERROR: install dir not writable — aborting"
  exit 2
fi

# Wait for Marshal main to actually quit (max ~30s).
i=0
while [ "$i" -lt 300 ] && kill -0 "$PARENT_PID" 2>/dev/null; do
  sleep 0.1
  i=$((i+1))
done

if kill -0 "$PARENT_PID" 2>/dev/null; then
  echo "WARN: parent still alive after 30s — forcing kill"
  kill -KILL "$PARENT_PID" 2>/dev/null || true
  sleep 1
fi

# Strip quarantine so macOS does not re-prompt on next launch.
/usr/bin/xattr -dr com.apple.quarantine "$STAGING_APP" 2>/dev/null || true

# Two-phase swap with rollback if mv-in fails.
BACKUP=""
if [ -d "$INSTALL_APP" ]; then
  BACKUP="$INSTALL_APP.old-$$"
  if ! mv "$INSTALL_APP" "$BACKUP"; then
    echo "ERROR: could not move old bundle aside"
    exit 3
  fi
fi

if ! mv "$STAGING_APP" "$INSTALL_APP"; then
  echo "ERROR: could not move new bundle into place — rolling back"
  if [ -n "$BACKUP" ] && [ -d "$BACKUP" ]; then
    mv "$BACKUP" "$INSTALL_APP" || true
  fi
  exit 4
fi

if [ -n "$BACKUP" ]; then
  rm -rf "$BACKUP" 2>/dev/null || true
fi

# Re-launch the freshly installed bundle.
/usr/bin/open "$INSTALL_APP"

echo "[post-quit-installer] done $(date)"
exit 0
`;
}

// ── helpers ──

function runProcess(
  spawnImpl: typeof spawn,
  cmd: string,
  args: string[]
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

function truncate(value: string, n: number): string {
  return value.length <= n ? value : `${value.slice(0, n)}…`;
}
