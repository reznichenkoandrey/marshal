import fs from "node:fs";

import type { DictationBackend } from "./settings-store.ts";

export type SetupHealthStatus = "ok" | "warn" | "error" | "unknown";
type MediaPermissionStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export type SetupHealthItem = {
  id: string;
  label: string;
  status: SetupHealthStatus;
  detail: string;
  action?: string;
};

export type SetupHealthInput = {
  platform: NodeJS.Platform;
  dictationEnabled: boolean;
  dictationBackend: DictationBackend;
  microphoneStatus?: MediaPermissionStatus;
  screenStatus?: MediaPermissionStatus;
  accessibilityTrusted?: boolean;
  apiKeyPresent: boolean;
  whisperBinPath: string;
  whisperModelPath: string;
  codesignIdentityPresent?: boolean;
  exists?: (path: string) => boolean;
};

export type SetupHealthSummary = {
  items: SetupHealthItem[];
  counts: Record<SetupHealthStatus, number>;
};

export function buildSetupHealth(input: SetupHealthInput): SetupHealthSummary {
  const exists = input.exists ?? fs.existsSync;
  const whisperBinExists = exists(input.whisperBinPath);
  const whisperModelExists = exists(input.whisperModelPath);
  const items: SetupHealthItem[] = [];

  items.push(input.dictationEnabled
    ? permissionItem({
      id: "microphone",
      label: "Microphone",
      status: input.platform === "darwin" ? input.microphoneStatus : undefined,
      okDetail: "Granted. Dictation can record audio.",
      missingDetail: "Required for voice dictation.",
      action: "System Settings -> Privacy & Security -> Microphone"
    })
    : disabledDictationItem("microphone", "Microphone"));

  items.push({
    id: "accessibility",
    label: "Accessibility",
    status: input.platform === "darwin"
      ? input.accessibilityTrusted ? "ok" : "error"
      : "unknown",
    detail: input.platform === "darwin"
      ? input.accessibilityTrusted
        ? "Granted. Hotkeys and text insertion can control the focused app."
        : "Required for global hotkeys and direct text insertion."
      : "Only checked on macOS.",
    action: input.platform === "darwin"
      ? "System Settings -> Privacy & Security -> Accessibility"
      : undefined
  });

  items.push(permissionItem({
    id: "screen-recording",
    label: "Screen Recording",
    status: input.platform === "darwin" ? input.screenStatus : undefined,
    okDetail: "Granted. OCR translation and capture workflows can read the screen.",
    missingDetail: "Required for OCR translation and screen capture.",
    action: "System Settings -> Privacy & Security -> Screen Recording"
  }));

  items.push(input.dictationEnabled
    ? {
      id: "whisper-local",
      label: "Local Whisper",
      status: whisperStatus(input.dictationBackend, whisperBinExists, whisperModelExists),
      detail: whisperDetail(input.dictationBackend, whisperBinExists, whisperModelExists),
      action: whisperBinExists && whisperModelExists ? undefined : "Run npm run setup:dictation"
    }
    : disabledDictationItem("whisper-local", "Local Whisper"));

  items.push(input.dictationEnabled
    ? {
      id: "cloud-api",
      label: "Cloud API key",
      status: cloudStatus(input.dictationBackend, input.apiKeyPresent),
      detail: cloudDetail(input.dictationBackend, input.apiKeyPresent),
      action: input.apiKeyPresent ? undefined : "Set MARSHAL_API_KEY in .env"
    }
    : disabledDictationItem("cloud-api", "Cloud API key"));

  items.push({
    id: "codesign",
    label: "Stable dev codesign",
    status: input.platform === "darwin"
      ? input.codesignIdentityPresent ? "ok" : "warn"
      : "unknown",
    detail: input.platform === "darwin"
      ? input.codesignIdentityPresent
        ? "Marshal Self-Signed identity is available. macOS TCC grants should survive rebuilds."
        : "Missing Marshal Self-Signed identity. Rebuilds may reset TCC permissions."
      : "Only checked on macOS.",
    action: input.platform === "darwin" && !input.codesignIdentityPresent
      ? "Run npm run setup:codesign-cert"
      : undefined
  });

  return {
    items,
    counts: countStatuses(items)
  };
}

function disabledDictationItem(id: string, label: string): SetupHealthItem {
  return {
    id,
    label,
    status: "ok",
    detail: "Voice dictation is disabled."
  };
}

function permissionItem(input: {
  id: string;
  label: string;
  status?: MediaPermissionStatus;
  okDetail: string;
  missingDetail: string;
  action: string;
}): SetupHealthItem {
  if (!input.status) {
    return {
      id: input.id,
      label: input.label,
      status: "unknown",
      detail: "Only checked on macOS."
    };
  }
  if (input.status === "granted") {
    return {
      id: input.id,
      label: input.label,
      status: "ok",
      detail: input.okDetail
    };
  }
  return {
    id: input.id,
    label: input.label,
    status: input.status === "denied" || input.status === "restricted" ? "error" : "warn",
    detail: `${input.missingDetail} Current status: ${input.status}.`,
    action: input.action
  };
}

function whisperStatus(
  backend: DictationBackend,
  binExists: boolean,
  modelExists: boolean
): SetupHealthStatus {
  if (binExists && modelExists) return "ok";
  return backend === "groq" ? "warn" : "error";
}

function whisperDetail(backend: DictationBackend, binExists: boolean, modelExists: boolean): string {
  if (binExists && modelExists) return "whisper.cpp binary and model are present.";
  const missing = [
    binExists ? "" : "binary",
    modelExists ? "" : "model"
  ].filter(Boolean).join(" and ");
  if (backend === "groq") {
    return `Local fallback is missing ${missing}; Groq-only dictation can still run while online.`;
  }
  return `Local transcription is missing ${missing}.`;
}

function cloudStatus(backend: DictationBackend, apiKeyPresent: boolean): SetupHealthStatus {
  if (apiKeyPresent) return "ok";
  if (backend === "groq") return "error";
  if (backend === "hybrid") return "warn";
  return "ok";
}

function cloudDetail(backend: DictationBackend, apiKeyPresent: boolean): string {
  if (apiKeyPresent) return "MARSHAL_API_KEY is configured.";
  if (backend === "groq") return "Groq-only dictation requires MARSHAL_API_KEY.";
  if (backend === "hybrid") return "Hybrid dictation will use local Whisper until MARSHAL_API_KEY is set.";
  return "Not required for local-only dictation.";
}

function countStatuses(items: SetupHealthItem[]): Record<SetupHealthStatus, number> {
  return items.reduce<Record<SetupHealthStatus, number>>(
    (counts, item) => {
      counts[item.status] += 1;
      return counts;
    },
    { ok: 0, warn: 0, error: 0, unknown: 0 }
  );
}
