import { describe, expect, it } from "vitest";

import {
  DEFAULT_SPEECH_RATE,
  MAX_QUEUED_ITEMS,
  MAX_SPEECH_RATE,
  MIN_SPEECH_RATE,
  SpeechQueue,
  detectSpeechLang,
  normalizeSpeechRate,
  parseSayVoices,
  pickVoice,
  voiceBaseName,
  type SystemVoice
} from "../desktop/speech/speech-policy.ts";

// Real `say -v '?'` lines from a Mac with a Ukrainian UI: display names are
// localized and the enhanced variant prints identically to the compact one.
const SAY_OUTPUT = [
  "Albert              en_US    # Hello! My name is Albert.",
  "Bells               en_US    # Hello! My name is Bells.",
  "Daniel              en_GB    # Hello! My name is Daniel.",
  "Eddy (Англійська (Велика Британія)) en_GB    # Hello! My name is Eddy.",
  "Lesya (Українська (Україна)) uk_UA    # Привіт! Мене звуть Леся.",
  "Lesya (Українська (Україна)) uk_UA    # Привіт! Мене звуть Леся.",
  "Samantha (Англійська (США)) en_US    # Hello! My name is Samantha.",
  "Alice               it_IT    # Ciao! Mi chiamo Alice.",
  ""
].join("\n");

describe("parseSayVoices", () => {
  it("keeps localized names verbatim and drops duplicate variants", () => {
    const voices = parseSayVoices(SAY_OUTPUT);
    expect(voices).toContainEqual({ name: "Lesya (Українська (Україна))", locale: "uk_UA" });
    expect(voices.filter((voice) => voice.locale === "uk_UA")).toHaveLength(1);
    expect(voices).toHaveLength(7);
  });

  it("ignores lines that are not voices", () => {
    expect(parseSayVoices("Voice `x' not found.\n\n")).toEqual([]);
  });
});

describe("voiceBaseName", () => {
  it("strips the localized language suffix", () => {
    expect(voiceBaseName("Lesya (Українська (Україна))")).toBe("Lesya");
    expect(voiceBaseName("Daniel")).toBe("Daniel");
  });
});

describe("pickVoice", () => {
  const voices = parseSayVoices(SAY_OUTPUT);

  it("finds the Ukrainian voice without knowing its name", () => {
    expect(pickVoice(voices, "uk")?.locale).toBe("uk_UA");
  });

  it("returns null when no voice exists for the language instead of borrowing another", () => {
    const englishOnly: SystemVoice[] = voices.filter((voice) => !voice.locale.startsWith("uk"));
    expect(pickVoice(englishOnly, "uk")).toBeNull();
  });

  it("prefers a real English voice over novelty ones listed first", () => {
    expect(voiceBaseName(pickVoice(voices, "en")?.name ?? "")).toBe("Samantha");
  });

  it("honours the Settings choice while it is installed", () => {
    expect(pickVoice(voices, "en", "Daniel")?.name).toBe("Daniel");
    expect(voiceBaseName(pickVoice(voices, "en", "Removed Voice")?.name ?? "")).toBe("Samantha");
  });

  it("ignores a preferred voice of the wrong language", () => {
    expect(pickVoice(voices, "uk", "Daniel")?.locale).toBe("uk_UA");
  });
});

describe("detectSpeechLang", () => {
  it("detects plain Ukrainian and English", () => {
    expect(detectSpeechLang("Сесія завершила задачу.")).toBe("uk");
    expect(detectSpeechLang("The session finished its task.")).toBe("en");
  });

  it("keeps a Ukrainian sentence Ukrainian despite English terms and identifiers", () => {
    expect(detectSpeechLang("Тести пройшли, rate limit більше не б'є по API.")).toBe("uk");
    expect(detectSpeechLang("Оновлено `desktop/speech/speech-service.ts` і speechQueue, PR відкрито.")).toBe("uk");
    expect(detectSpeechLang("Виправлено fix у backend retry logic.")).toBe("uk");
  });

  it("does not let a single Ukrainian word flip an English sentence", () => {
    expect(detectSpeechLang("Build passed, all tests green, PR opened for review — дякую")).toBe("en");
  });

  it("uses the fallback when the text has no words", () => {
    expect(detectSpeechLang("42 / 17", "en")).toBe("en");
    expect(detectSpeechLang("", "uk")).toBe("uk");
  });
});

describe("normalizeSpeechRate", () => {
  it("clamps and defaults", () => {
    expect(normalizeSpeechRate(undefined)).toBe(DEFAULT_SPEECH_RATE);
    expect(normalizeSpeechRate("abc")).toBe(DEFAULT_SPEECH_RATE);
    expect(normalizeSpeechRate(10)).toBe(MIN_SPEECH_RATE);
    expect(normalizeSpeechRate(9_999)).toBe(MAX_SPEECH_RATE);
    expect(normalizeSpeechRate("220")).toBe(220);
  });
});

describe("SpeechQueue", () => {
  it("speaks in arrival order", () => {
    const queue = new SpeechQueue();
    queue.enqueue({ text: "a", lang: "uk" });
    queue.enqueue({ text: "b", lang: "en" });
    expect(queue.take()?.text).toBe("a");
    expect(queue.take()?.text).toBe("b");
    expect(queue.take()).toBeUndefined();
  });

  it("replaces a session's unspoken update in place", () => {
    const queue = new SpeechQueue();
    queue.enqueue({ text: "s1 old", lang: "uk", key: "s1" });
    queue.enqueue({ text: "s2", lang: "uk", key: "s2" });
    queue.enqueue({ text: "s1 new", lang: "uk", key: "s1" });
    expect(queue.size).toBe(2);
    expect(queue.take()?.text).toBe("s1 new");
    expect(queue.take()?.text).toBe("s2");
  });

  it("puts an interrupted phrase back at the front", () => {
    const queue = new SpeechQueue();
    queue.enqueue({ text: "next", lang: "uk" });
    queue.requeue({ text: "cut", lang: "uk", key: "s1" });
    expect(queue.take()?.text).toBe("cut");
  });

  it("drops an interrupted phrase once a newer one for its session is waiting", () => {
    const queue = new SpeechQueue();
    queue.enqueue({ text: "s1 newer", lang: "uk", key: "s1" });
    queue.requeue({ text: "s1 cut", lang: "uk", key: "s1" });
    expect(queue.size).toBe(1);
    expect(queue.take()?.text).toBe("s1 newer");
  });

  it("drops the oldest phrase when flooded", () => {
    const queue = new SpeechQueue();
    for (let i = 0; i <= MAX_QUEUED_ITEMS; i++) queue.enqueue({ text: String(i), lang: "en" });
    expect(queue.size).toBe(MAX_QUEUED_ITEMS);
    expect(queue.take()?.text).toBe("1");
  });

  it("clears", () => {
    const queue = new SpeechQueue();
    queue.enqueue({ text: "a", lang: "uk" });
    queue.clear();
    expect(queue.size).toBe(0);
  });
});
