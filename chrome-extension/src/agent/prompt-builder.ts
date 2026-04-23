// Prompt builder for Sidebar and Agent modes.
// Runs in the sidepanel context.

interface PageState {
  url: string;
  title: string;
  visibleText: string;
  elements: ElementInfo[];
  screenshot?: string;
}

interface ElementInfo {
  index: number;
  tag: string;
  role: string;
  text: string;
  selector: string;
  type: string;
  href: string;
  placeholder: string;
  value: string;
}

interface AgentAction {
  action: "click" | "type" | "scroll" | "navigate" | "wait" | "done";
  selector?: string;
  text?: string;
  url?: string;
  direction?: "up" | "down";
  ms?: number;
  result?: string;
  reason?: string;
}

interface StepRecord {
  step: number;
  action: AgentAction;
  result: string;
}

function buildSidebarPrompt(pageState: PageState, userQuestion: string): string {
  const lines: string[] = [];

  lines.push(`Page URL: ${pageState.url}`);
  lines.push(`Page Title: ${pageState.title}`);
  lines.push("");
  lines.push("Page Content:");
  lines.push(pageState.visibleText.slice(0, 15000));
  lines.push("");
  lines.push(`User Question: ${userQuestion}`);

  return lines.join("\n");
}

function buildAgentPrompt(task: string, pageState: PageState, history: StepRecord[]): string {
  const lines: string[] = [];

  lines.push("You are a browser automation agent. You see a web page and execute actions on it.");
  lines.push("Respond with EXACTLY ONE JSON action object. No other text, explanations, or markdown.");
  lines.push("");
  lines.push("Available actions:");
  lines.push('{"action":"click","selector":"CSS_SELECTOR","reason":"why"}');
  lines.push('{"action":"type","selector":"CSS_SELECTOR","text":"TEXT_TO_TYPE","reason":"why"}');
  lines.push('{"action":"scroll","direction":"down","reason":"why"}');
  lines.push('{"action":"navigate","url":"https://...","reason":"why"}');
  lines.push('{"action":"wait","ms":2000,"reason":"why"}');
  lines.push('{"action":"done","result":"FINAL_ANSWER","reason":"task completed"}');
  lines.push("");
  lines.push("--- CURRENT PAGE ---");
  lines.push(`URL: ${pageState.url}`);
  lines.push(`Title: ${pageState.title}`);
  lines.push("");

  // Interactive elements
  if (pageState.elements.length > 0) {
    lines.push("Interactive elements:");
    for (const el of pageState.elements) {
      const parts = [`[${el.index}]`, el.tag];
      if (el.role) parts.push(`role="${el.role}"`);
      if (el.text) parts.push(`"${el.text}"`);
      if (el.type) parts.push(`type=${el.type}`);
      if (el.href) parts.push(`href=${el.href.slice(0, 80)}`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.value) parts.push(`value="${el.value.slice(0, 40)}"`);
      parts.push(`→ ${el.selector}`);
      lines.push(parts.join(" "));
    }
    lines.push("");
  }

  // Visible text (trimmed for agent)
  lines.push("Visible text (truncated):");
  lines.push(pageState.visibleText.slice(0, 10000));
  lines.push("");

  // Task
  lines.push(`--- TASK ---`);
  lines.push(task);
  lines.push("");

  // History
  if (history.length > 0) {
    lines.push("--- PREVIOUS STEPS ---");
    // Keep last 5 steps to avoid exceeding context
    const recent = history.slice(-5);
    for (const step of recent) {
      lines.push(`Step ${step.step + 1}: ${JSON.stringify(step.action)} → ${step.result}`);
    }
    lines.push("");
  }

  lines.push("--- YOUR ACTION (JSON only) ---");

  return lines.join("\n");
}

function parseAction(responseText: string): AgentAction {
  // Try to extract JSON from the response
  const jsonMatch = responseText.match(/\{[^{}]*"action"\s*:\s*"[^"]+[^{}]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as AgentAction;
      if (parsed.action) return parsed;
    } catch {
      // Fall through
    }
  }

  // Try code block
  const codeBlockMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]) as AgentAction;
      if (parsed.action) return parsed;
    } catch {
      // Fall through
    }
  }

  // Fallback: treat the entire response as a "done" result
  return { action: "done", result: responseText.trim(), reason: "No parseable action found" };
}
