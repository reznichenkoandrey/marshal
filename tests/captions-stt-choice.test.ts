// tests/captions-stt-choice.test.ts
//
// #208: live captions default to the local model when one is installed. The
// rule is small, but it decides whether a call is captioned inside Groq's 20
// requests per minute or without any limit, and whether an explicit choice in
// Settings is respected — so both halves are pinned.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveCaptionsSttBackend } from "../desktop/captions/stt-choice.ts";

describe("resolveCaptionsSttBackend", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.MARSHAL_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.MARSHAL_API_KEY;
    else process.env.MARSHAL_API_KEY = savedKey;
  });

  it("goes local when a model is installed and nothing was chosen", () => {
    process.env.MARSHAL_API_KEY = "gsk";
    expect(resolveCaptionsSttBackend(undefined, "hybrid", true)).toBe("whisper-cpp");
    expect(resolveCaptionsSttBackend("", undefined, true)).toBe("whisper-cpp");
  });

  it("respects an explicit choice from Settings, local model or not", () => {
    expect(resolveCaptionsSttBackend("groq", undefined, true)).toBe("groq");
    expect(resolveCaptionsSttBackend("hybrid", undefined, true)).toBe("hybrid");
    expect(resolveCaptionsSttBackend("whisper-cpp", "groq", false)).toBe("whisper-cpp");
  });

  it("follows dictation when there is no local model, as captions always did", () => {
    process.env.MARSHAL_API_KEY = "gsk";
    expect(resolveCaptionsSttBackend(undefined, "groq", false)).toBe("groq");
    // Dictation left on auto: hybrid with a key…
    expect(resolveCaptionsSttBackend(undefined, undefined, false)).toBe("hybrid");
    delete process.env.MARSHAL_API_KEY;
    // …and local without one.
    expect(resolveCaptionsSttBackend(undefined, undefined, false)).toBe("whisper-cpp");
  });
});
