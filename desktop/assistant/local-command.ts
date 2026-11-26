// Voice commands Marshal answers itself, without the dispatcher's model turn
// (#506): its own features with fixed wording, the session status and "are you
// there". Only a whole short utterance counts, like `matchSleepCommand`: a miss
// costs a model turn, a false hit runs the wrong action.

import { speakableProject } from "./waiting-speech.ts";

export type LocalCommand =
  | { kind: "action"; action: string }
  | { kind: "status"; lang: "uk" | "en" }
  | { kind: "presence"; lang: "uk" | "en" };

const NAMES = new Set(["маршал", "маршале", "маршалл", "маршала", "marshal", "marshall", "hey", "гей", "агов", "слухай"]);
const FILLER = new Set(["будь", "ласка", "please", "давай", "можеш", "мені", "зараз", "the", "a", "my", "me", "can", "you", "for"]);
const MAX_WORDS = 7;

const ACTIONS: ReadonlyArray<[action: string, phrases: readonly string[]]> = [
  ["translator", ["перекладач", "відкрий перекладач", "покажи перекладач", "translator", "open translator"]],
  ["translator-close", ["закрий перекладач", "сховай перекладач", "close translator", "hide translator"]],
  ["captions", ["субтитри", "увімкни субтитри", "вимкни субтитри", "captions", "toggle captions"]],
  ["record-call", ["запиши дзвінок", "запиши зустріч", "запис дзвінка", "зупини запис", "record call", "record meeting", "stop recording"]],
  ["record-screen", ["запиши екран", "record screen"]],
  ["recordings", ["записи дзвінків", "відкрий записи", "відкрий записи дзвінків", "покажи записи", "recordings", "open recordings"]],
  ["capture", ["скрін", "зроби скрін", "скріншот", "зроби скріншот", "знімок екрана", "зроби знімок екрана", "screenshot", "take screenshot"]],
  ["play-pause", ["пауза", "на паузу", "постав на паузу", "зніми з паузи", "продовж відео", "pause", "resume", "play"]],
  ["next-track", ["наступний трек", "наступне відео", "наступна пісня", "next track", "next song"]],
  ["previous-track", ["попередній трек", "попереднє відео", "попередня пісня", "previous track", "previous song"]],
  ["skip", ["досить", "пропусти", "замовкни", "помовч", "skip", "stop talking", "be quiet"]],
  ["settings", ["налаштування", "відкрий налаштування", "settings", "open settings"]],
  ["hub", ["хаб", "відкрий хаб", "hub", "open hub"]],
  ["next-meeting", ["наступна зустріч", "яка наступна зустріч", "коли наступна зустріч", "next meeting", "what is next meeting", "when is next meeting"]],
  ["join-meeting", ["підключи до зустрічі", "підключи мене до зустрічі", "join meeting", "join next meeting"]]
];
const STATUS = ["що там по сесіях", "що по сесіях", "як там сесії", "хто працює", "що відбувається", "статус", "status", "session status", "what is going on", "who is working"];
const PRESENCE = ["ти тут", "ти мене чуєш", "привіт", "are you there", "can you hear me", "hello", "hi"];

type Hit = { kind: "action"; action: string } | "status" | "presence";

const LOOKUP = new Map<string, Hit>([
  ...ACTIONS.flatMap(([action, phrases]) => phrases.map((phrase): [string, Hit] => [key(phrase), { kind: "action", action }])),
  ...STATUS.map((phrase): [string, Hit] => [key(phrase), "status"]),
  ...PRESENCE.map((phrase): [string, Hit] => [key(phrase), "presence"])
]);

function words(text: string): string[] {
  return text.toLowerCase().replace(/[’`]/g, "'").replace(/[^\p{L}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
}

// Phrases go through the same filter as speech, so "open the translator" and "open translator" meet.
function key(text: string): string {
  return words(text).filter((word) => !NAMES.has(word) && !FILLER.has(word)).join(" ");
}

export function commandLanguage(text: string): "uk" | "en" {
  return /\p{Script=Cyrillic}/u.test(text) ? "uk" : "en";
}

export function matchLocalCommand(text: string): LocalCommand | null {
  // A capture note ends with a "Screenshot:" line: it is for a session, never local.
  if (text.includes("\n")) return null;
  const all = words(text);
  if (all.length === 0 || all.length > MAX_WORDS) return null;
  const hit = LOOKUP.get(key(text));
  if (!hit) return null;
  if (hit === "status" || hit === "presence") return { kind: hit, lang: commandLanguage(text) };
  return hit;
}

export type StatusSession = { project: string; status: string | null; waitingFor: string | null };

type ProjectState = "question" | "permission" | "working" | "done";
const STATE_RANK: Record<ProjectState, number> = { question: 0, permission: 1, working: 2, done: 3 };

function stateOf(session: StatusSession): ProjectState {
  if (session.status === "waiting") return session.waitingFor === "input needed" ? "question" : "permission";
  if (session.status === "busy" || session.status === "shell") return "working";
  return "done";
}

// More named "done" projects than this read as a list: "the rest are done" instead.
const MAX_NAMED_DONE = 2;

/**
 * The status answer the dispatcher used to give after `./marshal sessions`:
 * only the state, by project, never what a session works on.
 */
export function describeSessionStatus(sessions: readonly StatusSession[], lang: "uk" | "en"): string {
  const uk = lang === "uk";
  if (sessions.length === 0) return uk ? "Живих сесій немає." : "No live sessions.";
  const projects = new Map<string, ProjectState>();
  for (const session of sessions) {
    const state = stateOf(session);
    const before = projects.get(session.project);
    if (!before || STATE_RANK[state] < STATE_RANK[before]) projects.set(session.project, state);
  }
  const byState = (state: ProjectState) => [...projects].filter(([, s]) => s === state).map(([project]) => speakableProject(project));
  const done = byState("done");
  if (done.length === projects.size) return uk ? "Усі сесії готові." : "All sessions are done.";

  const parts = [
    ...byState("question").map((p) => (uk ? `у ${p} питання` : `${p} has a question`)),
    ...byState("permission").map((p) => (uk ? `${p} чекає дозволу` : `${p} needs permission`)),
    ...byState("working").map((p) => (uk ? `${p} ще працює` : `${p} is still working`))
  ];
  if (done.length > MAX_NAMED_DONE) parts.push(uk ? "решта готові" : "the rest are done");
  else parts.push(...done.map((p) => (uk ? `${p} готово` : `${p} is done`)));
  const sentence = parts.join(", ");
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}.`;
}
