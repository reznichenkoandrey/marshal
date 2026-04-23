// Content script injected programmatically via chrome.scripting.executeScript.
// Creates an element picker overlay on the active tab.

(() => {
  // Prevent double-injection
  if ((window as unknown as Record<string, boolean>).__marshalPickerActive) return;
  (window as unknown as Record<string, boolean>).__marshalPickerActive = true;

  let outputType: "text" | "html" = "text";
  let active = false;

  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed;
    pointer-events: none;
    background: rgba(14, 116, 255, 0.15);
    border: 2px solid #0e74ff;
    border-radius: 3px;
    z-index: 2147483646;
    transition: all 0.08s ease;
    display: none;
  `;

  const tooltip = document.createElement("div");
  tooltip.style.cssText = `
    position: fixed;
    top: 8px;
    left: 50%;
    transform: translateX(-50%);
    padding: 8px 16px;
    background: rgba(0, 0, 0, 0.85);
    color: #fff;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    border-radius: 8px;
    z-index: 2147483647;
    pointer-events: none;
    white-space: nowrap;
  `;
  tooltip.textContent = "Click an element to capture \u2022 Esc to cancel";

  let hoveredElement: Element | null = null;

  function activate(type: "text" | "html"): void {
    outputType = type;
    active = true;
    document.documentElement.style.cursor = "crosshair";
    document.body.appendChild(overlay);
    document.body.appendChild(tooltip);
    overlay.style.display = "block";

    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
  }

  function deactivate(): void {
    active = false;
    (window as unknown as Record<string, boolean>).__marshalPickerActive = false;
    document.documentElement.style.cursor = "";
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    overlay.remove();
    tooltip.remove();
    hoveredElement = null;
  }

  function onMouseMove(event: MouseEvent): void {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || target === overlay || target === tooltip) return;

    hoveredElement = target;
    const rect = target.getBoundingClientRect();
    overlay.style.top = `${rect.top}px`;
    overlay.style.left = `${rect.left}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
  }

  function onClick(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (!hoveredElement) {
      deactivate();
      sendCancelled();
      return;
    }

    const el = hoveredElement as HTMLElement;
    let payload: string;

    if (outputType === "html") {
      payload = el.outerHTML.slice(0, 120000);
    } else {
      payload = (el.innerText || el.textContent || "").trim().slice(0, 50000);
    }

    deactivate();
    sendResult(payload);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      deactivate();
      sendCancelled();
    }
  }

  function sendResult(payload: string): void {
    chrome.runtime.sendMessage({
      type: "marshal-picker-result",
      payload
    });
  }

  function sendCancelled(): void {
    chrome.runtime.sendMessage({
      type: "marshal-picker-cancelled"
    });
  }

  // Listen for activation message from sidepanel (via background relay)
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "marshal-start-picker" && !active) {
      activate(message.outputType ?? "text");
    }
    if (message?.type === "marshal-cancel-picker" && active) {
      deactivate();
    }
  });
})();
