// desktop/captions/summary-prompt.ts
//
// What the summarizer is asked, and how its answer is turned into overlay
// HTML. Both halves are pure so the prompt shape and the markdown subset can
// be pinned by tests — the overlay renders with innerHTML, so the renderer
// here is also the escaping boundary.
//
// The summarizer is a scribe (V3 spec, #211): it restates what the speakers
// said. There is deliberately one prompt and no mode that answers questions
// or speaks as the user — those were removed, not hidden behind a flag.

/** The V3 spec's system prompt, verbatim — do not "improve" it. */
export const SUMMARY_SYSTEM_PROMPT =
  "Act as an expert real-time business scribe. Your sole task is to analyze the incoming live transcript " +
  "text. Summarize the speaker's core concepts, tech decisions, or action items into exactly 2-3 concise " +
  "bullet points. Use bold text formatting ONLY for primary architectural concepts, numbers, or technical " +
  "metrics. Speak in a professional, direct tone. Avoid conversational filler or introductory statements.";

/**
 * Framing for the user's reference files: agendas, project logs, glossaries.
 * They exist to get names and terms right, so the header says exactly that —
 * and that the bullets never go beyond what was actually said.
 */
export const REFERENCE_CONTEXT_HEADER =
  "Meeting background supplied by the user — agendas, project logs, glossaries. Use it only to spell " +
  "names and technical terms correctly and to recognise what is being discussed. Summarize only what " +
  "the speakers actually said; never add facts from this background:";

export interface SummaryInput {
  transcript: string;
  ocrContext: string;
  /** Language name/code the summary should be written in; empty = follow the transcript. */
  outputLanguage: string;
  /** Concatenated reference files (context-store.ts); empty = none. */
  referenceContext?: string;
}

export interface SummaryMessages {
  /** Full system prompt: instructions plus, when present, the reference block. */
  system: string;
  /** Instructions alone — what the Anthropic path sends as its first system block. */
  systemInstructions: string;
  /** The reference block alone, or empty; a stable prefix worth caching. */
  referenceContext: string;
  user: string;
}

/**
 * The transcript goes last so the model's attention lands on what was just
 * said; the OCR block is labelled as screen content so it is treated as
 * context, not as speech.
 */
export function buildSummaryMessages(input: SummaryInput): SummaryMessages {
  const parts: string[] = [];
  const ocr = input.ocrContext.trim();
  if (ocr.length > 0) {
    parts.push("Screen context (OCR of a region the user selected, may be partial):\n" + ocr);
  }
  parts.push("Live transcript (oldest first, most recent last):\n" + input.transcript.trim());
  const language = input.outputLanguage.trim();
  parts.push(
    language.length > 0
      ? `Write the bullet points in ${language}.`
      : "Write the bullet points in the same language as the transcript."
  );
  const reference = (input.referenceContext ?? "").trim();
  const systemInstructions = SUMMARY_SYSTEM_PROMPT;
  const referenceContext = reference.length > 0 ? `${REFERENCE_CONTEXT_HEADER}\n\n${reference}` : "";
  const system = referenceContext.length > 0 ? `${systemInstructions}\n\n${referenceContext}` : systemInstructions;
  return { system, systemInstructions, referenceContext, user: parts.join("\n\n") };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineMarkdown(escaped: string): string {
  // Only the constructs the system prompt allows: bold and inline code.
  // Anything else stays literal, which is safer than a full markdown parser
  // on text that was produced by a model and rendered with innerHTML.
  return escaped
    .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/`([^`]+)`/gu, "<code>$1</code>");
}

/**
 * Markdown subset → HTML for the overlay. Bullets become a list, other lines
 * become paragraphs. Works on partial (still streaming) text: an unfinished
 * `**bold` stays as literal asterisks until its closing pair arrives.
 */
export function renderSummaryHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const html: string[] = [];
  let listOpen = false;
  let codeLines: string[] | null = null;
  const closeList = (): void => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };

  for (const rawLine of lines) {
    // Fenced code: a summary may quote a query or a config line that was
    // discussed. Everything between the fences is verbatim (escaped), and an
    // unclosed fence while streaming still renders as code rather than as a
    // stray paragraph.
    if (codeLines !== null) {
      if (/^\s*```/u.test(rawLine)) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = null;
      } else {
        codeLines.push(rawLine);
      }
      continue;
    }
    if (/^\s*```/u.test(rawLine)) {
      closeList();
      codeLines = [];
      continue;
    }
    const line = rawLine.trim();
    if (line.length === 0) {
      closeList();
      continue;
    }
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/u);
    if (bullet) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${inlineMarkdown(escapeHtml(bullet[1]))}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inlineMarkdown(escapeHtml(line))}</p>`);
  }
  closeList();
  if (codeLines !== null) html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  return html.join("");
}
