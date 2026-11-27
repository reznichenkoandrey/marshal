// Main-process glue for the Claude Code hooks (#263): the Settings toggle that
// installs/removes them, and the receiver that runs only while they are
// installed. Also owns context routing (#286): Stop events keep the session
// dossiers fresh. Kept out of main.ts so that file only calls in.

import path from "node:path";

import { Notification } from "electron";

import { uiLanguage } from "../i18n/ui-language.ts";
import { loadSettings } from "../settings-store.ts";
import { completeOnce, summarizeAnswer } from "./answer-summary.ts";
import { ChromeGuard, cleanDeviceName, isDeviceId, type ChromeDevices } from "./chrome-guard.ts";
import { isUnderRoots, parseRoutingRoots } from "./context-router.ts";
import { DossierKeeper } from "./dossier.ts";
import { focusSession } from "./focus.ts";
import {
  defaultClaudeSettingsPath,
  hookCommand,
  installChromeGuard,
  installHooks,
  readChromeGuardInstalled,
  readHooksInstalled,
  readNeedsPermissionHook,
  uninstallChromeGuard,
  uninstallHooks
} from "./hook-installer.ts";
import { ClaudeHookService, type AssistantRoutes } from "./hook-service.ts";
import { listLiveSessions, type ClaudeSession } from "./registry.ts";
import { SessionNotifier, type SpokenSessionEvent } from "./session-notifier.ts";

const MAX_HELD_NOTIFICATIONS = 20;

export type ClaudeHooksState = {
  installed: boolean;
  settingsPath: string;
  /** Live sessions, and how many of them context routing may read (#303). */
  sessions: { live: number; routable: number };
  error?: string;
};

export type ChromeGuardState = {
  installed: boolean;
  devices: ChromeDevices;
  error?: string;
};

/** The person's answer to "is this browser on this Mac?"; null = they closed the dialog. */
export type ConfirmBrowser = (deviceId: string, name: string) => Promise<boolean | null>;

function inRoutingRoots(session: Pick<ClaudeSession, "cwd">): boolean {
  return isUnderRoots(session.cwd, parseRoutingRoots(loadSettings().claudeCodeRoutingRoots));
}

export class ClaudeHooksController {
  private readonly service: ClaudeHookService;
  private readonly notifier: SessionNotifier;
  // Electron drops a Notification's click handler once the object is
  // collected; hold the shown ones until they are clicked or closed.
  private readonly shown = new Set<Notification>();
  private readonly dossiers: DossierKeeper;
  private ignoredFolder: string | null = null;
  private readonly stopListeners: Array<(sessionId: string, lastMessage: string) => void> = [];
  private readonly quietFolders = new Set<string>();
  private readonly chromeGuard: ChromeGuard;

  constructor(
    userDataDir: string,
    // Every notification text also goes to the assistant home's line (#308).
    private readonly announce: (text: string) => void = () => {},
    // Any hook event may change which sessions wait: the tray badge recounts (#309).
    private readonly onSessionEvent: () => void = () => {},
    // Session results read aloud for the voice assistant (#318).
    speak: (event: SpokenSessionEvent) => void = () => {},
    // Permission prompts answered by voice (#375): the hook's stdout, "" = the usual prompt.
    askPermission: (raw: string) => Promise<string> = async () => "",
    // Call check (#267): finished results are held while a call is active.
    callCheck: () => Promise<boolean> = async () => false,
    // Whose browser is this (#477): only the person may say a browser is on this Mac.
    private readonly confirmBrowser: ConfirmBrowser = async () => null,
    // Turns that answer a voice command are spoken from their own last paragraph (#508).
    voiceAnswer: (sessionId: string, name: string) => boolean = () => false
  ) {
    this.dossiers = new DossierKeeper({
      storePath: path.join(userDataDir, "claude-code", "dossiers.json"),
      complete: (request) => completeOnce(request)
    });
    this.notifier = new SessionNotifier({
      notify: (title, body, onClick) => this.notify(title, body, onClick),
      speak,
      voiceAnswer,
      onCall: callCheck,
      language: uiLanguage,
      summarize: (text) => summarizeAnswer(text, loadSettings().claudeCodeSummaryLanguage),
      findSession: (sessionId) => listLiveSessions().find((session) => session.sessionId === sessionId),
      focus: (pid) => {
        void focusSession(pid).catch((err: unknown) => {
          console.warn("[claude-hooks] focus failed:", err instanceof Error ? err.message : err);
        });
      }
    });
    this.service = new ClaudeHookService(path.join(userDataDir, "claude-code"), (event) => {
      if (this.ignoredFolder && event.cwd && path.resolve(event.cwd) === this.ignoredFolder) return;
      if (event.cwd && this.quietFolders.has(path.resolve(event.cwd))) return;
      void this.notifier.handle(event);
      this.onSessionEvent();
      if (event.type === "stop") for (const listener of this.stopListeners) listener(event.sessionId, event.lastMessage);
      // A finished turn is when "what it is doing now" changes.
      if (event.type === "stop" && loadSettings().claudeCodeContextRouting) {
        const session = listLiveSessions().find((live) => live.sessionId === event.sessionId);
        if (session && inRoutingRoots(session)) void this.dossiers.refresh(session);
      }
    }, askPermission);
    this.chromeGuard = new ChromeGuard(undefined, `${hookCommand(this.service.guardScriptPath)} add`);
    this.service.setChromeGuard({
      judge: (raw) => this.chromeGuard.judge(raw) ?? "allow",
      propose: (form) => this.proposeBrowser(form)
    });
  }

  /** On app start: listen only if the user installed the hooks or the Chrome guard. */
  async startIfInstalled(): Promise<void> {
    if (!readHooksInstalled() && !readChromeGuardInstalled()) return;
    this.upgrade();
    await this.service.start().catch((err: unknown) => {
      console.warn("[claude-hooks] receiver failed to start:", err instanceof Error ? err.message : err);
    });
  }

  /** Called with the session id and its last answer on every finished turn (Stop hook): reminders after a session (#270), plan steps (#278). */
  onSessionStop(listener: (sessionId: string, lastMessage: string) => void): void {
    this.stopListeners.push(listener);
  }

  /** Events from this folder are dropped: the dispatcher's turns in Claude desktop also run the owner's hooks (#437). */
  setIgnoredFolder(dir: string | null): void {
    this.ignoredFolder = dir ? path.resolve(dir) : null;
  }

  /** Events from this folder are dropped too: unattended `claude -p` runs of scheduled workflows (#280). */
  addQuietFolder(dir: string): void {
    this.quietFolders.add(path.resolve(dir));
  }

  /** The voice dispatcher's helper reaches Marshal through the hook receiver (#318). */
  setAssistantRoutes(routes: AssistantRoutes | null): void {
    this.service.setAssistantRoutes(routes);
  }

  /** The voice assistant needs the receiver and the Stop hook: installing them is part of turning it on. */
  async ensureInstalled(): Promise<ClaudeHooksState> {
    if (readHooksInstalled()) {
      this.upgrade();
      await this.service.start();
      return this.state();
    }
    return this.setInstalled(true);
  }

  /** A session's last dossier without rebuilding it; null outside the folders that may be read (#303). */
  cachedDossier(sessionId: string, cwd: string): string | null {
    return inRoutingRoots({ cwd }) ? this.dossiers.cached(sessionId) : null;
  }

  /** For the dispatcher's `./marshal context`: the same scope and dossiers as #286. */
  async routingContext(sessions: readonly ClaudeSession[]): Promise<string> {
    if (!loadSettings().claudeCodeContextRouting) return "off";
    const routable = sessions.filter(inRoutingRoots);
    if (routable.length === 0) return "off";
    const dossiers = await this.dossiers.dossiersFor(routable);
    return JSON.stringify(routable.map((session) => ({
      name: session.name,
      folder: path.basename(session.cwd),
      dossier: dossiers.get(session.sessionId) ?? null
    })));
  }

  // Hooks installed before #375 lack PermissionRequest; adding it is the same merge as an install.
  private upgrade(): void {
    if (!readNeedsPermissionHook()) return;
    try {
      installHooks(this.service.writeScript());
    } catch (err) {
      console.warn("[claude-hooks] permission hook not added:", err instanceof Error ? err.message : err);
    }
  }

  get hookDir(): string {
    return path.dirname(this.service.scriptPath);
  }

  state(error?: string): ClaudeHooksState {
    const live = listLiveSessions();
    return {
      installed: readHooksInstalled(),
      settingsPath: defaultClaudeSettingsPath(),
      sessions: { live: live.length, routable: live.filter(inRoutingRoots).length },
      ...(error ? { error } : {})
    };
  }

  async setInstalled(installed: boolean): Promise<ClaudeHooksState> {
    try {
      if (installed) {
        installHooks(this.service.writeScript());
        await this.service.start();
      } else {
        uninstallHooks();
        this.notifier.dispose();
        // The Chrome guard answers through the same receiver: it stays up for it.
        if (!readChromeGuardInstalled()) this.service.remove();
      }
      return this.state();
    } catch (err) {
      return this.state(err instanceof Error ? err.message : String(err));
    }
  }

  chromeGuardState(error?: string): ChromeGuardState {
    let devices: ChromeDevices = {};
    let readError = error;
    try {
      devices = this.chromeGuard.devices();
    } catch (err) {
      readError ??= err instanceof Error ? err.message : String(err);
    }
    return { installed: readChromeGuardInstalled(), devices, ...(readError ? { error: readError } : {}) };
  }

  async setChromeGuardInstalled(installed: boolean): Promise<ChromeGuardState> {
    try {
      if (installed) {
        this.service.writeScript();
        installChromeGuard(this.service.guardScriptPath);
        await this.service.start();
      } else {
        uninstallChromeGuard();
        if (!readHooksInstalled()) this.service.remove();
      }
      return this.chromeGuardState();
    } catch (err) {
      return this.chromeGuardState(err instanceof Error ? err.message : String(err));
    }
  }

  /** From the tray: the person flips whether a registered browser is on this Mac. */
  setBrowserHere(deviceId: string, here: boolean): ChromeGuardState {
    try {
      this.chromeGuard.setDevice(deviceId, "", here);
      return this.chromeGuardState();
    } catch (err) {
      return this.chromeGuardState(err instanceof Error ? err.message : String(err));
    }
  }

  /** `add <deviceId> <name>` from the guard script: the agent proposes, the dialog decides. */
  private async proposeBrowser(form: string): Promise<string> {
    const params = new URLSearchParams(form);
    const id = (params.get("id") ?? "").trim();
    const name = cleanDeviceName(params.get("name") ?? "");
    if (!isDeviceId(id) || !name) return "usage: add <deviceId> <name>, with the deviceId list_connected_browsers reported.";
    const here = await this.confirmBrowser(id, name);
    if (here === null) return "The person closed the dialog: nothing was recorded. Ask them before proposing it again.";
    this.chromeGuard.setDevice(id, name, here);
    return here
      ? `Recorded: ${id} is "${name}", this computer's browser. Call select_browser again.`
      : `Recorded: ${id} is "${name}", NOT this computer's browser. It is never driven from here: do not select it.`;
  }

  stop(): void {
    this.notifier.dispose();
    this.service.stop();
  }

  private notify(title: string, body: string, onClick: () => void): void {
    this.announce(body ? `${title} — ${body}` : title);
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    const release = () => this.shown.delete(notification);
    notification.on("click", () => {
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
