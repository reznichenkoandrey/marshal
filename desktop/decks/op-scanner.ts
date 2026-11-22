// desktop/decks/op-scanner.ts
//
// Splits a model stream into complete top-level JSON objects (#277). The model
// writes a deck as one operation per object; an operation is handed out only
// once its closing brace has arrived, so a slide cut in half by a chunk
// boundary is never applied. No Electron and no deck knowledge here: the
// caller validates what each object means (deck-model.ts).

/** One operation larger than this is a runaway stream, not a slide. */
export const MAX_OP_CHARS = 512 * 1024;

export type ScannedOp = { ok: true; value: unknown } | { ok: false; reason: string };

export class OpScanner {
  private buffer = "";
  private depth = 0;
  private inString = false;
  private escaped = false;
  private skipping = false;

  /** Text of the operation that is still open, for a growing preview. */
  get pending(): string {
    return this.skipping ? "" : this.buffer;
  }

  /**
   * Feed the next chunk. Returns every operation that closed inside it, in
   * order. Anything between objects (newlines, commas, array brackets, code
   * fences, prose) is ignored.
   */
  feed(chunk: string): ScannedOp[] {
    const results: ScannedOp[] = [];
    let start = this.depth > 0 ? 0 : -1;
    const offset = this.buffer.length;
    const text = this.buffer + chunk;

    for (let i = offset; i < text.length; i += 1) {
      const char = text[i];
      if (this.depth === 0) {
        if (char === "{") {
          this.depth = 1;
          start = i;
        }
        continue;
      }
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === "\\") this.escaped = true;
        else if (char === '"') this.inString = false;
        continue;
      }
      if (char === '"') this.inString = true;
      else if (char === "{") this.depth += 1;
      else if (char === "}") {
        this.depth -= 1;
        if (this.depth > 0) continue;
        if (this.skipping) {
          this.skipping = false;
        } else {
          results.push(parseObject(text.slice(start, i + 1)));
        }
        start = -1;
      }
    }

    if (this.depth === 0 || this.skipping) {
      this.buffer = "";
    } else {
      this.buffer = text.slice(start);
      if (this.buffer.length > MAX_OP_CHARS) {
        // Keep tracking braces so the tail of the oversized object is not
        // mistaken for new operations, but stop holding its text.
        this.buffer = "";
        this.skipping = true;
        results.push({ ok: false, reason: `operation exceeds ${MAX_OP_CHARS} characters` });
      }
    }
    return results;
  }
}

function parseObject(text: string): ScannedOp {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${(error as Error).message}` };
  }
}

/**
 * Best-effort value of a string field inside an operation that is still being
 * written, so the open slide can be drawn as it grows. Stops at the last
 * complete character; a half-written escape is left out.
 */
export function partialStringField(pending: string, key: string): string | null {
  // ponytail: first textual match of the key, so a field whose own text quotes
  // `"html":"` before the real one would win. Use a real incremental parser if
  // operations ever carry free text ahead of the field being previewed.
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(pending);
  if (!match) return null;
  let out = "";
  for (let i = match.index + match[0].length; i < pending.length; i += 1) {
    const char = pending[i];
    if (char === '"') return out;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = pending[i + 1];
    if (next === undefined) return out;
    if (next === "u") {
      const hex = pending.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += SIMPLE_ESCAPES[next] ?? next;
    i += 1;
  }
  return out;
}

const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
