const state = {
  sessions: [],
  activeSessionId: null,
  pendingFiles: [],
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

fileInput.addEventListener("change", async () => {
  state.pendingFiles = Array.from(fileInput.files ?? []);
  renderPendingFiles();
});

newSessionButton.addEventListener("click", async () => {
  const session = await createSession();
  await refreshSessions();
  state.activeSessionId = session.id;
  await loadSession(session.id);
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = taskInput.value.trim();
  if (!text || !state.activeSessionId) {
    return;
  }

  const attachments = await Promise.all(state.pendingFiles.map(fileToUploadPayload));
  await fetch(`/api/sessions/${state.activeSessionId}/messages`, {
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
  await refreshSessions();
  await loadSession(state.activeSessionId);
});

async function bootstrap() {
  await refreshSessions();
  if (state.sessions.length === 0) {
    const session = await createSession();
    await refreshSessions();
    state.activeSessionId = session.id;
  } else {
    state.activeSessionId = state.sessions[0].id;
  }

  await loadSession(state.activeSessionId);
  state.pollHandle = window.setInterval(async () => {
    await refreshSessions();
    if (state.activeSessionId) {
      await loadSession(state.activeSessionId, false);
    }
  }, 2000);
}

async function refreshSessions() {
  const response = await fetch("/api/sessions");
  const payload = await response.json();
  state.sessions = payload.data ?? [];
  renderSessions();
}

async function loadSession(sessionId, scroll = true) {
  const response = await fetch(`/api/sessions/${sessionId}`);
  const payload = await response.json();
  const session = payload.data;
  if (!session) {
    return;
  }

  state.activeSessionId = session.id;
  sessionTitle.textContent = session.title;
  renderSessions();
  renderMessages(session);
  renderEvents(session);
  if (scroll) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

async function createSession() {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({})
  });
  const payload = await response.json();
  return payload.data;
}

function renderSessions() {
  sessionList.innerHTML = "";
  state.sessions.forEach((session) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-card${session.id === state.activeSessionId ? " active" : ""}`;
    button.innerHTML = `
      <span class="session-title">${escapeHtml(session.title)}</span>
      <span class="session-meta">${escapeHtml(session.updatedAt)}</span>
      <span class="session-meta">${escapeHtml(session.activeTaskStatus ?? "idle")}</span>
    `;
    button.addEventListener("click", async () => {
      state.activeSessionId = session.id;
      await loadSession(session.id);
    });
    sessionList.appendChild(button);
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

function renderPendingFiles() {
  attachmentList.innerHTML = state.pendingFiles
    .map((file) => `<span class="pending-file">${escapeHtml(file.name)} (${file.size} bytes)</span>`)
    .join("");
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
