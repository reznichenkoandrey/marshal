// Picks the Claude Code session a spoken command is meant for when the
// command names none (#286): one cheap model call with the command and each
// live session's dossier returns exactly one session or "unsure". Unsure goes
// to the picker (#264) — this never guesses. The gesture, the name matcher and
// the picker live in #264; this is the half it calls when no name matched.

import type { OneShotRequest } from "./answer-summary.ts";
import type { ClaudeSession } from "./registry.ts";

export type ContextRoute =
  | { kind: "session"; sessionId: string }
  | { kind: "unsure"; candidates: string[] } // sessionIds → picker
  | { kind: "off" }; // setting disabled

export interface ContextRouter {
  route(command: string, sessions: readonly ClaudeSession[]): Promise<ContextRoute>;
}

export type ContextRouterDeps = {
  enabled: () => boolean;
  dossiers: (sessions: readonly ClaudeSession[]) => Promise<Map<string, string>>;
  complete: (request: OneShotRequest) => Promise<string | null>;
};

export type RouteCandidate = { label: string; name: string; cwd: string; dossier: string | null };

const ROUTE_SYSTEM =
  "You route a short voice command to one of several Claude Code coding sessions. Each session has a label, " +
  "a title, a working directory and a dossier of what it works on. The command and the dossiers may be in " +
  "Ukrainian or English, mixed, with speech-to-text spelling errors: match by meaning across languages " +
  "(\"фікс кешу\" is about cache invalidation, \"тести\" are tests).\n" +
  "Reply with the label of the one session the command is clearly about, e.g. S2.\n" +
  "If the command fits more than one session, fits none, or is too generic to tell (\"run the tests\", \"так\"), " +
  "reply UNSURE followed by the labels that could fit, e.g. UNSURE S1 S3. Never guess.\n" +
  "Reply with nothing else.";

export function buildRouteRequest(command: string, candidates: readonly RouteCandidate[]): OneShotRequest {
  const blocks = candidates.map((candidate) =>
    [
      `${candidate.label}: ${candidate.name}`,
      `Directory: ${candidate.cwd}`,
      candidate.dossier ?? "Dossier: not available yet"
    ].join("\n")
  );
  return {
    system: ROUTE_SYSTEM,
    user: `Sessions:\n\n${blocks.join("\n\n")}\n\nCommand: ${command}`,
    maxTokens: 24,
    label: "context route"
  };
}

export type RouteDecision = { pick: string } | { unsure: string[] };

/**
 * Exactly one known label is a pick; anything else — UNSURE, an unknown
 * label, two labels, prose, no reply — is unsure. The candidates are the
 * labels an UNSURE reply names when it names at least two, else all of them.
 */
export function parseRouteReply(reply: string | null, labels: readonly string[]): RouteDecision {
  const text = (reply ?? "").trim().toUpperCase();
  const single = /^(S\d+)\.?$/u.exec(text);
  if (single && labels.includes(single[1])) return { pick: single[1] };
  if (/^UNSURE\b/u.test(text)) {
    const named = [...new Set(text.match(/\bS\d+\b/gu) ?? [])].filter((label) => labels.includes(label));
    if (named.length >= 2) return { unsure: named };
  }
  return { unsure: [...labels] };
}

export function createContextRouter(deps: ContextRouterDeps): ContextRouter {
  return {
    async route(command, sessions) {
      if (!deps.enabled()) return { kind: "off" };
      const ids = sessions.map((session) => session.sessionId);
      if (sessions.length === 0) return { kind: "unsure", candidates: [] };
      // The only live session is the only possible target; the picker would
      // offer just it, so the model call buys nothing.
      if (sessions.length === 1) return { kind: "session", sessionId: ids[0] };
      if (command.trim() === "") return { kind: "unsure", candidates: ids };

      const dossiers = await deps.dossiers(sessions).catch((err: unknown) => {
        console.warn("[claude-code] dossiers unavailable:", err instanceof Error ? err.message : err);
        return new Map<string, string>();
      });
      const candidates = sessions.map((session, index) => ({
        label: `S${index + 1}`,
        name: session.name,
        cwd: session.cwd,
        dossier: dossiers.get(session.sessionId) ?? null
      }));
      const reply = await deps.complete(buildRouteRequest(command, candidates));
      const decision = parseRouteReply(reply, candidates.map((candidate) => candidate.label));
      const idOf = (label: string) => ids[Number(label.slice(1)) - 1];
      return "pick" in decision
        ? { kind: "session", sessionId: idOf(decision.pick) }
        : { kind: "unsure", candidates: decision.unsure.map(idOf) };
    }
  };
}

const NOTICE_COMMAND_CHARS = 120;

/** The "Sent to <session> by context" notification, so a wrong route is visible. */
export function routedNotice(sessionName: string, command: string): { title: string; body: string } {
  const text = command.trim();
  return {
    title: `Sent to ${sessionName} by context`,
    body: text.length > NOTICE_COMMAND_CHARS ? `${text.slice(0, NOTICE_COMMAND_CHARS)}…` : text
  };
}
