// Feature status snapshot for the home dashboard (#398). Main gathers the raw
// facts on window open and on state events it already has; this decides what
// each card says. Stats are raw values (model, backend, latency); the renderer
// adds the words.

import path from "node:path";

export type FeatureId = "dictation" | "captions" | "translator" | "speech" | "calendar";
export type FeatureState = "ready" | "running" | "off" | "no_model" | "error";

export type FeatureCard = { id: FeatureId; state: FeatureState; stats: string[] };

export type FeatureInputs = {
  dictation: { enabled: boolean; modelPath: string | null; resident: boolean; active: boolean; backend: string };
  captions: { running: boolean; stt: string };
  translator: { available: boolean; backend: string | null; open: boolean; lastLatencyMs: number | null; lastFailed: boolean };
  speech: { enabled: boolean; speaking: boolean; engine: string; engineInstalled: boolean };
  calendar: { enabled: boolean; configured: boolean; lastError: string | null; lastSyncAt: string | null };
};

/** `ggml-large-v3-turbo-q8_0.bin` → `large-v3-turbo-q8_0`. */
export function modelLabel(modelPath: string): string {
  return path.basename(modelPath).replace(/^ggml-/u, "").replace(/\.bin$/u, "");
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return "–";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function featureCards(input: FeatureInputs): FeatureCard[] {
  const { dictation, captions, translator, speech, calendar } = input;
  return [
    {
      id: "dictation",
      state: !dictation.enabled ? "off" : !dictation.modelPath && dictation.backend !== "groq" ? "no_model" : dictation.active ? "running" : "ready",
      stats: [dictation.modelPath ? modelLabel(dictation.modelPath) : dictation.backend, dictation.resident ? "resident" : "cold"]
    },
    {
      id: "captions",
      state: captions.running ? "running" : "ready",
      stats: [captions.stt]
    },
    {
      id: "translator",
      state: !translator.available || translator.lastFailed ? "error" : translator.open ? "running" : "ready",
      stats: [translator.backend ?? "–", formatLatency(translator.lastLatencyMs)]
    },
    {
      id: "speech",
      state: !speech.enabled ? "off" : !speech.engineInstalled ? "no_model" : speech.speaking ? "running" : "ready",
      stats: [speech.engine]
    },
    {
      id: "calendar",
      state: !calendar.enabled || !calendar.configured ? "off" : calendar.lastError ? "error" : "ready",
      stats: [calendar.lastSyncAt ?? "–"]
    }
  ];
}
