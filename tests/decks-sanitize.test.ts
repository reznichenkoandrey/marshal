// tests/decks-sanitize.test.ts
//
// Slide HTML comes from a model. These are the vectors from the spec (#277):
// scripts, event handlers and anything that could load a URL must be gone,
// while ordinary slide markup, Cyrillic included, survives.

import { describe, expect, it } from "vitest";

import { safeStyle, sanitizeSlideHtml } from "../desktop/decks/sanitize.ts";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("sanitizeSlideHtml", () => {
  it("keeps ordinary slide markup", () => {
    const html = '<h2 class="lead">Релізи за жовтень</h2><ul><li><strong>0.6.0</strong> — Holos</li><li>R&amp;D &lt;3</li></ul>';
    expect(sanitizeSlideHtml(html)).toBe(html);
  });

  it("removes scripts together with their content", () => {
    expect(sanitizeSlideHtml('<p>a</p><script>alert("</p>")</script><p>b</p>')).toBe("<p>a</p><p>b</p>");
    expect(sanitizeSlideHtml("<p>a</p><SCRIPT src=x></SCRIPT >b")).toBe("<p>a</p>b");
    expect(sanitizeSlideHtml("<p>a</p><script>never closed")).toBe("<p>a</p>");
  });

  it("removes event handlers", () => {
    expect(sanitizeSlideHtml(`<img src="${PNG}" onerror="alert(1)">`)).toBe(`<img src="${PNG}">`);
    expect(sanitizeSlideHtml("<p onclick=alert(1) ONMOUSEOVER='x'>a</p>")).toBe("<p>a</p>");
  });

  it("removes links and javascript: URLs but keeps the text", () => {
    expect(sanitizeSlideHtml('<a href="javascript:alert(1)">click</a>')).toBe("click");
    expect(sanitizeSlideHtml('<a href="https://example.com">site</a>')).toBe("site");
  });

  it("removes images that are not inline raster data", () => {
    expect(sanitizeSlideHtml('<img src="https://example.com/a.png">')).toBe("");
    expect(sanitizeSlideHtml('<img src="//example.com/a.png" alt="x">')).toBe("");
    expect(sanitizeSlideHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=">')).toBe("");
    expect(sanitizeSlideHtml('<img src="data:text/html;base64,PHN2Zz4=">')).toBe("");
    expect(sanitizeSlideHtml('<img alt="no source">')).toBe("");
    expect(sanitizeSlideHtml(`<img src="${PNG}" alt="Графік" width="320">`)).toBe(
      `<img src="${PNG}" alt="Графік" width="320">`
    );
  });

  it("removes frames, embeds, svg and forms", () => {
    expect(sanitizeSlideHtml('<iframe src="https://example.com"></iframe>ok')).toBe("ok");
    expect(sanitizeSlideHtml('<object data="x"></object><embed src="x">ok</embed>')).toBe("");
    expect(sanitizeSlideHtml("<svg><script>alert(1)</script></svg>ok")).toBe("ok");
    expect(sanitizeSlideHtml('<form action="https://example.com"><input name="a">ok</form>')).toBe("ok");
  });

  it("removes style blocks and unsafe inline declarations", () => {
    expect(sanitizeSlideHtml('<style>@import url("https://example.com/a.css");</style><p>a</p>')).toBe("<p>a</p>");
    expect(
      sanitizeSlideHtml('<p style="color: red; background: url(https://example.com/a.png); font-weight: 700">a</p>')
    ).toBe('<p style="color: red; font-weight: 700">a</p>');
    expect(sanitizeSlideHtml('<p style="background:u\\72l(x)">a</p>')).toBe("<p>a</p>");
  });

  it("checks attribute values after entity decoding", () => {
    expect(sanitizeSlideHtml('<p style="background:&#117;rl&lpar;https://example.com/a.png)">a</p>')).toBe("<p>a</p>");
    expect(sanitizeSlideHtml('<img src="&#104;ttps://example.com/a.png">')).toBe("");
  });

  it("drops comments, doctype and processing instructions", () => {
    expect(sanitizeSlideHtml("<!-- <script>x</script> --><p>a</p><!doctype html><?xml x?>")).toBe("<p>a</p>");
    expect(sanitizeSlideHtml("<p>a</p><!-- never closed <p>b</p>")).toBe("<p>a</p>");
  });

  it("drops a tag that never closes instead of leaking it as markup", () => {
    expect(sanitizeSlideHtml('<p>a</p><img src="x" onerror="alert(1)"')).toBe("<p>a</p>");
    expect(sanitizeSlideHtml('<p title="a>b" onclick="x">text</p>')).toBe("<p>text</p>");
  });

  it("closes what the model left open and ignores stray closing tags", () => {
    expect(sanitizeSlideHtml("<ul><li>a<li>b")).toBe("<ul><li>a<li>b</li></li></ul>");
    expect(sanitizeSlideHtml("</div><p>a</span></p>")).toBe("<p>a</p>");
  });

  it("escapes a bare angle bracket and a bare ampersand", () => {
    expect(sanitizeSlideHtml("<p>1 < 2 & 3 > 2</p>")).toBe("<p>1 &lt; 2 &amp; 3 &gt; 2</p>");
  });

  it("gives the same result when run twice", () => {
    const dirty = `<section class="a b"><h1 style="color: red; x: url(y)">T&amp;C</h1><img src="${PNG}" alt='"q"'><script>x</script>1 < 2`;
    const once = sanitizeSlideHtml(dirty);
    expect(sanitizeSlideHtml(once)).toBe(once);
  });

  it("never emits a script, a handler or a URL scheme for hostile input", () => {
    const vectors = [
      "<scr<script>ipt>alert(1)</scr</script>ipt>",
      '<img src="x" onerror=alert(1)//',
      "<svg/onload=alert(1)>",
      '<p style="x:expression(alert(1))">a</p>',
      '<div style="background-image: image-set(\'https://example.com/a.png\' 1x)">a</div>',
      "<math><mtext><script>alert(1)</script></mtext></math>",
      '<table background="https://example.com/a.png"><tr><td colspan="2">a</td></tr></table>',
      '<p class="a" onclick="b" class="c">a</p>',
      "<plaintext><p>a</p>",
      '<base href="https://example.com/"><link rel="stylesheet" href="https://example.com/a.css"><meta http-equiv="refresh" content="0;url=https://example.com">'
    ];
    for (const vector of vectors) {
      const clean = sanitizeSlideHtml(vector);
      expect(clean).not.toMatch(/<script|<svg|<iframe|<link|<meta|<base|\son\w+\s*=|https?:|javascript:|url\(|expression/i);
    }
  });
});

describe("safeStyle", () => {
  it("keeps plain declarations and drops malformed ones", () => {
    expect(safeStyle("color:red;; font-size : 2em ;nonsense; 1x: y")).toBe("color: red; font-size: 2em");
  });
});
