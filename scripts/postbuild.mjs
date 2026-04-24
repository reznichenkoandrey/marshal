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
    }
  ];

  for (const target of swiftTargets) {
    await fs.mkdir(path.dirname(target.out), { recursive: true });
    try {
      execFileSync("swiftc", [target.src, "-O", "-o", target.out], { stdio: "inherit" });
      console.log(`[postbuild] ${target.label} compiled →`, target.out);
    } catch (err) {
      console.warn(`[postbuild] swiftc ${target.label} failed — ${target.fallbackNote}:`, err.message);
    }
  }

  // Patch the dev Electron.app Info.plist so TCC allows our Swift helpers to
  // touch the microphone / screen. Packaged builds get these via
  // build.mac.extendInfo — this is the dev-only equivalent. #50.
  const patchScript = path.join(root, "scripts", "patch-electron-info-plist.sh");
  try {
    execFileSync("bash", [patchScript], { stdio: "inherit" });
  } catch (err) {
    console.warn("[postbuild] patch-electron-info-plist failed:", err.message);
  }
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
