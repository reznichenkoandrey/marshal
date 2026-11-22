// desktop/decks/deck-window.ts
//
// The deck window (#277): shows a deck while it builds, presents it full
// screen and exports it. Created on open and destroyed on close; the service,
// the stream and every handler go with it, so a closed window costs nothing.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog } from "electron";

import { createSummaryStreamer } from "../captions/summarizer.js";
import { parseDeckRequest, type DeckRequest } from "./deck-generator.js";
import { renderDeckPdf } from "./deck-pdf.js";
import { DeckService, deckFileName, type DeckViewState } from "./deck-service.js";
import { DeckStore } from "./deck-store.js";

const rendererDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderer");

export class DeckWindow {
  private window: BrowserWindow | null = null;
  private service: DeckService | null = null;
  private presenting = false;
  private pending: (() => void)[] = [];

  constructor(
    private readonly preloadPath: string,
    private readonly userDataDir: string
  ) {}

  /** Opens the window on the most recent deck, or on the empty hint. */
  open(): void {
    this.withService((service) => {
      if (service.state().status === "empty") service.openLatest();
    });
  }

  /** True when a model is configured; a build needs one. */
  static canBuild(): boolean {
    return createSummaryStreamer(process.env) !== null;
  }

  /** Opens the window and builds; resolves with the final state, or null if the window closed first. */
  build(request: DeckRequest): Promise<DeckViewState | null> {
    return new Promise((resolve) => {
      this.withService((service) => {
        const window = this.window;
        const closed = (): void => resolve(null);
        window?.once("closed", closed);
        void service.build(request).then((state) => {
          window?.removeListener("closed", closed);
          resolve(window && !window.isDestroyed() ? state : null);
        });
      });
    });
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.close();
  }

  /** Runs once the page can receive state; right away when the window is already up. */
  private withService(run: (service: DeckService) => void): void {
    if (this.window && !this.window.isDestroyed() && this.service) {
      this.window.show();
      app.focus({ steal: true });
      this.window.focus();
      if (this.pending.length > 0) this.pending.push(() => run(this.service as DeckService));
      else run(this.service);
      return;
    }

    const window = new BrowserWindow({
      width: 1100,
      height: 720,
      minWidth: 560,
      minHeight: 400,
      show: false,
      frame: false,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 },
      backgroundColor: "#131316",
      // LSUIElement app: a plain window that falls behind another app has no
      // way back to the front (see CLAUDE.md, #168).
      alwaysOnTop: true,
      fullscreenable: true,
      webPreferences: { preload: this.preloadPath, contextIsolation: true, nodeIntegration: false }
    });
    this.window = window;
    this.presenting = false;

    const service = new DeckService({
      store: new DeckStore(path.join(this.userDataDir, "decks")),
      model: () => {
        const streamer = createSummaryStreamer(process.env);
        return streamer
          ? (messages, maxTokens, onDelta, signal) => streamer.streamMessages(messages, maxTokens, onDelta, signal)
          : null;
      },
      onChange: () => this.send(),
      log: (line) => console.warn(`[decks] ${line}`)
    });
    this.service = service;
    this.pending = [() => run(service)];

    // Handlers live on this window's webContents: no other page can call them,
    // and they go away with the window.
    const ipc = window.webContents.ipc;
    ipc.handle("marshal:decks:build", (_event, input: { words?: unknown }) => {
      const request = typeof input?.words === "string" ? parseDeckRequest(input.words) : null;
      if (request) void service.build(request);
    });
    ipc.handle("marshal:decks:present", (_event, input: { on?: unknown }) => {
      window.setFullScreen(input?.on === true);
    });
    ipc.handle("marshal:decks:export", async (_event, input: { format?: unknown }) => {
      const format = input?.format === "pdf" ? "pdf" : "html";
      const html = service.exportHtml();
      if (!html) return { ok: false };
      const picked = await dialog.showSaveDialog(window, {
        defaultPath: path.join(app.getPath("documents"), deckFileName(service.state().title, format))
      });
      if (picked.canceled || !picked.filePath) return { ok: false };
      try {
        await fs.writeFile(picked.filePath, format === "pdf" ? await renderDeckPdf(html) : html);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    });
    ipc.handle("marshal:decks:close", () => this.close());

    const setPresenting = (on: boolean): void => {
      this.presenting = on;
      this.send();
    };
    window.on("enter-full-screen", () => setPresenting(true));
    window.on("leave-full-screen", () => setPresenting(false));
    window.on("closed", () => {
      service.cancel();
      if (this.window === window) {
        this.window = null;
        this.service = null;
        this.pending = [];
      }
    });
    window.webContents.once("did-finish-load", () => {
      window.show();
      app.focus({ steal: true });
      window.focus();
      const queued = this.pending;
      this.pending = [];
      for (const task of queued) task();
      this.send();
    });
    void window.loadFile(path.join(rendererDir, "deck.html"));
  }

  private send(): void {
    if (!this.window || this.window.isDestroyed() || !this.service) return;
    this.window.webContents.send("marshal:decks-state", { ...this.service.state(), presenting: this.presenting });
  }
}
