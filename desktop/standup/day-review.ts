// Assembles the day review card from local facts (#272). Main calls it from
// the tray; the result is copied to the clipboard, nothing is sent anywhere.

import { collectCommits, collectSessions, listTranscripts } from "./collect.ts";
import { buildStandup, renderStandup, type Language, type MeetingFact } from "./standup.ts";

export type DayReviewInput = {
  roots: readonly string[];
  author: string;
  projectsDir: string;
  live: readonly { sessionId: string; name: string; status: string | null; cwd: string }[];
  meetings: readonly MeetingFact[];
  now: Date;
  language: Language;
};

export async function buildDayReview(input: DayReviewInput): Promise<string> {
  const startOfDay = new Date(input.now);
  startOfDay.setHours(0, 0, 0, 0);
  const [commits, transcripts] = await Promise.all([
    collectCommits(input.roots, startOfDay, input.author),
    listTranscripts(input.projectsDir, input.live)
  ]);
  const sessions = await collectSessions(transcripts, startOfDay);
  const card = buildStandup({ commits, meetings: [...input.meetings], sessions }, input.now, input.language);
  return renderStandup(card, input.language);
}
