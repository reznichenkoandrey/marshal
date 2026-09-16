import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TranslatorAuthError, isAuthStatus, isTranslatorAuthError } from "../desktop/translator/backends/errors.ts";
import type {
  TargetLang,
  TranslateOptions,
  TranslationResult,
  TranslatorBackend
} from "../desktop/translator/backends/types.ts";

// Which backend ids should reject, and what every call recorded. The fake
// factory below builds a backend per id so the service's own resolution
// decides which one gets used.
const rejecting = new Set<string>();
const calls: string[] = [];

function buildFakeBackend(id: TranslatorBackend["id"]): TranslatorBackend {
  const guard = async (): Promise<void> => {
    if (rejecting.has(id)) {
      throw new TranslatorAuthError(id, 401, '{"error":{"code":"expired_api_key"}}');
    }
  };
  return {
    id,
    async translateText(text: string, targetLang: TargetLang, _options?: TranslateOptions): Promise<TranslationResult> {
      calls.push(`${id}:text`);
      await guard();
      return { translation: `${id}:${text}`, sourceLang: "en", targetLang };
    },
    async translateImage(
      _base64: string,
      _mimeType: string,
      targetLang: TargetLang,
      _options?: TranslateOptions
    ): Promise<TranslationResult> {
      calls.push(`${id}:image`);
      await guard();
      return { translation: `${id}:image`, sourceLang: "auto", targetLang };
    }
  };
}

// Keep the real resolution logic — that is what is under test here — and
// replace only the construction of concrete backends.
vi.mock("../desktop/translator/backends/factory.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktop/translator/backends/factory.ts")>();
  return {
    ...actual,
    createTranslatorBackend: (id: TranslatorBackend["id"]) => buildFakeBackend(id)
  };
});

const { TranslatorService } = await import("../desktop/translator/translator-service.ts");

const originalKey = process.env.MARSHAL_API_KEY;

beforeEach(() => {
  rejecting.clear();
  calls.length = 0;
  process.env.MARSHAL_API_KEY = "gsk_present";
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.MARSHAL_API_KEY;
  else process.env.MARSHAL_API_KEY = originalKey;
});

describe("isAuthStatus / isTranslatorAuthError", () => {
  it("treats only 401 and 403 as credential failures", () => {
    expect(isAuthStatus(401)).toBe(true);
    expect(isAuthStatus(403)).toBe(true);
    expect(isAuthStatus(429)).toBe(false);
    expect(isAuthStatus(500)).toBe(false);
    expect(isAuthStatus(undefined)).toBe(false);
  });

  it("recognises an unwrapped SDK error by its status", () => {
    expect(isTranslatorAuthError(Object.assign(new Error("nope"), { status: 401 }))).toBe(true);
    expect(isTranslatorAuthError(Object.assign(new Error("slow down"), { status: 429 }))).toBe(false);
    expect(isTranslatorAuthError(new Error("plain"))).toBe(false);
    expect(isTranslatorAuthError(null)).toBe(false);
  });

  it("keeps the status and backend on the typed error", () => {
    const err = new TranslatorAuthError("openai-api", 403, "forbidden");
    expect(err.status).toBe(403);
    expect(err.backendId).toBe("openai-api");
    expect(err.message).toContain("403");
  });
});

describe("auto backend falls back on a rejected credential", () => {
  it("retries the same call on the keyless backend and still returns a translation", async () => {
    rejecting.add("apple-vision");
    const svc = new TranslatorService({ choice: "auto", bridgeMode: "claude-cli" });
    expect(svc.backendId).toBe("apple-vision");

    const result = await svc.translateText("hello", "uk");

    expect(result.translation).toBe("claude-cli:hello");
    expect(calls).toEqual(["apple-vision:text", "claude-cli:text"]);
    expect(svc.backendId).toBe("claude-cli");
  });

  it("announces the swap once, with both backends and the status", async () => {
    rejecting.add("apple-vision");
    const svc = new TranslatorService({ choice: "auto", bridgeMode: "claude-cli" });
    const notices: unknown[] = [];
    svc.on("fallback", (n) => notices.push(n));

    await svc.translateText("one", "uk");
    await svc.translateText("two", "uk");

    expect(notices).toEqual([{ from: "apple-vision", to: "claude-cli", status: 401 }]);
  });

  it("stops paying a doomed round trip on every later call", async () => {
    rejecting.add("apple-vision");
    const svc = new TranslatorService({ choice: "auto", bridgeMode: "claude-cli" });

    await svc.translateText("one", "uk");
    calls.length = 0;
    await svc.translateText("two", "uk");

    expect(calls).toEqual(["claude-cli:text"]);
  });

  it("covers the image path too", async () => {
    rejecting.add("apple-vision");
    const svc = new TranslatorService({ choice: "auto", bridgeMode: "claude-cli" });
    const result = await svc.translateImage("data==", "image/png", "uk");
    expect(result.translation).toBe("claude-cli:image");
  });

  it("covers translateAuto, which the hotkeys use", async () => {
    rejecting.add("apple-vision");
    const svc = new TranslatorService({ choice: "auto", bridgeMode: "claude-cli" });
    const result = await svc.translateAuto("Привіт");
    expect(result.translation).toBe("claude-cli:Привіт");
    expect(result.targetLang).toBe("en");
  });

  it("retries the key after the user changes provider settings", async () => {
    rejecting.add("apple-vision");
    const svc = new TranslatorService({ choice: "auto", bridgeMode: "claude-cli" });
    await svc.translateText("one", "uk");
    expect(svc.backendId).toBe("claude-cli");

    // The user went to Settings — that is the moment a fixed key would appear.
    rejecting.clear();
    svc.setBackend("auto");

    expect(svc.backendId).toBe("apple-vision");
    const result = await svc.translateText("two", "uk");
    expect(result.translation).toBe("apple-vision:two");
  });
});

describe("what the fallback must NOT do", () => {
  it("leaves an explicitly pinned backend to fail loudly", async () => {
    rejecting.add("openai-api");
    const svc = new TranslatorService({ choice: "openai-api", bridgeMode: "claude-cli" });

    await expect(svc.translateText("hello", "uk")).rejects.toThrow(TranslatorAuthError);
    expect(calls).toEqual(["openai-api:text"]);
    expect(svc.backendId).toBe("openai-api");
  });

  it("does not swallow failures that are not credential failures", async () => {
    const svc = new TranslatorService({ choice: "auto", bridgeMode: "claude-cli" });
    const boom = new Error("model overloaded");
    const backend = { id: "apple-vision" as const, translateText: async () => { throw boom; }, translateImage: async () => { throw boom; } };
    // Force the service onto a backend that fails for a non-auth reason.
    Reflect.set(svc, "backend", backend);

    await expect(svc.translateText("hello", "uk")).rejects.toThrow("model overloaded");
  });

  it("surfaces the original error when there is nothing better to fall back to", async () => {
    // bridgeMode `api` maps to openai-api with or without a key, so the
    // keyless resolution is the same backend — there is no escape hatch.
    rejecting.add("openai-api");
    const svc = new TranslatorService({ choice: "auto", bridgeMode: "api" });
    expect(svc.backendId).toBe("openai-api");

    await expect(svc.translateText("hello", "uk")).rejects.toThrow(TranslatorAuthError);
    expect(calls).toEqual(["openai-api:text"]);
  });
});
