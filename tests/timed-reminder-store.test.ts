import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TimedReminderStore } from "../desktop/calendar/timed-reminder-store.ts";

const NOW = Date.parse("2026-11-19T10:00:00Z");
const dirs: string[] = [];

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reminders-"));
  dirs.push(dir);
  return path.join(dir, "timed-reminders.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("TimedReminderStore", () => {
  it("survives a restart and fires a time reminder once", () => {
    const file = tempFile();
    const fired: string[] = [];
    const first = new TimedReminderStore(file, (r) => fired.push(r.text));
    first.add("stretch", { kind: "at", at: NOW + 60_000 }, NOW);
    first.stop();

    const second = new TimedReminderStore(file, (r) => fired.push(r.text));
    expect(second.pending()).toHaveLength(1);
    second.fire(NOW);
    expect(fired).toEqual([]);
    second.fire(NOW + 60_000);
    second.fire(NOW + 120_000);
    expect(fired).toEqual(["stretch"]);
    second.stop();
  });

  it("fires a session reminder when that session's turn ends", () => {
    const fired: string[] = [];
    const store = new TimedReminderStore(tempFile(), (r) => fired.push(r.text));
    store.add("review the diff", { kind: "session", session: "marshal" }, NOW);
    store.sessionFinished("snoriq");
    expect(fired).toEqual([]);
    store.sessionFinished("marshal");
    expect(fired).toEqual(["review the diff"]);
    store.stop();
  });
});
