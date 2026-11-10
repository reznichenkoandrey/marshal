// Settings as a view inside the assistant home (#317). The home owns showing
// and hiding it; this module owns the form.

const api = window.marshalDesktop;
const t = (key, params) => window.MarshalI18n?.t(key, params) ?? key;

const dom = {
  settingsLanguage: document.getElementById("settings-language"),
  settingsHealthSummary: document.getElementById("settings-health-summary"),
  settingsHealthList: document.getElementById("settings-health-list"),
  settingsHealthRefresh: document.getElementById("settings-health-refresh"),
  settingsBridgeMode: document.getElementById("settings-bridge-mode"),
  settingsClaudeModel: document.getElementById("settings-claude-model"),
  settingsCodexModel: document.getElementById("settings-codex-model"),
  settingsProviderHint: document.getElementById("settings-provider-hint"),
  settingsTranslatorBackend: document.getElementById("settings-translator-backend"),
  settingsDictationEnabled: document.getElementById("settings-dictation-enabled"),
  settingsDictationHotkey: document.getElementById("settings-dictation-hotkey"),
  settingsDictationHoldDelay: document.getElementById("settings-dictation-hold-delay"),
  settingsDictationToggleTapCount: document.getElementById("settings-dictation-toggle-tap-count"),
  settingsDictationBackend: document.getElementById("settings-dictation-backend"),
  settingsDictationLanguage: document.getElementById("settings-dictation-language"),
  settingsClaudeHooksStatus: document.getElementById("settings-claude-hooks-status"),
  settingsClaudeHooksToggle: document.getElementById("settings-claude-hooks-toggle"),
  settingsClaudeSummaryLanguage: document.getElementById("settings-claude-summary-language"),
  settingsClaudeContextRouting: document.getElementById("settings-claude-context-routing"),
  settingsClaudeRoutingRoots: document.getElementById("settings-claude-routing-roots"),
  settingsClaudeRoutingCount: document.getElementById("settings-claude-routing-count"),
  settingsDictationAutoPaste: document.getElementById("settings-dictation-autopaste"),
  settingsDictationPrompt: document.getElementById("settings-dictation-prompt"),
  settingsDictationPromptReset: document.getElementById("settings-dictation-prompt-reset"),
  settingsDictationMicrophone: document.getElementById("settings-dictation-microphone"),
  settingsDictationMicrophoneRefresh: document.getElementById("settings-dictation-microphone-refresh"),
  settingsCaptionsHotkey: document.getElementById("settings-captions-hotkey"),
  settingsCaptionsOcrHotkey: document.getElementById("settings-captions-ocr-hotkey"),
  settingsCaptionsDragModifier: document.getElementById("settings-captions-drag-modifier"),
  settingsCaptionsProvider: document.getElementById("settings-captions-provider"),
  settingsCaptionsModel: document.getElementById("settings-captions-model"),
  settingsCaptionsOutputLanguage: document.getElementById("settings-captions-output-language"),
  settingsCaptionsSttBackend: document.getElementById("settings-captions-stt-backend"),
  settingsCaptionsLanguage: document.getElementById("settings-captions-language"),
  settingsCaptionsPrompt: document.getElementById("settings-captions-prompt"),
  settingsCaptionsVad: document.getElementById("settings-captions-vad"),
  settingsCaptionsContextDir: document.getElementById("settings-captions-context-dir"),
  settingsCaptionsContextOpen: document.getElementById("settings-captions-context-open"),
  settingsCaptionsContextInfo: document.getElementById("settings-captions-context-info"),
  settingsCaptionsSilenceMs: document.getElementById("settings-captions-silence-ms"),
  settingsCaptionsTurnPolicy: document.getElementById("settings-captions-turn-policy"),
  settingsCaptionsSpeculativeStt: document.getElementById("settings-captions-speculative-stt"),
  settingsCaptionsMixMic: document.getElementById("settings-captions-mix-mic"),
  settingsCaptionsPromptReset: document.getElementById("settings-captions-prompt-reset"),
  settingsCaptureFolder: document.getElementById("settings-capture-folder"),
  settingsCaptureFolderPick: document.getElementById("settings-capture-folder-pick"),
  settingsLaunchAtLogin: document.getElementById("settings-launch-at-login"),
  settingsSpeechEnabled: document.getElementById("settings-speech-enabled"),
  settingsAssistantDispatcher: document.getElementById("settings-assistant-dispatcher"),
  settingsAssistantGeneralDir: document.getElementById("settings-assistant-general-dir"),
  settingsAssistantGeneralMode: document.getElementById("settings-assistant-general-mode"),
  settingsAssistantModel: document.getElementById("settings-assistant-model"),
  settingsSpeechVoiceUk: document.getElementById("settings-speech-voice-uk"),
  settingsSpeechVoiceEn: document.getElementById("settings-speech-voice-en"),
  settingsSpeechRate: document.getElementById("settings-speech-rate"),
  settingsSpeechTest: document.getElementById("settings-speech-test"),
  settingsSpeechStatus: document.getElementById("settings-speech-status"),
  settingsCheckUpdates: document.getElementById("settings-check-updates"),
  settingsCalendarEnabled: document.getElementById("settings-calendar-enabled"),
  settingsCalendarUrl: document.getElementById("settings-calendar-url"),
  settingsCalendarForget: document.getElementById("settings-calendar-forget"),
  settingsCalendarStatus: document.getElementById("settings-calendar-status"),
  settingsCheckUpdatesNow: document.getElementById("settings-check-updates-now"),
  settingsUpdateResult: document.getElementById("settings-update-result"),
  settingsSave: document.getElementById("settings-save"),
  settingsStatus: document.getElementById("settings-status"),
  appearanceSegmented: document.getElementById("appearance-segmented"),
  settingsLook: document.getElementById("settings-look"),
  settingsPalette: document.getElementById("settings-palette"),
  settingsPaletteField: document.getElementById("settings-palette-field"),
};
async function populateMicrophoneDropdown(preferredValue) {
  // Re-build the input-device dropdown from a fresh listMicrophones() call.
  // The default "System default" option is the first <option> in the markup
  // and is preserved across rebuilds — its value is the empty string, which
  // is also what settings save as "track macOS default". See #95.
  const select = dom.settingsDictationMicrophone;
  if (!select || !api?.listMicrophones) return;
  let result;
  try {
    result = await api.listMicrophones();
  } catch (err) {
    console.warn("listMicrophones failed", err);
    return;
  }
  const devices = Array.isArray(result?.devices) ? result.devices : [];
  // Keep the first option (system default) and rebuild the rest.
  const firstOption = select.firstElementChild;
  select.innerHTML = "";
  if (firstOption) select.appendChild(firstOption);
  for (const device of devices) {
    if (!device || typeof device.id !== "string" || !device.id) continue;
    const option = document.createElement("option");
    option.value = device.id;
    const transport = device.transportType && device.transportType !== "Unknown"
      ? ` · ${device.transportType}`
      : "";
    const defaultBadge = device.isDefault ? ` ${t("settings.micSystemDefaultBadge")}` : "";
    option.textContent = `${device.name}${transport}${defaultBadge}`;
    select.appendChild(option);
  }
  // Re-apply the preferred selection. If the saved mic was unplugged (not in
  // the new device list), browsers silently fall back to the first option,
  // which is the "system default" sentinel — exactly the safe behavior.
  if (typeof preferredValue === "string") {
    select.value = preferredValue;
  }
}


async function populateSpeechVoices(voiceUk, voiceEn) {
  if (!api?.getSpeechVoices) return;
  let report;
  try {
    report = await api.getSpeechVoices();
  } catch (err) {
    console.warn("getSpeechVoices failed", err);
    return;
  }
  const fill = (select, voices, preferred) => {
    if (!select) return;
    const automatic = select.firstElementChild;
    select.innerHTML = "";
    if (automatic) select.appendChild(automatic);
    for (const voice of voices) {
      const option = document.createElement("option");
      option.value = voice.name;
      option.textContent = `${voice.name} · ${voice.locale}`;
      select.appendChild(option);
    }
    // A saved voice that was since removed falls back to "Automatic".
    select.value = voices.some((voice) => voice.name === preferred) ? preferred : "";
  };
  fill(dom.settingsSpeechVoiceUk, report?.uk ?? [], voiceUk);
  fill(dom.settingsSpeechVoiceEn, report?.en ?? [], voiceEn);
  if (!dom.settingsSpeechStatus) return;
  dom.settingsSpeechStatus.textContent = !report?.available
    ? t("settings.speechUnavailable")
    : (report.uk ?? []).length === 0 ? t("settings.noUkVoice") : t("settings.usesTheSavedSettingsSave");
}

async function speakTestPhrase() {
  if (!api?.speakTestPhrase || !dom.settingsSpeechStatus) return;
  dom.settingsSpeechStatus.textContent = t("settings.speaking");
  try {
    const results = await api.speakTestPhrase();
    dom.settingsSpeechStatus.textContent = results
      .map((result) => (result.ok ? `${result.lang}: ${result.voice}` : `${result.lang ?? "?"}: ${result.error}`))
      .join(" · ");
  } catch (err) {
    dom.settingsSpeechStatus.textContent = t("settings.testFailed", { error: err?.message ?? String(err) });
  }
}

// ── Appearance (light / dark / system) and look ──

function applyAppearance(value) {
  window.MarshalTheme?.setAppearance(value);
  refreshAppearanceSegmented();
}

function refreshLookFields() {
  const theme = window.MarshalTheme?.current();
  if (!theme) return;
  if (dom.settingsLook) dom.settingsLook.value = theme.look;
  if (dom.settingsPalette) dom.settingsPalette.value = theme.palette;
  dom.settingsPaletteField?.classList.toggle("hidden", theme.look !== "hud");
}

function refreshAppearanceSegmented() {
  if (!dom.appearanceSegmented) return;
  const current = window.MarshalTheme?.appearance() ?? "system";
  dom.appearanceSegmented.querySelectorAll(".segmented-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.appearance === current);
    btn.setAttribute("aria-selected", btn.dataset.appearance === current ? "true" : "false");
  });
}

const PROVIDER_HINT_KEYS = {
  "claude-cli": "settings.providerHint.claudeCli",
  "codex-cli": "settings.providerHint.codexCli",
  "claude": "settings.providerHint.claude",
  "api": "settings.providerHint.api",
  "claude-web": "settings.providerHint.claudeWeb",
  "playwright": "settings.providerHint.playwright",
  "extension": "settings.providerHint.extension"
};

async function openSettings() {
  if (!api?.getSettings) return;
  try {
    const current = await api.getSettings();
    dom.settingsBridgeMode.value = current.bridgeMode;
    dom.settingsClaudeModel.value = current.claudeModel ?? "";
    dom.settingsCodexModel.value = current.codexModel ?? "";
    if (dom.settingsLanguage) dom.settingsLanguage.value = current.assistantLanguage ?? "auto";
    if (dom.settingsTranslatorBackend) {
      dom.settingsTranslatorBackend.value = current.translatorBackend ?? "auto";
    }
    if (dom.settingsDictationEnabled) {
      dom.settingsDictationEnabled.checked = current.dictationEnabled ?? true;
    }
    if (dom.settingsDictationHotkey) {
      dom.settingsDictationHotkey.value = current.dictationHotkey ?? "Cmd+Shift+D";
    }
    if (dom.settingsDictationHoldDelay) {
      dom.settingsDictationHoldDelay.value = String(current.dictationHoldDelayMs ?? 200);
    }
    if (dom.settingsDictationToggleTapCount) {
      dom.settingsDictationToggleTapCount.value = String(current.dictationToggleTapCount ?? 0);
    }
    if (dom.settingsDictationBackend) {
      dom.settingsDictationBackend.value = current.dictationBackend ?? "hybrid";
    }
    if (dom.settingsDictationLanguage) {
      dom.settingsDictationLanguage.value = current.dictationLanguage ?? "auto";
    }
    if (dom.settingsClaudeSummaryLanguage) {
      dom.settingsClaudeSummaryLanguage.value = current.claudeCodeSummaryLanguage ?? "auto";
    }
    if (dom.settingsClaudeContextRouting) {
      dom.settingsClaudeContextRouting.checked = current.claudeCodeContextRouting ?? true;
    }
    if (dom.settingsClaudeRoutingRoots) {
      dom.settingsClaudeRoutingRoots.value = current.claudeCodeRoutingRoots ?? "";
    }
    if (dom.settingsDictationAutoPaste) {
      dom.settingsDictationAutoPaste.checked = current.dictationAutoPaste ?? false;
    }
    if (dom.settingsDictationPrompt) {
      dom.settingsDictationPrompt.value = current.dictationPrompt ?? "";
    }
    // Microphone dropdown is populated lazily — we fire-and-forget so the
    // settings modal opens instantly even if HAL is slow. The default
    // option ("") is already in the markup so the value sticks immediately.
    if (dom.settingsDictationMicrophone) {
      dom.settingsDictationMicrophone.value = current.dictationMicrophone ?? "";
      void populateMicrophoneDropdown(current.dictationMicrophone ?? "");
    }
    const captionsFields = {
      settingsCaptionsHotkey: current.captionsHotkey ?? "CommandOrControl+Alt+Shift+C",
      settingsCaptionsOcrHotkey: current.captionsOcrHotkey ?? "Control+Shift+S",
      settingsCaptionsDragModifier: current.captionsDragModifier ?? "LeftControl",
      settingsCaptionsProvider: current.captionsProvider ?? "auto",
      settingsCaptionsModel: current.captionsModel ?? "",
      settingsCaptionsOutputLanguage: current.captionsOutputLanguage ?? "",
      settingsCaptionsSttBackend: current.captionsSttBackend ?? "auto",
      settingsCaptionsLanguage: current.captionsLanguage ?? "auto",
      settingsCaptionsPrompt: current.captionsPrompt ?? "",
      settingsCaptionsVad: current.captionsVad ?? "silero",
      settingsCaptionsSilenceMs: String(current.captionsSilenceMs ?? 900),
      settingsCaptionsTurnPolicy: current.captionsTurnPolicy ?? "interrupt"
    };
    if (dom.settingsCaptionsSpeculativeStt) {
      dom.settingsCaptionsSpeculativeStt.checked = current.captionsSpeculativeStt ?? true;
    }
    if (dom.settingsCaptionsMixMic) {
      dom.settingsCaptionsMixMic.checked = current.captionsMixMicrophone ?? false;
    }
    for (const [key, value] of Object.entries(captionsFields)) {
      if (dom[key]) dom[key].value = value;
    }
    void refreshCaptionsContextInfo();
    if (dom.settingsCaptureFolder) {
      dom.settingsCaptureFolder.value = current.captureDefaultFolder ?? "";
    }
    if (dom.settingsLaunchAtLogin) {
      dom.settingsLaunchAtLogin.checked = current.launchAtLogin ?? false;
    }
    if (dom.settingsCheckUpdates) {
      dom.settingsCheckUpdates.checked = current.checkForUpdatesAutomatic ?? true;
    }
    if (dom.settingsCalendarEnabled) {
      dom.settingsCalendarEnabled.checked = current.calendarEnabled ?? false;
    }
    if (dom.settingsCalendarUrl) dom.settingsCalendarUrl.value = "";
    void api?.calendarStatus?.().then(renderCalendarStatus).catch(() => renderCalendarStatus(null));
    if (dom.settingsSpeechEnabled) dom.settingsSpeechEnabled.checked = current.speechEnabled ?? false;
    if (dom.settingsAssistantDispatcher) dom.settingsAssistantDispatcher.checked = current.assistantDispatcher ?? false;
    if (dom.settingsAssistantGeneralDir) dom.settingsAssistantGeneralDir.value = current.assistantGeneralDir ?? "";
    if (dom.settingsAssistantGeneralMode) dom.settingsAssistantGeneralMode.value = current.assistantGeneralPermissionMode ?? "bypass";
    if (dom.settingsAssistantModel) dom.settingsAssistantModel.value = current.assistantDispatcherModel ?? "haiku";
    if (dom.settingsSpeechRate) dom.settingsSpeechRate.value = String(current.speechRate ?? 190);
    void populateSpeechVoices(current.speechVoiceUk ?? "", current.speechVoiceEn ?? "");
    refreshSettingsVisibility();
    refreshAppearanceSegmented();
    refreshLookFields();
    void refreshSetupHealth();
    void refreshClaudeHooks();
    clearSettingsStatus();
  } catch (err) {
    console.error("openSettings failed", err);
  }
}

let claudeHooksInstalled = false;
let claudeHooksState = null;

function renderClaudeHooks(state) {
  if (!dom.settingsClaudeHooksStatus || !dom.settingsClaudeHooksToggle) return;
  claudeHooksState = state;
  claudeHooksInstalled = state?.installed === true;
  dom.settingsClaudeHooksStatus.textContent = state?.error
    ? t("settings.failed", { error: state.error })
    : t(claudeHooksInstalled ? "settings.hooksInstalled" : "settings.hooksNotInstalled");
  dom.settingsClaudeHooksToggle.textContent = t(claudeHooksInstalled ? "settings.removeHooks" : "settings.installHooks");
  dom.settingsClaudeHooksToggle.disabled = false;
  if (dom.settingsClaudeRoutingCount) {
    const sessions = state?.sessions;
    dom.settingsClaudeRoutingCount.textContent = sessions
      ? t("settings.routingCount", { routable: sessions.routable, live: sessions.live })
      : "";
  }
}

async function refreshClaudeHooks() {
  if (!api?.getClaudeCodeHooks) return;
  renderClaudeHooks(await api.getClaudeCodeHooks().catch((err) => ({ installed: false, error: err?.message ?? String(err) })));
}

async function toggleClaudeHooks() {
  if (!api?.setClaudeCodeHooks || !dom.settingsClaudeHooksToggle) return;
  dom.settingsClaudeHooksToggle.disabled = true;
  const next = !claudeHooksInstalled;
  renderClaudeHooks(await api.setClaudeCodeHooks(next).catch((err) => ({
    installed: claudeHooksInstalled,
    error: err?.message ?? String(err)
  })));
}

let calendarStatus = null;

// The saved address never comes back from main; only whether one exists.
function renderCalendarStatus(status) {
  if (!dom.settingsCalendarStatus) return;
  calendarStatus = status;
  let text = t("settings.calendar.noAddress");
  if (status?.configured) {
    text = t("settings.calendar.saved");
    if (status.lastError) text += ` ${t("settings.calendar.lastCheckFailed", { error: status.lastError })}`;
    else if (status.next) {
      const start = new Date(status.next.start).toLocaleString(window.MarshalI18n?.language() === "uk" ? "uk-UA" : "en-GB");
      text += ` ${t("settings.calendar.next", { start, title: status.next.title })}`;
    } else if (status.lastSyncAt) text += ` ${t("settings.calendar.noUpcoming")}`;
  }
  dom.settingsCalendarStatus.textContent = text;
  if (dom.settingsCalendarUrl) {
    dom.settingsCalendarUrl.placeholder = status?.configured
      ? t("settings.calendar.replacePlaceholder")
      : "https://calendar.google.com/calendar/ical/…/basic.ics";
  }
}

async function refreshSetupHealth() {
  if (!api?.getSetupHealth || !dom.settingsHealthList || !dom.settingsHealthSummary) return;
  if (dom.settingsHealthRefresh) dom.settingsHealthRefresh.disabled = true;
  dom.settingsHealthSummary.textContent = t("settings.checking");
  dom.settingsHealthList.innerHTML = "";
  try {
    const health = await api.getSetupHealth();
    renderSetupHealth(health);
  } catch (err) {
    dom.settingsHealthSummary.textContent = t("settings.checkFailed", { error: err?.message ?? err });
  } finally {
    if (dom.settingsHealthRefresh) dom.settingsHealthRefresh.disabled = false;
  }
}

function renderSetupHealth(health) {
  const items = Array.isArray(health?.items) ? health.items : [];
  const counts = health?.counts ?? {};
  const blocking = Number(counts.error ?? 0);
  const warnings = Number(counts.warn ?? 0);
  dom.settingsHealthSummary.textContent = blocking > 0
    ? t("settings.health.blocking", { blocking, warnings })
    : warnings > 0
      ? t("settings.health.warnings", { warnings })
      : t("settings.health.ready");
  dom.settingsHealthList.innerHTML = items.map(renderSetupHealthItem).join("");
}

function renderSetupHealthItem(item) {
  const status = typeof item?.status === "string" ? item.status : "unknown";
  const label = escapeHtml(item?.label ?? t("settings.health.unknown"));
  const detail = escapeHtml(item?.detail ?? "");
  const action = item?.action ? `<span class="health-action">${escapeHtml(item.action)}</span>` : "";
  return `
    <div class="health-item health-${status}">
      <span class="health-dot" aria-hidden="true"></span>
      <div class="health-copy">
        <div class="health-title">${label}</div>
        <div class="health-detail">${detail}${action}</div>
      </div>
    </div>
  `;
}

let closeSettings = () => {};

function refreshSettingsVisibility() {
  const mode = dom.settingsBridgeMode.value;
  dom.settingsProviderHint.textContent = PROVIDER_HINT_KEYS[mode] ? t(PROVIDER_HINT_KEYS[mode]) : "";
  document.querySelectorAll("[data-visible-for]").forEach((el) => {
    const applicable = el.getAttribute("data-visible-for").split(",").map((s) => s.trim());
    el.classList.toggle("hidden", !applicable.includes(mode));
  });
}

function showSettingsStatus(message, kind) {
  dom.settingsStatus.textContent = message;
  dom.settingsStatus.classList.remove("hidden", "success", "error");
  if (kind) dom.settingsStatus.classList.add(kind);
}

function clearSettingsStatus() {
  dom.settingsStatus.classList.add("hidden");
  dom.settingsStatus.textContent = "";
}

async function refreshCaptionsContextInfo() {
  if (!api?.getCaptionsContextInfo || !dom.settingsCaptionsContextDir) return;
  try {
    const info = await api.getCaptionsContextInfo();
    dom.settingsCaptionsContextDir.value = info.dir || t("settings.captionsUnavailable");
    const used = info.files.filter((file) => file.included > 0);
    if (dom.settingsCaptionsContextInfo) {
      const files = used.map((file) => file.name).join(", ");
      const summary = used.length === 0
        ? t("settings.context.none")
        : info.truncated > 0
          ? t("settings.context.filesCut", { count: used.length, files, cut: info.truncated })
          : t("settings.context.files", { count: used.length, files });
      dom.settingsCaptionsContextInfo.textContent = `${summary} ${t("settings.context.hint")}`;
    }
  } catch (err) {
    console.error("getCaptionsContextInfo failed", err);
  }
}

async function saveSettingsFromForm() {
  if (!api?.updateSettings) return;
  const payload = {
    bridgeMode: dom.settingsBridgeMode.value,
    claudeModel: dom.settingsClaudeModel.value.trim(),
    codexModel: dom.settingsCodexModel.value.trim(),
    translatorBackend: dom.settingsTranslatorBackend?.value ?? "auto",
    assistantLanguage: dom.settingsLanguage?.value ?? "auto",
    dictationEnabled: dom.settingsDictationEnabled?.checked ?? true,
    dictationHotkey: (dom.settingsDictationHotkey?.value ?? "RightCmd").trim() || "RightCmd",
    dictationHoldDelayMs: Number.parseInt(dom.settingsDictationHoldDelay?.value ?? "200", 10),
    dictationToggleTapCount: Number.parseInt(dom.settingsDictationToggleTapCount?.value ?? "0", 10),
    dictationBackend: dom.settingsDictationBackend?.value ?? "hybrid",
    dictationLanguage: dom.settingsDictationLanguage?.value ?? "auto",
    claudeCodeSummaryLanguage: dom.settingsClaudeSummaryLanguage?.value ?? "auto",
    claudeCodeContextRouting: dom.settingsClaudeContextRouting?.checked ?? true,
    claudeCodeRoutingRoots: dom.settingsClaudeRoutingRoots?.value ?? "",
    dictationMicrophone: (dom.settingsDictationMicrophone?.value ?? "").trim(),
    dictationAutoPaste: dom.settingsDictationAutoPaste?.checked ?? false,
    dictationPrompt: dom.settingsDictationPrompt?.value ?? "",
    captionsHotkey: (dom.settingsCaptionsHotkey?.value ?? "").trim(),
    captionsOcrHotkey: (dom.settingsCaptionsOcrHotkey?.value ?? "").trim(),
    captionsDragModifier: (dom.settingsCaptionsDragModifier?.value ?? "").trim(),
    captionsProvider: dom.settingsCaptionsProvider?.value ?? "auto",
    captionsModel: (dom.settingsCaptionsModel?.value ?? "").trim(),
    captionsOutputLanguage: (dom.settingsCaptionsOutputLanguage?.value ?? "").trim(),
    captionsSttBackend: dom.settingsCaptionsSttBackend?.value ?? "auto",
    captionsLanguage: dom.settingsCaptionsLanguage?.value ?? "auto",
    captionsPrompt: dom.settingsCaptionsPrompt?.value ?? "",
    captionsVad: dom.settingsCaptionsVad?.value ?? "silero",
    captionsSilenceMs: Number.parseInt(dom.settingsCaptionsSilenceMs?.value ?? "900", 10),
    captionsTurnPolicy: dom.settingsCaptionsTurnPolicy?.value ?? "interrupt",
    captionsSpeculativeStt: dom.settingsCaptionsSpeculativeStt?.checked ?? true,
    captionsMixMicrophone: dom.settingsCaptionsMixMic?.checked ?? false,
    captureDefaultFolder: dom.settingsCaptureFolder?.value.trim() ?? "",
    launchAtLogin: dom.settingsLaunchAtLogin?.checked ?? false,
    checkForUpdatesAutomatic: dom.settingsCheckUpdates?.checked ?? true,
    calendarEnabled: dom.settingsCalendarEnabled?.checked ?? false,
    speechEnabled: dom.settingsSpeechEnabled?.checked ?? false,
    assistantDispatcher: dom.settingsAssistantDispatcher?.checked ?? false,
    assistantGeneralDir: dom.settingsAssistantGeneralDir?.value.trim() ?? "",
    assistantGeneralPermissionMode: dom.settingsAssistantGeneralMode?.value ?? "bypass",
    assistantDispatcherModel: dom.settingsAssistantModel?.value.trim() || "haiku",
    speechRate: Number.parseInt(dom.settingsSpeechRate?.value ?? "190", 10),
    speechVoiceUk: dom.settingsSpeechVoiceUk?.value ?? "",
    speechVoiceEn: dom.settingsSpeechVoiceEn?.value ?? ""
  };
  dom.settingsSave.disabled = true;
  showSettingsStatus(t("settings.saving"), null);
  try {
    // Saved before the settings so turning reminders on starts with the new address.
    const calendarUrl = dom.settingsCalendarUrl?.value.trim() ?? "";
    if (calendarUrl && api.calendarSetUrl) {
      renderCalendarStatus(await api.calendarSetUrl(calendarUrl));
      dom.settingsCalendarUrl.value = "";
    }
    const saved = await api.updateSettings(payload);
    if (dom.settingsLaunchAtLogin) {
      dom.settingsLaunchAtLogin.checked = saved?.launchAtLogin ?? false;
    }
    void refreshSetupHealth();
    const launchRejected = payload.launchAtLogin && saved?.launchAtLogin === false;
    showSettingsStatus(
      launchRejected
        ? t("settings.savedLoginRejected")
        : t("settings.saved"),
      launchRejected ? "error" : "success"
    );
    if (!launchRejected) {
      setTimeout(closeSettings, 900);
    }
  } catch (err) {
    console.error("saveSettings failed", err);
    showSettingsStatus(t("settings.failed", { error: err?.message ?? err }), "error");
  } finally {
    dom.settingsSave.disabled = false;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Settings: check for updates ──

async function checkForUpdatesFromSettings() {
  const btn = dom.settingsCheckUpdatesNow;
  const out = dom.settingsUpdateResult;
  if (!btn || !out || !api?.checkForUpdatesSilent) return;

  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = t("settings.checking");
  out.classList.remove("hidden", "is-available", "is-error");
  out.innerHTML = `<div class="update-result-row"><span class="title">${escapeHtml(t("settings.update.contacting"))}</span></div>`;

  try {
    const result = await api.checkForUpdatesSilent();
    renderUpdateResult(result);
  } catch (err) {
    out.classList.add("is-error");
    out.innerHTML = `<div class="update-result-row"><span class="title">${escapeHtml(t("settings.checkFailed", { error: err?.message ?? String(err) }))}</span></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

function renderUpdateResult(result) {
  const out = dom.settingsUpdateResult;
  if (!out) return;
  out.classList.remove("is-available", "is-error");

  if (result && "error" in result && result.error) {
    out.classList.add("is-error");
    out.innerHTML = `<div class="update-result-row"><span class="title">${escapeHtml(t("settings.update.unreachable", { error: result.error }))}</span></div>`;
    return;
  }
  if (!result || !("available" in result)) {
    out.classList.add("is-error");
    out.innerHTML = `<div class="update-result-row"><span class="title">${escapeHtml(t("settings.update.unexpected"))}</span></div>`;
    return;
  }
  if (!result.available) {
    out.innerHTML = `<div class="update-result-row"><span class="title">${escapeHtml(t("settings.update.upToDate", { version: result.currentVersion ?? "" }))}</span></div>`;
    return;
  }

  out.classList.add("is-available");
  const fallbackUrl = result.downloadUrl || result.releaseUrl;
  const notes = (result.releaseNotes ?? "").trim();
  const canInstall = Boolean(result.installable);

  const installButton = canInstall
    ? `<button type="button" class="btn btn-primary" data-update-install>${escapeHtml(t("settings.update.install"))}</button>`
    : "";
  const releasePageLinkClass = canInstall ? "btn-secondary-link" : "btn btn-primary";
  const releasePageLinkLabel = escapeHtml(t(canInstall ? "settings.update.releasePage" : "settings.update.download"));

  out.innerHTML = `
    <div class="update-result-row">
      <span class="title">${escapeHtml(t("settings.update.available", { version: result.latestVersion }))} <span style="color:var(--text-muted);font-weight:400;">${escapeHtml(t("settings.update.youHave", { version: result.currentVersion }))}</span></span>
      <div class="update-result-actions">
        ${installButton}
        <button type="button" class="${releasePageLinkClass}" data-update-release-page>${releasePageLinkLabel}</button>
      </div>
    </div>
    ${notes ? `<div class="update-result-notes">${escapeHtml(notes)}</div>` : ""}
  `;
  out.querySelector("[data-update-release-page]")?.addEventListener("click", () => {
    void api.openExternal?.(fallbackUrl);
  });
  out.querySelector("[data-update-install]")?.addEventListener("click", () => {
    void startInPlaceInstall(result);
  });
}

const UPDATE_PHASES = new Set(["starting", "downloading", "verifying", "extracting", "staging", "relaunching", "done", "error"]);
const phaseLabel = (phase) => (UPDATE_PHASES.has(phase) ? t(`settings.update.phase.${phase}`) : phase);

let updateInstallDisposer = null;

async function startInPlaceInstall(result) {
  const out = dom.settingsUpdateResult;
  if (!out || !api?.startUpdateInstall) return;

  // Drop the action buttons immediately so the user can't double-click.
  out.classList.remove("is-error");
  out.classList.add("is-available");
  out.innerHTML = `
    <div class="update-result-row">
      <span class="title">${escapeHtml(t("settings.update.installing", { version: result.latestVersion }))}</span>
    </div>
    <div class="update-progress">
      <div class="update-progress-bar is-indeterminate"><div class="update-progress-bar-fill"></div></div>
      <div class="update-progress-label">
        <span data-update-phase>${escapeHtml(phaseLabel("starting"))}</span>
        <span data-update-detail></span>
      </div>
    </div>
  `;

  const bar = out.querySelector(".update-progress-bar");
  const fill = out.querySelector(".update-progress-bar-fill");
  const phaseEl = out.querySelector("[data-update-phase]");
  const detailEl = out.querySelector("[data-update-detail]");

  if (typeof updateInstallDisposer === "function") {
    updateInstallDisposer();
    updateInstallDisposer = null;
  }
  updateInstallDisposer = api.onUpdateInstallProgress?.((_event, payload) => {
    if (!payload) return;
    phaseEl.textContent = phaseLabel(payload.phase);
    if (Number.isFinite(payload.ratio) && payload.ratio >= 0 && payload.ratio <= 1) {
      bar.classList.remove("is-indeterminate");
      fill.style.width = `${Math.round(payload.ratio * 100)}%`;
    } else {
      bar.classList.add("is-indeterminate");
    }
    if (payload.phase === "downloading" && payload.bytesTotal) {
      detailEl.textContent = `${formatBytes(payload.bytesDownloaded ?? 0)} / ${formatBytes(payload.bytesTotal)}`;
    } else if (payload.message) {
      detailEl.textContent = payload.message;
    } else {
      detailEl.textContent = "";
    }
  });

  try {
    await api.startUpdateInstall();
    // The main process spawns the post-quit script and triggers app.quit().
    // We won't actually get here in practice — the window goes away first —
    // but if the quit is somehow delayed, show a friendly "relaunching" state.
    phaseEl.textContent = phaseLabel("relaunching");
    bar.classList.remove("is-indeterminate");
    fill.style.width = "100%";
    detailEl.textContent = "";
  } catch (err) {
    out.classList.remove("is-available");
    out.classList.add("is-error");
    const message = err?.message ?? String(err);
    out.innerHTML = `
      <div class="update-result-row">
        <span class="title">${escapeHtml(t("settings.update.installFailed", { error: message }))}</span>
        <div class="update-result-actions">
          <button type="button" class="btn btn-secondary" data-update-retry>${escapeHtml(t("settings.update.retry"))}</button>
          <button type="button" class="btn-secondary-link" data-update-release-page>${escapeHtml(t("settings.update.releasePage"))}</button>
        </div>
      </div>
    `;
    out.querySelector("[data-update-retry]")?.addEventListener("click", () => {
      void startInPlaceInstall(result);
    });
    out.querySelector("[data-update-release-page]")?.addEventListener("click", () => {
      void api.openExternal?.(result.downloadUrl || result.releaseUrl);
    });
  } finally {
    if (typeof updateInstallDisposer === "function") {
      updateInstallDisposer();
      updateInstallDisposer = null;
    }
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// ── Init ──

function bindEvents() {
  dom.settingsBridgeMode?.addEventListener("change", refreshSettingsVisibility);
  dom.settingsHealthRefresh?.addEventListener("click", () => refreshSetupHealth());
  dom.settingsSave?.addEventListener("click", saveSettingsFromForm);
  dom.settingsClaudeHooksToggle?.addEventListener("click", () => void toggleClaudeHooks());
  dom.settingsCalendarForget?.addEventListener("click", async () => {
    if (!api?.calendarSetUrl) return;
    if (dom.settingsCalendarUrl) dom.settingsCalendarUrl.value = "";
    renderCalendarStatus(await api.calendarSetUrl(""));
  });
  dom.settingsCaptureFolderPick?.addEventListener("click", async () => {
    if (!api?.selectDirectory || !dom.settingsCaptureFolder) return;
    try {
      const picked = await api.selectDirectory();
      if (picked) dom.settingsCaptureFolder.value = picked;
    } catch (err) {
      console.error("selectDirectory failed", err);
    }
  });
  dom.settingsDictationPromptReset?.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!dom.settingsDictationPrompt || !api?.getDictationDefaults) return;
    try {
      const { prompt } = await api.getDictationDefaults();
      dom.settingsDictationPrompt.value = prompt ?? "";
    } catch (err) {
      console.error("getDictationDefaults failed", err);
    }
  });

  dom.settingsCaptionsContextOpen?.addEventListener("click", async () => {
    if (!api?.openCaptionsContextFolder) return;
    try {
      const result = await api.openCaptionsContextFolder();
      if (!result.ok) showSettingsStatus(t("settings.openFolderFailed", { error: result.error ?? t("settings.unknownError") }), "error");
      else void refreshCaptionsContextInfo();
    } catch (err) {
      console.error("openCaptionsContextFolder failed", err);
    }
  });

  dom.settingsCaptionsPromptReset?.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!dom.settingsCaptionsPrompt || !api?.getCaptionsDefaults) return;
    try {
      const { prompt } = await api.getCaptionsDefaults();
      dom.settingsCaptionsPrompt.value = prompt ?? "";
    } catch (err) {
      console.error("getCaptionsDefaults failed", err);
    }
  });
  dom.settingsDictationMicrophoneRefresh?.addEventListener("click", async (e) => {
    e.preventDefault();
    // Preserve the user's current pick across a refresh — the device list may
    // include / exclude their chosen mic depending on whether it's plugged in,
    // but the value still needs to round-trip if we re-render the dropdown.
    const previous = dom.settingsDictationMicrophone?.value ?? "";
    await populateMicrophoneDropdown(previous);
  });
  dom.settingsCheckUpdatesNow?.addEventListener("click", checkForUpdatesFromSettings);
  dom.settingsSpeechTest?.addEventListener("click", speakTestPhrase);
  dom.appearanceSegmented?.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented-btn");
    if (!btn?.dataset.appearance) return;
    applyAppearance(btn.dataset.appearance);
  });
  dom.settingsLook?.addEventListener("change", () => {
    window.MarshalTheme?.set({ look: dom.settingsLook.value });
    refreshLookFields();
  });
  dom.settingsPalette?.addEventListener("change", () => {
    window.MarshalTheme?.set({ palette: dom.settingsPalette.value });
  });
  // Text this module wrote itself does not carry data-i18n; redraw it.
  window.addEventListener("marshal:language", () => {
    refreshSettingsVisibility();
    if (claudeHooksState) renderClaudeHooks(claudeHooksState);
    renderCalendarStatus(calendarStatus);
    if (!dom.settingsHealthRefresh?.disabled) void refreshSetupHealth();
    void refreshCaptionsContextInfo();
  });

}

/** `close` returns the home to its main view, as Save does on success. */
export function initSettings({ close }) {
  closeSettings = close;
  bindEvents();
}

export { openSettings };
