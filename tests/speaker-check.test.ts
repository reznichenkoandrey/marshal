import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildProfile,
  checkSpeaker,
  enrolSpeaker,
  installSpeaker,
  isSpeakerInstalled,
  loadProfile,
  parseEmbedOutput,
  parseSayVoiceSamples,
  saveProfile,
  speakerPaths,
  SPEAKER_MODEL,
  type EmbedFiles,
  type EmbedRow,
  type SpeakerProfile
} from "../desktop/assistant/speaker/speaker-check.ts";
import { WakeListener } from "../desktop/assistant/wake/wake-listener.ts";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "marshal-speaker-test-"));

// Unit vectors at a given angle from the x axis: cosine similarity is cos(angle difference).
const voice = (degrees: number): number[] => [Math.cos((degrees * Math.PI) / 180), Math.sin((degrees * Math.PI) / 180), 0];
const row = (start: number, degrees: number, levelDb = -25): EmbedRow => ({ file: 0, start, levelDb, embedding: voice(degrees) });

// 40 one-second-hop windows of one voice wobbling ±4°, and 12 foreign voices 60–90° away.
const ownerWindows = Array.from({ length: 40 }, (_, index) => row(index, (index % 9) - 4));
const foreignVoices = Array.from({ length: 12 }, (_, index) => voice(60 + index * 2.5));

function readyProfile(): SpeakerProfile {
  const profile = buildProfile(ownerWindows, foreignVoices, { now: 1 });
  if (!profile) throw new Error("no profile");
  return profile;
}

describe("parseEmbedOutput", () => {
  it("keeps embedding rows and skips error lines and noise", () => {
    const rows = parseEmbedOutput(
      [
        '{"file":0,"start":1.00,"levelDb":-23.4,"embedding":[0.1,0.2]}',
        '{"file":1,"error":"too short"}',
        "warning from a library",
        '{"file":2,"embedding":[]}',
        '{"file":3,"embedding":[1,"x"]}',
        "{broken"
      ].join("\n")
    );
    expect(rows).toEqual([{ file: 0, start: 1, levelDb: -23.4, embedding: [0.1, 0.2] }]);
  });
});

describe("buildProfile", () => {
  it("calibrates a threshold between the owner's windows and foreign voices", () => {
    const { calibration, embedding, ownerLevelsDb } = readyProfile();
    expect(calibration.status).toBe("ready");
    if (calibration.status !== "ready") return;
    expect(calibration.ownerSamples).toBe(40);
    expect(calibration.foreignSamples).toBe(12);
    expect(calibration.optimistic).toBe(true);
    expect(calibration.threshold).toBeGreaterThan(0.6);
    expect(calibration.threshold).toBeLessThan(1);
    expect(embedding).toHaveLength(3);
    // Levels come from accepted wake clips on the wake mic, never from the enrolment file.
    expect(ownerLevelsDb).toEqual([]);
  });

  it("drops windows far quieter than the rest: pauses are not the owner's voice", () => {
    const withPauses = [...ownerWindows, row(40, 90, -70), row(41, 90, -70)];
    expect(buildProfile(withPauses, foreignVoices)?.calibration.ownerSamples).toBe(40);
  });

  it("stays collecting on a short recording", () => {
    expect(buildProfile(ownerWindows.slice(0, 8), foreignVoices)?.calibration.status).toBe("collecting");
  });

  it("is unusable when foreign voices score like the owner", () => {
    const alike = Array.from({ length: 12 }, (_, index) => voice(index % 5));
    expect(buildProfile(ownerWindows, alike)?.calibration.status).toBe("unusable");
  });

  it("gives nothing for no windows", () => {
    expect(buildProfile([], foreignVoices)).toBeNull();
  });
});

describe("parseSayVoiceSamples", () => {
  const output = [
    "Albert              en_US    # Hello! My name is Albert.",
    "Daniel              en_GB    # Hello! My name is Daniel.",
    "Anna                de_DE    # Hallo! Ich heiße Anna.",
    "Eddy (German (Germany)) de_DE    # Hallo! Ich heiße Eddy.",
    "Eddy (English (UK)) en_GB    # Hello! My name is Eddy.",
    "Lesya               uk_UA    # Привіт! Мене звуть Леся.",
    "not a voice line"
  ].join("\n");

  it("takes one sample per voice, English and Ukrainian first, without novelty voices", () => {
    const names = parseSayVoiceSamples(output).map((sample) => sample.name);
    expect(names).toEqual(["Daniel", "Lesya", "Anna", "Eddy (German (Germany))"]);
  });

  it("doubles the stock sentence and honours the limit", () => {
    expect(parseSayVoiceSamples(output, 1)).toEqual([{ name: "Daniel", text: "Hello! My name is Daniel. Hello! My name is Daniel." }]);
  });
});

describe("voice print on disk", () => {
  it("is written 0600 in a 0700 directory and read back", async () => {
    const file = path.join(tmp(), "speaker", "profile.json");
    await saveProfile(file, readyProfile());
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect((await loadProfile(file))?.embedding).toHaveLength(3);
  });

  it("ignores a file from another model or one that does not parse", async () => {
    const dir = tmp();
    const other = path.join(dir, "other.json");
    await saveProfile(other, { ...readyProfile(), model: "another.onnx" });
    expect(await loadProfile(other)).toBeNull();
    const broken = path.join(dir, "broken.json");
    writeFileSync(broken, "{");
    expect(await loadProfile(broken)).toBeNull();
    expect(await loadProfile(path.join(dir, "missing.json"))).toBeNull();
  });
});

describe("checkSpeaker", () => {
  const embedAs = (degrees: number, levelDb = -25): EmbedFiles => async () => [row(0, degrees, levelDb)];

  async function enrolled(profile = readyProfile()): Promise<string> {
    const file = path.join(tmp(), "profile.json");
    await saveProfile(file, profile);
    return file;
  }

  it("accepts the owner's voice and remembers its level", async () => {
    const file = await enrolled();
    const verdict = await checkSpeaker("/clip.wav", file, embedAs(2, -22));
    expect(verdict).toMatchObject({ verdict: "accept", reason: "owner" });
    expect(verdict.score).toBeGreaterThan(0.99);
    expect((await loadProfile(file))?.ownerLevelsDb).toEqual([-22]);
  });

  it("rejects another voice and keeps its level out of the profile", async () => {
    const file = await enrolled();
    expect(await checkSpeaker("/clip.wav", file, embedAs(70))).toMatchObject({ verdict: "reject", reason: "not-owner" });
    expect((await loadProfile(file))?.ownerLevelsDb).toEqual([]);
  });

  it("rejects the owner's voice from far away once the usual level is known", async () => {
    const file = await enrolled({ ...readyProfile(), ownerLevelsDb: Array(10).fill(-22) });
    expect(await checkSpeaker("/clip.wav", file, embedAs(2, -45))).toMatchObject({ verdict: "reject", reason: "background" });
  });

  it("lets the command through without a voice print", async () => {
    const verdict = await checkSpeaker("/clip.wav", path.join(tmp(), "none.json"), embedAs(70));
    expect(verdict).toEqual({ verdict: "accept", reason: "not-calibrated", score: null });
  });

  it("lets the command through when the voice print has no usable threshold", async () => {
    const file = await enrolled(buildProfile(ownerWindows.slice(0, 8), foreignVoices)!);
    expect(await checkSpeaker("/clip.wav", file, embedAs(70))).toMatchObject({ verdict: "accept", reason: "not-calibrated" });
  });

  it("lets the command through when the helper fails, gives nothing or there is no clip", async () => {
    const file = await enrolled();
    const failing: EmbedFiles = async () => {
      throw new Error("helper died");
    };
    const unavailable = { verdict: "accept", reason: "unavailable", score: null };
    expect(await checkSpeaker("/clip.wav", file, failing)).toEqual(unavailable);
    expect(await checkSpeaker("/clip.wav", file, async () => [])).toEqual(unavailable);
    expect(await checkSpeaker(null, file, embedAs(70))).toEqual(unavailable);
  });
});

describe("enrolSpeaker", () => {
  it("refuses a recording with no speech and writes nothing", async () => {
    const file = path.join(tmp(), "profile.json");
    await expect(enrolSpeaker("/silence.wav", file, async () => [])).rejects.toThrow("No speech");
    expect(await loadProfile(file)).toBeNull();
  });
});

describe("installSpeaker", () => {
  // The wake phrase's runtime is already there, so only the model is fetched.
  function roots(): { root: string; wakeRoot: string } {
    const dir = tmp();
    const wakeRoot = path.join(dir, "wake");
    const lib = path.join(wakeRoot, "sherpa-onnx-v1.13.8-osx-arm64-shared", "lib");
    mkdirSync(lib, { recursive: true });
    writeFileSync(path.join(lib, "libsherpa-onnx-c-api.dylib"), "");
    return { root: path.join(dir, "speaker"), wakeRoot };
  }

  it("reuses the wake phrase's runtime", () => {
    const { root, wakeRoot } = roots();
    expect(speakerPaths(root, wakeRoot).lib).toBe(path.join(wakeRoot, "sherpa-onnx-v1.13.8-osx-arm64-shared", "lib"));
    expect(isSpeakerInstalled(speakerPaths(root, wakeRoot))).toBe(false);
  });

  it("rejects a download of the wrong size and leaves no model behind", async () => {
    const { root, wakeRoot } = roots();
    const fetchImpl = (async () => new Response("not the model")) as typeof fetch;
    await expect(installSpeaker({ root, wakeRoot, fetchImpl })).rejects.toThrow(`expected ${SPEAKER_MODEL.bytes}`);
    expect(isSpeakerInstalled(speakerPaths(root, wakeRoot))).toBe(false);
  });

  it("rejects a download of the right size with the wrong checksum", async () => {
    const { root, wakeRoot } = roots();
    const fetchImpl = (async () => new Response(new Uint8Array(SPEAKER_MODEL.bytes))) as typeof fetch;
    await expect(installSpeaker({ root, wakeRoot, fetchImpl })).rejects.toThrow("checksum");
    expect(isSpeakerInstalled(speakerPaths(root, wakeRoot))).toBe(false);
  });

  it("reports a failed request", async () => {
    const { root, wakeRoot } = roots();
    const fetchImpl = (async () => new Response("", { status: 404 })) as typeof fetch;
    await expect(installSpeaker({ root, wakeRoot, fetchImpl })).rejects.toThrow("HTTP 404");
  });
});

describe("WakeListener with the speaker check", () => {
  function fakeHelper(): { bin: string; dir: string } {
    const dir = tmp();
    const bin = path.join(dir, "fake-helper");
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
    return { bin, dir };
  }

  function run(speaker: { enabled: boolean; owner: boolean }): Promise<{ outcome: string; verified: Array<string | null> }> {
    const { bin, dir } = fakeHelper();
    const verified: Array<string | null> = [];
    return new Promise((resolve) => {
      const done = (outcome: string) => {
        listener.stop();
        resolve({ outcome, verified });
      };
      const listener = new WakeListener({
        binPath: bin,
        paths: { lib: dir, model: dir, keywords: path.join(dir, "keywords.txt") },
        transcribe: async () => "Маршал, відкрий перекладач.",
        allowed: async () => true,
        speaker: {
          enabled: () => speaker.enabled,
          verify: async (clip) => {
            verified.push(clip);
            return speaker.owner;
          }
        },
        onCommand: (text) => done(text),
        onNameOnly: () => done("name only"),
        // Idle after the candidate was handled: nothing reached the dispatcher.
        onPhase: ({ dictating, transcribing }) => {
          if (!dictating && !transcribing && verified.length > 0) setTimeout(() => done("dropped"), 50);
        }
      });
      listener.start();
    });
  }

  it("passes the owner's command on, with the clip handed to the check", async () => {
    const { outcome, verified } = await run({ enabled: true, owner: true });
    expect(outcome).toBe("відкрий перекладач.");
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatch(/\.wav$/);
  }, 10_000);

  it("drops a command in another voice", async () => {
    expect((await run({ enabled: true, owner: false })).outcome).toBe("dropped");
  }, 10_000);

  it("never asks the check while the setting is off", async () => {
    const { outcome, verified } = await run({ enabled: false, owner: false });
    expect(outcome).toBe("відкрий перекладач.");
    expect(verified).toEqual([]);
  }, 10_000);
});
