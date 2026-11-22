// Board window (#276, Stage 1 of docs/VOICE_BOARDS.md): a text box drives one
// Mermaid diagram. Main only talks to the model; parsing, op application and
// Mermaid itself live in the renderer, so nothing of a board exists while the
// window is closed (#281).

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow } from "electron";

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

const rendererDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderer");

export class BoardWindow {
  private window: BrowserWindow | null = null;

  constructor(
    private readonly preloadPath: string,
    private readonly complete: BoardComplete = completeOnce
  ) {}

  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      return;
    }

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
    ipc.handle("marshal:board:close", () => this.close());

    // The page renders model text: it never opens a window and never leaves board.html.
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());

    window.on("closed", () => {
      this.window = null;
    });
    window.webContents.once("did-finish-load", () => {
      window.show();
      window.focus();
    });
    void window.loadFile(path.join(rendererDir, "board.html"));
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
  }
}
