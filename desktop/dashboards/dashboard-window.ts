// "Dashboards" window (#279): charts built from read-only data by a spoken or
// typed request. Created on open and destroyed on close; data is fetched only
// while it is open (on open, on Refresh, on a build) — there is no timer.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog } from "electron";

import { createSummaryStreamer } from "../captions/summarizer.ts";
import { t, uiLanguage } from "../i18n/ui-language.ts";
import { DashboardService, type DashboardState } from "./dashboard-service.ts";
import { runDashboardVoice, type DashboardVerb } from "./voice.ts";

const rendererDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderer");

export class DashboardWindow {
  private window: BrowserWindow | null = null;
  private service: DashboardService | null = null;
  /** Resolves once the window is on screen and the saved dashboard is loaded. */
  private ready: Promise<void> = Promise.resolve();

  constructor(
    private readonly preloadPath: string,
    private readonly userDataDir: string
  ) {}

  open(): void {
    // Cached charts first, then fresh data: the saved numbers are from the last time the window was open.
    void this.ensure().then(({ service, fresh }) => (fresh ? service.refresh() : undefined));
  }

  /**
   * `./marshal do dashboard …`: opens the window and runs the action there, so
   * a voice build is cancelled by closing the window like any other. `say`
   * gets the line for the end of a build or refresh.
   */
  async voice(verb: DashboardVerb, spoken: string, say: (text: string) => void): Promise<string> {
    const { service, fresh } = await this.ensure();
    const result = await runDashboardVoice(verb, spoken, service, t, fresh);
    void result.done?.then((line) => {
      // Nothing is said about a build the owner ended by closing the window.
      if (line && this.service === service) say(line);
    });
    return result.reply;
  }

  private async ensure(): Promise<{ service: DashboardService; fresh: boolean }> {
    if (this.window && !this.window.isDestroyed() && this.service) {
      this.window.show();
      app.focus({ steal: true });
      this.window.focus();
      await this.ready;
      return { service: this.service, fresh: false };
    }

    const window = new BrowserWindow({
      width: 1100,
      height: 720,
      minWidth: 520,
      minHeight: 360,
      show: false,
      frame: false,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 10 },
      backgroundColor: "#131316",
      // LSUIElement app: a plain window that falls behind another app has no
      // way back to the front (see CLAUDE.md, #168).
      alwaysOnTop: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    this.window = window;
    // Charts may show project data: keep the window out of a screen share.
    window.setContentProtection(true);

    const service = new DashboardService({
      dir: path.join(this.userDataDir, "dashboards"),
      model: () => {
        const streamer = createSummaryStreamer(process.env);
        return streamer ? (messages, maxTokens, onDelta, signal) => streamer.streamMessages(messages, maxTokens, onDelta, signal) : null;
      },
      language: uiLanguage,
      onChange: (state) => this.send(state)
    });
    this.service = service;

    // Handlers live on this window's webContents: no other page can call them,
    // and they go away with the window.
    const ipc = window.webContents.ipc;
    ipc.handle("marshal:dashboards:build", (_event, input: { prompt?: unknown }) => {
      if (typeof input?.prompt === "string") void service.build(input.prompt);
    });
    ipc.handle("marshal:dashboards:refresh", () => void service.refresh());
    ipc.handle("marshal:dashboards:pick-folder", async () => {
      const picked = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
      const folder = picked.filePaths[0];
      if (picked.canceled || !folder) return;
      await service.setFolder(folder);
      void service.refresh();
    });
    ipc.handle("marshal:dashboards:save-template", () => service.saveTemplate());
    ipc.handle("marshal:dashboards:open-template", async (_event, input: { name?: unknown }) => {
      if (typeof input?.name === "string" && (await service.openTemplate(input.name))) void service.refresh();
    });
    ipc.handle("marshal:dashboards:delete-template", (_event, input: { name?: unknown }) => {
      if (typeof input?.name === "string") return service.deleteTemplate(input.name);
    });
    ipc.handle("marshal:dashboards:close", () => this.close());

    window.on("closed", () => {
      service.cancel();
      if (this.window === window) {
        this.window = null;
        this.service = null;
      }
    });
    this.ready = new Promise((resolve) => {
      window.webContents.once("did-finish-load", () => {
        window.show();
        app.focus({ steal: true });
        window.focus();
        void service.load().then(resolve);
      });
      // A window closed before it loaded must not leave a voice action waiting.
      window.once("closed", resolve);
    });
    void window.loadFile(path.join(rendererDir, "dashboards.html"));
    await this.ready;
    return { service, fresh: true };
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.close();
  }

  private send(state: DashboardState): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("marshal:dashboards-state", state);
  }
}
