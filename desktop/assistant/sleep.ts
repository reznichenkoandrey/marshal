// "Маршал, спати" / "Маршал, прокинься" (#375). Matched in main before the
// dispatcher: no model round trip, and it works while the dispatcher is down.
// Only a whole short utterance counts, so "скажи marshal, що час спати" still
// goes to a session.

export type SleepCommand = "sleep" | "wake";

const NAMES = new Set(["маршал", "маршале", "маршалл", "маршала", "marshal", "marshall", "hey", "гей", "агов"]);
const FILLER = new Set(["будь", "ласка", "please", "давай", "можеш", "іди", "йди", "піди", "лягай", "go", "to", "up", "now", "зараз", "вже", "пора", "час"]);
const SLEEP = new Set(["спати", "спать", "спи", "засинай", "засни", "заснути", "відпочинь", "відпочивай", "sleep"]);
const WAKE = new Set(["прокинься", "прокидайся", "прокинутись", "проснись", "просыпайся", "вставай", "wake", "awake"]);
const MAX_WORDS = 5;

export function matchSleepCommand(text: string): SleepCommand | null {
  const words = text.toLowerCase().replace(/[^\p{L}\s'’-]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_WORDS) return null;
  const rest = words.filter((word) => !NAMES.has(word) && !FILLER.has(word));
  if (rest.length !== 1) return null;
  if (SLEEP.has(rest[0])) return "sleep";
  if (WAKE.has(rest[0])) return "wake";
  return null;
}
