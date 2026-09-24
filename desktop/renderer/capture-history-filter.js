// desktop/renderer/capture-history-filter.js
//
// Search and date grouping for the capture history grid. Pure functions, no
// DOM, no IPC — the renderer holds the full list main pushed it and re-derives
// the view on every keystroke, which is why finding a capture is instant and
// needs no second disk read.
//
// Split out of capture-history.js so the matching rules are testable
// (tests/capture-history-filter.test.ts), the same way capture-shapes.js
// carries the editor's pure half.

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a tile's badge says, and what the search matches on for `kind`. */
export function kindLabel(kind) {
  return kind === "image" ? "PNG" : String(kind ?? "").toUpperCase();
}

/**
 * ISO day stamp in LOCAL time. `toISOString()` is UTC and would file an
 * evening capture under the next day for anyone east of Greenwich.
 */
export function isoDay(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight for a timestamp, as ms. Grouping keys off this. */
function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Heading for a day group: "Today", "Yesterday", the weekday inside the last
 * week, then the ISO date. The ISO date is deliberate rather than a locale
 * string — it is what the search box matches, so the heading and the query
 * that finds it are the same text.
 */
export function dayLabel(ms, now = Date.now()) {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Date(ms).toLocaleDateString(undefined, { weekday: "long" });
  return isoDay(ms);
}

/**
 * True when the entry answers the query. Everything visible on a tile is
 * searchable — the filename, the badge, the ISO date and the day heading —
 * because the user remembers a capture by whichever of those stuck ("that PNG
 * from yesterday", "the one from the 24th").
 *
 * Multiple words all have to match, in any order, so "png yesterday" narrows
 * instead of finding nothing.
 */
export function matchesQuery(entry, query, now = Date.now()) {
  const terms = String(query ?? "")
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = [
    entry.name,
    kindLabel(entry.kind),
    isoDay(entry.modifiedAt),
    dayLabel(entry.modifiedAt, now)
  ]
    .join(" ")
    .toLowerCase();

  return terms.every((term) => haystack.includes(term));
}

export function filterEntries(entries, query, now = Date.now()) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => matchesQuery(entry, query, now));
}

/**
 * Entries bucketed by local day, newest day first and newest entry first
 * inside each day. Empty groups are never produced, so a filtered view shows
 * only the days that still have something in them.
 */
export function groupByDay(entries, now = Date.now()) {
  const buckets = new Map();
  for (const entry of entries) {
    const key = startOfDay(entry.modifiedAt);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }

  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([key, group]) => ({
      key,
      label: dayLabel(key, now),
      entries: [...group].sort((a, b) => b.modifiedAt - a.modifiedAt)
    }));
}
