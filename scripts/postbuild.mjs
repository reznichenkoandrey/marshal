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

// Stage whisper.cpp into dist/ so electron-builder ships it inside the
// packaged DMG. Without this, voice dictation silently fails in production:
// `whisper-backend.ts` resolves the binary relative to `process.cwd()` which
// in a packaged build points outside the .app, so `fs.access` always fails.
//
// Both artifacts are produced by `npm run setup:dictation` (whisper-cli built
// from source, model fetched from upstream). They're optional — if the user
// hasn't run setup yet, we skip silently and the dev runtime falls back to
// the `.whisper/` symlink in the project root.
{
  const whisperBinSrc = path.join(root, ".whisper", "whisper.cpp", "build", "bin", "whisper-cli");
  const whisperBinDst = path.join(root, "dist", "desktop", "dictation", "whisper-cli");
  // Search the user's `.whisper/models/` for any of the supported models, in
  // priority order. First match wins. Lets users upgrade ggml-small → turbo
  // → large just by re-running setup:dictation with WHISPER_MODEL=... and
  // rebuilding, with no postbuild edits. See #93.
  const WHISPER_MODELS = ["ggml-large-v3-turbo.bin", "ggml-large-v3.bin", "ggml-small.bin"];

  await fs.mkdir(path.dirname(whisperBinDst), { recursive: true });

  try {
    await fs.access(whisperBinSrc);
    await fs.copyFile(whisperBinSrc, whisperBinDst);
    await fs.chmod(whisperBinDst, 0o755);
    console.log("[postbuild] whisper-cli copied →", whisperBinDst);
  } catch {
    console.warn("[postbuild] whisper-cli missing (run `npm run setup:dictation`) — packaged builds will need it for voice dictation");
  }

  let copiedModel = false;
  for (const modelName of WHISPER_MODELS) {
    const src = path.join(root, ".whisper", "models", modelName);
    const dst = path.join(root, "dist", "desktop", "dictation", modelName);
    try {
      await fs.access(src);
      await fs.copyFile(src, dst);
      console.log(`[postbuild] ${modelName} copied →`, dst);
      copiedModel = true;
      break;
    } catch {
      // Try next candidate.
    }
  }
  if (!copiedModel) {
    console.warn("[postbuild] no whisper model found in .whisper/models/ (run `npm run setup:dictation`) — packaged builds will need it for voice dictation");
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

  for (const target of swiftTargets) {
    await fs.mkdir(path.dirname(target.out), { recursive: true });
    try {
      execFileSync("swiftc", [target.src, "-O", "-o", target.out], { stdio: "inherit" });
      console.log(`[postbuild] ${target.label} compiled →`, target.out);
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
