// desktop/decks/deck-pdf.ts
//
// PDF of a deck through Electron's own printToPDF (#277): a hidden window that
// exists only for the export and is destroyed after it. The deck's print CSS
// sets one 1280×720 page per slide.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BrowserWindow } from "electron";

export async function renderDeckPdf(html: string): Promise<Buffer> {
  // A file, not a data: URL: Chromium caps the length of a URL it navigates to.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marshal-deck-"));
  const file = path.join(dir, "deck.html");
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  try {
    await fs.writeFile(file, html, "utf8");
    await window.loadFile(file);
    return await window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  } finally {
    window.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
