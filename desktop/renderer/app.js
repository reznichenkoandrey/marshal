// Marshal Desktop — Chat UI controller

const STORAGE_KEYS = {
  appearance: "marshal-appearance",
  recentDirs: "marshal-recent-dirs",
  workingDir: "marshal-working-dir",
  activeProject: "marshal-active-project"
};

const MAX_RECENT_DIRS = 5;
const APPEARANCE_VALUES = ["light", "dark", "system"];

function loadAppearance() {
  const stored = localStorage.getItem(STORAGE_KEYS.appearance);
  if (APPEARANCE_VALUES.includes(stored)) return stored;
  // Backward-compat: migrate the old `marshal-theme` key.
  const legacy = localStorage.getItem("marshal-theme");
  if (legacy === "light" || legacy === "dark") return legacy;
  return "system";
}

// ── State ──

const state = {
  sessions: [],
  activeSessionId: null,
  activeSession: null,
  pendingFiles: [],
  sidebarOpen: false,
  appearance: loadAppearance(),
  workingDir: localStorage.getItem(STORAGE_KEYS.workingDir) || "~/",
  recentDirs: JSON.parse(localStorage.getItem(STORAGE_KEYS.recentDirs) || "[]"),
  pollHandle: null,
  pollInterval: 5000,
  projectId: localStorage.getItem(STORAGE_KEYS.activeProject) || null,
  isTaskRunning: false
};

// BroadcastChannel keeps the translator window in sync when the user flips
// the theme from the main window (and vice versa).
const appearanceChannel = typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("marshal-appearance")
  : null;

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
  settingsCaptureFolder: document.getElementById("settings-capture-folder"),
  settingsCaptureFolderPick: document.getElementById("settings-capture-folder-pick"),
  settingsLaunchAtLogin: document.getElementById("settings-launch-at-login"),
  settingsCheckUpdates: document.getElementById("settings-check-updates"),
  settingsCheckUpdatesNow: document.getElementById("settings-check-updates-now"),
  settingsUpdateResult: document.getElementById("settings-update-result"),
  settingsSave: document.getElementById("settings-save"),
  settingsStatus: document.getElementById("settings-status"),
  appearanceSegmented: document.getElementById("appearance-segmented"),
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
  applyAppearance(state.appearance, { broadcast: false });
  window.MarshalIcons?.apply();
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

  // Render events for the currently running / queued task. The assistant
  // message is only created AFTER completion, so during the wait we attach
  // the timeline pill directly under the user message the task belongs to.
  // Previously this checked `!messages.some(m.taskId === active)` — but the
  // user message already carries that taskId, so the check was always false
  // and the pill never rendered while we were waiting. Now: render unless an
  // assistant reply already exists.
  const activeTask = tasks.find((t) => t.status === "running" || t.status === "queued");
  if (
    activeTask &&
    !messages.some((m) => m.role === "assistant" && m.taskId === activeTask.id)
  ) {
    const eventsEl = renderToolEvents(activeTask);
    if (eventsEl) {
      // Keep expanded while running so the user sees planning/tool activity
      // instead of staring at a blank typing indicator for 10-30 s.
      eventsEl.open = true;
      dom.messages.appendChild(eventsEl);
    }
  }

  // Show running task indicator below the live timeline.
  if (state.isTaskRunning) {
    const typingRow = createTypingIndicator();
    dom.messages.appendChild(typingRow);
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

  // One collapsible pill per task (previously one card per event). The summary
  // shows the latest event + step count; expanding reveals the full timeline.
  const details = document.createElement("details");
  details.className = "tool-timeline";

  const latest = events[events.length - 1];
  const isDone = task.status === "completed" || task.status === "failed";
  // Keep terminal states collapsed by default — they rarely need drilling into.
  // Running tasks stay collapsed too; the summary is live-updated anyway.
  details.open = false;

  const summary = document.createElement("summary");
  summary.className = "tool-timeline-summary";

  const icon = document.createElement("span");
  icon.className = "tool-timeline-icon";
  icon.textContent = getEventIcon(latest.type, task.status);
  summary.appendChild(icon);

  const label = document.createElement("span");
  label.className = "tool-timeline-label";
  label.textContent = formatEventLabel(latest);
  summary.appendChild(label);

  if (events.length > 1) {
    const count = document.createElement("span");
    count.className = "tool-timeline-count";
    count.textContent = `${events.length}`;
    count.title = `${events.length} steps`;
    summary.appendChild(count);
  }

  details.appendChild(summary);

  const list = document.createElement("ul");
  list.className = "tool-timeline-list";
  for (const ev of events) {
    const li = document.createElement("li");
    const liIcon = document.createElement("span");
    liIcon.className = "tool-timeline-list-icon";
    liIcon.textContent = getEventIcon(ev.type, task.status);
    li.appendChild(liIcon);

    const liLabel = document.createElement("span");
    liLabel.textContent = formatEventLabel(ev);
    li.appendChild(liLabel);

    if (ev.detail || ev.payload) {
      const detail = document.createElement("pre");
      detail.className = "tool-timeline-detail";
      detail.textContent = ev.detail || JSON.stringify(ev.payload, null, 2);
      li.appendChild(detail);
    }

    list.appendChild(li);
  }
  details.appendChild(list);

  // Collapsed terminal tasks: keep summary single-line; for running tasks the
  // caller will re-render when new events arrive.
  void isDone;

  return details;
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
    empty.className = "session-list-empty";
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
    deleteBtn.innerHTML = window.MarshalIcons?.render("x", { size: 14 }) ?? "\u00d7";
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
    dom.dirPicker.setAttribute("aria-expanded", "true");
  } else {
    closeDirDropdown();
  }
}

function closeDirDropdown() {
  dom.dirDropdown.classList.add("hidden");
  dom.dirPicker?.setAttribute("aria-expanded", "false");
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

// ── Appearance (light / dark / system) ──

function applyAppearance(value, { broadcast = true } = {}) {
  const next = APPEARANCE_VALUES.includes(value) ? value : "system";
  state.appearance = next;
  localStorage.setItem(STORAGE_KEYS.appearance, next);
  // Remove legacy key so migration doesn't re-trigger.
  localStorage.removeItem("marshal-theme");

  const root = document.documentElement;
  if (next === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", next);
  }

  refreshThemeToggleIcon();
  refreshAppearanceSegmented();

  if (broadcast) {
    appearanceChannel?.postMessage({ appearance: next });
  }
}

function cycleAppearance() {
  const idx = APPEARANCE_VALUES.indexOf(state.appearance);
  const next = APPEARANCE_VALUES[(idx + 1) % APPEARANCE_VALUES.length];
  applyAppearance(next);
}

function refreshThemeToggleIcon() {
  if (!dom.themeToggle || !window.MarshalIcons) return;
  const iconName =
    state.appearance === "light" ? "sun" :
    state.appearance === "dark" ? "moon" : "monitor";
  dom.themeToggle.innerHTML = window.MarshalIcons.render(iconName, { size: 18 });
  dom.themeToggle.title = `Appearance: ${state.appearance} (click to cycle)`;
}

function refreshAppearanceSegmented() {
  if (!dom.appearanceSegmented) return;
  dom.appearanceSegmented.querySelectorAll(".segmented-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.appearance === state.appearance);
    btn.setAttribute("aria-selected", btn.dataset.appearance === state.appearance ? "true" : "false");
  });
}

// Re-apply the system palette when macOS flips appearance and the user is on
// "system" — no-op otherwise because `data-theme` is explicit.
const systemMedia = window.matchMedia("(prefers-color-scheme: dark)");
systemMedia.addEventListener?.("change", () => {
  if (state.appearance === "system") {
    // CSS handles the actual repaint; we just nudge the toggle icon.
    refreshThemeToggleIcon();
  }
});

appearanceChannel?.addEventListener("message", (event) => {
  const next = event.data?.appearance;
  if (APPEARANCE_VALUES.includes(next) && next !== state.appearance) {
    applyAppearance(next, { broadcast: false });
  }
});

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
  dom.settingsCheckUpdatesNow?.addEventListener("click", checkForUpdatesFromSettings);
  document.querySelectorAll('[data-close="settings"]').forEach((el) =>
    el.addEventListener("click", closeSettings)
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !dom.settingsModal?.classList.contains("hidden")) {
      closeSettings();
    }
  });

  // Appearance — header icon cycles; segmented control in Settings
  dom.themeToggle?.addEventListener("click", cycleAppearance);
  dom.appearanceSegmented?.addEventListener("click", (e) => {
    const btn = e.target.closest(".segmented-btn");
    if (!btn?.dataset.appearance) return;
    applyAppearance(btn.dataset.appearance);
  });

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
    if (dom.settingsCaptureFolder) {
      dom.settingsCaptureFolder.value = current.captureDefaultFolder ?? "";
    }
    if (dom.settingsLaunchAtLogin) {
      dom.settingsLaunchAtLogin.checked = current.launchAtLogin ?? false;
    }
    if (dom.settingsCheckUpdates) {
      dom.settingsCheckUpdates.checked = current.checkForUpdatesAutomatic ?? true;
    }
    refreshSettingsVisibility();
    refreshAppearanceSegmented();
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
    dictationPrompt: dom.settingsDictationPrompt?.value ?? "",
    captureDefaultFolder: dom.settingsCaptureFolder?.value.trim() ?? "",
    launchAtLogin: dom.settingsLaunchAtLogin?.checked ?? false,
    checkForUpdatesAutomatic: dom.settingsCheckUpdates?.checked ?? true
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

// ── Settings: check for updates ──

async function checkForUpdatesFromSettings() {
  const btn = dom.settingsCheckUpdatesNow;
  const out = dom.settingsUpdateResult;
  if (!btn || !out || !api?.checkForUpdatesSilent) return;

  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = "Checking…";
  out.classList.remove("hidden", "is-available", "is-error");
  out.innerHTML = `<div class="update-result-row"><span class="title">Contacting GitHub Releases…</span></div>`;

  try {
    const result = await api.checkForUpdatesSilent();
    renderUpdateResult(result);
  } catch (err) {
    out.classList.add("is-error");
    out.innerHTML = `<div class="update-result-row"><span class="title">Check failed: ${escapeHtml(err?.message ?? String(err))}</span></div>`;
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
    out.innerHTML = `<div class="update-result-row"><span class="title">Could not reach GitHub: ${escapeHtml(result.error)}</span></div>`;
    return;
  }
  if (!result || !("available" in result)) {
    out.classList.add("is-error");
    out.innerHTML = `<div class="update-result-row"><span class="title">Unexpected response</span></div>`;
    return;
  }
  if (!result.available) {
    out.innerHTML = `<div class="update-result-row"><span class="title">You're up to date (v${escapeHtml(result.currentVersion ?? "")}).</span></div>`;
    return;
  }

  out.classList.add("is-available");
  const url = result.downloadUrl || result.releaseUrl;
  const notes = (result.releaseNotes ?? "").trim();
  out.innerHTML = `
    <div class="update-result-row">
      <span class="title">Marshal v${escapeHtml(result.latestVersion)} is available <span style="color:var(--text-muted);font-weight:400;">(you have v${escapeHtml(result.currentVersion)})</span></span>
      <button type="button" class="btn btn-primary" data-update-download>Download</button>
    </div>
    ${notes ? `<div class="update-result-notes">${escapeHtml(notes)}</div>` : ""}
  `;
  out.querySelector("[data-update-download]")?.addEventListener("click", () => {
    void api.openExternal?.(url);
  });
}

// ── Init ──

void bootstrap();
