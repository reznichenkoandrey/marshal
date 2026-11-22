// Board window (#276, docs/VOICE_BOARDS.md): a spoken or typed request draws
// one Mermaid diagram. Main only talks to the model and saves the result;
// parsing, op application and Mermaid itself live in the renderer, so nothing
// of a board exists while the window is closed (#281).

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, shell } from "electron";

import { completeOnce } from "../claude-code/answer-summary.ts";
import { t } from "../i18n/ui-language.ts";
import {
  askBoardModel,
  buildBoardRequest,
  buildRepairRequest,
  parseBoardLanguage,
  type BoardComplete,
  type BoardReply
} from "./board-prompt.ts";
import { saveBoard } from "./board-store.ts";

const rendererDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderer");

export class BoardWindow {
  private window: BrowserWindow | null = null;
  private loaded = false;
  private pending: string | null = null;
  private lastFile: string | null = null;

  constructor(
    private readonly preloadPath: string,
    private readonly boardsDir: string,
    private readonly complete: BoardComplete = completeOnce
  ) {}

  /**
   * `request` is a spoken request (#276 Stage 2): the page draws it as if it
   * were typed. The window then shows without taking focus, because the owner
   * spoke from another app and is still typing there.
   */
  open(request = ""): void {
    const text = request.trim();
    if (this.window && !this.window.isDestroyed()) {
      if (text === "") this.window.focus();
      else if (this.loaded) this.window.webContents.send("marshal:board-request", { text });
      else this.pending = text;
      return;
    }
    this.pending = text === "" ? null : text;
    this.loaded = false;

    const window = new BrowserWindow({
      width: 1100,
      height: 760,
      minWidth: 520,
      minHeight: 400,
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

    // Handlers live on this window's own webContents, so no other page can ask for a model call.
    const ipc = window.webContents.ipc;
    ipc.handle("marshal:board:draw", (_event, input: { text?: unknown; language?: unknown }) => {
      const text = typeof input?.text === "string" ? input.text.trim() : "";
      if (text === "") return { ok: false, error: t("board.error.empty") } satisfies BoardReply;
      return askBoardModel(buildBoardRequest(text, parseBoardLanguage(input.language)), this.complete, t("board.error.noModel"));
    });
    ipc.handle("marshal:board:repair", (_event, input: { source?: unknown; error?: unknown; language?: unknown }) => {
      const source = typeof input?.source === "string" ? input.source : "";
      const error = typeof input?.error === "string" ? input.error : "";
      if (source.trim() === "") return { ok: false, error: t("board.error.empty") } satisfies BoardReply;
      return askBoardModel(
        buildRepairRequest(source, error, parseBoardLanguage(input.language)),
        this.complete,
        t("board.error.noModel")
      );
    });
    ipc.handle("marshal:board:save", (_event, input: { request?: unknown; source?: unknown; language?: unknown }) => {
      if (typeof input?.source !== "string") return { ok: false };
      try {
        const saved = saveBoard(this.boardsDir, {
          request: typeof input.request === "string" ? input.request : "",
          source: input.source,
          language: parseBoardLanguage(input.language)
        });
        if (!saved) return { ok: false };
        this.lastFile = saved.file;
        return { ok: true, id: saved.id };
      } catch (err) {
        console.warn(`[board] save failed: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false };
      }
    });
    // Only the file main wrote itself: the page never names a path.
    ipc.handle("marshal:board:reveal", () => {
      if (this.lastFile) shell.showItemInFolder(this.lastFile);
      return { ok: this.lastFile !== null };
    });
    ipc.handle("marshal:board:close", () => this.close());

    // The page renders model text: it never opens a window and never leaves board.html.
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());

    window.on("closed", () => {
      this.window = null;
      this.loaded = false;
      this.pending = null;
      this.lastFile = null;
    });
    window.webContents.once("did-finish-load", () => {
      this.loaded = true;
      if (this.pending === null) {
        window.show();
        window.focus();
        return;
      }
      window.showInactive();
      window.webContents.send("marshal:board-request", { text: this.pending });
      this.pending = null;
    });
    void window.loadFile(path.join(rendererDir, "board.html"));
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
  }
}
