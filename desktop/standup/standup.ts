// Day review card for a standup (#272): done, doing and blockers from facts
// that are already on disk. Read-only and local, no network. Pure builders
// live here; the readers (git, transcript heads) are small and fed by main.

export type Language = "uk" | "en";

export type CommitFact = { hash: string; subject: string; repo: string; at: string };
export type MeetingFact = { title: string; startedAt: string };
export type SessionFact = { name: string; status: string | null; project: string; lastTopic: string | null; touchedAt: number };

export type StandupCard = { done: string[]; doing: string[]; blockers: string[] };

const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";

/** Format for `git log`: hash, ISO date, subject, separated so subjects with spaces parse. */
export const GIT_LOG_FORMAT = `%H${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s${RECORD_SEPARATOR}`;

export function parseGitLog(stdout: string, repo: string): CommitFact[] {
  const commits: CommitFact[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    const trimmed = record.replace(/^\n+/, "");
    if (trimmed === "") continue;
    const [hash, at, subject] = trimmed.split(FIELD_SEPARATOR);
    if (!hash || !at || subject === undefined) continue;
    commits.push({ hash: hash.slice(0, 8), subject: subject.trim(), repo, at });
  }
  return commits;
}

/** First user prompt of a transcript head, which names what the session is about. */
export function topicFromTranscriptHead(jsonlHead: string, maxChars = 120): string | null {
  for (const line of jsonlHead.split("\n")) {
    if (line.trim() === "") continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "user" || entry.isSidechain === true || entry.isMeta === true) continue;
    const message = entry.message as { content?: unknown } | undefined;
    const content = message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.find((block: { type?: unknown; text?: unknown }) => block.type === "text" && typeof block.text === "string")?.text
        : undefined;
    if (typeof text !== "string") continue;
    const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/\s+/g, " ").trim();
    if (cleaned !== "") return cleaned.slice(0, maxChars);
  }
  return null;
}

/** Local midnight as an epoch ms, so "today" means the owner's day. */
export function startOfDay(now: Date): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

export function isToday(iso: string, now: Date): boolean {
  const at = Date.parse(iso);
  return Number.isFinite(at) && at >= startOfDay(now) && at <= now.getTime();
}

const HEADINGS: Record<Language, { done: string; doing: string; blockers: string; none: string }> = {
  uk: { done: "Зроблено", doing: "В роботі", blockers: "Блокери", none: "—" },
  en: { done: "Done", doing: "Doing", blockers: "Blockers", none: "—" }
};

/**
 * The card: commits and recorded calls are done; sessions touched today are
 * doing; sessions waiting on the owner are blockers.
 */
export function buildStandup(
  facts: { commits: CommitFact[]; meetings: MeetingFact[]; sessions: SessionFact[] },
  now: Date,
  language: Language
): StandupCard {
  const done = [
    ...facts.commits.filter((c) => isToday(c.at, now)).map((c) => `${c.repo}: ${c.subject} (${c.hash})`),
    ...facts.meetings.filter((m) => isToday(m.startedAt, now)).map((m) => `${m.title}`)
  ];
  const touched = facts.sessions.filter((s) => s.touchedAt >= startOfDay(now));
  const blockers = touched
    .filter((s) => s.status === "waiting")
    .map((s) => `${s.name} (${s.project}): ${s.lastTopic ?? "—"}`);
  const doing = touched
    .filter((s) => s.status !== "waiting")
    .map((s) => `${s.name} (${s.project}): ${s.lastTopic ?? "—"}`);
  return { done, doing, blockers };
}

export function renderStandup(card: StandupCard, language: Language): string {
  const h = HEADINGS[language];
  const section = (heading: string, items: string[]): string[] =>
    [`${heading}:`, ...(items.length > 0 ? items.map((item) => `- ${item}`) : [`- ${h.none}`])];
  return [
    ...section(h.done, card.done),
    "",
    ...section(h.doing, card.doing),
    "",
    ...section(h.blockers, card.blockers)
  ].join("\n");
}
