import { afterEach, describe, expect, it, vi } from "vitest";

import { chooseSpeechEngine, normalizeSpeechEngine } from "../desktop/speech/speech-policy.ts";
import {
  SONIOX_WARM_MS,
  SonioxTts,
  buildSonioxConfig,
  parseSonioxMessage,
  sonioxApiKey,
  sonioxSpeedForRate
} from "../desktop/speech/soniox.ts";

class FakeSocket extends EventTarget {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 }));
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  receive(frame: Record<string, unknown>): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(frame) }));
  }
}

function setup(key: string | null = "test-key") {
  const sockets: FakeSocket[] = [];
  const keys: string[] = [];
  const tts = new SonioxTts(
    () => key,
    (_url, k) => {
      keys.push(k);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    }
  );
  return { tts, sockets, keys };
}

const audio = (streamId: string, bytes: number[]) => ({
  stream_id: streamId,
  audio: Buffer.from(bytes).toString("base64"),
  audio_end: false
});

afterEach(() => {
  vi.useRealTimers();
});

describe("soniox engine choice", () => {
  it("is a known engine that speaks only Ukrainian and only with a key", () => {
    expect(normalizeSpeechEngine("soniox")).toBe("soniox");
    expect(chooseSpeechEngine("soniox", "uk", true)).toBe("soniox");
    expect(chooseSpeechEngine("soniox", "en", true)).toBe("macos");
    expect(chooseSpeechEngine("soniox", "uk", false)).toBe("macos");
  });

  it("reads the key from the environment, ignoring blanks", () => {
    expect(sonioxApiKey({ SONIOX_API_KEY: " abc " })).toBe("abc");
    expect(sonioxApiKey({ SONIOX_API_KEY: "  " })).toBeNull();
    expect(sonioxApiKey({})).toBeNull();
  });

  it("maps the say rate to the API speed range", () => {
    expect(sonioxSpeedForRate(190)).toBe(1);
    expect(sonioxSpeedForRate(360)).toBe(1.3);
    expect(sonioxSpeedForRate(90)).toBe(0.7);
  });

  it("asks for Ukrainian Adrian as raw 24 kHz PCM", () => {
    expect(buildSonioxConfig("s1", 1)).toEqual({
      stream_id: "s1",
      model: "tts-rt-v2",
      language: "uk",
      voice: "Adrian",
      audio_format: "pcm_s16le",
      sample_rate: 24_000,
      speed: 1
    });
  });
});

describe("parseSonioxMessage", () => {
  it("decodes audio, termination and errors", () => {
    const parsed = parseSonioxMessage(JSON.stringify(audio("s1", [1, 2, 3])));
    expect(parsed.kind).toBe("audio");
    if (parsed.kind === "audio") expect([...parsed.audio]).toEqual([1, 2, 3]);
    expect(parseSonioxMessage('{"terminated":true,"stream_id":"s1"}')).toEqual({ kind: "terminated", streamId: "s1" });
    expect(
      parseSonioxMessage(
        JSON.stringify({
          stream_id: "s1",
          error_code: 402,
          error_type: "organization_balance_exhausted",
          error_message: "Organization balance exhausted."
        })
      )
    ).toEqual({
      kind: "error",
      streamId: "s1",
      message: "Soniox 402 organization_balance_exhausted: Organization balance exhausted."
    });
  });

  it("ignores frames it does not understand", () => {
    expect(parseSonioxMessage("not json").kind).toBe("ignore");
    expect(parseSonioxMessage("[]").kind).toBe("ignore");
    expect(parseSonioxMessage('{"audio":"AAA="}').kind).toBe("ignore");
    expect(parseSonioxMessage('{"stream_id":"s1","audio_end":true}').kind).toBe("ignore");
  });
});

describe("SonioxTts", () => {
  it("streams chunks as they arrive and resolves on termination", async () => {
    const { tts, sockets, keys } = setup();
    const chunks: number[][] = [];
    const phrase = tts.speak("Привіт", 1, (pcm) => chunks.push([...pcm]));
    sockets[0].open();
    await Promise.resolve();
    const [config, text] = sockets[0].sent;
    expect(keys).toEqual(["test-key"]);
    expect(config).toMatchObject({ model: "tts-rt-v2", voice: "Adrian" });
    expect(text).toEqual({ stream_id: config.stream_id, text: "Привіт", text_end: true });
    const id = String(config.stream_id);
    sockets[0].receive(audio(id, [1]));
    sockets[0].receive(audio("someone-else", [9]));
    sockets[0].receive(audio(id, [2]));
    sockets[0].receive({ terminated: true, stream_id: id });
    await phrase.done;
    expect(chunks).toEqual([[1], [2]]);
    tts.close();
  });

  it("reuses one open socket for the next phrase", async () => {
    const { tts, sockets } = setup();
    const first = tts.speak("один", 1, () => {});
    sockets[0].open();
    await Promise.resolve();
    sockets[0].receive({ terminated: true, stream_id: sockets[0].sent[0].stream_id });
    await first.done;
    const second = tts.speak("два", 1, () => {});
    await Promise.resolve();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].sent).toHaveLength(4);
    second.cancel();
    await second.done;
    expect(sockets[0].sent.at(-1)).toMatchObject({ cancel: true });
    tts.close();
  });

  it("rejects on an error frame so the caller can fall back (402)", async () => {
    const { tts, sockets } = setup();
    const phrase = tts.speak("текст", 1, () => {});
    sockets[0].open();
    await Promise.resolve();
    sockets[0].receive({
      stream_id: sockets[0].sent[0].stream_id,
      error_code: 402,
      error_type: "organization_balance_exhausted"
    });
    await expect(phrase.done).rejects.toThrow("402 organization_balance_exhausted");
    tts.close();
  });

  it("rejects without a key and opens nothing", async () => {
    const { tts, sockets } = setup(null);
    await expect(tts.speak("текст", 1, () => {}).done).rejects.toThrow("SONIOX_API_KEY");
    expect(sockets).toHaveLength(0);
  });

  it("rejects when the connection drops mid-phrase", async () => {
    const { tts, sockets } = setup();
    const phrase = tts.speak("текст", 1, () => {});
    sockets[0].open();
    await Promise.resolve();
    sockets[0].close();
    await expect(phrase.done).rejects.toThrow("closed");
  });

  it("times out when no audio comes", async () => {
    vi.useFakeTimers();
    const { tts, sockets } = setup();
    const phrase = tts.speak("текст", 1, () => {});
    const settled = expect(phrase.done).rejects.toThrow("timed out");
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(6_000);
    await settled;
    expect(sockets[0].sent.at(-1)).toMatchObject({ cancel: true });
    tts.close();
  });

  it("closes the socket after the keep-warm window and keeps nothing open", async () => {
    vi.useFakeTimers();
    const { tts, sockets } = setup();
    tts.warmUp();
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(SONIOX_WARM_MS - 1);
    expect(sockets[0].closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0].closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

