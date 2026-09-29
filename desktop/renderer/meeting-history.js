// Meeting recordings renderer. Main pushes the list; a click on a row opens
// its player inline. Only one player exists at a time so two recordings never
// play over each other.

const list = document.getElementById("list");
const empty = document.getElementById("empty");
const folderLabel = document.getElementById("folder-path");
const api = window.marshalMeetingHistory;

let entries = [];
let openId = null;

if (!api) {
  empty.classList.remove("hidden");
  empty.textContent = "Recordings API unavailable — preload script failed to load.";
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
}

function render() {
  list.replaceChildren();
  empty.classList.toggle("hidden", entries.length > 0);
  if (!entries.some((entry) => entry.id === openId)) openId = null;
  for (const entry of entries) list.append(renderEntry(entry));
}

function renderEntry(entry) {
  const item = el("li", "meeting");
  const row = el("div", "meeting-row");
  const media = entry.videoPath ?? entry.audioPath;

  row.append(el("span", "meeting-kind", entry.mode === "screen" ? "Screen" : "Audio"));
  const title = el("div", "meeting-title");
  title.append(el("span", "meeting-date", formatDate(entry.startedAt)));
  const problem = entry.state === "error" || entry.state === "interrupted";
  title.append(el("span", problem ? "meeting-sub problem" : "meeting-sub", describe(entry)));
  row.append(title);

  const actions = el("div", "meeting-actions");
  actions.append(button("Show in Finder", () => void api.reveal(media ?? `${entry.folder}/manifest.json`)));
  if (entry.state !== "recording" && entry.state !== "finalizing") {
    actions.append(button("Delete", async () => {
      if (!confirm(`Move the recording from ${formatDate(entry.startedAt)} to the Trash?`)) return;
      const result = await api.trash(entry.id);
      if (!result?.ok) alert(result?.error ?? "Could not delete the recording.");
    }));
  }
  row.append(actions);
  item.append(row);

  if (media) {
    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      openId = openId === entry.id ? null : entry.id;
      render();
    });
  }
  if (media && openId === entry.id) {
    item.classList.add("open");
    const player = el("div", "meeting-player");
    const tag = document.createElement(entry.videoPath ? "video" : "audio");
    tag.controls = true;
    tag.autoplay = true;
    tag.src = `file://${encodeURI(media)}`;
    player.append(tag);
    item.append(player);
  }
  return item;
}

function describe(entry) {
  if (entry.state === "recording") return "Recording…";
  if (entry.state === "finalizing") return "Saving…";
  if (entry.state === "interrupted") return "Interrupted — raw chunks are in the folder";
  if (entry.state === "error") return `Failed: ${entry.error ?? "unknown error"}`;
  const parts = [];
  if (entry.durationMs !== null) parts.push(formatDuration(entry.durationMs));
  parts.push(formatBytes(entry.bytes));
  if (entry.warnings.length > 0) parts.push(`${entry.warnings.length} warning(s)`);
  return parts.join(" · ");
}

function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
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
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, onClick) {
  const node = el("button", "ghost-btn", label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}
