// Marshal Desktop — Chat UI controller

const STORAGE_KEYS = {
  theme: "marshal-theme",
  recentDirs: "marshal-recent-dirs",
  workingDir: "marshal-working-dir",
  activeProject: "marshal-active-project"
};

const MAX_RECENT_DIRS = 5;

// ── State ──

const state = {
  sessions: [],
  activeSessionId: null,
  activeSession: null,
  pendingFiles: [],
  sidebarOpen: false,
  theme: localStorage.getItem(STORAGE_KEYS.theme) || "light",
  workingDir: localStorage.getItem(STORAGE_KEYS.workingDir) || "~/",
  recentDirs: JSON.parse(localStorage.getItem(STORAGE_KEYS.recentDirs) || "[]"),
  pollHandle: null,
  pollInterval: 5000,
  projectId: localStorage.getItem(STORAGE_KEYS.activeProject) || null,
  isTaskRunning: false
};

// ── DOM refs ──

const dom = {
  sidebar: document.getElementById("sidebar"),
  sidebarOverlay: document.getElementById("sidebar-overlay"),
  sessionList: document.getElementById("session-list"),
  menuBtn: document.getElementById("menu-btn"),
  newChatBtn: document.getElementById("new-chat-btn"),
  clearAllBtn: document.getElementById("clear-all-btn"),
  dirPicker: document.getElementById("dir-picker"),
  dirLabel: document.getElementById("dir-label"),
  dirDropdown: document.getElementById("dir-dropdown"),
  translateBtn: document.getElementById("translate-btn"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsModal: document.getElementById("settings-modal"),
  settingsForm: document.getElementById("settings-form"),
  settingsBridgeMode: document.getElementById("settings-bridge-mode"),
  settingsClaudeModel: document.getElementById("settings-claude-model"),
  settingsCodexModel: document.getElementById("settings-codex-model"),
  settingsProviderHint: document.getElementById("settings-provider-hint"),
  settingsTranslatorBackend: document.getElementById("settings-translator-backend"),
  settingsDictationEnabled: document.getElementById("settings-dictation-enabled"),
  settingsDictationHotkey: document.getElementById("settings-dictation-hotkey"),
  settingsDictationBackend: document.getElementById("settings-dictation-backend"),
  settingsDictationLanguage: document.getElementById("settings-dictation-language"),
  settingsDictationAutoPaste: document.getElementById("settings-dictation-autopaste"),
  settingsDictationPrompt: document.getElementById("settings-dictation-prompt"),
  settingsDictationPromptReset: document.getElementById("settings-dictation-prompt-reset"),
  settingsSave: document.getElementById("settings-save"),
  settingsStatus: document.getElementById("settings-status"),
  themeToggle: document.getElementById("theme-toggle"),
  messages: document.getElementById("messages"),
  welcome: document.getElementById("welcome"),
  attachmentsPreview: document.getElementById("attachments-preview"),
  composer: document.getElementById("composer"),
  attachBtn: document.getElementById("attach-btn"),
  fileInput: document.getElementById("file-input"),
  taskInput: document.getElementById("task-input"),
  sendBtn: document.getElementById("send-btn")
};

// ── API shorthand ──

const api = window.marshalDesktop;

// ── Bootstrap ──

async function bootstrap() {
  applyTheme(state.theme);
  updateDirLabel();
  bindEvents();
  await ensureDefaultProject();
  await refreshSessions();
  startPolling();
}

// ── Project management ──

async function ensureDefaultProject() {
  try {
    const projects = await api.listProjects();
    if (projects.length > 0) {
      state.projectId = state.projectId && projects.some((p) => p.id === state.projectId)
        ? state.projectId
        : projects[0].id;
    } else {
      const project = await api.createProject("Default");
      state.projectId = project.id;
    }
    localStorage.setItem(STORAGE_KEYS.activeProject, state.projectId);
  } catch (err) {
    console.error("Failed to ensure default project:", err);
  }
}

// ── Session management ──

async function refreshSessions() {
  if (!state.projectId) return;

  try {
    state.sessions = await api.listSessions(state.projectId);
    renderSessionList();

    if (state.activeSessionId) {
      await loadSession(state.activeSessionId, false);
    }
  } catch (err) {
    console.error("Failed to refresh sessions:", err);
  }
}

async function loadSession(sessionId, scroll = true) {
  if (!state.projectId) return;

  try {
    const session = await api.readSession({ sessionId, projectId: state.projectId });
    if (!session) return;

    state.activeSessionId = session.id;
    state.activeSession = session;

    // Detect running task
    const wasRunning = state.isTaskRunning;
    state.isTaskRunning = session.tasks?.some(
      (t) => t.status === "running" || t.status === "queued"
    ) ?? false;

    // Adjust poll interval
    if (state.isTaskRunning && state.pollInterval !== 1000) {
      state.pollInterval = 1000;
      restartPolling();
    } else if (!state.isTaskRunning && wasRunning) {
      state.pollInterval = 5000;
      restartPolling();
    }

    renderSessionList();
    renderMessages(session, scroll);
  } catch (err) {
    console.error("Failed to load session:", err);
  }
}

async function createNewSession(initialText) {
  if (!state.projectId) await ensureDefaultProject();

  // Reset state and show clean welcome screen
  state.activeSessionId = null;
  state.activeSession = null;
  state.isTaskRunning = false;
  dom.messages.innerHTML = "";
  renderWelcome();
  renderSessionList();
  closeSidebar();
  dom.taskInput.focus();

  if (initialText) {
    await submitTask(initialText);
  }
}

async function deleteSession(sessionId) {
  if (!state.projectId) return;

  try {
    await api.deleteSession({ sessionId, projectId: state.projectId });

    if (state.activeSessionId === sessionId) {
      state.activeSessionId = null;
      state.activeSession = null;
    }

    await refreshSessions();

    if (!state.activeSessionId && state.sessions.length > 0) {
      await loadSession(state.sessions[0].id);
    } else if (state.sessions.length === 0) {
      renderWelcome();
    }
  } catch (err) {
    console.error("Failed to delete session:", err);
  }
}

async function clearAllSessions() {
  if (!state.projectId || state.sessions.length === 0) return;

  try {
    for (const session of [...state.sessions]) {
      await api.deleteSession({ sessionId: session.id, projectId: state.projectId });
    }
    state.activeSessionId = null;
    state.activeSession = null;
    state.sessions = [];
    renderSessionList();
    renderWelcome();
  } catch (err) {
    console.error("Failed to clear sessions:", err);
  }
}

// ── Task submission ──

async function submitTask(text) {
  if (!text.trim()) return;

  // Auto-create session if none active
  if (!state.activeSessionId) {
    if (!state.projectId) await ensureDefaultProject();
    const session = await api.createSession({ projectId: state.projectId });
    state.activeSessionId = session.id;
  }

  try {
    const attachments = await Promise.all(state.pendingFiles.map(fileToPayload));

    // Optimistic: show user message immediately
    appendOptimisticMessage(text, attachments);

    const session = await api.submitTask({
      sessionId: state.activeSessionId,
      projectId: state.projectId,
      text,
      route: "auto",
      attachments,
      workingDir: resolveAbsoluteDir(state.workingDir)
    });

    state.activeSessionId = session.id;
    state.pendingFiles = [];
    renderAttachments();

    // Switch to fast polling
    state.isTaskRunning = true;
    state.pollInterval = 1000;
    restartPolling();

    await refreshSessions();
    await loadSession(session.id);
  } catch (err) {
    console.error("Failed to submit task:", err);
    appendErrorMessage("Failed to submit task: " + err.message);
  }
}

// ── Rendering ──

function renderWelcome() {
  dom.messages.innerHTML = "";
  dom.welcome.classList.remove("hidden");
  dom.messages.appendChild(dom.welcome);
}

function renderMessages(session, scroll = true) {
  dom.messages.innerHTML = "";
  const messages = session.messages || [];
  const tasks = session.tasks || [];

  if (messages.length === 0 && tasks.length === 0) {
    renderWelcome();
    return;
  }

  dom.welcome.classList.add("hidden");

  // Build task events index keyed by taskId
  const taskMap = new Map();
  for (const task of tasks) {
    taskMap.set(task.id, task);
  }

  for (const msg of messages) {
    const row = createMessageRow(msg);
    dom.messages.appendChild(row);

    // Render tool events after assistant messages
    if (msg.role === "assistant" && msg.taskId && taskMap.has(msg.taskId)) {
      const task = taskMap.get(msg.taskId);
      const eventsEl = renderToolEvents(task);
      if (eventsEl) {
        dom.messages.appendChild(eventsEl);
      }
    }
  }

  // Show running task indicator
  if (state.isTaskRunning) {
    const typingRow = createTypingIndicator();
    dom.messages.appendChild(typingRow);
  }

  // Render events for active running task not yet associated with a message
  const activeTask = tasks.find((t) => t.status === "running" || t.status === "queued");
  if (activeTask && !messages.some((m) => m.taskId === activeTask.id)) {
    const eventsEl = renderToolEvents(activeTask);
    if (eventsEl) {
      dom.messages.appendChild(eventsEl);
    }
  }

  if (scroll) {
    requestAnimationFrame(() => {
      dom.messages.scrollTop = dom.messages.scrollHeight;
    });
  }
}

function createMessageRow(msg) {
  const row = document.createElement("div");
  row.className = `message-row ${msg.role}`;

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = msg.text || "";

  if (msg.attachments?.length > 0) {
    const attachDiv = document.createElement("div");
    attachDiv.className = "message-attachments";
    for (const att of msg.attachments) {
      const pill = document.createElement("span");
      pill.className = "attachment-pill";
      pill.textContent = att.name || "file";
      attachDiv.appendChild(pill);
    }
    bubble.appendChild(attachDiv);
  }

  row.appendChild(bubble);
  return row;
}

function renderToolEvents(task) {
  const events = task.events || [];
  if (events.length === 0) return null;

  const group = document.createElement("div");
  group.className = "tool-events-group";

  for (const event of events) {
    const card = document.createElement("details");
    card.className = "tool-card";

    const summary = document.createElement("summary");
    const icon = document.createElement("span");
    icon.className = "tool-card-icon";
    icon.textContent = getEventIcon(event.type, task.status);

    const label = document.createElement("span");
    label.className = "tool-card-label";
    label.textContent = formatEventLabel(event);

    summary.appendChild(icon);
    summary.appendChild(label);
    card.appendChild(summary);

    if (event.detail || event.payload) {
      const content = document.createElement("div");
      content.className = "tool-card-content";
      content.textContent = event.detail || JSON.stringify(event.payload, null, 2);
      card.appendChild(content);
    }

    group.appendChild(card);
  }

  return group;
}

function getEventIcon(eventType, taskStatus) {
  if (eventType === "task_completed") return "\u2713";
  if (eventType === "task_failed" || eventType === "tool_failed") return "\u2717";
  if (eventType === "tool_completed" || eventType === "step_completed") return "\u2713";
  if (taskStatus === "running") return "\u27F3";
  return "\u2022";
}

function formatEventLabel(event) {
  const typeLabel = event.type.replace(/_/g, " ");
  if (event.detail) {
    return `${typeLabel}: ${truncate(event.detail, 60)}`;
  }
  return typeLabel;
}

function createTypingIndicator() {
  const row = document.createElement("div");
  row.className = "message-row assistant";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble typing-indicator";

  for (let i = 0; i < 3; i++) {
    const dot = document.createElement("span");
    dot.className = "typing-dot";
    bubble.appendChild(dot);
  }

  row.appendChild(bubble);
  return row;
}

function appendOptimisticMessage(text, attachments) {
  dom.welcome.classList.add("hidden");

  const msg = { role: "user", text, attachments: attachments.map((a) => ({ name: a.name })) };
  const row = createMessageRow(msg);
  dom.messages.appendChild(row);
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

function appendErrorMessage(text) {
  const row = document.createElement("div");
  row.className = "message-row system";
  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = text;
  row.appendChild(bubble);
  dom.messages.appendChild(row);
  dom.messages.scrollTop = dom.messages.scrollHeight;
}

// ── Session list ──

function renderSessionList() {
  dom.sessionList.innerHTML = "";

  if (state.sessions.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding: 16px; color: var(--text-tertiary); font-size: 13px; text-align: center;";
    empty.textContent = "No conversations yet";
    dom.sessionList.appendChild(empty);
    return;
  }

  for (const session of state.sessions) {
    const item = document.createElement("div");
    item.className = `session-item${session.id === state.activeSessionId ? " active" : ""}`;

    const textDiv = document.createElement("div");
    textDiv.className = "session-item-text";

    const title = document.createElement("div");
    title.className = "session-item-title";
    title.textContent = session.title || "Untitled";

    const meta = document.createElement("div");
    meta.className = "session-item-meta";
    meta.textContent = session.activeTaskStatus || "idle";

    textDiv.appendChild(title);
    textDiv.appendChild(meta);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "session-delete-btn";
    deleteBtn.textContent = "\u00d7";
    deleteBtn.title = "Delete session";

    textDiv.addEventListener("click", () => {
      loadSession(session.id);
      closeSidebar();
    });

    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSession(session.id);
    });

    item.appendChild(textDiv);
    item.appendChild(deleteBtn);
    dom.sessionList.appendChild(item);
  }
}

// ── Attachments ──

function renderAttachments() {
  dom.attachmentsPreview.innerHTML = "";

  for (let i = 0; i < state.pendingFiles.length; i++) {
    const file = state.pendingFiles[i];
    const pill = document.createElement("span");
    pill.className = "pending-file";
    pill.innerHTML = `${escapeHtml(file.name)} <button class="pending-file-remove" data-idx="${i}">&times;</button>`;
    dom.attachmentsPreview.appendChild(pill);
  }

  // Bind remove buttons
  dom.attachmentsPreview.querySelectorAll(".pending-file-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx, 10);
      state.pendingFiles.splice(idx, 1);
      renderAttachments();
      updateSendBtn();
    });
  });
}

// ── Directory picker ──

function updateDirLabel() {
  dom.dirLabel.textContent = shortenPath(state.workingDir);
}

function renderDirDropdown() {
  dom.dirDropdown.innerHTML = "";

  for (const dir of state.recentDirs) {
    const btn = document.createElement("button");
    btn.className = "dir-dropdown-item";
    btn.textContent = shortenPath(dir);
    btn.title = dir;
    btn.addEventListener("click", () => {
      selectDir(dir);
      closeDirDropdown();
    });
    dom.dirDropdown.appendChild(btn);
  }

  if (state.recentDirs.length > 0) {
    const sep = document.createElement("div");
    sep.className = "dir-dropdown-separator";
    dom.dirDropdown.appendChild(sep);
  }

  const browseBtn = document.createElement("button");
  browseBtn.className = "dir-dropdown-item";
  browseBtn.textContent = "Browse...";
  browseBtn.addEventListener("click", async () => {
    closeDirDropdown();
    try {
      const dirPath = await api.selectDirectory();
      if (dirPath) {
        selectDir(dirPath);
      }
    } catch (err) {
      console.error("Directory picker failed:", err);
    }
  });
  dom.dirDropdown.appendChild(browseBtn);
}

function selectDir(dirPath) {
  state.workingDir = dirPath;
  localStorage.setItem(STORAGE_KEYS.workingDir, dirPath);

  // Update recent dirs (dedup, cap at MAX_RECENT_DIRS)
  state.recentDirs = [dirPath, ...state.recentDirs.filter((d) => d !== dirPath)].slice(0, MAX_RECENT_DIRS);
  localStorage.setItem(STORAGE_KEYS.recentDirs, JSON.stringify(state.recentDirs));

  updateDirLabel();
}

function toggleDirDropdown() {
  const isHidden = dom.dirDropdown.classList.contains("hidden");
  if (isHidden) {
    renderDirDropdown();
    dom.dirDropdown.classList.remove("hidden");
  } else {
    closeDirDropdown();
  }
}

function closeDirDropdown() {
  dom.dirDropdown.classList.add("hidden");
}

// ── Sidebar ──

function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  dom.sidebar.classList.toggle("open", state.sidebarOpen);
  dom.sidebarOverlay.classList.toggle("hidden", !state.sidebarOpen);
}

function closeSidebar() {
  state.sidebarOpen = false;
  dom.sidebar.classList.remove("open");
  dom.sidebarOverlay.classList.add("hidden");
}

// ── Theme ──

function applyTheme(theme) {
  state.theme = theme;
  document.body.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEYS.theme, theme);
}

function toggleTheme() {
  applyTheme(state.theme === "light" ? "dark" : "light");
}

// ── Textarea auto-resize ──

function autoResize(textarea) {
  textarea.style.height = "auto";
  const maxHeight = 144; // ~6 rows
  textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + "px";
}

function updateSendBtn() {
  const hasText = dom.taskInput.value.trim().length > 0;
  const hasFiles = state.pendingFiles.length > 0;
  dom.sendBtn.disabled = !(hasText || hasFiles);
}

// ── Polling ──

function startPolling() {
  stopPolling();
  state.pollHandle = setInterval(async () => {
    try {
      if (state.activeSessionId) {
        await loadSession(state.activeSessionId, false);
      } else {
        await refreshSessions();
      }
    } catch (err) {
      console.error("Poll error:", err);
    }
  }, state.pollInterval);
}

function stopPolling() {
  if (state.pollHandle) {
    clearInterval(state.pollHandle);
    state.pollHandle = null;
  }
}

function restartPolling() {
  startPolling();
}

// Stop polling when the window is hidden (menu-bar-style blur → hide on
// macOS) or unloaded. Without this, the interval keeps invoking IPC and
// keeps the backend busy while the user isn't even looking at the UI.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopPolling();
  } else if (!state.pollHandle) {
    startPolling();
  }
});

window.addEventListener("beforeunload", stopPolling);

// ── Event bindings ──

function bindEvents() {
  // Sidebar
  dom.menuBtn.addEventListener("click", toggleSidebar);
  dom.sidebarOverlay.addEventListener("click", closeSidebar);
  dom.newChatBtn.addEventListener("click", () => createNewSession());
  dom.clearAllBtn.addEventListener("click", clearAllSessions);

  // Dir picker
  dom.dirPicker.addEventListener("click", toggleDirDropdown);

  // Close dropdown on click outside
  document.addEventListener("click", (e) => {
    if (!dom.dirPicker.contains(e.target) && !dom.dirDropdown.contains(e.target)) {
      closeDirDropdown();
    }
  });

  // Translator
  dom.translateBtn?.addEventListener("click", () => api.openTranslator?.());

  // Settings
  dom.settingsBtn?.addEventListener("click", openSettings);
  dom.settingsBridgeMode?.addEventListener("change", refreshSettingsVisibility);
  dom.settingsSave?.addEventListener("click", saveSettingsFromForm);
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
  document.querySelectorAll('[data-close="settings"]').forEach((el) =>
    el.addEventListener("click", closeSettings)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !dom.settingsModal?.classList.contains("hidden")) {
      closeSettings();
    }
  });

  // Theme
  dom.themeToggle.addEventListener("click", toggleTheme);

  // File attachments
  dom.attachBtn.addEventListener("click", () => dom.fileInput.click());
  dom.fileInput.addEventListener("change", () => {
    const newFiles = Array.from(dom.fileInput.files || []);
    state.pendingFiles.push(...newFiles);
    dom.fileInput.value = "";
    renderAttachments();
    updateSendBtn();
  });

  // Textarea
  dom.taskInput.addEventListener("input", () => {
    autoResize(dom.taskInput);
    updateSendBtn();
  });

  dom.taskInput.addEventListener("keydown", (e) => {
    // Enter = send, Shift+Enter = newline
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!dom.sendBtn.disabled) {
        handleSubmit();
      }
    }
  });

  // Composer form submit
  dom.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    handleSubmit();
  });
}

// ── Settings modal ──

const PROVIDER_HINTS = {
  "claude-cli":
    "Uses the local `claude` CLI. Requires Claude Code installed and `claude auth` completed with a Pro or Max subscription.",
  "codex-cli":
    "Uses the local `codex` CLI. Requires Codex CLI installed and `codex login` completed with a ChatGPT Plus/Pro/Business/Enterprise account.",
  "claude":
    "Uses the Anthropic Messages API. Requires ANTHROPIC_API_KEY in the app's .env file (pay-per-token billing).",
  "api":
    "Uses an OpenAI-compatible endpoint (Groq, OpenRouter, OpenAI). Requires MARSHAL_API_KEY and MARSHAL_API_BASE in .env.",
  "claude-web":
    "Automates claude.ai in a Playwright browser. Slow and fragile — use only as a fallback.",
  "playwright":
    "Automates chatgpt.com in a Playwright browser. Slow and fragile — use only as a fallback.",
  "extension":
    "Routes requests through the Marshal Chrome extension bridge."
};

async function openSettings() {
  if (!api?.getSettings) return;
  try {
    const current = await api.getSettings();
    dom.settingsBridgeMode.value = current.bridgeMode;
    dom.settingsClaudeModel.value = current.claudeModel ?? "";
    dom.settingsCodexModel.value = current.codexModel ?? "";
    if (dom.settingsTranslatorBackend) {
      dom.settingsTranslatorBackend.value = current.translatorBackend ?? "auto";
    }
    if (dom.settingsDictationEnabled) {
      dom.settingsDictationEnabled.checked = current.dictationEnabled ?? true;
    }
    if (dom.settingsDictationHotkey) {
      dom.settingsDictationHotkey.value = current.dictationHotkey ?? "Cmd+Shift+D";
    }
    if (dom.settingsDictationBackend) {
      dom.settingsDictationBackend.value = current.dictationBackend ?? "whisper-cpp";
    }
    if (dom.settingsDictationLanguage) {
      dom.settingsDictationLanguage.value = current.dictationLanguage ?? "auto";
    }
    if (dom.settingsDictationAutoPaste) {
      dom.settingsDictationAutoPaste.checked = current.dictationAutoPaste ?? false;
    }
    if (dom.settingsDictationPrompt) {
      dom.settingsDictationPrompt.value = current.dictationPrompt ?? "";
    }
    refreshSettingsVisibility();
    clearSettingsStatus();
    dom.settingsModal.classList.remove("hidden");
  } catch (err) {
    console.error("openSettings failed", err);
  }
}

function closeSettings() {
  dom.settingsModal?.classList.add("hidden");
}

function refreshSettingsVisibility() {
  const mode = dom.settingsBridgeMode.value;
  dom.settingsProviderHint.textContent = PROVIDER_HINTS[mode] ?? "";
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

async function saveSettingsFromForm() {
  if (!api?.updateSettings) return;
  const payload = {
    bridgeMode: dom.settingsBridgeMode.value,
    claudeModel: dom.settingsClaudeModel.value.trim(),
    codexModel: dom.settingsCodexModel.value.trim(),
    translatorBackend: dom.settingsTranslatorBackend?.value ?? "auto",
    dictationEnabled: dom.settingsDictationEnabled?.checked ?? true,
    dictationHotkey: (dom.settingsDictationHotkey?.value ?? "RightCmd").trim() || "RightCmd",
    dictationBackend: dom.settingsDictationBackend?.value ?? "whisper-cpp",
    dictationLanguage: dom.settingsDictationLanguage?.value ?? "auto",
    dictationAutoPaste: dom.settingsDictationAutoPaste?.checked ?? false,
    dictationPrompt: dom.settingsDictationPrompt?.value ?? ""
  };
  dom.settingsSave.disabled = true;
  showSettingsStatus("Saving and restarting backend…", null);
  try {
    await api.updateSettings(payload);
    showSettingsStatus("Saved. New settings are active.", "success");
    setTimeout(closeSettings, 900);
  } catch (err) {
    console.error("saveSettings failed", err);
    showSettingsStatus(`Failed: ${err?.message ?? err}`, "error");
  } finally {
    dom.settingsSave.disabled = false;
  }
}

function handleSubmit() {
  const text = dom.taskInput.value.trim();
  if (!text && state.pendingFiles.length === 0) return;

  dom.taskInput.value = "";
  autoResize(dom.taskInput);
  updateSendBtn();

  submitTask(text);
}

// ── Utilities ──

function fileToPayload(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(",")[1] || "";
      resolve({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        contentBase64: base64
      });
    };
    reader.readAsDataURL(file);
  });
}

function resolveAbsoluteDir(dir) {
  if (!dir || dir === "~/") return null;
  // Expand ~ to /Users/<username> (Electron preload doesn't have os.homedir)
  if (dir.startsWith("~/")) {
    // Extract home dir from a known absolute recent dir or guess from path pattern
    const absRecent = state.recentDirs.find(d => d.startsWith("/"));
    if (absRecent) {
      const homeMatch = absRecent.match(/^(\/Users\/[^/]+)/);
      if (homeMatch) return dir.replace("~", homeMatch[1]);
    }
  }
  if (dir.startsWith("/")) return dir;
  return null;
}

function shortenPath(dirPath) {
  if (!dirPath) return "~/";
  const home = dirPath.replace(/^\/Users\/[^/]+/, "~");
  if (home.length > 30) {
    const parts = home.split("/");
    if (parts.length > 3) {
      return parts[0] + "/.../" + parts.slice(-2).join("/");
    }
  }
  return home;
}

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.substring(0, maxLen) + "...";
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Init ──

void bootstrap();
