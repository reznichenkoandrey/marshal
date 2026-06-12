import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const rendererDir = path.join(process.cwd(), "desktop", "renderer");

describe("desktop renderer CSP", () => {
  it("defines a non-eval Content-Security-Policy for every HTML renderer", async () => {
    const entries = await readdir(rendererDir, { withFileTypes: true });
    const htmlFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
      .map((entry) => entry.name)
      .sort();

    expect(htmlFiles.length).toBeGreaterThan(0);

    for (const file of htmlFiles) {
      const source = await readFile(path.join(rendererDir, file), "utf8");
      const match = source.match(
        /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/u
      );
      expect(match, `${file} is missing a CSP meta tag`).not.toBeNull();
      const policy = match?.[1] ?? "";
      expect(policy, `${file} must block eval`).not.toContain("unsafe-eval");
      expect(policy, `${file} must disable object embeds`).toContain("object-src 'none'");
      expect(policy, `${file} must disable base URI injection`).toContain("base-uri 'none'");
    }
  });
});
