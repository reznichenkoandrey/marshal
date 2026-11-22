// Board window (#276, docs/VOICE_BOARDS.md): a spoken or typed request draws
// one Mermaid diagram. Main only talks to the model and saves the result;
// parsing, op application and Mermaid itself live in the renderer, so nothing
// of a board exists while the window is closed (#281).

import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, shell } from "electron";

import { createSummaryStreamer } from "../captions/summarizer.ts";
import { completeOnce, type OneShotRequest } from "../claude-code/answer-summary.ts";
import { t } from "../i18n/ui-language.ts";
import {
  askBoardModel,
  buildBoardRequest,
  buildBrainstormRequest,
  buildRepairRequest,
  parseBoardLanguage,
  parseBoardRole,
  type BoardComplete,
  type BoardReply
} from "./board-prompt.ts";
import { sanitizeBoardState, saveBoard } from "./board-store.ts";

export type BoardMode = "diagram" | "brainstorm";
export type BoardStream = (request: OneShotRequest, onDelta: (delta: string) => void) => Promise<string | null>;

/** The summary provider's stream with a board prompt: ops reach the window as the model writes them. */
const streamOnce: BoardStream = async (request, onDelta) => {
  const streamer = createSummaryStreamer();
  if (!streamer) return null;
  try {
    return await streamer.streamMessages(
      { system: request.system, systemInstructions: request.system, referenceContext: "", user: request.user },
      request.maxTokens,
      onDelta,
      AbortSignal.timeout(request.timeoutMs ?? 60_000)
    );
  } catch (err) {
    console.warn(`[board] ${request.label} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
};

const rendererDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderer");

export class BoardWindow {
  private window: BrowserWindow | null = null;
  private loaded = false;
  private pending: { text: string; mode: BoardMode } | null = null;
  private lastFile: string | null = null;

  constructor(
    private readonly preloadPath: string,
    private readonly boardsDir: string,
    private readonly complete: BoardComplete = completeOnce,
    private readonly stream: BoardStream = streamOnce
  ) {}

  /**
   * `request` is a spoken request (#276 Stage 2): the page draws it as if it
   * were typed. The window then shows without taking focus, because the owner
   * spoke from another app and is still typing there.
   */
  open(request = "", mode?: BoardMode): void {
    const text = request.trim();
    // A mode alone still reaches the page: "open the brainstorm board" switches it.
    const spoken = text !== "" || mode ? { text, mode: mode ?? "diagram" } : null;
    if (this.window && !this.window.isDestroyed()) {
      if (text === "") this.window.focus();
      if (!spoken) return;
      if (this.loaded) this.window.webContents.send("marshal:board-request", spoken);
      else this.pending = spoken;
      return;
    }
    this.pending = spoken;
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
    ipc.handle("marshal:board:brainstorm", (_event, input: { text?: unknown; role?: unknown; language?: unknown; board?: unknown }) => {
      const text = typeof input?.text === "string" ? input.text.trim() : "";
      if (text === "") return { ok: false, error: t("board.error.empty") } satisfies BoardReply;
      const request = buildBrainstormRequest(
        text,
        sanitizeBoardState(input.board),
        parseBoardRole(input.role),
        parseBoardLanguage(input.language)
      );
      const send = (delta: string) => {
        if (!window.isDestroyed()) window.webContents.send("marshal:board-delta", { delta });
      };
      return askBoardModel(request, (next) => this.stream(next, send), t("board.error.noModel"));
    });
    ipc.handle("marshal:board:save", (_event, input: { request?: unknown; source?: unknown; language?: unknown; board?: unknown; id?: unknown }) => {
      const brainstorm = input?.board !== undefined;
      if (!brainstorm && typeof input?.source !== "string") return { ok: false };
      try {
        const saved = saveBoard(this.boardsDir, {
          request: typeof input.request === "string" ? input.request : "",
          language: parseBoardLanguage(input.language),
          ...(brainstorm
            ? { state: sanitizeBoardState(input.board), id: typeof input.id === "string" ? input.id : undefined }
            : { source: input.source as string })
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
      const spoken = this.pending;
      this.pending = null;
      if (spoken) window.webContents.send("marshal:board-request", spoken);
      if (spoken && spoken.text !== "") {
        window.showInactive();
        return;
      }
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
