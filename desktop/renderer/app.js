const PROJECT_STORAGE_KEY = "marshal-desktop-active-project";

const state = {
  health: null,
  projects: [],
  sessions: [],
  activeSessionId: null,
  selectedProjectId: null,
  pendingFiles: [],
  logExpanded: false,
  pollHandle: null
};

const sessionList = document.querySelector("#session-list");
const sessionTitle = document.querySelector("#session-title");
const messagesEl = document.querySelector("#messages");
const taskEventsEl = document.querySelector("#task-events");
const attachmentList = document.querySelector("#attachment-list");
const fileInput = document.querySelector("#file-input");
const routeSelect = document.querySelector("#route-select");
const taskInput = document.querySelector("#task-input");
const composer = document.querySelector("#composer");
const newSessionButton = document.querySelector("#new-session-button");
const newProjectButton = document.querySelector("#new-project-button");
const projectSelect = document.querySelector("#project-select");
const refreshButton = document.querySelector("#refresh-button");
const toggleEventsButton = document.querySelector("#toggle-events-button");
const openChatGPTButton = document.querySelector("#open-chatgpt-button");
const openOperatorWebButton = document.querySelector("#open-operator-web-button");
const restartBackendButton = document.querySelector("#restart-backend-button");
const openWorkspaceButton = document.querySelector("#open-workspace-button");
const restartAppButton = document.querySelector("#restart-app-button");
const statusMessage = document.querySelector("#status-message");

fileInput.addEventListener("change", () => {
  state.pendingFiles = Array.from(fileInput.files ?? []);
  renderPendingFiles();
});

newSessionButton.addEventListener("click", async () => {
  if (!state.selectedProjectId) {
    return;
  }

  await withStatus("Creating session...", async () => {
    const session = await window.marshalDesktop.createSession({ projectId: state.selectedProjectId });
    await refreshProjects();
    await refreshSessions();
    state.activeSessionId = session.id;
    await loadSession(session.id);
  });
});

newProjectButton.addEventListener("click", async () => {
  const name = window.prompt("Project name");
  if (!name || !name.trim()) {
    return;
  }

  await withStatus("Creating project...", async () => {
    const project = await window.marshalDesktop.createProject(name.trim());
    await refreshProjects(project.id);
    await handleProjectChange(project.id);
  });
});

projectSelect.addEventListener("change", async () => {
  const projectId = projectSelect.value || null;
  if (!projectId || projectId === state.selectedProjectId) {
    return;
  }

  await withStatus("Switching project...", () => handleProjectChange(projectId));
});

refreshButton.addEventListener("click", async () => {
  await withStatus("Refreshing sessions...", async () => {
    await refreshHealth();
    await refreshSessions();
    if (state.activeSessionId) {
      await loadSession(state.activeSessionId, false);
    }
  });
});

toggleEventsButton.addEventListener("click", () => {
  state.logExpanded = !state.logExpanded;
  renderEventsVisibility();
});

openChatGPTButton.addEventListener("click", async () => {
  await withStatus("Opening ChatGPT bridge...", async () => {
    const output = await window.marshalDesktop.openChatGPT();
    setStatus(output || "ChatGPT launcher executed.");
  });
});

openOperatorWebButton.addEventListener("click", async () => {
  await withStatus("Opening web console...", async () => {
    const url = await window.marshalDesktop.openOperatorWeb();
    setStatus(`Web console opened: ${url}`);
  });
});

restartBackendButton.addEventListener("click", async () => {
  if (!window.confirm("Restart the desktop backend now?")) {
    return;
  }

  await withStatus("Restarting desktop backend...", async () => {
    await window.marshalDesktop.restartBackend();
    await refreshHealth();
    if (state.activeSessionId) {
      await loadSession(state.activeSessionId, false);
    }
  });
});

openWorkspaceButton.addEventListener("click", async () => {
  if (!state.activeSessionId || !state.selectedProjectId) {
    return;
  }

  await withStatus("Opening workspace...", async () => {
    const workspacePath = await window.marshalDesktop.openWorkspace({
      sessionId: state.activeSessionId,
      projectId: state.selectedProjectId
    });
    setStatus(`Workspace opened: ${workspacePath}`);
  });
});

restartAppButton.addEventListener("click", async () => {
  if (!window.confirm("Restart Marshal Desktop now?")) {
    return;
  }

  await withStatus("Restarting app...", () => window.marshalDesktop.restartApp());
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = taskInput.value.trim();
  if (!text || !state.activeSessionId || !state.selectedProjectId) {
    return;
  }

  await withStatus("Submitting task...", async () => {
    const attachments = await Promise.all(state.pendingFiles.map(fileToUploadPayload));
    const session = await window.marshalDesktop.submitTask({
      sessionId: state.activeSessionId,
      projectId: state.selectedProjectId,
      text,
      route: routeSelect.value,
      attachments
    });

    taskInput.value = "";
    state.pendingFiles = [];
    fileInput.value = "";
    renderPendingFiles();
    await refreshHealth();
    await refreshProjects();
    await refreshSessions();
    state.activeSessionId = session.id;
    await loadSession(session.id);
  });
});

async function bootstrap() {
  await withStatus("Loading desktop shell...", async () => {
    await refreshProjects();
    const initialProjectId = getInitialProjectId();
    if (initialProjectId) {
      await handleProjectChange(initialProjectId);
    } else {
      renderProjects();
      renderSessions();
      renderEmptySession();
    }

    await refreshHealth();
    state.pollHandle = window.setInterval(async () => {
      try {
        await refreshHealth();
        await refreshSessions();
        if (state.activeSessionId) {
          await loadSession(state.activeSessionId, false);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), true);
      }
    }, 2500);
  });
}

async function handleProjectChange(projectId) {
  state.selectedProjectId = projectId;
  localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
  projectSelect.value = projectId;
  await refreshSessions();

  if (!state.sessions.some((session) => session.id === state.activeSessionId)) {
    state.activeSessionId = state.sessions[0]?.id ?? null;
  }

  if (state.activeSessionId) {
    await loadSession(state.activeSessionId);
  } else {
    renderSessions();
    renderEmptySession();
  }
}

async function refreshHealth() {
  try {
    state.health = await window.marshalDesktop.getHealth();
    renderHealth("Connected");
  } catch (error) {
    state.health = null;
    renderHealth("Unavailable");
    throw error;
  }
}

async function refreshProjects(preferredProjectId = state.selectedProjectId) {
  state.projects = await window.marshalDesktop.listProjects();
  const nextProjectId =
    preferredProjectId && state.projects.some((project) => project.id === preferredProjectId)
      ? preferredProjectId
      : getInitialProjectId();

  state.selectedProjectId = nextProjectId;
  renderProjects();
}

async function refreshSessions() {
  if (!state.selectedProjectId) {
    state.sessions = [];
    renderSessions();
    return;
  }

  state.sessions = await window.marshalDesktop.listSessions(state.selectedProjectId);
  renderSessions();
}

async function loadSession(sessionId, scroll = true) {
  if (!state.selectedProjectId) {
    renderEmptySession();
    return;
  }

  const session = await window.marshalDesktop.readSession({
    sessionId,
    projectId: state.selectedProjectId
  });

  if (!session) {
    return;
  }

  state.activeSessionId = session.id;
  sessionTitle.textContent = session.title;
  renderSessions();
  renderMessages(session);
  renderEvents(session);
  renderEventsVisibility();
  renderComposerState();
  if (scroll) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

async function deleteSession(sessionId) {
  if (!window.confirm("Delete this session?")) {
    return;
  }

  await withStatus("Deleting session...", async () => {
    await window.marshalDesktop.deleteSession({
      sessionId,
      projectId: state.selectedProjectId
    });

    if (state.activeSessionId === sessionId) {
      state.activeSessionId = null;
    }

    await refreshHealth();
    await refreshProjects();
    await refreshSessions();
    state.activeSessionId = state.sessions[0]?.id ?? null;

    if (state.activeSessionId) {
      await loadSession(state.activeSessionId);
      return;
    }

    renderEmptySession();
  });
}

function renderHealth(backendLabel = state.health ? "Connected" : "Unavailable") {
  document.querySelector("#health-projects").textContent = String(state.health?.projectCount ?? 0);
  document.querySelector("#health-sessions").textContent = String(state.health?.sessionCount ?? 0);
  document.querySelector("#health-running").textContent = String(state.health?.runningTasks ?? 0);
  document.querySelector("#health-queued").textContent = String(state.health?.queuedTasks ?? 0);
  document.querySelector("#health-backend").textContent = backendLabel;
}

function renderProjects() {
  projectSelect.innerHTML = "";

  state.projects.forEach((project) => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = `${project.name} (${project.sessionCount})`;
    projectSelect.appendChild(option);
  });

  if (state.selectedProjectId) {
    projectSelect.value = state.selectedProjectId;
  }
}

function renderSessions() {
  sessionList.innerHTML = "";

  if (state.sessions.length === 0) {
    sessionList.innerHTML = `<p class="empty-state">No sessions yet.</p>`;
    return;
  }

  state.sessions.forEach((session) => {
    const card = document.createElement("article");
    card.className = `session-card${session.id === state.activeSessionId ? " active" : ""}`;
    card.innerHTML = `
      <button class="session-open-button" type="button">
        <span class="session-title">${escapeHtml(session.title)}</span>
        <span class="session-meta">${escapeHtml(session.activeTaskStatus ?? "idle")}</span>
      </button>
      <button class="session-delete-button" type="button">Delete</button>
    `;

    card.querySelector(".session-open-button").addEventListener("click", () => {
      void withStatus("Loading session...", () => loadSession(session.id));
    });

    card.querySelector(".session-delete-button").addEventListener("click", () => {
      void deleteSession(session.id);
    });

    sessionList.appendChild(card);
  });
}

function renderMessages(session) {
  messagesEl.innerHTML = "";
  session.messages.forEach((message) => {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;
    const attachments =
      message.attachments.length > 0
        ? `<div class="message-attachments">${message.attachments
            .map((attachment) => `<span class="attachment-pill">${escapeHtml(attachment.name)}</span>`)
            .join("")}</div>`
        : "";

    article.innerHTML = `
      <header>
        <strong>${escapeHtml(message.role)}</strong>
        <span>${escapeHtml(message.createdAt)}</span>
        <span>${escapeHtml(message.route ?? "n/a")}</span>
      </header>
      <p>${escapeHtml(message.text)}</p>
      ${attachments}
    `;
    messagesEl.appendChild(article);
  });

  if (session.messages.length === 0) {
    messagesEl.innerHTML = `<p class="empty-state">Messages will appear after the first task.</p>`;
  }
}

function renderEvents(session) {
  taskEventsEl.innerHTML = "";
  const tasks = [...session.tasks].reverse();

  if (tasks.length === 0) {
    taskEventsEl.innerHTML = `<p class="empty-state">Execution log will appear after the first task.</p>`;
    return;
  }

  tasks.forEach((task) => {
    const section = document.createElement("section");
    section.className = "task-card";
    section.innerHTML = `
      <header>
        <strong>${escapeHtml(task.status)}</strong>
        <span>${escapeHtml(task.route)}</span>
        <span>${escapeHtml(task.createdAt)}</span>
      </header>
      <p>${escapeHtml(task.prompt)}</p>
      <div class="event-list">
        ${task.events
          .slice(-8)
          .reverse()
          .map(
            (event) => `
              <div class="event-row">
                <span>${escapeHtml(event.type)}</span>
                <span>${escapeHtml(event.detail)}</span>
              </div>
            `
          )
          .join("")}
      </div>
    `;
    taskEventsEl.appendChild(section);
  });
}

function renderEventsVisibility() {
  taskEventsEl.classList.toggle("hidden", !state.logExpanded || !state.activeSessionId);
  toggleEventsButton.textContent = state.logExpanded ? "Hide Log" : "Show Log";
}

function renderPendingFiles() {
  attachmentList.innerHTML = state.pendingFiles
    .map((file) => `<span class="pending-file">${escapeHtml(file.name)} (${file.size} bytes)</span>`)
    .join("");
}

function renderEmptySession() {
  sessionTitle.textContent = "No session selected";
  messagesEl.innerHTML = `<p class="empty-state">Choose a session on the left or create a new one.</p>`;
  taskEventsEl.innerHTML = "";
  renderEventsVisibility();
  renderComposerState();
}

function renderComposerState() {
  const disabled = !state.activeSessionId;
  taskInput.disabled = disabled;
  routeSelect.disabled = disabled;
  fileInput.disabled = disabled;
  openWorkspaceButton.disabled = disabled;
  composer.querySelector("#send-button").disabled = disabled;
  taskInput.placeholder = disabled ? "Create or select a session first." : "Describe what Marshal should do.";
}

function getInitialProjectId() {
  const remembered = localStorage.getItem(PROJECT_STORAGE_KEY);
  if (remembered && state.projects.some((project) => project.id === remembered)) {
    return remembered;
  }

  return state.projects[0]?.id ?? null;
}

async function fileToUploadPayload(file) {
  const buffer = await file.arrayBuffer();
  return {
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    contentBase64: arrayBufferToBase64(buffer)
  };
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return window.btoa(binary);
}

async function withStatus(message, action) {
  setStatus(message);
  try {
    const result = await action();
    if (message !== "Restarting app...") {
      setStatus("Ready.");
    }
    return result;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
    throw error;
  }
}

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle("error", isError);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

void bootstrap();
