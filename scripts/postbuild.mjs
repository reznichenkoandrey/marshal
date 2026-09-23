import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const sourceManifest = path.join(root, "chrome-extension", "manifest.json");
const distDir = path.join(root, "dist", "chrome-extension");
const distManifest = path.join(distDir, "manifest.json");
const desktopRendererSourceDir = path.join(root, "desktop", "renderer");
const desktopRendererDistDir = path.join(root, "dist", "desktop", "renderer");
const bridgePort = String(Number(process.env.CHATGPT_EXTENSION_BRIDGE_PORT ?? "3210"));
const sanitizedScripts = [
  path.join(distDir, "src", "background.js"),
  path.join(distDir, "src", "sidepanel", "sidepanel.js"),
  path.join(distDir, "src", "picker", "element-picker.js")
];

// Static assets that tsc does not emit (HTML, CSS)
const staticAssets = [
  {
    from: path.join(root, "chrome-extension", "src", "sidepanel", "sidepanel.html"),
    to: path.join(distDir, "src", "sidepanel", "sidepanel.html")
  },
  {
    from: path.join(root, "chrome-extension", "src", "sidepanel", "sidepanel.css"),
    to: path.join(distDir, "src", "sidepanel", "sidepanel.css")
  },
  {
    from: path.join(root, "chrome-extension", "src", "sidepanel", "design-tokens.css"),
    to: path.join(distDir, "src", "sidepanel", "design-tokens.css")
  },
  {
    from: path.join(root, "chrome-extension", "src", "sidepanel", "icons.js"),
    to: path.join(distDir, "src", "sidepanel", "icons.js")
  }
];

await fs.mkdir(distDir, { recursive: true });
await fs.copyFile(sourceManifest, distManifest);

// Copy side panel static assets
for (const asset of staticAssets) {
  await fs.mkdir(path.dirname(asset.to), { recursive: true });
  await fs.copyFile(asset.from, asset.to);
}

for (const filePath of sanitizedScripts) {
  const source = await fs.readFile(filePath, "utf8");
  const sanitized = source
    .replaceAll("__MARSHAL_BRIDGE_PORT__", bridgePort)
    .replace(/\nexport \{\};?\s*$/u, "\n");
  if (sanitized !== source) {
    await fs.writeFile(filePath, sanitized, "utf8");
  }
}

await fs.rm(desktopRendererDistDir, { recursive: true, force: true });
await copyDirectory(desktopRendererSourceDir, desktopRendererDistDir);

// Stage the whisper-cli binary into dist/ so electron-builder ships it inside
// the packaged app: building it needs git + cmake, which an installed app
// cannot assume. `whisper-backend.ts` resolves it relative to the compiled JS
// file, which lands here in dev and in app.asar.unpacked when packaged.
//
// The MODEL is deliberately NOT staged. It is 0.5–3 GB, which made the DMG
// 1.5 GB for an app under 100 MB. It lives in the shared models directory
// instead (see desktop/dictation/model-installer.ts) and is installed either
// from the tray ("Download dictation model…") or by `npm run setup:dictation`.
// Any model left over from a build that predates this is removed so the next
// package does not quietly pick it back up.
{
  const whisperBinSrc = path.join(root, ".whisper", "whisper.cpp", "build", "bin", "whisper-cli");
  const dictationDistDir = path.join(root, "dist", "desktop", "dictation");
  const whisperBinDst = path.join(dictationDistDir, "whisper-cli");

  await fs.mkdir(dictationDistDir, { recursive: true });

  try {
    await fs.access(whisperBinSrc);
    await fs.copyFile(whisperBinSrc, whisperBinDst);
    await fs.chmod(whisperBinDst, 0o755);
    console.log("[postbuild] whisper-cli copied →", whisperBinDst);
  } catch {
    console.warn("[postbuild] whisper-cli missing (run `npm run setup:dictation`) — packaged builds will need it for voice dictation");
  }

  const staged = await fs.readdir(dictationDistDir).catch(() => []);
  for (const entry of staged) {
    if (!entry.endsWith(".bin")) continue;
    await fs.rm(path.join(dictationDistDir, entry), { force: true });
    console.log(`[postbuild] removed bundled model ${entry} — models ship out of band now`);
  }
}

// Compile Swift helpers (macOS only).
if (process.platform === "darwin") {
  const swiftTargets = [
    {
      src: path.join(root, "desktop", "dictation", "audio-recorder.swift"),
      out: path.join(root, "dist", "desktop", "dictation", "audio-recorder"),
      label: "audio-recorder",
      fallbackNote: "voice dictation will be disabled"
    },
    {
      src: path.join(root, "desktop", "dictation", "focus-probe.swift"),
      out: path.join(root, "dist", "desktop", "dictation", "focus-probe"),
      label: "focus-probe",
      fallbackNote: "dictation will fall back to clipboard-only (no auto-paste)"
    },
    {
      src: path.join(root, "desktop", "dictation", "insert-text.swift"),
      out: path.join(root, "dist", "desktop", "dictation", "insert-text"),
      label: "insert-text",
      fallbackNote: "dictation will fall back to clipboard + Cmd+V (no direct caret insert)"
    },
    {
      src: path.join(root, "desktop", "dictation", "ptt-monitor.swift"),
      out: path.join(root, "dist", "desktop", "dictation", "ptt-monitor"),
      label: "ptt-monitor",
      fallbackNote: "modifier-only push-to-talk falls back to uiohook (needs Input Monitoring)"
    },
    {
      src: path.join(root, "desktop", "dictation", "mic-list.swift"),
      out: path.join(root, "dist", "desktop", "dictation", "mic-list"),
      label: "mic-list",
      fallbackNote: "microphone selection dropdown will show 'system default' only"
    },
    {
      src: path.join(root, "desktop", "translator", "apple-vision-ocr.swift"),
      out: path.join(root, "dist", "desktop", "translator", "apple-vision-ocr"),
      label: "apple-vision-ocr",
      fallbackNote: "local OCR will be unavailable, fall back to cloud vision backends"
    },
    {
      src: path.join(root, "desktop", "translator", "send-keystroke.swift"),
      out: path.join(root, "dist", "desktop", "translator", "send-keystroke"),
      label: "send-keystroke",
      fallbackNote: "Cmd+Option+L layout switch will be unavailable"
    },
    {
      src: path.join(root, "desktop", "capture", "swift", "screen-recorder.swift"),
      out: path.join(root, "dist", "desktop", "capture", "screen-recorder"),
      label: "screen-recorder",
      fallbackNote: "video recording (Cmd+Option+6) will be unavailable"
    },
    {
      src: path.join(root, "desktop", "capture", "swift", "system-audio-recorder.swift"),
      out: path.join(root, "dist", "desktop", "capture", "system-audio-recorder"),
      label: "system-audio-recorder",
      fallbackNote: "meeting recording will fall back to microphone-only audio"
    },
    {
      src: path.join(root, "desktop", "captions", "swift", "system-audio-tap.swift"),
      out: path.join(root, "dist", "desktop", "captions", "system-audio-tap"),
      label: "system-audio-tap",
      fallbackNote: "live captions (system audio → subtitles overlay) will be unavailable"
    },
    {
      src: path.join(root, "desktop", "capture", "swift", "scroll-capture.swift"),
      out: path.join(root, "dist", "desktop", "capture", "scroll-capture"),
      label: "scroll-capture",
      fallbackNote: "scrolling capture (experimental) will be unavailable"
    },
    {
      src: path.join(root, "desktop", "capture", "swift", "scroll-stitch.swift"),
      out: path.join(root, "dist", "desktop", "capture", "scroll-stitch"),
      label: "scroll-stitch",
      fallbackNote: "scrolling capture stitching will be unavailable"
    }
  ];

  // Resolve stable codesign identity once for the whole batch. Without a
  // stable signature each rebuild gives every helper a fresh CDHash, so macOS
  // TCC treats them as new binaries and re-prompts for Microphone / Screen
  // Recording on every dev run. See scripts/setup-codesign-cert.sh.
  const stableIdentity = resolveStableCodesignIdentity();
  if (stableIdentity) {
    console.log(`[postbuild] Using stable codesign identity for Swift helpers: ${stableIdentity}`);
  } else {
    console.warn("[postbuild] No stable codesign identity found — Swift helpers will be ad-hoc signed. Run `npm run setup:codesign-cert` to fix.");
  }

  let compiled = 0;
  for (const target of swiftTargets) {
    await fs.mkdir(path.dirname(target.out), { recursive: true });
    try {
      execFileSync("swiftc", [target.src, "-O", "-o", target.out], { stdio: "inherit" });
      console.log(`[postbuild] ${target.label} compiled →`, target.out);
      compiled += 1;
    } catch (err) {
      console.warn(`[postbuild] swiftc ${target.label} failed — ${target.fallbackNote}:`, err.message);
      continue;
    }
    try {
      const signArgs = stableIdentity
        ? ["--force", "--sign", stableIdentity, "--timestamp=none", target.out]
        : ["--force", "--sign", "-", target.out];
      execFileSync("codesign", signArgs, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      console.warn(`[postbuild] codesign ${target.label} failed:`, err.message);
    }
  }

  // One helper failing is a degraded feature and a warning. Every helper
  // failing is a broken toolchain (a macOS SDK the installed swiftc cannot
  // target, #148) and must not produce an app with no dictation, no OCR and
  // no captions that only a full read of the build log would explain.
  if (compiled === 0) {
    console.error(
      "[postbuild] no Swift helper compiled — check `swiftc -version` and `xcrun --show-sdk-path`; " +
      "set MARSHAL_SKIP_SWIFT=1 to build without helpers on purpose"
    );
    if (process.env.MARSHAL_SKIP_SWIFT !== "1") process.exit(1);
  }

  // Patch the dev Electron.app Info.plist so TCC allows our Swift helpers to
  // touch the microphone / screen, and re-sign the bundle with the stable
  // identity so its CDHash stays constant across rebuilds. Packaged builds
  // get these via build.mac.extendInfo — this is the dev-only equivalent.
  // See #50, #84.
  const patchScript = path.join(root, "scripts", "patch-electron-info-plist.sh");
  try {
    execFileSync("bash", [patchScript], { stdio: "inherit" });
  } catch (err) {
    console.warn("[postbuild] patch-electron-info-plist failed:", err.message);
  }
}

function resolveStableCodesignIdentity() {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    for (const line of out.split("\n")) {
      if (!line.includes("Marshal Self-Signed")) continue;
      if (line.includes("Invalid")) continue;
      const match = line.match(/\b([0-9A-F]{40})\b/);
      if (match) return match[1];
    }
  } catch {
    // security tool missing or no identities — fall through to null.
  }
  return null;
}

async function copyDirectory(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile()) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}
