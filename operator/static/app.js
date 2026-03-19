const PROJECT_STORAGE_KEY = "marshal-active-project";

const state = {
  projects: [],
  sessions: [],
  activeSessionId: null,
  selectedProjectId: null,
  pendingFiles: [],
  pollHandle: null,
  logExpanded: false
};

const sessionList = document.querySelector("#session-list");
const sessionTitle = document.querySelector("#session-title");
const projectChip = document.querySelector("#project-chip");
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
const toggleEventsButton = document.querySelector("#toggle-events-button");

fileInput.addEventListener("change", async () => {
  state.pendingFiles = Array.from(fileInput.files ?? []);
  renderPendingFiles();
});

newSessionButton.addEventListener("click", async () => {
  if (!state.selectedProjectId) {
    return;
  }

  const session = await createSession();
  await refreshProjects();
  await refreshSessions();
  state.activeSessionId = session.id;
  await loadSession(session.id);
});

newProjectButton.addEventListener("click", async () => {
  const name = window.prompt("Project name");
  if (!name || !name.trim()) {
    return;
  }

  const project = await createProject(name.trim());
  await refreshProjects(project.id);
  await handleProjectChange(project.id);
});

projectSelect.addEventListener("change", async () => {
  const projectId = projectSelect.value || null;
  if (!projectId || projectId === state.selectedProjectId) {
    return;
  }

  await handleProjectChange(projectId);
});

toggleEventsButton.addEventListener("click", () => {
  state.logExpanded = !state.logExpanded;
  renderEventsVisibility();
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = taskInput.value.trim();
  if (!text || !state.activeSessionId || !state.selectedProjectId) {
    return;
  }

  const attachments = await Promise.all(state.pendingFiles.map(fileToUploadPayload));
  await requestJson(`${sessionPath(state.activeSessionId)}/messages?${projectQuery()}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      text,
      route: routeSelect.value,
      attachments
    })
  });

  taskInput.value = "";
  state.pendingFiles = [];
  fileInput.value = "";
  renderPendingFiles();
  await refreshProjects();
  await refreshSessions();
  await loadSession(state.activeSessionId);
});

async function bootstrap() {
  await refreshProjects();
  await handleProjectChange(getInitialProjectId());

  state.pollHandle = window.setInterval(async () => {
    await refreshSessions();
    if (!state.activeSessionId) {
      renderComposerState();
      return;
    }

    if (!state.sessions.some((session) => session.id === state.activeSessionId)) {
      state.activeSessionId = state.sessions[0]?.id ?? null;
    }

    if (state.activeSessionId) {
      await loadSession(state.activeSessionId, false);
    } else {
      renderEmptySession();
    }
  }, 2000);
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

async function refreshProjects(preferredProjectId = state.selectedProjectId) {
  const payload = await requestJson("/api/projects");
  state.projects = payload.data ?? [];
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

  const payload = await requestJson(`/api/sessions?${projectQuery()}`);
  state.sessions = payload.data ?? [];
  renderSessions();
}

async function loadSession(sessionId, scroll = true) {
  if (!state.selectedProjectId) {
    renderEmptySession();
    return;
  }

  const payload = await requestJson(`${sessionPath(sessionId)}?${projectQuery()}`);
  const session = payload.data;
  if (!session) {
    return;
  }

  state.activeSessionId = session.id;
  sessionTitle.textContent = session.title;
  projectChip.textContent = session.projectName;
  renderSessions();
  renderMessages(session);
  renderEvents(session);
  renderEventsVisibility();
  renderComposerState();
  if (scroll) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

async function createProject(name) {
  const payload = await requestJson("/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ name })
  });
  return payload.data;
}

async function createSession() {
  const payload = await requestJson("/api/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      projectId: state.selectedProjectId
    })
  });
  return payload.data;
}

async function deleteSession(sessionId) {
  if (!window.confirm("Delete this chat?")) {
    return;
  }

  await requestJson(`${sessionPath(sessionId)}?${projectQuery()}`, {
    method: "DELETE"
  });

  if (state.activeSessionId === sessionId) {
    state.activeSessionId = null;
  }

  await refreshProjects();
  await refreshSessions();
  state.activeSessionId = state.sessions[0]?.id ?? null;

  if (state.activeSessionId) {
    await loadSession(state.activeSessionId);
    return;
  }

  renderEmptySession();
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
    sessionList.innerHTML = `<p class="empty-state">No chats in this project yet.</p>`;
    return;
  }

  state.sessions.forEach((session) => {
    const article = document.createElement("article");
    article.className = `session-card${session.id === state.activeSessionId ? " active" : ""}`;

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "session-open-button";
    openButton.innerHTML = `
      <span class="session-title">${escapeHtml(session.title)}</span>
      <span class="session-meta">${escapeHtml(session.updatedAt)}</span>
      <span class="session-meta">${escapeHtml(session.activeTaskStatus ?? "idle")}</span>
    `;
    openButton.addEventListener("click", async () => {
      state.activeSessionId = session.id;
      await loadSession(session.id);
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "session-delete-button";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteSession(session.id);
    });

    article.append(openButton, deleteButton);
    sessionList.appendChild(article);
  });
}

function renderMessages(session) {
  messagesEl.innerHTML = "";
  session.messages.forEach((message) => {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;
    const attachments = message.attachments.length
      ? `<div class="message-attachments">${message.attachments
          .map((attachment) => `<span>${escapeHtml(attachment.name)}</span>`)
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
  toggleEventsButton.textContent = state.logExpanded ? "Hide Execution Log" : "Show Execution Log";
}

function renderPendingFiles() {
  attachmentList.innerHTML = state.pendingFiles
    .map((file) => `<span class="pending-file">${escapeHtml(file.name)} (${file.size} bytes)</span>`)
    .join("");
}

function renderEmptySession() {
  sessionTitle.textContent = "No chat selected";
  projectChip.textContent = getSelectedProject()?.name ?? "Project";
  messagesEl.innerHTML = `<p class="empty-state">Choose a chat on the left or create a new one.</p>`;
  taskEventsEl.innerHTML = "";
  renderEventsVisibility();
  renderComposerState();
}

function renderComposerState() {
  const disabled = !state.activeSessionId;
  taskInput.disabled = disabled;
  routeSelect.disabled = disabled;
  fileInput.disabled = disabled;
  composer.querySelector("#send-button").disabled = disabled;
  taskInput.placeholder = disabled ? "Create or select a chat first." : "Describe what Marshal should do.";
}

function getInitialProjectId() {
  const savedProjectId = localStorage.getItem(PROJECT_STORAGE_KEY);
  if (savedProjectId && state.projects.some((project) => project.id === savedProjectId)) {
    return savedProjectId;
  }

  return state.projects.find((project) => project.isDefault)?.id ?? state.projects[0]?.id ?? null;
}

function getSelectedProject() {
  return state.projects.find((project) => project.id === state.selectedProjectId) ?? null;
}

function projectQuery() {
  const params = new URLSearchParams();
  if (state.selectedProjectId) {
    params.set("projectId", state.selectedProjectId);
  }
  return params.toString();
}

function sessionPath(sessionId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}`;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
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
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

bootstrap().catch((error) => {
  console.error(error);
  sessionTitle.textContent = "Failed to load operator console";
});
