// "Маршал, ідея …" (#558): the idea is appended to the ideas folder's
// INBOX.md at once, so it survives whatever happens next, and a Claude
// session opens in that folder to research, plan and prototype it by the
// folder's own rules. No model turn: the trigger is a fixed phrase.

import { appendFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type IdeaLang = "uk" | "en";

const SEP = "[\\s,.:;!?—–-]";
const NAME = "(?:маршал[еа]?|маршалл|marshal|marshall|гей|hey|агов|слухай)";
// Longer phrases first: "запиши ідею" must not stop at "запиши".
const TRIGGER = "(?:нова\\s+ідея|запиши\\s+ідею|ідея|запиши|new\\s+idea|idea|note)";
const PATTERN = new RegExp(`^${SEP}*(?:${NAME}${SEP}+)*${TRIGGER}(?=$|${SEP})${SEP}*`, "iu");

/** The idea's words after the trigger ("" when the owner said only the trigger), or null when it is not an idea. */
export function matchIdeaCommand(text: string): { idea: string } | null {
  if (text.includes("\n")) return null;
  const match = PATTERN.exec(text);
  return match ? { idea: text.slice(match[0].length).trim() } : null;
}

/** The folder from Settings with `~/` expanded; null when none is set. */
export function resolveIdeasDir(setting: string, home = homedir()): string | null {
  const value = setting.trim();
  if (!value) return null;
  if (value === "~") return home;
  return value.startsWith("~/") ? path.join(home, value.slice(2)) : path.resolve(value);
}

const pad = (value: number) => String(value).padStart(2, "0");

export function ideaHeading(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

const INBOX_HEADER: Record<IdeaLang, string> = {
  uk: "# Inbox ідей\n\nІдеї, надиктовані Marshal («Маршал, ідея …»). Текст із розпізнавання мови, можливі помилки.\n",
  en: "# Ideas inbox\n\nIdeas dictated to Marshal (\"Marshal, idea …\"). Speech recognition text, may contain slips.\n"
};

/** Appends the idea under a dated heading; the folder must exist. Returns the heading. */
export async function appendIdea(dir: string, idea: string, now: Date, lang: IdeaLang): Promise<string> {
  if (!(await stat(dir)).isDirectory()) throw new Error(`${dir} is not a folder`);
  const inbox = path.join(dir, "INBOX.md");
  const fresh = await stat(inbox).then(() => false, () => true);
  const heading = ideaHeading(now);
  // Speech has no markdown of its own: a leading "#" would become a heading.
  const body = idea.replace(/^#+\s*/u, "");
  await appendFile(inbox, `${fresh ? INBOX_HEADER[lang] : ""}\n## ${heading}\n\n${body}\n`, { mode: 0o600 });
  return heading;
}

/** The task for the session that takes the idea further. */
export function ideaBrief(idea: string, heading: string, lang: IdeaLang): string {
  if (lang === "en") {
    return [
      `A new idea, dictated to Marshal and appended to INBOX.md under "## ${heading}" (speech recognition, may contain slips):`,
      `"${idea}"`,
      "",
      "1. Read this folder's README.md, CLAUDE.md and its docs standard (if any) and follow their rules over this list.",
      "2. If the idea duplicates an existing idea folder or backlog item, add to that one instead of creating a new one.",
      "3. Otherwise create the idea's folder the way the existing ones are named, with IDEA.md like theirs.",
      "4. Check whether it is viable with web search: real competitors with prices, demand, store and legal risks. Write the overview with a clear go / no-go.",
      "5. GO: write the development plan and the rest of the docs (parallel subagents are fine), and a clickable HTML prototype in design/ when the idea has a UI. NO-GO: only the overview with the reason.",
      "6. Update the index in README.md and add a link to the idea's folder under its INBOX.md entry.",
      "Do not push, publish, buy or sign up for anything. End with a two-sentence summary and the verdict."
    ].join("\n");
  }
  return [
    `Нова ідея, надиктована Marshal і дописана в INBOX.md під «## ${heading}» (текст із розпізнавання мови, можливі помилки):`,
    `«${idea}»`,
    "",
    "1. Прочитай README.md, CLAUDE.md і стандарт документації цієї теки (якщо є) і дій за їхніми правилами, а не лише за цим списком.",
    "2. Якщо ідея дублює наявну теку чи пункт беклогу — допиши туди, нову не створюй.",
    "3. Інакше створи теку ідеї за тим самим іменуванням, що й наявні, з IDEA.md у їхньому форматі.",
    "4. Перевір життєздатність веб-пошуком: реальні конкуренти з цінами, попит, ризики сторів і юридичні. Запиши overview з чітким go / no-go.",
    "5. GO — план розробки й решта docs (можна паралельно сабагентами), і клікабельний HTML-прототип у design/, якщо в ідеї є UI. NO-GO — лише overview з причиною.",
    "6. Онови таблицю в README.md і під записом в INBOX.md додай посилання на теку ідеї.",
    "Нічого не пуш, не публікуй, не купуй і ніде не реєструйся. В кінці — підсумок у два речення і вердикт."
  ].join("\n");
}

type Line = "ask" | "noFolder" | "saved" | "savedNoSession" | "openedNoReturn" | "failed";

const LINES: Record<IdeaLang, Record<Line, string>> = {
  uk: {
    ask: "Яка ідея?",
    noFolder: "Не знаю, куди записати: вкажи теку ідей у Settings, Voice assistant.",
    saved: "Записав. Відкриваю сесію, вона дослідить ідею.",
    savedNoSession: "Записав, але сесію відкрити не вдалося.",
    openedNoReturn: "Сесія з ідеєю відкрита, натисни Enter у Claude.",
    failed: "Не вдалося записати ідею."
  },
  en: {
    ask: "What's the idea?",
    noFolder: "I don't know where to put it: set the ideas folder in Settings, Voice assistant.",
    saved: "Saved. Opening a session to research it.",
    savedNoSession: "Saved, but I couldn't open a session.",
    openedNoReturn: "The idea session is open, press Return in Claude.",
    failed: "I couldn't save the idea."
  }
};

export function ideaLine(line: Line, lang: IdeaLang): string {
  return LINES[lang][line];
}
