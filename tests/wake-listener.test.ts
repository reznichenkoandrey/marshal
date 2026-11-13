import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { wakeCommand, WakeListener } from "../desktop/assistant/wake/wake-listener.ts";

describe("wakeCommand (#274)", () => {
  it("keeps what follows the name", () => {
    expect(wakeCommand("Маршал, відкрий перекладач.")).toBe("відкрий перекладач.");
    expect(wakeCommand("Marshal, what's next?")).toBe("what's next?");
    expect(wakeCommand("Гей, маршале, котра година?")).toBe("котра година?");
    expect(wakeCommand("Маршалл — запиши дзвінок")).toBe("запиши дзвінок");
    expect(wakeCommand("Слухай, Маршал, что там по сессиях?")).toBe("что там по сессиях?");
  });

  it("is empty for the name alone", () => {
    expect(wakeCommand("Маршал.")).toBe("");
    expect(wakeCommand(" marshal ")).toBe("");
  });

  it("finds the name at the start of a later sentence: the clip starts before it", () => {
    expect(wakeCommand("Ну добре. Маршал, що там по сесіях?")).toBe("що там по сесіях?");
  });

  it("ignores words the spotter confuses with the name and the name mid-sentence", () => {
    expect(wakeCommand("Поїхали на маршрут.")).toBeNull();
    expect(wakeCommand("Маршрутка вже тут.")).toBeNull();
    expect(wakeCommand("Скажи marshal, що час спати.")).toBeNull();
    expect(wakeCommand("The martial arts class.")).toBeNull();
    expect(wakeCommand("")).toBeNull();
  });
});

describe("WakeListener", () => {
  it("transcribes the clip after a spot and passes the command on", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "marshal-wake-"));
    const bin = path.join(dir, "fake-helper");
    // Spots at once, then 2 s of silence: longer than the pause after the name alone.
    writeFileSync(
      bin,
      `#!/bin/sh
echo ready
echo wake
i=0
while [ $i -lt 20 ]; do echo "level -60.0"; sleep 0.1; i=$((i+1)); done &
read cmd clip
echo "clip $clip"
cat > /dev/null
`
    );
    chmodSync(bin, 0o755);
    const phases: string[] = [];
    const command = await new Promise<string>((resolve, reject) => {
      const listener = new WakeListener({
        binPath: bin,
        paths: { lib: dir, model: dir, keywords: path.join(dir, "keywords.txt") },
        transcribe: async () => "Маршал, відкрий перекладач.",
        allowed: async () => true,
        onCommand: (text) => {
          listener.stop();
          resolve(text);
        },
        onNameOnly: () => reject(new Error("name only")),
        onPhase: ({ dictating, transcribing }) => phases.push(dictating ? "listening" : transcribing ? "thinking" : "idle")
      });
      listener.start();
    });
    expect(command).toBe("відкрий перекладач.");
    expect(phases.slice(0, 2)).toEqual(["listening", "thinking"]);
  }, 10_000);
});
