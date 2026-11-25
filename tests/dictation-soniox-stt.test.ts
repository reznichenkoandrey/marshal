import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SONIOX_STT_MODEL,
  SonioxSttSession,
  SttTranscript,
  buildSonioxSttConfig,
  parseSttMessage,
  sonioxSttKey
} from "../desktop/dictation/soniox-stt.ts";

class FakeSocket extends EventTarget {
  readyState = 0;
  readonly sent: Array<string | Buffer> = [];

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
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

function setup(terms: string[] = []) {
  const socket = new FakeSocket();
  const urls: string[] = [];
  const keys: string[] = [];
  const onEndpoint = vi.fn();
  const session = new SonioxSttSession("test-key", terms, onEndpoint, (url, key) => {
    urls.push(url);
    keys.push(key);
    return socket as unknown as WebSocket;
  });
  return { session, socket, urls, keys, onEndpoint };
}

const tokens = (...list: Array<[string, boolean]>) => ({
  tokens: list.map(([text, is_final]) => ({ text, is_final }))
});

afterEach(() => {
  vi.useRealTimers();
});

describe("soniox stt choice", () => {
  const env = { MARSHAL_ASSISTANT_STT: "soniox", SONIOX_API_KEY: "k" };

  it("streams only assistant input and only when Settings chose Soniox with a key", () => {
    expect(sonioxSttKey("talk", env)).toBe("k");
    expect(sonioxSttKey("assistant", env)).toBe("k");
    expect(sonioxSttKey("answer", env)).toBe("k");
    expect(sonioxSttKey("paste", env)).toBeNull();
    expect(sonioxSttKey("talk", { ...env, MARSHAL_ASSISTANT_STT: "whisper" })).toBeNull();
    expect(sonioxSttKey("talk", { MARSHAL_ASSISTANT_STT: "soniox" })).toBeNull();
  });
});

describe("soniox stt config", () => {
  it("asks for raw 16 kHz mono PCM, uk+en hints and endpoints", () => {
    const config = buildSonioxSttConfig([]);
    expect(config).toEqual({
      model: SONIOX_STT_MODEL,
      audio_format: "pcm_s16le",
      sample_rate: 16_000,
      num_channels: 1,
      language_hints: ["uk", "en"],
      enable_language_identification: true,
      enable_endpoint_detection: true
    });
    expect(config).not.toHaveProperty("api_key");
  });

  it("passes glossary terms as context, deduplicated and trimmed", () => {
    expect(buildSonioxSttConfig([" rate limit", "rate limit", "", "product_flat"]).context).toEqual({
      terms: ["rate limit", "product_flat"]
    });
  });
});

describe("soniox stt frames", () => {
  it("reads tokens, finished and errors, ignores the rest", () => {
    expect(parseSttMessage(JSON.stringify(tokens(["При", true], ["віт", false])))).toEqual({
      kind: "tokens",
      tokens: [
        { text: "При", isFinal: true },
        { text: "віт", isFinal: false }
      ],
      finished: false
    });
    expect(parseSttMessage('{"tokens":[],"finished":true}')).toEqual({ kind: "tokens", tokens: [], finished: true });
    expect(parseSttMessage('{"error_code":402,"error_message":"Organization balance exhausted"}')).toEqual({
      kind: "error",
      message: "Soniox 402: Organization balance exhausted"
    });
    expect(parseSttMessage('{"tokens":[]}')).toEqual({ kind: "ignore" });
    expect(parseSttMessage("not json")).toEqual({ kind: "ignore" });
  });

  it("keeps final tokens, replaces the guess and spots the endpoint", () => {
    const transcript = new SttTranscript();
    transcript.feed([{ text: "Відкрий", isFinal: true }, { text: " пере", isFinal: false }]);
    expect(transcript.text).toBe("Відкрий пере");
    transcript.feed([{ text: " перекладач", isFinal: false }]);
    expect(transcript.text).toBe("Відкрий перекладач");
    transcript.feed([{ text: " перекладач", isFinal: true }, { text: "<end>", isFinal: true }]);
    expect(transcript.text).toBe("Відкрий перекладач");
    expect(transcript.endpoint).toBe(true);
  });
});

describe("soniox stt session", () => {
  it("authenticates with the key, sends config, then the PCM queued during the handshake", () => {
    const { session, socket, urls, keys } = setup(["deploy"]);
    session.write(Buffer.from([1, 2]));
    expect(socket.sent).toEqual([]);
    socket.open();
    session.write(Buffer.from([3, 4]));
    expect(urls[0]).toBe("wss://stt-rt.soniox.com/transcribe-websocket");
    expect(keys).toEqual(["test-key"]);
    const config = JSON.parse(socket.sent[0] as string) as Record<string, unknown>;
    expect(config.context).toEqual({ terms: ["deploy"] });
    expect(socket.sent.slice(1)).toEqual([Buffer.from([1, 2]), Buffer.from([3, 4])]);
  });

  it("ends the audio with an empty frame and resolves with the final text", async () => {
    const { session, socket } = setup();
    socket.open();
    session.write(Buffer.from([1, 2]));
    const text = session.finish();
    expect(socket.sent.at(-1)).toBe("");
    socket.receive(tokens(["Що там", true], [" по сесіях", true]));
    socket.receive({ tokens: [], finished: true });
    await expect(text).resolves.toBe("Що там по сесіях");
    expect(socket.readyState).toBe(3);
  });

  it("sends the end frame after the handshake when the key went up first", async () => {
    const { session, socket } = setup();
    session.write(Buffer.from([1]));
    const text = session.finish();
    socket.open();
    expect(socket.sent.at(-1)).toBe("");
    socket.receive({ tokens: [{ text: "так", is_final: true }], finished: true });
    await expect(text).resolves.toBe("так");
  });

  it("rejects on a 402 balance error so the command falls back to whisper", async () => {
    const { session, socket } = setup();
    socket.open();
    session.write(Buffer.from([1]));
    socket.receive({ error_code: 402, error_message: "Organization balance exhausted" });
    await expect(session.finish()).rejects.toThrow("Soniox 402: Organization balance exhausted");
  });

  it("rejects when the connection drops before the text is final", async () => {
    const { session, socket } = setup();
    socket.open();
    session.write(Buffer.from([1]));
    const text = session.finish();
    socket.close();
    await expect(text).rejects.toThrow("closed (1000)");
  });

  it("rejects when no audio came from the recorder", async () => {
    const { session, socket } = setup();
    socket.open();
    await expect(session.finish()).rejects.toThrow("no audio");
  });

  it("times out instead of waiting forever", async () => {
    vi.useFakeTimers();
    const { session, socket } = setup();
    socket.open();
    session.write(Buffer.from([1]));
    const text = session.finish(1_000);
    vi.advanceTimersByTime(1_000);
    await expect(text).rejects.toThrow("timed out");
    expect(socket.readyState).toBe(3);
  });

  it("reports the endpoint once", () => {
    const { session, socket, onEndpoint } = setup();
    socket.open();
    session.write(Buffer.from([1]));
    socket.receive(tokens(["так", true], ["<end>", true]));
    socket.receive(tokens(["<end>", true]));
    expect(onEndpoint).toHaveBeenCalledTimes(1);
  });
});
