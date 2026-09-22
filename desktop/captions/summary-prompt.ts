// desktop/captions/summary-prompt.ts
//
// What the summarizer is asked, and how its answer is turned into overlay
// HTML. Both halves are pure so the prompt shape and the markdown subset can
// be pinned by tests — the overlay renders with innerHTML, so the renderer
// here is also the escaping boundary.

export const SUMMARY_SYSTEM_PROMPT =
  "Act as an accessibility summarizer. Condense the incoming text transcripts and context into " +
  "highly concise, bulleted summaries. Maximum 2-3 short bullet points. Use bold formatting for " +
  "technical keywords and formulas only. Avoid conversational filler.";

export interface SummaryInput {
  transcript: string;
  ocrContext: string;
  /** Language name/code the summary should be written in; empty = follow the transcript. */
  outputLanguage: string;
}

export interface SummaryMessages {
  system: string;
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
    parts.push("Screen context (OCR of the user's workspace, may be partial):\n" + ocr);
  }
  parts.push("Live transcript (oldest first, most recent last):\n" + input.transcript.trim());
  const language = input.outputLanguage.trim();
  parts.push(
    language.length > 0
      ? `Write the bullet points in ${language}.`
      : "Write the bullet points in the same language as the transcript."
  );
  return { system: SUMMARY_SYSTEM_PROMPT, user: parts.join("\n\n") };
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
  const closeList = (): void => {
    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }
  };

  for (const rawLine of lines) {
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
  return html.join("");
}
