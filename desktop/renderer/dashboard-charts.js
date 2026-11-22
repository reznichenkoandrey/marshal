// desktop/renderer/dashboard-charts.js
//
// Inline SVG for the Dashboards window (#279): line and bar charts from
// `{ label, value }` rows. Pure functions, no DOM — tested in
// tests/dashboard-charts.test.ts. Colours come from the classes in
// dashboards.css (tokens only); there is no chart library by design.

const WIDTH = 600;
const HEIGHT = 220;
const PAD = { top: 12, right: 20, bottom: 26, left: 36 };
const MAX_X_LABELS = 7;
const MAX_LABEL_CHARS = 12;

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeXml(value) {
  return String(value).replace(/[&<>"']/gu, (char) => ESCAPES[char]);
}

/** Upper bound of the value axis: the smallest 1 / 2 / 5 × 10ⁿ that holds `max`. */
export function niceMax(max) {
  if (!(max > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 5, 10].map((step) => step * power).find((bound) => bound >= max);
}

/** ISO dates lose the year (11-22); other labels are cut to fit under a bar. */
export function shortLabel(label) {
  const text = String(label);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return text.slice(5);
  return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1)}…` : text;
}

/** Indexes of the labels drawn on the x axis: all of them when they fit, else evenly spaced with both ends. */
export function labelIndexes(count, max = MAX_X_LABELS) {
  if (count <= max) return Array.from({ length: count }, (_unused, index) => index);
  const picked = new Set();
  for (let step = 0; step < max; step += 1) picked.add(Math.round((step * (count - 1)) / (max - 1)));
  return [...picked];
}

const round = (value) => Math.round(value * 10) / 10;

/** An SVG string, or "" when there is nothing to draw. `kind` is "line" or "bar". */
export function renderChart(kind, rows) {
  const data = Array.isArray(rows) ? rows.filter((row) => row && Number.isFinite(row.value)) : [];
  if (data.length === 0) return "";
  const top = niceMax(Math.max(...data.map((row) => row.value)));
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const baseline = PAD.top + plotHeight;
  const y = (value) => round(PAD.top + plotHeight * (1 - Math.max(0, value) / top));
  const slot = plotWidth / data.length;
  // Bars sit in the middle of their slot; line points span the full width.
  const x = (index) =>
    round(kind === "bar" || data.length === 1 ? PAD.left + slot * (index + 0.5) : PAD.left + (plotWidth * index) / (data.length - 1));

  const parts = [
    `<svg class="chart" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img">`,
    `<line class="chart-grid" x1="${PAD.left}" y1="${PAD.top}" x2="${WIDTH - PAD.right}" y2="${PAD.top}"/>`,
    `<line class="chart-axis" x1="${PAD.left}" y1="${baseline}" x2="${WIDTH - PAD.right}" y2="${baseline}"/>`,
    `<text class="chart-label" x="${PAD.left - 6}" y="${PAD.top + 4}" text-anchor="end">${top}</text>`,
    `<text class="chart-label" x="${PAD.left - 6}" y="${baseline}" text-anchor="end">0</text>`
  ];

  if (kind === "bar") {
    const width = round(Math.min(48, slot * 0.7));
    data.forEach((row, index) => {
      const barTop = y(row.value);
      parts.push(
        `<rect class="chart-bar" x="${round(x(index) - width / 2)}" y="${barTop}" width="${width}" height="${round(baseline - barTop)}">` +
          `<title>${escapeXml(row.label)}: ${row.value}</title></rect>`
      );
    });
  } else {
    const points = data.map((row, index) => `${x(index)},${y(row.value)}`);
    parts.push(`<polygon class="chart-area" points="${x(0)},${baseline} ${points.join(" ")} ${x(data.length - 1)},${baseline}"/>`);
    parts.push(`<polyline class="chart-line" points="${points.join(" ")}"/>`);
    data.forEach((row, index) => {
      parts.push(`<circle class="chart-dot" cx="${x(index)}" cy="${y(row.value)}" r="2.5"><title>${escapeXml(row.label)}: ${row.value}</title></circle>`);
    });
  }

  for (const index of labelIndexes(data.length)) {
    parts.push(`<text class="chart-label" x="${x(index)}" y="${HEIGHT - 8}" text-anchor="middle">${escapeXml(shortLabel(data[index].label))}</text>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

/** Age of a chart's data in whole minutes, or null when it has none. */
export function ageMinutes(updatedAt, now = Date.now()) {
  const at = Date.parse(updatedAt ?? "");
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 60_000)) : null;
}
