import { describe, expect, it } from "vitest";

import { matchSleepCommand } from "../desktop/assistant/sleep.ts";

describe("matchSleepCommand", () => {
  it("puts the assistant to sleep in Ukrainian, Russian-ish and English", () => {
    for (const text of ["Маршал, спати.", "маршал спать", "Маршале, іди спати!", "Засинай", "Marshal, go to sleep.", "sleep", "Маршал, відпочинь будь ласка"]) {
      expect(matchSleepCommand(text), text).toBe("sleep");
    }
  });

  it("wakes it up", () => {
    for (const text of ["Маршал, прокинься.", "Прокидайся", "Маршал вставай", "Marshal, wake up!", "Hey Marshall, wake up"]) {
      expect(matchSleepCommand(text), text).toBe("wake");
    }
  });

  it("leaves longer commands and other words to the dispatcher", () => {
    for (const text of [
      "Скажи marshal, що мені час іти спати після деплою",
      "funky-rabbit, спати",
      "Маршал, відкрий перекладач",
      "Маршал",
      "",
      "не спати"
    ]) {
      expect(matchSleepCommand(text), text).toBeNull();
    }
  });
});
