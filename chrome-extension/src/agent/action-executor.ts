// Content script injected via chrome.scripting.executeScript into the active tab.
// Executes a single agent action (click, type, scroll, navigate, wait).

(() => {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "marshal-execute-action") return;

    void executeAction(message.action)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error: unknown) => {
        const text = error instanceof Error ? error.message : "Action execution failed.";
        sendResponse({ ok: false, result: text });
      });

    return true; // Keep message channel open for async response
  });

  interface AgentAction {
    action: string;
    selector?: string;
    text?: string;
    url?: string;
    direction?: string;
    ms?: number;
    result?: string;
  }

  async function executeAction(action: AgentAction): Promise<string> {
    switch (action.action) {
      case "click":
        return doClick(action.selector ?? "");
      case "type":
        return doType(action.selector ?? "", action.text ?? "");
      case "scroll":
        return doScroll(action.direction ?? "down");
      case "navigate":
        return doNavigate(action.url ?? "");
      case "wait":
        return doWait(action.ms ?? 1000);
      case "done":
        return action.result ?? "Done.";
      default:
        return `Unknown action: ${action.action}`;
    }
  }

  function doClick(selector: string): string {
    const element = resolveElement(selector);
    if (!element) {
      // Fallback: if selector looks like it targets a link, try finding by href or text
      const linkEl = findLinkByTextOrHref(selector);
      if (linkEl) {
        linkEl.click();
        return `Clicked link: ${getElementLabel(linkEl).slice(0, 60)}`;
      }
      return `Element not found: ${selector}`;
    }

    // Scroll into view first
    element.scrollIntoView({ block: "center", behavior: "smooth" });

    // If it's a link, use native click (most reliable for navigation)
    if (element instanceof HTMLAnchorElement && element.href) {
      element.click();
      return `Clicked link: ${getElementLabel(element).slice(0, 60)} (${element.href})`;
    }

    // Dispatch full click sequence
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true }));
    }
    element.click();

    const text = getElementLabel(element).slice(0, 60);
    return `Clicked: ${text || selector}`;
  }

  function doType(selector: string, text: string): string {
    const element = resolveElement(selector);
    if (!element) return `Element not found: ${selector}`;

    element.focus();

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      // Native setter bypass for React/Vue/Svelte
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (nativeSetter) {
        nativeSetter.call(element, text);
      } else {
        element.value = text;
      }
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // Contenteditable
      element.focus();
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, text);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }

    return `Typed "${text.slice(0, 40)}" into ${selector}`;
  }

  function doScroll(direction: string): string {
    const amount = direction === "up" ? -600 : 600;
    window.scrollBy({ top: amount, behavior: "smooth" });
    return `Scrolled ${direction}`;
  }

  function doNavigate(url: string): string {
    window.location.href = url;
    return `Navigating to ${url}`;
  }

  async function doWait(ms: number): Promise<string> {
    const capped = Math.min(ms, 5000);
    await new Promise((resolve) => setTimeout(resolve, capped));
    return `Waited ${capped}ms`;
  }

  function findLinkByTextOrHref(selector: string): HTMLAnchorElement | null {
    // Extract text hints from the selector (e.g. "Trend Data" from complex CSS)
    const links = document.querySelectorAll("a[href]");
    for (const link of links) {
      const a = link as HTMLAnchorElement;
      if (!isVisible(a)) continue;
      const label = getElementLabel(a).toLowerCase();
      const selectorLower = selector.toLowerCase();
      // Match if selector contains recognizable text
      if (label.includes("trend data") && selectorLower.includes("trend")) return a;
      if (label.includes("dashboard") && selectorLower.includes("dashboard")) return a;
    }
    return null;
  }

  function resolveElement(selector: string): HTMLElement | null {
    try {
      const el = document.querySelector(selector);
      if (el && isVisible(el as HTMLElement)) return el as HTMLElement;
    } catch {
      // Invalid selector — try fallback
    }

    // Fallback: search by text content
    if (selector.startsWith('"') && selector.endsWith('"')) {
      const searchText = selector.slice(1, -1).toLowerCase();
      const candidates = document.querySelectorAll("a, button, [role='button'], input, [onclick]");
      for (const el of candidates) {
        const label = getElementLabel(el as HTMLElement).toLowerCase();
        if (label.includes(searchText) && isVisible(el as HTMLElement)) {
          return el as HTMLElement;
        }
      }
    }

    return null;
  }

  function getElementLabel(el: HTMLElement): string {
    return [
      el.getAttribute("aria-label") || "",
      el.getAttribute("title") || "",
      el.textContent || ""
    ].join(" ").replace(/\s+/g, " ").trim();
  }

  function isVisible(el: HTMLElement): boolean {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
})();
