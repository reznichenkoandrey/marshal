// Dashboards renderer (#279). Main owns the dashboard and pushes its whole
// state on every change; this window draws it and sends three intents: build
// from a request, refresh, choose the repository folder. No timers: "updated
// N min ago" is computed when a state arrives, not ticked.

import { ageMinutes, escapeXml, renderChart } from "./dashboard-charts.js";

const api = window.marshalDashboards;
const t = (key, params) => window.MarshalI18n?.t(key, params) ?? key;

const charts = document.getElementById("charts");
const empty = document.getElementById("empty");
const errorLine = document.getElementById("error");
const title = document.getElementById("board-title");
const note = document.getElementById("board-note");
const folderLabel = document.getElementById("folder-path");
const prompt = document.getElementById("prompt");
const buildButton = document.getElementById("build-btn");
const refreshButton = document.getElementById("refresh-btn");
const saveButton = document.getElementById("save-btn");
const templates = document.getElementById("templates");

let state = { folder: null, dashboard: null, busy: false, error: null, templates: [] };

// A saved template: its name opens it, the cross removes it.
function templateChip(name) {
  const label = escapeXml(name);
  return (
    `<span class="template"${name === state.dashboard?.title ? ' data-current="true"' : ""}>` +
    `<button type="button" class="template-open" data-template="${label}">${label}</button>` +
    `<button type="button" class="template-delete" data-delete="${label}" aria-label="${escapeXml(t("dash.deleteTemplate", { title: name }))}">×</button>` +
    "</span>"
  );
}

function statusText(chart) {
  switch (chart.status) {
    case "pending":
      return t("dash.status.pending");
    case "error":
      return chart.error || t("dash.status.error");
    case "timeout":
      return t("dash.status.timeout");
    default:
      return t("dash.status.empty");
  }
}

function updatedText(chart) {
  const minutes = ageMinutes(chart.updatedAt);
  if (minutes === null) return "";
  if (minutes < 1) return t("dash.updatedNow");
  return minutes < 60 ? t("dash.updatedMin", { n: minutes }) : t("dash.updatedHours", { n: Math.floor(minutes / 60) });
}

// What main ran for this chart, shown as is: nothing is executed out of sight.
function queryText(query) {
  if (!query) return "";
  const command = query.source === "git" ? "git log" : `gh ${query.metric === "prs" ? "pr" : "issue"} list`;
  return `${command} · ${query.groupBy} · ${query.days}d`;
}

function card(chart) {
  const svg = chart.status === "ready" || (chart.status === "pending" && chart.rows) ? renderChart(chart.kind, chart.rows) : "";
  const stats = chart.stats
    ? `${t("dash.stat.total")} ${chart.stats.total} · ${t("dash.stat.avg")} ${chart.stats.avg} · ${t("dash.stat.max")} ${chart.stats.max}`
    : "";
  return (
    `<article class="chart-card" data-status="${escapeXml(chart.status)}">` +
    `<header><h3>${escapeXml(chart.title)}</h3><span class="ochip" data-tone="muted">${escapeXml(chart.source)}</span></header>` +
    `<div class="chart-body">${svg || escapeXml(statusText(chart))}</div>` +
    `<div class="chart-foot"><span class="caps">${escapeXml(stats)}</span><span class="caps">${escapeXml(updatedText(chart))}</span></div>` +
    `<div class="chart-foot"><span class="caps">${escapeXml(queryText(chart.query))}</span></div>` +
    "</article>"
  );
}

function render() {
  const dashboard = state.dashboard;
  folderLabel.textContent = state.folder ?? t("dash.noFolder");
  folderLabel.title = state.folder ?? "";
  title.textContent = dashboard?.title ?? "";
  note.textContent = state.busy ? t("dash.working") : "";
  errorLine.textContent = state.error ?? "";
  errorLine.classList.toggle("hidden", !state.error);
  empty.classList.toggle("hidden", Boolean(dashboard?.charts.length));
  charts.innerHTML = (dashboard?.charts ?? []).map(card).join("");
  templates.innerHTML = (state.templates ?? []).map(templateChip).join("");
  buildButton.disabled = state.busy;
  refreshButton.disabled = state.busy || !dashboard;
  saveButton.disabled = state.busy || !dashboard?.charts.length;
}

if (api) {
  api.onState((_event, next) => {
    state = next ?? state;
    render();
  });
  document.getElementById("ask").addEventListener("submit", (event) => {
    event.preventDefault();
    const request = prompt.value.trim();
    if (request === "" || state.busy) return;
    void api.build(request);
    prompt.value = "";
  });
  refreshButton.addEventListener("click", () => void api.refresh());
  saveButton.addEventListener("click", () => void api.saveTemplate());
  templates.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button?.dataset.template && !state.busy) void api.openTemplate(button.dataset.template);
    else if (button?.dataset.delete) void api.deleteTemplate(button.dataset.delete);
  });
  document.getElementById("folder-btn").addEventListener("click", () => void api.pickFolder());
  document.getElementById("close-btn").addEventListener("click", () => void api.close());
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") void api.close();
  });
  window.addEventListener("marshal:language", render);
  prompt.focus();
}
window.MarshalIcons?.apply();
render();
