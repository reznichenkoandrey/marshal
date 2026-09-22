// desktop/captions/sse.ts
//
// Incremental parser for the server-sent-events stream an OpenAI-compatible
// `chat/completions` endpoint returns with `stream: true`. Bytes arrive in
// arbitrary chunks, so the parser keeps the unfinished line between calls
// and yields only the text deltas — which is all the overlay needs.

interface ChatCompletionChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

export class OpenAiSseParser {
  private buffer = "";
  private finished = false;

  /** True once `data: [DONE]` was seen. */
  get done(): boolean {
    return this.finished;
  }

  /** Feed a chunk of the response body; returns the text deltas it completed. */
  push(chunk: string): string[] {
    if (this.finished) return [];
    this.buffer += chunk;
    const deltas: string[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      const delta = this.parseLine(line);
      if (delta === null) continue;
      if (delta === DONE) {
        this.finished = true;
        return deltas;
      }
      deltas.push(delta);
    }
    return deltas;
  }

  private parseLine(line: string): string | null | typeof DONE {
    if (!line.startsWith("data:")) return null;
    const payload = line.slice("data:".length).trim();
    if (payload.length === 0) return null;
    if (payload === "[DONE]") return DONE;
    let parsed: ChatCompletionChunk;
    try {
      parsed = JSON.parse(payload) as ChatCompletionChunk;
    } catch {
      // A malformed event is the provider's problem, not a reason to drop
      // the whole stream. Skip it and keep reading.
      return null;
    }
    const content = parsed.choices?.[0]?.delta?.content;
    return typeof content === "string" && content.length > 0 ? content : null;
  }
}

const DONE = Symbol("sse-done");
