import { describe, expect, it } from "vitest";

import { ageMinutes, escapeXml, labelIndexes, niceMax, renderChart, shortLabel } from "../desktop/renderer/dashboard-charts.js";

describe("dashboard charts", () => {
  it("picks a round axis maximum", () => {
    expect([0, 1, 3, 7, 12, 180].map(niceMax)).toEqual([1, 1, 5, 10, 20, 200]);
  });

  it("shortens labels", () => {
    expect(shortLabel("2026-11-22")).toBe("11-22");
    expect(shortLabel("area:chrome-extension")).toBe("area:chrome…");
    expect(shortLabel("bug")).toBe("bug");
  });

  it("thins x labels but keeps both ends", () => {
    expect(labelIndexes(3)).toEqual([0, 1, 2]);
    const picked = labelIndexes(30);
    expect(picked.length).toBeLessThanOrEqual(7);
    expect(picked[0]).toBe(0);
    expect(picked.at(-1)).toBe(29);
  });

  it("draws a line chart and a bar chart", () => {
    const rows = [
      { label: "2026-11-20", value: 2 },
      { label: "2026-11-21", value: 0 },
      { label: "2026-11-22", value: 5 }
    ];
    const line = renderChart("line", rows);
    expect(line).toContain("<polyline");
    expect(line.match(/<circle/gu)).toHaveLength(3);
    expect(line).toContain(">11-20<");
    const bar = renderChart("bar", rows);
    expect(bar.match(/<rect/gu)).toHaveLength(3);
    expect(bar).not.toContain("<polyline");
  });

  it("uses classes, never colours", () => {
    const svg = renderChart("bar", [{ label: "a", value: 1 }]);
    expect(svg).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|fill="|stroke="/iu);
  });

  it("escapes labels that come from a repository", () => {
    const svg = renderChart("bar", [{ label: '<script>alert("x")</script>', value: 1 }]);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(escapeXml(`a&b'c`)).toBe("a&amp;b&#39;c");
  });

  it("draws nothing without rows and survives a single point", () => {
    expect(renderChart("line", [])).toBe("");
    expect(renderChart("line", undefined)).toBe("");
    expect(renderChart("line", [{ label: "only", value: 3 }])).not.toContain("NaN");
  });

  it("computes the age of the data", () => {
    const now = Date.parse("2026-11-22T12:00:00Z");
    expect(ageMinutes("2026-11-22T11:57:30Z", now)).toBe(2);
    expect(ageMinutes(undefined, now)).toBeNull();
  });
});
