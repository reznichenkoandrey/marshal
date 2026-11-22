// desktop/decks/sanitize.ts
//
// Allowlist sanitiser for model-written slide HTML (#277): no scripts, no
// event handlers, no external URLs. It never passes markup through: the
// output is rebuilt from allowlisted tags and attributes with every value
// re-escaped, so what was checked is exactly what the browser decodes.
//
// This is the second layer. The guarantee is the render context (sandboxed
// iframe + CSP `default-src 'none'`), see docs/VOICE_DECKS.md.

const ALLOWED_TAGS = new Set([
  "section", "div", "span", "p", "h1", "h2", "h3", "h4", "ul", "ol", "li",
  "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "code", "pre",
  "blockquote", "br", "hr", "table", "thead", "tbody", "tr", "th", "td",
  "figure", "figcaption", "img"
]);

const VOID_TAGS = new Set(["br", "hr", "img"]);

/** Dropped together with everything up to their closing tag. */
const DROPPED_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template", "svg",
  "math", "title", "head", "textarea", "select", "xmp", "noembed", "noframes",
  "frameset", "applet", "audio", "video", "canvas", "plaintext"
]);

const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/;
const UNSAFE_STYLE_VALUE = /url\s*\(|image-set|expression|@import|javascript:|behavior|-moz-binding|\/\*|[\\<>]/i;
const STYLE_PROPERTY = /^-{0,2}[a-z][a-z0-9-]*$/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  colon: ":", lpar: "(", rpar: ")", tab: "\t", newline: "\n"
};

export function sanitizeSlideHtml(input: string): string {
  const out: string[] = [];
  const open: string[] = [];
  const length = input.length;
  let i = 0;

  while (i < length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out.push(escapeText(input.slice(i)));
      break;
    }
    if (lt > i) out.push(escapeText(input.slice(i, lt)));

    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? length : end + 3;
      continue;
    }
    const next = input[lt + 1];
    if (next === "!" || next === "?") {
      i = after(input.indexOf(">", lt), length);
      continue;
    }

    const closing = next === "/";
    const nameStart = lt + (closing ? 2 : 1);
    const nameMatch = /^[a-zA-Z][^\s/>]*/.exec(input.slice(nameStart, nameStart + 64));
    if (!nameMatch) {
      if (closing) {
        i = after(input.indexOf(">", lt), length);
      } else {
        out.push("&lt;");
        i = lt + 1;
      }
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    const bodyStart = nameStart + nameMatch[0].length;
    const end = findTagEnd(input, bodyStart);
    if (end === -1) break;
    i = end + 1;

    if (closing) {
      const at = open.lastIndexOf(name);
      if (at === -1) continue;
      while (open.length > at) out.push(`</${open.pop()}>`);
      continue;
    }
    if (DROPPED_WITH_CONTENT.has(name)) {
      const close = new RegExp(`</${name}[\\s/>]`, "i").exec(input.slice(i));
      if (!close) break;
      i = after(input.indexOf(">", i + close.index), length);
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue;

    const attributes = safeAttributes(name, input.slice(bodyStart, end));
    if (attributes === null) continue;
    out.push(`<${name}${attributes}>`);
    if (!VOID_TAGS.has(name)) open.push(name);
  }

  while (open.length > 0) out.push(`</${open.pop()}>`);
  return out.join("");
}

function after(index: number, length: number): number {
  return index === -1 ? length : index + 1;
}

/** Index of the `>` that ends a tag; quotes open only after `=`, as in HTML. */
function findTagEnd(input: string, from: number): number {
  let quote = "";
  let previous = "";
  for (let i = from; i < input.length; i += 1) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if ((char === '"' || char === "'") && previous === "=") quote = char;
    else if (char === ">") return i;
    if (!/\s/.test(char)) previous = char;
  }
  return -1;
}

/** Serialised safe attributes, or null when the element itself must go. */
function safeAttributes(tag: string, body: string): string | null {
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const kept = new Map<string, string>();
  for (const match of body.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (kept.has(name)) continue;
    const value = safeValue(tag, name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
    if (value !== null) kept.set(name, value);
  }
  if (tag === "img" && !kept.has("src")) return null;
  return [...kept].map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("");
}

function safeValue(tag: string, name: string, value: string): string | null {
  switch (name) {
    case "class":
      return /^[\w\- ]+$/.test(value) ? value : null;
    case "style":
      return safeStyle(value) || null;
    case "lang":
      return /^[a-zA-Z-]{2,12}$/.test(value) ? value : null;
    case "dir":
      return /^(?:ltr|rtl|auto)$/.test(value) ? value : null;
    case "colspan":
    case "rowspan":
      return (tag === "td" || tag === "th") && /^\d{1,3}$/.test(value) ? value : null;
    case "src":
      return tag === "img" && DATA_IMAGE.test(value) ? value : null;
    case "alt":
      return tag === "img" ? value : null;
    case "width":
    case "height":
      return tag === "img" && /^\d{1,4}$/.test(value) ? value : null;
    default:
      return null;
  }
}

/** Keeps `property: value` declarations that cannot load or run anything. */
export function safeStyle(value: string): string {
  const kept: string[] = [];
  for (const declaration of value.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim();
    const text = declaration.slice(colon + 1).trim();
    if (!STYLE_PROPERTY.test(property) || !text || UNSAFE_STYLE_VALUE.test(text)) continue;
    kept.push(`${property}: ${text}`);
  }
  return kept.join("; ");
}

function decodeEntities(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, (whole, hex, decimal, named) => {
    if (named) return NAMED_ENTITIES[(named as string).toLowerCase()] ?? whole;
    const code = Number.parseInt((hex ?? decimal) as string, hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Text between tags: entity references survive, everything else is literal. */
function escapeText(text: string): string {
  return text
    .replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** For plain strings (titles) placed into deck HTML. */
export function escapeHtml(text: string): string {
  return escapeAttribute(text);
}
