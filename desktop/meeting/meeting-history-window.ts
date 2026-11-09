// "Meeting Recordings" window: every call MeetingRecorder saved, newest
// first, with an inline player. Deleting moves the recording's folder to the
// Trash rather than unlinking it — a call is not something to lose to a misclick.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow, shell } from "electron";

import { finishMeeting } from "./meeting-assembly.ts";
import type { MeetingLibrary } from "./meeting-library.ts";
import { meetingNotesFiles, parseNotesLanguage } from "./meeting-notes.ts";
import { MeetingNotesService } from "./meeting-notes-service.ts";

const currentFilePath = fileURLToPath(import.meta.url);
const desktopDistDir = path.dirname(currentFilePath);
const rendererDir = path.join(desktopDistDir, "..", "renderer");

export class MeetingHistoryWindow {
  private window: BrowserWindow | null = null;
  private readonly finishing = new Set<string>();
  // Owned here, not by the BrowserWindow: closing the window keeps the job running.
  private readonly notes = new MeetingNotesService((progress) => this.sendNotesProgress(progress));

  constructor(
    private readonly preloadPath: string,
    private readonly library: MeetingLibrary,
    private readonly libraryRoot: string,
    private readonly activeId: () => string | null
  ) {}

  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      this.refresh();
      return;
    }

    this.window = new BrowserWindow({
      width: 820,
      height: 600,
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

    this.window.on("closed", () => {
      this.window = null;
    });
    this.window.webContents.once("did-finish-load", () => {
      this.refresh();
      this.window?.show();
      this.window?.focus();
    });
    void this.window.loadFile(path.join(rendererDir, "meeting-history.html"));
  }

  close(): void {
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
  }

  refresh(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("marshal:meeting-history-loaded", {
      folder: this.libraryRoot,
      entries: this.library.list(this.activeId())
    });
    this.sendNotesProgress(this.notes.current());
  }

  private sendNotesProgress(progress: ReturnType<MeetingNotesService["current"]>): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("marshal:meeting-history-notes-progress", progress);
  }

  /** "Transcribe & summarize" (#271). Only ever started by this click — never automatically (#229). */
  async summarize(id: string, language: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.library.list(this.activeId()).find((candidate) => candidate.id === id);
    if (!entry) return { ok: false, error: "Recording not found." };
    if (entry.state !== "done" || !entry.audioPath) return { ok: false, error: "This recording has no finished audio." };
    if (this.finishing.has(id)) return { ok: false, error: "This recording is being finished." };
    const result = await this.notes.run({
      id,
      folder: entry.folder,
      audioPath: entry.audioPath,
      startedAt: entry.startedAt,
      language: parseNotesLanguage(language)
    });
    this.refresh();
    return result;
  }

  cancelNotes(id: string): boolean {
    return this.notes.cancel(id);
  }

  async readNotes(id: string): Promise<unknown> {
    const folder = this.library.folderFor(id);
    if (!folder) return null;
    try {
      return JSON.parse(await fs.readFile(meetingNotesFiles(folder).notesJson, "utf8")) as unknown;
    } catch {
      return null;
    }
  }

  async openNotesFile(id: string, file: "notes" | "transcript"): Promise<{ ok: boolean; error?: string }> {
    const folder = this.library.folderFor(id);
    if (!folder) return { ok: false, error: "Recording not found." };
    const files = meetingNotesFiles(folder);
    const failure = await shell.openPath(file === "transcript" ? files.transcript : files.notesMd);
    return failure ? { ok: false, error: failure } : { ok: true };
  }

  reveal(filePath: string): { ok: boolean; error?: string } {
    if (!this.library.contains(filePath)) return { ok: false, error: "Path is outside the recordings folder." };
    shell.showItemInFolder(filePath);
    return { ok: true };
  }

  /** Builds the final files of an interrupted or failed recording from its raw chunks (#254). */
  async finish(id: string): Promise<{ ok: boolean; error?: string }> {
    if (id === this.activeId()) return { ok: false, error: "This recording is still in progress." };
    if (this.finishing.has(id)) return { ok: false, error: "This recording is already being finished." };
    const folder = this.library.folderFor(id);
    if (!folder) return { ok: false, error: "Recording not found." };
    this.finishing.add(id);
    try {
      await finishMeeting(folder);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    } finally {
      this.finishing.delete(id);
      this.refresh();
    }
  }

  async trash(id: string): Promise<{ ok: boolean; error?: string }> {
    if (id === this.activeId()) return { ok: false, error: "This recording is still in progress." };
    if (this.finishing.has(id)) return { ok: false, error: "This recording is being finished." };
    if (this.notes.current()?.id === id) return { ok: false, error: "This recording is being transcribed." };
    const folder = this.library.folderFor(id);
    if (!folder) return { ok: false, error: "Recording not found." };
    try {
      await shell.trashItem(folder);
      this.refresh();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}
