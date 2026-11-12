// Meeting recordings renderer. Main pushes the list; a click on a row opens
// its player and notes in the right rail. Only one player exists at a time so two recordings never
// play over each other. "Transcribe & summarize" (#271) runs in main; this
// window only shows its progress and the notes it left next to the recording.

const list = document.getElementById("list");
const table = document.getElementById("table");
const metrics = document.getElementById("metrics");
const detailTitle = document.getElementById("detail-title");
const detailBody = document.getElementById("detail-body");
const empty = document.getElementById("empty");
const folderLabel = document.getElementById("folder-path");
const api = window.marshalMeetingHistory;
const t = (key, params) => window.MarshalI18n?.t(key, params) ?? key;
const uiLocale = () => (window.MarshalI18n?.language() === "uk" ? "uk-UA" : "en-GB");

let entries = [];
let openId = null;
// Ids being finished: the row keeps a disabled "Finishing…" until main's
// refresh replaces it with the finished recording.
const finishing = new Set();
// The running notes job, as main reports it ({ id, phase, done, total }) or null.
let notesJob = null;
// notes.json by recording id, fetched when its row is first opened.
const notesCache = new Map();
// The open player survives re-renders: progress re-renders the list every
// chunk, and a fresh <audio> each time would restart playback.
let player = null;
const languageSelect = document.getElementById("notes-language");
const LANGUAGE_KEY = "marshal.meetingNotesLanguage";

if (!api) {
  empty.classList.remove("hidden");
  empty.textContent = t("meetings.apiUnavailable");
} else {
  api.onLoaded((_event, payload) => {
    entries = Array.isArray(payload?.entries) ? payload.entries : [];
    folderLabel.textContent = payload?.folder ?? "";
    folderLabel.title = payload?.folder ?? "";
    render();
  });
  document.getElementById("refresh-btn").addEventListener("click", () => void api.refresh());
  document.getElementById("reveal-folder-btn").addEventListener("click", () => void api.revealFolder());
  document.getElementById("close-btn").addEventListener("click", () => void api.close());
  api.onNotesProgress((_event, progress) => {
    if (notesJob && !progress) notesCache.delete(notesJob.id);
    notesJob = progress ?? null;
    render();
  });
  try {
    languageSelect.value = localStorage.getItem(LANGUAGE_KEY) ?? "auto";
  } catch {
    // Storage unavailable: the select keeps its default.
  }
  languageSelect.addEventListener("change", () => {
    try {
      localStorage.setItem(LANGUAGE_KEY, languageSelect.value);
    } catch {
      // Not remembered across sessions; the current choice still applies.
    }
  });
  window.addEventListener("marshal:language", render);
}

async function summarize(entry) {
  const result = await api.summarize(entry.id, languageSelect.value);
  if (!result?.ok && !result?.cancelled) alert(result?.error ?? t("meetings.notesFailed"));
}

function render() {
  list.replaceChildren();
  empty.classList.toggle("hidden", entries.length > 0);
  table.hidden = entries.length === 0;
  if (!entries.some((entry) => entry.id === openId)) openId = null;
  if (player && player.id !== openId) player = null;
  for (const entry of entries) list.append(renderEntry(entry));
  renderMetrics();
  renderDetail();
  window.MarshalIcons?.apply();
}

function renderMetrics() {
  const durationMs = entries.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0);
  const bytes = entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
  const unfinished = entries.filter((entry) => entry.state === "error" || entry.state === "interrupted").length;
  setMetric("count", String(entries.length));
  setMetric("duration", durationMs > 0 ? formatDuration(durationMs) : "—");
  setMetric("size", bytes > 0 ? formatBytes(bytes) : "—");
  setMetric("unfinished", String(unfinished)).classList.toggle("over", unfinished > 0);
}

function setMetric(name, value) {
  const node = metrics.querySelector(`[data-metric="${name}"]`);
  node.querySelector(".num").textContent = value;
  return node;
}

function renderEntry(entry) {
  const row = el("tr", "meeting meeting-row");
  const media = entry.videoPath ?? entry.audioPath;
  const unfinished = entry.state === "error" || entry.state === "interrupted";
  const busy = finishing.has(entry.id);
  const transcribing = notesJob?.id === entry.id;
  const problem = unfinished && !busy;

  const when = el("td", "meeting-title");
  when.append(el("span", "meeting-date", formatDate(entry.startedAt)));
  const detail = describe(entry);
  const sub = el("span", problem ? "meeting-sub problem" : "meeting-sub", detail);
  if (problem) sub.title = detail;
  when.append(sub);
  row.append(when);
  row.append(el("td", "right mono", entry.durationMs !== null ? formatDuration(entry.durationMs) : "—"));
  row.append(el("td", "right mono", entry.bytes ? formatBytes(entry.bytes) : "—"));
  const mode = el("td");
  mode.append(chip(entry.mode === "screen" ? t("meetings.modeScreen") : t("meetings.kindAudio"), "muted"));
  row.append(mode);
  const status = el("td");
  status.append(chip(...statusChip(entry)));
  row.append(status);

  const actions = el("div", "meeting-actions");
  if (unfinished) {
    const finish = primary(busy ? t("meetings.finishing") : t("meetings.finish"), async () => {
      finishing.add(entry.id);
      render();
      const result = await api.finish(entry.id);
      finishing.delete(entry.id);
      render();
      if (!result?.ok) alert(result?.error ?? t("meetings.finishFailed"));
    });
    finish.disabled = busy;
    finish.title = t("meetings.finishTitle");
    actions.append(finish);
  }
  if (entry.state === "done" && entry.audioPath) {
    if (transcribing) {
      actions.append(primary(t("meetings.cancel"), () => void api.cancelNotes(entry.id)));
    } else if (!entry.notesPath) {
      const make = primary(t("meetings.summarize"), () => void summarize(entry));
      make.disabled = notesJob !== null;
      make.title = notesJob ? t("meetings.summarizeBusyTitle") : t("meetings.summarizeTitle");
      actions.append(make);
    } else {
      actions.append(primary(t("meetings.showNotes"), () => {
        openId = entry.id;
        render();
      }));
    }
  }
  const more = [button(t("meetings.showInFinder"), () => void api.reveal(media ?? `${entry.folder}/manifest.json`))];
  if (entry.state !== "recording" && entry.state !== "finalizing" && !busy && !transcribing) {
    const remove = button(t("meetings.delete"), async () => {
      if (!confirm(t("meetings.deleteConfirm", { date: formatDate(entry.startedAt) }))) return;
      const result = await api.trash(entry.id);
      if (!result?.ok) alert(result?.error ?? t("meetings.deleteFailed"));
    });
    remove.classList.add("danger");
    more.push(remove);
  }
  actions.append(overflow(more));
  const cell = el("td", "right");
  cell.append(actions);
  row.append(cell);

  if (media) {
    row.addEventListener("click", (event) => {
      if (event.target.closest("button, details")) return;
      openId = openId === entry.id ? null : entry.id;
      render();
    });
  }
  if (media && openId === entry.id) row.classList.add("open");
  return row;
}

/** The right rail: the open recording's player and its notes. */
function renderDetail() {
  const entry = entries.find((item) => item.id === openId);
  detailTitle.textContent = entry ? formatDate(entry.startedAt) : t("meetings.detail");
  if (!entry) {
    detailBody.replaceChildren(el("p", "empty", t("meetings.pickRow")));
    return;
  }
  const media = entry.videoPath ?? entry.audioPath;
  if (player?.id !== entry.id) {
    const node = el("div", "meeting-player");
    const tag = document.createElement(entry.videoPath ? "video" : "audio");
    tag.controls = true;
    tag.autoplay = true;
    tag.src = `file://${encodeURI(media)}`;
    node.append(tag);
    player = { id: entry.id, node };
  }
  detailBody.replaceChildren(player.node);
  if (entry.notesPath) detailBody.append(renderNotes(entry));
}

function statusChip(entry) {
  if (entry.state === "recording") return [t("meetings.statusRecording"), "bad"];
  if (entry.state === "finalizing") return [t("meetings.statusSaving"), "live"];
  if (finishing.has(entry.id)) return [t("meetings.statusFinishing"), "live"];
  if (notesJob?.id === entry.id) {
    const pct = notesJob.total ? Math.round((notesJob.done / notesJob.total) * 100) : 0;
    return [t("meetings.statusTranscribing", { pct }), "live"];
  }
  if (entry.state === "interrupted") return [t("meetings.statusInterrupted"), "warn"];
  if (entry.state === "error") return [t("meetings.statusFailed"), "bad"];
  if (entry.notesPath) return [t("meetings.statusNotes"), "ok"];
  return [t("meetings.statusReady"), "muted"];
}

function renderNotes(entry) {
  const box = el("div", "meeting-notes");
  if (!notesCache.has(entry.id)) {
    box.append(el("p", "notes-empty", t("meetings.loadingNotes")));
    notesCache.set(entry.id, null);
    void api.readNotes(entry.id).then((notes) => {
      notesCache.set(entry.id, notes ?? { error: true });
      render();
    });
    return box;
  }
  const notes = notesCache.get(entry.id);
  if (!notes) {
    box.append(el("p", "notes-empty", t("meetings.loadingNotes")));
    return box;
  }
  if (notes.error) {
    box.append(el("p", "notes-empty", t("meetings.notesUnreadable")));
  } else {
    box.append(el("h3", "notes-title", notes.title || t("meetings.notesFallbackTitle")));
    appendList(box, t("meetings.notesSummary"), notes.summary);
    appendList(box, t("meetings.notesDecisions"), notes.decisions);
    const tasks = Array.isArray(notes.tasks) ? notes.tasks : [];
    if (tasks.length > 0) {
      box.append(el("h4", "notes-heading", t("meetings.notesTasks")));
      const list = el("ul", "notes-tasks");
      for (const task of tasks) {
        const row = el("li", "notes-task");
        row.append(el("span", "notes-task-text", task.task));
        if (task.owner) row.append(el("span", "notes-task-owner", task.owner));
        if (task.mine) row.append(el("span", "notes-task-mine", t("meetings.notesMine")));
        const copy = button(t("meetings.copy"), async () => {
          await navigator.clipboard.writeText(task.task);
          copy.textContent = t("meetings.copied");
          setTimeout(() => (copy.textContent = t("meetings.copy")), 1200);
        });
        row.append(copy);
        list.append(row);
      }
      box.append(list);
    }
  }
  const actions = el("div", "notes-actions");
  actions.append(button(t("meetings.openNotes"), () => void api.openNotesFile(entry.id, "notes")));
  actions.append(button(t("meetings.openTranscript"), () => void api.openNotesFile(entry.id, "transcript")));
  const again = button(notesJob?.id === entry.id ? t("meetings.regenerating") : t("meetings.regenerate"), () => void summarize(entry));
  again.disabled = notesJob !== null;
  again.title = t("meetings.regenerateTitle");
  actions.append(again);
  box.append(actions);
  return box;
}

function appendList(box, heading, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  box.append(el("h4", "notes-heading", heading));
  const list = el("ul", "notes-list");
  for (const item of items) list.append(el("li", "", item));
  box.append(list);
}

/** The row's second line: what is happening to it, or what went wrong. */
function describe(entry) {
  if (entry.state === "recording") return t("meetings.stateRecording");
  if (entry.state === "finalizing") return t("meetings.stateSaving");
  if (finishing.has(entry.id)) return t("meetings.stateFinishing");
  if (notesJob?.id === entry.id) return describeNotesJob(notesJob);
  // The status chip already says Interrupted; Finish explains the raw chunks in its tooltip.
  if (entry.state === "interrupted") return "";
  if (entry.state === "error") return t("meetings.stateFailed", { error: entry.error ?? t("meetings.unknownError") });
  return entry.warnings.length > 0 ? t("meetings.warnings", { count: entry.warnings.length }) : "";
}

function describeNotesJob(job) {
  if (job.phase === "transcribing") return t("meetings.transcribing", { done: job.done, total: job.total });
  if (job.phase === "summarizing") return t("meetings.writingNotes");
  return t("meetings.preparing");
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(uiLocale(), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return t("meetings.sizeGb", { size: (bytes / 1024 ** 3).toFixed(1) });
  return t("meetings.sizeMb", { size: Math.max(1, Math.round(bytes / 1024 ** 2)) });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className ?? "";
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, onClick, className = "ghost-btn") {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function primary(label, onClick) {
  return button(label, onClick, "btn-primary");
}

function chip(label, tone) {
  const node = el("span", "ochip", label);
  node.dataset.tone = tone;
  return node;
}

/** Secondary row actions behind a ⋯ button; picking one closes the menu. */
function overflow(buttons) {
  const menu = el("details", "menu");
  const summary = el("summary", "icon-btn");
  summary.dataset.icon = "ellipsis";
  summary.dataset.iconSize = "16";
  summary.title = t("meetings.more");
  summary.setAttribute("aria-label", t("meetings.more"));
  const listNode = el("div", "menu-list");
  for (const node of buttons) {
    node.className = `${node.className.replace("ghost-btn", "").trim()}`;
    node.addEventListener("click", () => menu.removeAttribute("open"));
    listNode.append(node);
  }
  menu.append(summary, listNode);
  return menu;
}
