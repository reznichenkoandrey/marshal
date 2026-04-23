// Content script injected via chrome.scripting.executeScript into the active tab.
// Captures page state: visible text, interactive elements with CSS selectors.

(() => {
  const MAX_TEXT_LENGTH = 15000;
  const MAX_ELEMENTS = 80;

  const INTERACTIVE_SELECTORS = [
    "a[href]",
    "button",
    'input:not([type="hidden"])',
    "select",
    "textarea",
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="radio"]',
    "[onclick]",
    "[tabindex]"
  ].join(",");

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

  interface PageCaptureResult {
    url: string;
    title: string;
    visibleText: string;
    elements: ElementInfo[];
  }

  function capture(): PageCaptureResult {
    return {
      url: window.location.href,
      title: document.title,
      visibleText: getVisibleText(),
      elements: getInteractiveElements()
    };
  }

  function getVisibleText(): string {
    const body = document.body;
    if (!body) return "";

    // Use innerText for rendered text (respects visibility)
    let text = body.innerText || "";
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + "\n[...truncated]";
    }
    return text.replace(/\n{3,}/g, "\n\n").trim();
  }

  function getInteractiveElements(): ElementInfo[] {
    const elements: ElementInfo[] = [];
    const candidates = document.querySelectorAll(INTERACTIVE_SELECTORS);

    let index = 1;
    for (const el of candidates) {
      if (index > MAX_ELEMENTS) break;

      const htmlEl = el as HTMLElement;
      if (!isVisible(htmlEl)) continue;

      const text = getElementText(htmlEl);
      if (!text && htmlEl.tagName !== "INPUT" && htmlEl.tagName !== "TEXTAREA" && htmlEl.tagName !== "SELECT") continue;

      elements.push({
        index: index++,
        tag: htmlEl.tagName.toLowerCase(),
        role: htmlEl.getAttribute("role") || "",
        text: text.slice(0, 80),
        selector: buildSelector(htmlEl),
        type: htmlEl.getAttribute("type") || "",
        href: (htmlEl as HTMLAnchorElement).href || "",
        placeholder: htmlEl.getAttribute("placeholder") || "",
        value: (htmlEl as HTMLInputElement).value || ""
      });
    }

    return elements;
  }

  function getElementText(el: HTMLElement): string {
    return [
      el.getAttribute("aria-label") || "",
      el.getAttribute("title") || "",
      el.textContent || ""
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isVisible(el: HTMLElement): boolean {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function buildSelector(el: HTMLElement): string {
    // Try ID first
    if (el.id) return `#${CSS.escape(el.id)}`;

    // Try data-testid
    const testId = el.getAttribute("data-testid");
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;

    // Build a path: tag.class:nth-of-type
    const parts: string[] = [];
    let current: HTMLElement | null = el;
    let depth = 0;

    while (current && current !== document.body && depth < 4) {
      let part = current.tagName.toLowerCase();

      // Add meaningful class (first non-utility class)
      const classes = Array.from(current.classList)
        .filter((c) => c.length > 2 && c.length < 30 && !/^(js-|_|ng-)/.test(c))
        .slice(0, 2);
      if (classes.length > 0) {
        part += "." + classes.map(CSS.escape).join(".");
      }

      // Add nth-of-type if siblings share the same tag
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((s) => s.tagName === current!.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }

      parts.unshift(part);
      current = current.parentElement;
      depth++;
    }

    return parts.join(" > ");
  }

  // Send result back via chrome.runtime.sendMessage
  const result = capture();
  chrome.runtime.sendMessage({ type: "marshal-page-capture-result", payload: result });
})();
