// Capture history renderer.
//
// Receives the entry list from main on did-finish-load (and on every refresh
// pulse), keeps it in memory, and re-derives the view — search filter, day
// grouping — on every keystroke. Filtering never goes back to main: the list
// is already here, and a disk read per character would make the field lag.
//
// Clicking a tile asks main to open / reveal / reopen-in-editor. The renderer
// has no filesystem access; every disk operation goes through marshalHistory
// in preload.

import { filterEntries, groupByDay, kindLabel } from "./capture-history-filter.js";

const t = (key, params) => window.MarshalI18n?.t(key, params) ?? key;
const locale = () => (window.MarshalI18n?.language() === "uk" ? "uk-UA" : "en-GB");
const dayLabels = () => ({ today: t("history.today"), yesterday: t("history.yesterday"), locale: locale() });

const groups = document.getElementById("groups");
const empty = document.getElementById("empty");
const folderLabel = document.getElementById("folder-path");
const searchInput = document.getElementById("search");
const refreshBtn = document.getElementById("refresh-btn");
const revealFolderBtn = document.getElementById("reveal-folder-btn");
const closeBtn = document.getElementById("close-btn");

const api = window.marshalHistory;

/** Everything main sent us, unfiltered. The search view derives from this. */
let allEntries = [];

if (!api) {
  // The preload script is mandatory. Surface a useful message rather than a
  // blank window if something went wrong with preload registration.
  empty.classList.remove("hidden");
  empty.innerHTML = `<p>${escapeText(t("history.apiUnavailable"))}</p>`;
} else {
  api.onLoaded((event, payload) => {
    allEntries = Array.isArray(payload?.entries) ? payload.entries : [];
    folderLabel.textContent = payload?.folder ?? "";
    folderLabel.title = payload?.folder ?? "";
    renderView();
  });
  refreshBtn?.addEventListener("click", () => void api.refresh());
  revealFolderBtn?.addEventListener("click", () => void api.revealFolder());
  closeBtn?.addEventListener("click", () => void api.close());
}

searchInput?.addEventListener("input", renderView);
if (api) window.addEventListener("marshal:language", renderView);
// Esc clears the query rather than closing the window — the window is the
// thing being searched, and losing it mid-search is never what was meant.
searchInput?.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  if (!searchInput.value) return;
  searchInput.value = "";
  renderView();
});

// ⌘F / typing anywhere lands in the search box: the grid has nothing else to
// type into, and reaching for the mouse to search is the slow path.
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "f") {
    e.preventDefault();
    searchInput?.focus();
    searchInput?.select();
  }
});

function renderView() {
  const query = searchInput?.value ?? "";
  const now = Date.now();
  const labels = dayLabels();
  const matching = filterEntries(allEntries, query, now, labels);
  groups.innerHTML = "";

  if (matching.length === 0) {
    empty.classList.remove("hidden");
    empty.innerHTML = allEntries.length === 0
      ? `<p>${escapeText(t("history.empty"))}</p><p class="history-empty-hint">${t("history.emptyHint")}</p>`
      : `<p>${escapeText(t("history.noMatch", { query }))}</p>`;
    return;
  }
  empty.classList.add("hidden");

  for (const day of groupByDay(matching, now, labels)) {
    groups.appendChild(buildDaySection(day));
  }
}

function buildDaySection(day) {
  const section = document.createElement("section");
  section.className = "history-day";

  const heading = document.createElement("h2");
  heading.className = "history-day-label";
  heading.textContent = day.label;

  const count = document.createElement("span");
  count.className = "history-day-count";
  count.textContent = captureCount(day.entries.length);
  heading.appendChild(count);

  const grid = document.createElement("div");
  grid.className = "history-grid";
  for (const entry of day.entries) grid.appendChild(buildTile(entry));

  section.append(heading, grid);
  return section;
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
  badge.textContent = kindLabel(entry.kind);

  const meta = document.createElement("div");
  meta.className = "tile-meta";

  const name = document.createElement("span");
  name.className = "tile-name";
  name.textContent = entry.name;

  const sub = document.createElement("div");
  sub.className = "tile-sub";

  const date = document.createElement("span");
  date.textContent = clockTime(entry.modifiedAt);

  const size = document.createElement("span");
  size.textContent = humanSize(entry.bytes);

  sub.append(date, size);
  meta.append(name, sub);

  const actions = document.createElement("div");
  actions.className = "tile-actions";

  const openBtn = document.createElement("button");
  openBtn.className = "tile-action-btn";
  openBtn.textContent = t(entry.kind === "image" ? "history.edit" : "history.open");
  openBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void handleOpen(entry);
  });

  const revealBtn = document.createElement("button");
  revealBtn.className = "tile-action-btn";
  revealBtn.textContent = t("history.reveal");
  revealBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void api.reveal(entry.path);
  });

  actions.append(openBtn, revealBtn);
  tile.append(thumb, badge, actions, meta);

  // An archived capture was never saved anywhere the user chose, so label it —
  // otherwise "Reveal" landing in an app-support folder is a surprise.
  if (entry.source === "archive") {
    const source = document.createElement("span");
    source.className = "tile-source";
    source.textContent = t("history.notSaved");
    source.title = t("history.notSavedTitle");
    tile.appendChild(source);
  }

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

/** Day grouping already carries the date, so the tile only needs the clock. */
function clockTime(ms) {
  return new Date(ms).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });
}

const COUNT_KEYS = { one: "history.countOne", few: "history.countFew" };

function captureCount(count) {
  const category = new Intl.PluralRules(window.MarshalI18n?.language() ?? "en").select(count);
  return t(COUNT_KEYS[category] ?? "history.countMany", { count });
}

function humanSize(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The query goes into innerHTML for the em-dashes around it, so escape it. */
function escapeText(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
