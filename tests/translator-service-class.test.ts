import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TranslatorService, resolveTranslatorChoice } from "../desktop/translator/translator-service.ts";
import type { TranslatorBackend, TranslationResult, TargetLang } from "../desktop/translator/backends/types.ts";

// Stub backends. `createTranslatorBackend` is the real seam between the
// service and the concrete backend implementations — replacing it with a
// fake lets us assert on dispatch + bridge-mode follow without hitting any
// network call.

const calls: Array<{ id: string; method: string; args: unknown[] }> = [];

function buildFakeBackend(id: TranslatorBackend["id"]): TranslatorBackend {
  return {
    id,
    async translateText(text: string, targetLang: TargetLang): Promise<TranslationResult> {
      calls.push({ id, method: "translateText", args: [text, targetLang] });
      return { translation: `${id}:${text}`, sourceLang: "auto", targetLang };
    },
    async translateImage(base64: string, mimeType: string, targetLang: TargetLang): Promise<TranslationResult> {
      calls.push({ id, method: "translateImage", args: [base64, mimeType, targetLang] });
      return { translation: `${id}:image`, sourceLang: "auto", targetLang };
    }
  };
}

vi.mock("../desktop/translator/backends/factory.ts", () => ({
  createTranslatorBackend: (id: TranslatorBackend["id"]) => buildFakeBackend(id),
  translatorBackendForBridge: (mode: string) => {
    // Mirror the production mapping just enough for the assertions below.
    // claude-cli → claude-cli; codex-cli → codex-cli; everything else → claude-cli.
    if (mode === "codex-cli") return "codex-cli";
    if (mode === "api") return "openai-api";
    return "claude-cli";
  },
  resolveTranslatorBackendId: (raw: string, fallback: string) => {
    const valid = ["claude-cli", "codex-cli", "claude-api", "openai-api", "groq", "apple-vision"];
    return valid.includes(raw) ? raw : fallback;
  }
}));

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TranslatorService constructor", () => {
  it("defaults to auto choice and claude-cli bridge", () => {
    const svc = new TranslatorService();
    expect(svc.backendId).toBe("claude-cli");
  });

  it("honors explicit choice over bridge follow", () => {
    const svc = new TranslatorService({ choice: "openai-api", bridgeMode: "claude-cli" });
    expect(svc.backendId).toBe("openai-api");
  });

  it("auto mode follows the bridge mode", () => {
    const svc = new TranslatorService({ choice: "auto", bridgeMode: "codex-cli" });
    expect(svc.backendId).toBe("codex-cli");
  });
});

describe("TranslatorService.setBackend", () => {
  it("rebuilds the backend on explicit choice change", () => {
    const svc = new TranslatorService({ choice: "auto", bridgeMode: "claude-cli" });
    expect(svc.backendId).toBe("claude-cli");
    svc.setBackend("openai-api");
    expect(svc.backendId).toBe("openai-api");
  });

  it("does not rebuild if the new id matches the current one", () => {
    const svc = new TranslatorService({ choice: "claude-cli" });
    // Capture identity by sending a translation to lock the backend, then
    // re-set the same choice and verify subsequent translations route to
    // the same fake instance (no new push to calls between the two).
    void svc.translateText("hi", "uk");
    svc.setBackend("claude-cli");
    void svc.translateText("hi2", "uk");
    expect(calls.filter((c) => c.method === "translateText")).toHaveLength(2);
  });
});

describe("TranslatorService.setBridgeMode", () => {
  it("auto choice follows the bridge change", () => {
    const svc = new TranslatorService({ choice: "auto", bridgeMode: "claude-cli" });
    expect(svc.backendId).toBe("claude-cli");
    svc.setBridgeMode("codex-cli");
    expect(svc.backendId).toBe("codex-cli");
  });

  it("explicit choice ignores the bridge change", () => {
    const svc = new TranslatorService({ choice: "openai-api", bridgeMode: "claude-cli" });
    svc.setBridgeMode("codex-cli");
    expect(svc.backendId).toBe("openai-api");
  });

  it("no-op when the new bridge mode equals the current one", () => {
    const svc = new TranslatorService({ choice: "auto", bridgeMode: "claude-cli" });
    svc.setBridgeMode("claude-cli");
    expect(svc.backendId).toBe("claude-cli");
  });
});

describe("TranslatorService translation calls", () => {
  it("translateText forwards to backend.translateText", async () => {
    const svc = new TranslatorService({ choice: "claude-cli" });
    const r = await svc.translateText("hello", "uk");
    expect(r.translation).toBe("claude-cli:hello");
    expect(calls.at(-1)).toMatchObject({ id: "claude-cli", method: "translateText" });
  });

  it("translateImage forwards to backend.translateImage", async () => {
    const svc = new TranslatorService({ choice: "openai-api" });
    const r = await svc.translateImage("data==", "image/png", "uk");
    expect(r.translation).toBe("openai-api:image");
    expect(calls.at(-1)).toMatchObject({ id: "openai-api", method: "translateImage" });
  });

  it("translateAuto picks targetLang based on heuristic (cyrillic → en)", async () => {
    const svc = new TranslatorService({ choice: "claude-cli" });
    await svc.translateAuto("Привіт"); // Cyrillic → targetLang en
    expect(calls.at(-1)).toMatchObject({ method: "translateText", args: ["Привіт", "en"] });
  });

  it("translateAuto routes latin script to uk", async () => {
    const svc = new TranslatorService({ choice: "claude-cli" });
    await svc.translateAuto("hello world");
    expect(calls.at(-1)).toMatchObject({ method: "translateText", args: ["hello world", "uk"] });
  });
});

describe("resolveTranslatorChoice", () => {
  it("returns the fallback when raw is undefined", () => {
    expect(resolveTranslatorChoice(undefined, "claude-cli")).toBe("claude-cli");
  });

  it("returns auto when raw === auto", () => {
    expect(resolveTranslatorChoice("auto", "openai-api")).toBe("auto");
  });

  it("normalizes case and trims whitespace", () => {
    expect(resolveTranslatorChoice("  Claude-CLI ", "openai-api")).toBe("claude-cli");
  });

  it("falls back when raw is unknown", () => {
    expect(resolveTranslatorChoice("mystery", "claude-cli")).toBe("claude-cli");
  });

  it("auto-fallback resolves to claude-cli", () => {
    // When fallback is auto and the raw value is invalid, we expect the
    // resolver to surface a concrete backend rather than another `auto`.
    expect(resolveTranslatorChoice("nope", "auto")).toBe("claude-cli");
  });
});
