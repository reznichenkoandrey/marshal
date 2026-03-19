import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourceManifest = path.join(root, "chrome-extension", "manifest.json");
const distDir = path.join(root, "dist", "chrome-extension");
const distManifest = path.join(distDir, "manifest.json");
const bridgePort = String(Number(process.env.CHATGPT_EXTENSION_BRIDGE_PORT ?? "3210"));
const sanitizedScripts = [
  path.join(distDir, "src", "background.js"),
  path.join(distDir, "src", "content.js")
];

await fs.mkdir(distDir, { recursive: true });
await fs.copyFile(sourceManifest, distManifest);

for (const filePath of sanitizedScripts) {
  const source = await fs.readFile(filePath, "utf8");
  const sanitized = source
    .replaceAll("__MARSHAL_BRIDGE_PORT__", bridgePort)
    .replace(/\nexport \{\};?\s*$/u, "\n");
  if (sanitized !== source) {
    await fs.writeFile(filePath, sanitized, "utf8");
  }
}
