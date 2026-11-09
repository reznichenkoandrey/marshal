// Main-process glue for the Claude Code hooks (#263): the Settings toggle that
// installs/removes them, and the receiver that runs only while they are
// installed. Also owns context routing (#286): Stop events keep the session
// dossiers fresh. Kept out of main.ts so that file only calls in.

import path from "node:path";

import { Notification } from "electron";

import { loadSettings } from "../settings-store.ts";
import { completeOnce, summarizeAnswer } from "./answer-summary.ts";
import { createContextRouter, routedNotice, type ContextRouter } from "./context-router.ts";
import { DossierKeeper } from "./dossier.ts";
import { focusSession } from "./focus.ts";
import { defaultClaudeSettingsPath, installHooks, readHooksInstalled, uninstallHooks } from "./hook-installer.ts";
import { ClaudeHookService } from "./hook-service.ts";
import { listLiveSessions, type ClaudeSession } from "./registry.ts";
import { SessionNotifier } from "./session-notifier.ts";

const MAX_HELD_NOTIFICATIONS = 20;

export type ClaudeHooksState = { installed: boolean; settingsPath: string; error?: string };

export class ClaudeHooksController {
  private readonly service: ClaudeHookService;
  private readonly notifier: SessionNotifier;
  // Electron drops a Notification's click handler once the object is
  // collected; hold the shown ones until they are clicked or closed.
  private readonly shown = new Set<Notification>();
  private readonly dossiers: DossierKeeper;
  /** For #264: the session a command that names none is meant for. */
  readonly contextRouter: ContextRouter;

  constructor(userDataDir: string) {
    this.dossiers = new DossierKeeper({
      storePath: path.join(userDataDir, "claude-code", "dossiers.json"),
      complete: (request) => completeOnce(request)
    });
    this.contextRouter = createContextRouter({
      enabled: () => loadSettings().claudeCodeContextRouting,
      dossiers: (sessions) => this.dossiers.dossiersFor(sessions),
      complete: (request) => completeOnce(request)
    });
    this.notifier = new SessionNotifier({
      notify: (title, body, onClick) => this.notify(title, body, onClick),
      summarize: (text) => summarizeAnswer(text, loadSettings().claudeCodeSummaryLanguage),
      findSession: (sessionId) => listLiveSessions().find((session) => session.sessionId === sessionId),
      focus: (pid) => {
        void focusSession(pid).catch((err: unknown) => {
          console.warn("[claude-hooks] focus failed:", err instanceof Error ? err.message : err);
        });
      }
    });
    this.service = new ClaudeHookService(path.join(userDataDir, "claude-code"), (event) => {
      void this.notifier.handle(event);
      // A finished turn is when "what it is doing now" changes.
      if (event.type === "stop" && loadSettings().claudeCodeContextRouting) {
        const session = listLiveSessions().find((live) => live.sessionId === event.sessionId);
        if (session) void this.dossiers.refresh(session);
      }
    });
  }

  /** On app start: listen only if the user installed the hooks. */
  async startIfInstalled(): Promise<void> {
    if (!readHooksInstalled()) return;
    await this.service.start().catch((err: unknown) => {
      console.warn("[claude-hooks] receiver failed to start:", err instanceof Error ? err.message : err);
    });
  }

  state(error?: string): ClaudeHooksState {
    return { installed: readHooksInstalled(), settingsPath: defaultClaudeSettingsPath(), ...(error ? { error } : {}) };
  }

  async setInstalled(installed: boolean): Promise<ClaudeHooksState> {
    try {
      if (installed) {
        installHooks(this.service.writeScript());
        await this.service.start();
      } else {
        uninstallHooks();
        this.notifier.dispose();
        this.service.remove();
      }
      return this.state();
    } catch (err) {
      return this.state(err instanceof Error ? err.message : String(err));
    }
  }

  stop(): void {
    this.notifier.dispose();
    this.service.stop();
  }

  /**
   * For #264, after sending a command picked by context: "Sent to <session>
   * by context". Clicking it or its button calls `onResend` (the picker), so
   * a wrong route can be redone from the notification.
   */
  notifyRoutedByContext(session: Pick<ClaudeSession, "name">, command: string, onResend: () => void): void {
    const { title, body } = routedNotice(session.name, command);
    this.notify(title, body, onResend, "Send elsewhere");
  }

  private notify(title: string, body: string, onClick: () => void, actionText?: string): void {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title,
      body,
      ...(actionText ? { actions: [{ type: "button" as const, text: actionText }] } : {})
    });
    const release = () => this.shown.delete(notification);
    notification.on("click", () => {
      release();
      onClick();
    });
    notification.on("action", () => {
      release();
      onClick();
    });
    notification.on("close", release);
    this.shown.add(notification);
    // macOS does not always report a dismissal; keep the newest ones only.
    if (this.shown.size > MAX_HELD_NOTIFICATIONS) this.shown.delete(this.shown.values().next().value as Notification);
    notification.show();
  }
}
