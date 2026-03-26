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
  path.join(distDir, "src", "content.js"),
  path.join(distDir, "src", "sidepanel", "sidepanel.js"),
  path.join(distDir, "src", "picker", "element-picker.js"),
  path.join(distDir, "src", "injector", "chat-input-injector.js"),
  path.join(distDir, "src", "agent", "page-capture.js"),
  path.join(distDir, "src", "agent", "action-executor.js"),
  path.join(distDir, "src", "agent", "prompt-builder.js")
];

// Static assets that tsc does not emit (HTML, CSS, JSON)
const staticAssets = [
  {
    from: path.join(root, "chrome-extension", "rules.json"),
    to: path.join(distDir, "rules.json")
  },
  {
    from: path.join(root, "chrome-extension", "src", "sidepanel", "sidepanel.html"),
    to: path.join(distDir, "src", "sidepanel", "sidepanel.html")
  },
  {
    from: path.join(root, "chrome-extension", "src", "sidepanel", "sidepanel.css"),
    to: path.join(distDir, "src", "sidepanel", "sidepanel.css")
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

// Compile the Swift pasteboard-watcher helper (macOS only).
// The binary is used by ClipboardMonitor to detect double Cmd+C without
// requiring Accessibility permission (NSPasteboard.changeCount is permission-free).
if (process.platform === "darwin") {
  const swiftSrc = path.join(root, "desktop", "translator", "pasteboard-watcher.swift");
  const swiftOut = path.join(root, "dist", "desktop", "translator", "pasteboard-watcher");
  await fs.mkdir(path.dirname(swiftOut), { recursive: true });
  try {
    execFileSync("swiftc", [swiftSrc, "-O", "-o", swiftOut], { stdio: "inherit" });
    console.log("[postbuild] pasteboard-watcher compiled →", swiftOut);
  } catch (err) {
    console.warn("[postbuild] swiftc failed — double Cmd+C will fall back to polling:", err.message);
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
