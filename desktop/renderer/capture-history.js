// Capture history renderer.
//
// Receives the entry list from main on did-finish-load (and on every refresh
// pulse), renders the grid, and asks main to open / reveal / reopen-in-editor
// when the user clicks a tile. The renderer has no filesystem access; every
// disk operation goes through marshalHistory in preload.

const grid = document.getElementById("grid");
const empty = document.getElementById("empty");
const folderLabel = document.getElementById("folder-path");
const refreshBtn = document.getElementById("refresh-btn");
const revealFolderBtn = document.getElementById("reveal-folder-btn");
const closeBtn = document.getElementById("close-btn");

const api = window.marshalHistory;

if (!api) {
  // The preload script is mandatory. Surface a useful message rather than a
  // blank window if something went wrong with preload registration.
  empty.classList.remove("hidden");
  empty.innerHTML = "<p>History API unavailable — preload script failed to load.</p>";
} else {
  api.onLoaded((event, payload) => render(payload));
  refreshBtn?.addEventListener("click", () => void api.refresh());
  revealFolderBtn?.addEventListener("click", () => void api.revealFolder());
  closeBtn?.addEventListener("click", () => void api.close());
}

function render(payload) {
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  folderLabel.textContent = payload?.folder ?? "";
  folderLabel.title = payload?.folder ?? "";
  grid.innerHTML = "";

  if (entries.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  for (const entry of entries) {
    grid.appendChild(buildTile(entry));
  }
}

function buildTile(entry) {
  const tile = document.createElement("article");
  tile.className = "tile";
  tile.title = entry.name;

  const thumb = document.createElement("div");
  thumb.className = "tile-thumb";

  if (entry.kind === "image" || entry.kind === "gif") {
    const img = document.createElement("img");
    img.loading = "lazy";
    // Using file:// directly is fine — Electron's preload window is local.
    img.src = `file://${encodeURI(entry.path)}`;
    img.alt = entry.name;
    thumb.appendChild(img);
  } else {
    const placeholder = document.createElement("span");
    placeholder.className = "placeholder";
    placeholder.textContent = entry.kind.toUpperCase();
    thumb.appendChild(placeholder);
  }

  const badge = document.createElement("span");
  badge.className = "tile-badge";
  badge.textContent = entry.kind === "image" ? "PNG" : entry.kind.toUpperCase();

  const meta = document.createElement("div");
  meta.className = "tile-meta";

  const name = document.createElement("span");
  name.className = "tile-name";
  name.textContent = entry.name;

  const sub = document.createElement("div");
  sub.className = "tile-sub";

  const date = document.createElement("span");
  date.textContent = relativeDate(entry.modifiedAt);

  const size = document.createElement("span");
  size.textContent = humanSize(entry.bytes);

  sub.append(date, size);
  meta.append(name, sub);

  const actions = document.createElement("div");
  actions.className = "tile-actions";

  const openBtn = document.createElement("button");
  openBtn.className = "tile-action-btn";
  openBtn.textContent = entry.kind === "image" ? "Edit" : "Open";
  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void handleOpen(entry);
  });

  const revealBtn = document.createElement("button");
  revealBtn.className = "tile-action-btn";
  revealBtn.textContent = "Reveal";
  revealBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void api.reveal(entry.path);
  });

  actions.append(openBtn, revealBtn);

  tile.append(thumb, badge, actions, meta);

  // Default click → primary action (edit images, open everything else).
  tile.addEventListener("click", () => void handleOpen(entry));

  return tile;
}

async function handleOpen(entry) {
  if (entry.kind === "image") {
    const r = await api.openInEditor(entry.path);
    if (!r?.ok) console.error("openInEditor failed", r?.error);
    return;
  }
  const r = await api.openExternal(entry.path);
  if (!r?.ok) console.error("openExternal failed", r?.error);
}

function relativeDate(ms) {
  const diff = Date.now() - ms;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))} min ago`;
  if (diff < day) return `${Math.round(diff / hour)} h ago`;
  if (diff < 7 * day) return `${Math.round(diff / day)} d ago`;
  const d = new Date(ms);
  return `${d.toLocaleDateString()}`;
}

function humanSize(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
