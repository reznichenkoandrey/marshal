// Main-process glue for dictating into a Claude Code session (#264): route the
// transcript, ask when it is ambiguous, focus the session's terminal tab and
// type into it. Routing rules live in session-router.ts.

import { clipboard, Menu, Notification, type Tray } from "electron";

import { deliverTranscript, insertTextIntoFocused, probeFocusedElement, sendKeystroke } from "../dictation/focus-paste.ts";
import { focusSession } from "./focus.ts";
import { describeStatus, listLiveSessions, type ClaudeSession } from "./registry.ts";
import type { ContextRouter } from "./context-router.ts";
import { planDelivery, SessionCommandRouter, type Delivery } from "./session-router.ts";

/** What #286 adds: the router and the "Sent to <session> by context" notice. */
export interface ContextRouting {
  readonly contextRouter: ContextRouter;
  notifyRoutedByContext(session: Pick<ClaudeSession, "name">, command: string, onResend: () => void): void;
}

// Terminal/iTerm need a moment after `activate` before keystrokes land in the
// newly selected tab rather than the previous one.
const FOCUS_SETTLE_MS = 150;
// Menu clicks arrive after the menu reports it closed.
const PICKER_CLICK_GRACE_MS = 200;

export class SessionDictation {
  private readonly router: SessionCommandRouter;

  constructor(
    private readonly getTray: () => Tray | null,
    private readonly contextRouting?: ContextRouting
  ) {
    this.router = new SessionCommandRouter(contextRouting?.contextRouter);
  }

  async handle(transcript: string): Promise<void> {
    const decision = await this.router.route(transcript, listLiveSessions());
    switch (decision.kind) {
      case "cancelled":
        return;
      case "no-sessions":
        this.notify("No Claude Code session is running", transcript);
        return;
      case "empty":
        this.notify(`Nothing to send to ${decision.session.name}`, "Say the command right after the session name.");
        return;
      case "send":
        if ((await this.send(decision.session, decision.command)) && decision.byContext) {
          this.contextRouting?.notifyRoutedByContext(decision.session, decision.command, () => {
            void this.resend(decision.session, decision.command);
          });
        }
        return;
      case "pick": {
        const session = await this.pick(decision.candidates, decision.command);
        if (session) await this.send(session, decision.command);
      }
    }
  }

  private async resend(wrong: ClaudeSession, command: string): Promise<void> {
    const others = listLiveSessions().filter((session) => session.sessionId !== wrong.sessionId);
    if (others.length === 0) {
      this.notify("No other Claude Code session is running", command);
      return;
    }
    const session = await this.pick(others, command);
    if (session) await this.send(session, command);
  }

  /** True only when the command was typed into the session. */
  private async send(session: ClaudeSession, command: string): Promise<boolean> {
    const delivery = planDelivery(command, session);
    if (delivery.kind === "blocked") {
      this.notify(`${session.name} ${delivery.reason}`, command);
      return false;
    }
    // Paste or typing only reaches the right session when its own tab is in
    // front; an app-level focus (Claude desktop, VS Code) shows whichever
    // session that app last had open.
    const focused = await focusSession(session.pid).catch(() => null);
    if (focused !== "tab") {
      if (delivery.kind === "text") clipboard.writeText(delivery.text);
      this.notify(
        `Open ${session.name} to send this`,
        `Marshal can type only into Terminal and iTerm sessions. ${delivery.kind === "text" ? "The command is on the clipboard." : ""}`.trim()
      );
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, FOCUS_SETTLE_MS));
    if (await this.type(delivery)) {
      this.router.remember(session.sessionId);
      return true;
    }
    this.notify(`Could not type into ${session.name}`, "The command is on the clipboard.");
    return false;
  }

  private async type(delivery: Exclude<Delivery, { kind: "blocked" }>): Promise<boolean> {
    if (delivery.kind === "key") {
      if (delivery.key === "escape") {
        return sendKeystroke("escape").then(() => true, () => false);
      }
      return insertTextIntoFocused(delivery.key);
    }
    clipboard.writeText(delivery.text);
    const result = await deliverTranscript(delivery.text, await probeFocusedElement());
    if (result === "clipboard") return false;
    return sendKeystroke("return").then(() => true, () => false);
  }

  private pick(candidates: ClaudeSession[], command: string): Promise<ClaudeSession | null> {
    const tray = this.getTray();
    if (!tray) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const settle = (session: ClaudeSession | null) => {
        if (settled) return;
        settled = true;
        resolve(session);
      };
      const preview = command.length > 60 ? `${command.slice(0, 57)}…` : command;
      const menu = Menu.buildFromTemplate([
        { label: `Send “${preview}” to:`, enabled: false },
        ...candidates.map((session) => ({
          label: `${session.name} — ${describeStatus(session)}`,
          click: () => settle(session)
        })),
        { type: "separator" as const },
        { label: "Cancel", click: () => settle(null) }
      ]);
      menu.once("menu-will-close", () => setTimeout(() => settle(null), PICKER_CLICK_GRACE_MS));
      tray.popUpContextMenu(menu);
    });
  }

  private notify(title: string, body: string): void {
    if (!Notification.isSupported()) return;
    new Notification({ title: `Marshal — ${title}`, body, silent: true }).show();
  }
}
