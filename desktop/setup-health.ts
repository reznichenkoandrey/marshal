import fs from "node:fs";

import { formatMegabytes, IDLE_BUDGET_BYTES, type FootprintSummary } from "./perf/footprint.ts";
import { translate, type MessageKey, type MessageParams, type UiLanguage } from "./i18n/catalog.ts";
import type { DictationBackend } from "./settings-store.ts";

type Tr = (key: MessageKey, params?: MessageParams) => string;

export type SetupHealthStatus = "ok" | "warn" | "error" | "unknown";
type MediaPermissionStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export type SetupHealthItem = {
  id: string;
  label: string;
  status: SetupHealthStatus;
  detail: string;
  action?: string;
};

export type BuildInfo = {
  revision: string | null;
  branch: string | null;
  dirty: boolean;
  builtAt: string;
};

export type SetupHealthInput = {
  platform: NodeJS.Platform;
  appVersion?: string;
  /** Written by scripts/postbuild.mjs; absent when running unbuilt sources. */
  buildInfo?: BuildInfo | null;
  dictationEnabled: boolean;
  dictationBackend: DictationBackend;
  microphoneStatus?: MediaPermissionStatus;
  screenStatus?: MediaPermissionStatus;
  accessibilityTrusted?: boolean;
  apiKeyPresent: boolean;
  /**
   * Where a packaged build looks for its own `.env`. Naming the path matters:
   * the project-root `.env` is inside the .app and unreachable once
   * installed, so "put it in .env" is not actionable advice there (#155).
   */
  envFilePath?: string;
  whisperBinPath: string;
  whisperModelPath: string;
  codesignIdentityPresent?: boolean;
  launchAtLogin: boolean;
  launchAtLoginOpenAtLogin?: boolean;
  launchAtLoginLastError?: string;
  /** Measured footprint of Marshal's process tree; null when measuring failed (#281). */
  memory?: FootprintSummary | null;
  exists?: (path: string) => boolean;
  /** Language of labels and details; English when not given. */
  language?: UiLanguage;
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
  const lang = input.language ?? "en";
  const tr: Tr = (key, params) => translate(lang, key, params);

  if (input.appVersion !== undefined) items.push(buildItem(tr, input.appVersion, input.buildInfo, lang));

  items.push(input.dictationEnabled
    ? permissionItem(tr, {
      id: "microphone",
      label: tr("health.microphone"),
      status: input.platform === "darwin" ? input.microphoneStatus : undefined,
      okDetail: tr("health.micOk"),
      missingDetail: tr("health.micMissing"),
      action: "System Settings -> Privacy & Security -> Microphone",
      // The recording is done by the audio-recorder helper, which holds its
      // own grant under its own name. This app never asks for the microphone
      // itself (#82), so its status sits at "not-determined" forever — a warn
      // there would be permanent and wrong (#174).
      notDeterminedIsUnknown: true,
      notDeterminedDetail: tr("health.micHelper")
    })
    : disabledDictationItem(tr, "microphone", tr("health.microphone")));

  items.push({
    id: "accessibility",
    label: tr("health.accessibility"),
    status: input.platform === "darwin"
      ? input.accessibilityTrusted ? "ok" : "error"
      : "unknown",
    detail: input.platform === "darwin"
      ? tr(input.accessibilityTrusted ? "health.accessOk" : "health.accessMissing")
      : tr("health.macOnly"),
    action: input.platform === "darwin"
      ? "System Settings -> Privacy & Security -> Accessibility"
      : undefined
  });

  items.push(permissionItem(tr, {
    id: "screen-recording",
    label: tr("health.screenRecording"),
    status: input.platform === "darwin" ? input.screenStatus : undefined,
    okDetail: tr("health.screenOk"),
    missingDetail: tr("health.screenMissing"),
    action: "System Settings -> Privacy & Security -> Screen Recording"
  }));

  items.push(input.dictationEnabled
    ? {
      id: "whisper-local",
      label: tr("health.localWhisper"),
      status: whisperStatus(input.dictationBackend, whisperBinExists, whisperModelExists),
      detail: whisperDetail(tr, input.dictationBackend, whisperBinExists, whisperModelExists),
      action: whisperAction(tr, whisperBinExists, whisperModelExists)
    }
    : disabledDictationItem(tr, "whisper-local", tr("health.localWhisper")));

  items.push(input.dictationEnabled
    ? {
      id: "cloud-api",
      label: tr("health.cloudApiKey"),
      status: cloudStatus(input.dictationBackend, input.apiKeyPresent),
      detail: cloudDetail(tr, input.dictationBackend, input.apiKeyPresent),
      action: apiKeyAction(tr, input.apiKeyPresent, input.envFilePath)
    }
    : disabledDictationItem(tr, "cloud-api", tr("health.cloudApiKey")));

  items.push({
    id: "codesign",
    label: tr("health.codesign"),
    status: input.platform === "darwin"
      ? input.codesignIdentityPresent ? "ok" : "warn"
      : "unknown",
    detail: input.platform === "darwin"
      ? tr(input.codesignIdentityPresent ? "health.codesignOk" : "health.codesignMissing")
      : tr("health.macOnly"),
    action: input.platform === "darwin" && !input.codesignIdentityPresent
      ? tr("health.codesignAction")
      : undefined
  });

  items.push(launchAtLoginItem(tr, input));
  if (input.memory !== undefined) items.push(memoryItem(tr, input.memory));

  return {
    items,
    counts: countStatuses(items)
  };
}

function buildItem(tr: Tr, version: string, info: BuildInfo | null | undefined, lang: UiLanguage): SetupHealthItem {
  const label = tr("health.build");
  if (!info) {
    return { id: "build", label, status: "unknown", detail: tr("health.buildUnbuilt", { version }) };
  }
  const revision = info.revision
    ? `${info.revision}${info.dirty ? tr("health.uncommitted") : ""}${info.branch ? ` (${info.branch})` : ""}`
    : tr("health.unknownRevision");
  const builtAt = new Date(info.builtAt);
  const when = Number.isNaN(builtAt.getTime())
    ? info.builtAt
    : builtAt.toLocaleString(lang === "uk" ? "uk-UA" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
  return { id: "build", label, status: "ok", detail: tr("health.buildDetail", { version, revision, when }) };
}

function memoryItem(tr: Tr, memory: FootprintSummary | null): SetupHealthItem {
  if (!memory) {
    return { id: "memory", label: tr("health.memory"), status: "unknown", detail: tr("health.memoryUnmeasured") };
  }
  const perProcess = memory.processes
    .filter((entry) => entry.bytes >= 1024 ** 2)
    .map((entry) => `${entry.name} ${formatMegabytes(entry.bytes)}`)
    .join(", ");
  const model = memory.modelBytes === null
    ? tr("health.modelNotLoaded")
    : tr("health.modelLoaded", { size: formatMegabytes(memory.modelBytes) });
  return {
    id: "memory",
    label: tr("health.memory"),
    status: memory.overBudget ? "warn" : "ok",
    detail: tr("health.memoryDetail", {
      used: formatMegabytes(memory.appBytes),
      budget: formatMegabytes(IDLE_BUDGET_BYTES),
      processes: perProcess,
      model
    })
  };
}

function launchAtLoginItem(tr: Tr, input: SetupHealthInput): SetupHealthItem {
  const label = tr("health.startAtLogin");
  if (input.platform !== "darwin" && input.platform !== "win32") {
    return {
      id: "launch-at-login",
      label,
      status: "unknown",
      detail: tr("health.loginOsOnly")
    };
  }

  const lastError = (input.launchAtLoginLastError ?? "").trim();
  if (!input.launchAtLogin) {
    return {
      id: "launch-at-login",
      label,
      status: lastError ? "warn" : "ok",
      detail: lastError
        ? tr("health.loginRejected", { error: lastError })
        : tr("health.loginDisabled")
    };
  }

  if (input.launchAtLoginOpenAtLogin) {
    return {
      id: "launch-at-login",
      label,
      status: "ok",
      detail: tr("health.loginEnabled")
    };
  }

  return {
    id: "launch-at-login",
    label,
    status: "warn",
    detail: lastError || tr("health.loginNotReported"),
    action: input.platform === "darwin" ? "System Settings -> General -> Login Items" : undefined
  };
}

function disabledDictationItem(tr: Tr, id: string, label: string): SetupHealthItem {
  return {
    id,
    label,
    status: "ok",
    detail: tr("health.dictationDisabled")
  };
}

function permissionItem(tr: Tr, input: {
  id: string;
  label: string;
  status?: MediaPermissionStatus;
  okDetail: string;
  missingDetail: string;
  action: string;
  /**
   * For a permission this process never requests itself, "not-determined"
   * says nothing about whether the feature works — report it as unknown
   * rather than as a problem the user should go fix.
   */
  notDeterminedIsUnknown?: boolean;
  notDeterminedDetail?: string;
}): SetupHealthItem {
  if (!input.status) {
    return {
      id: input.id,
      label: input.label,
      status: "unknown",
      detail: tr("health.macOnly")
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
  if (input.status === "not-determined" && input.notDeterminedIsUnknown) {
    return {
      id: input.id,
      label: input.label,
      status: "unknown",
      detail: input.notDeterminedDetail ?? input.missingDetail
    };
  }
  return {
    id: input.id,
    label: input.label,
    status: input.status === "denied" || input.status === "restricted" ? "error" : "warn",
    detail: tr("health.currentStatus", { detail: input.missingDetail, status: input.status }),
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

/**
 * The binary and the model have different remedies now that the model ships
 * out of band: building whisper-cli needs the repo checkout, while the model
 * is a download the installed app can do on its own.
 */
function whisperAction(tr: Tr, binExists: boolean, modelExists: boolean): string | undefined {
  if (binExists && modelExists) return undefined;
  if (!binExists) return tr("health.whisperSetup");
  return tr("health.whisperDownload");
}

function whisperDetail(tr: Tr, backend: DictationBackend, binExists: boolean, modelExists: boolean): string {
  if (binExists && modelExists) return tr("health.whisperOk");
  const missing = tr(!binExists && !modelExists
    ? "health.whisperMissingBoth"
    : binExists ? "health.whisperMissingModel" : "health.whisperMissingBinary");
  return tr(backend === "groq" ? "health.whisperGroqFallback" : "health.whisperLocalMissing", { missing });
}

function apiKeyAction(tr: Tr, apiKeyPresent: boolean, envFilePath: string | undefined): string | undefined {
  if (apiKeyPresent) return undefined;
  return envFilePath ? tr("health.apiKeyEnvFile", { path: envFilePath }) : tr("health.apiKeyEnv");
}

function cloudStatus(backend: DictationBackend, apiKeyPresent: boolean): SetupHealthStatus {
  if (apiKeyPresent) return "ok";
  if (backend === "groq") return "error";
  if (backend === "hybrid") return "warn";
  return "ok";
}

function cloudDetail(tr: Tr, backend: DictationBackend, apiKeyPresent: boolean): string {
  if (apiKeyPresent) return tr("health.apiKeyOk");
  if (backend === "groq") return tr("health.apiKeyGroq");
  if (backend === "hybrid") return tr("health.apiKeyHybrid");
  return tr("health.apiKeyNotNeeded");
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
