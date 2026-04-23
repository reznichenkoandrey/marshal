// desktop/translator/layout-switcher.ts
//
// Punto-Switcher-style helper. When the user typed text on the wrong keyboard
// layout (e.g. "ghbdsn" on ENG when they meant "привіт" on UKR), pressing the
// dedicated hotkey selects → copies → transliterates → pastes the correct
// text. The mapping is US QWERTY ↔ Ukrainian-PC (ЙЦУКЕН), which is the
// standard layout shipped with macOS.
//
// Flow (on hotkey):
//   1. Snapshot the current clipboard (so we can restore it afterwards).
//   2. Simulate ⌘C so the user's current selection lands in the clipboard.
//      If nothing is selected, the clipboard stays as it was and we bail.
//   3. Detect direction from the first letter with a script: Cyrillic → UKR
//      was typed instead of ENG (convert to ENG); Latin → the opposite.
//   4. Apply the character mapping. If the result equals the input (e.g. all
//      digits / already correct layout) — bail, no user-visible effect.
//   5. Write transliterated text to the clipboard, simulate ⌘V.
//   6. After paste commits, restore the original clipboard so the user
//      doesn't lose what they had copied before.
//
// Requires macOS Accessibility permission (shared with voice dictation and
// translator hotkeys) so `osascript` can send key events via System Events.

import { clipboard, globalShortcut } from "electron";
import { EventEmitter } from "node:events";
import { exec } from "node:child_process";

export const DEFAULT_LAYOUT_SWITCH_HOTKEY = "CommandOrControl+Alt+L";
const COPY_COMMIT_DELAY_MS = 120;
const BEFORE_PASTE_DELAY_MS = 40;
const PASTE_COMMIT_DELAY_MS = 120;

// US QWERTY → Ukrainian-PC (ЙЦУКЕН), lowercase + shifted pairs. Digits and
// most punctuation share the same physical key in both layouts, so we only
// map characters that actually differ.
const ENG_TO_UKR_BASE: Record<string, string> = {
  q: "й", w: "ц", e: "у", r: "к", t: "е", y: "н", u: "г", i: "ш", o: "щ", p: "з",
  "[": "х", "]": "ї",
  a: "ф", s: "і", d: "в", f: "а", g: "п", h: "р", j: "о", k: "л", l: "д",
  ";": "ж", "'": "є",
  z: "я", x: "ч", c: "с", v: "м", b: "и", n: "т", m: "ь",
  ",": "б", ".": "ю", "/": ".",
  // Shifted row
  Q: "Й", W: "Ц", E: "У", R: "К", T: "Е", Y: "Н", U: "Г", I: "Ш", O: "Щ", P: "З",
  "{": "Х", "}": "Ї",
  A: "Ф", S: "І", D: "В", F: "А", G: "П", H: "Р", J: "О", K: "Л", L: "Д",
  ":": "Ж", '"': "Є",
  Z: "Я", X: "Ч", C: "С", V: "М", B: "И", N: "Т", M: "Ь",
  "<": "Б", ">": "Ю", "?": ","
};

const UKR_TO_ENG_BASE: Record<string, string> = Object.fromEntries(
  Object.entries(ENG_TO_UKR_BASE).map(([eng, ukr]) => [ukr, eng])
);

export type TransliterateDirection = "eng-to-ukr" | "ukr-to-eng" | "none";

export interface TransliterateResult {
  text: string;
  direction: TransliterateDirection;
}

/**
 * Convert a string typed on the wrong keyboard layout. Direction is picked
 * from the first letter: Cyrillic means "was typed in UKR by mistake, want
 * ENG", and vice versa. Text with no letters returns unchanged.
 */
export function transliterate(input: string): TransliterateResult {
  if (!input) return { text: input, direction: "none" };

  const direction = detectDirection(input);
  if (direction === "none") return { text: input, direction };

  const table = direction === "eng-to-ukr" ? ENG_TO_UKR_BASE : UKR_TO_ENG_BASE;
  let out = "";
  for (const ch of input) {
    out += table[ch] ?? ch;
  }
  return { text: out, direction };
}

function detectDirection(input: string): TransliterateDirection {
  for (const ch of input) {
    if (/[A-Za-z]/.test(ch)) return "eng-to-ukr";
    if (/[\u0400-\u04FF]/.test(ch)) return "ukr-to-eng";
  }
  return "none";
}

export interface LayoutSwitcherOptions {
  hotkey?: string;
}

export class LayoutSwitcher extends EventEmitter {
  private readonly debug = process.env.MARSHAL_LAYOUT_SWITCH_DEBUG === "1";
  private readonly hotkey: string;
  private registered = false;
  private swapping = false;

  constructor(options: LayoutSwitcherOptions = {}) {
    super();
    this.hotkey =
      options.hotkey ??
      process.env.MARSHAL_LAYOUT_SWITCH_HOTKEY ??
      DEFAULT_LAYOUT_SWITCH_HOTKEY;
  }

  start(): void {
    if (this.registered) return;
    const ok = globalShortcut.register(this.hotkey, () => {
      void this.swap();
    });
    this.registered = ok;
    if (this.debug) {
      console.log(`[LayoutSwitcher] register ${this.hotkey} → ${ok ? "ok" : "FAILED"}`);
    }
  }

  stop(): void {
    if (!this.registered) return;
    globalShortcut.unregister(this.hotkey);
    this.registered = false;
  }

  private async swap(): Promise<void> {
    // Ignore re-entrant invocations while a swap is already in flight —
    // guards against the user holding the shortcut or trigger-happy macros.
    if (this.swapping) return;
    this.swapping = true;

    const originalClipboard = clipboard.readText();
    let didPaste = false;

    try {
      await sendKeystroke("c");
      await sleep(COPY_COMMIT_DELAY_MS);
      const selected = clipboard.readText();

      if (!selected || selected === originalClipboard) {
        // Cmd+C was a no-op — nothing selected in the foreground app.
        if (this.debug) console.log("[LayoutSwitcher] no selection, bail");
        return;
      }

      const { text: converted, direction } = transliterate(selected);
      if (direction === "none" || converted === selected) {
        if (this.debug) console.log(`[LayoutSwitcher] no-op (${direction})`);
        return;
      }

      clipboard.writeText(converted);
      await sleep(BEFORE_PASTE_DELAY_MS);
      await sendKeystroke("v");
      didPaste = true;
      await sleep(PASTE_COMMIT_DELAY_MS);

      if (this.debug) {
        console.log(
          `[LayoutSwitcher] ${direction}: "${selected.slice(0, 30)}" → "${converted.slice(0, 30)}"`
        );
      }
      this.emit("swap", { direction, source: selected, converted });
    } catch (err) {
      console.error("[LayoutSwitcher] swap failed:", err);
    } finally {
      // Restore the original clipboard so the user doesn't lose pre-swap
      // content. Skip the restore when we never pasted anything — it would
      // overwrite an identical value and is just extra work.
      if (didPaste) {
        clipboard.writeText(originalClipboard);
      }
      this.swapping = false;
    }
  }
}

function sendKeystroke(letter: "c" | "v"): Promise<void> {
  return new Promise((resolve, reject) => {
    // 10 s timeout so the first-run macOS Automation prompt ("Electron wants
    // to control System Events") has time to be answered. After the user
    // clicks OK once, subsequent calls return in <50 ms.
    exec(
      `osascript -e 'tell application "System Events" to keystroke "${letter}" using command down'`,
      { timeout: 10_000 },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve();
          return;
        }
        const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
        const errText = stderr?.toString().toLowerCase() ?? "";
        if (killed || errText.includes("-1743") || errText.includes("not authorized")) {
          reject(new Error(
            "macOS blocked Cmd+" + letter.toUpperCase() + " simulation. " +
            "Enable it in System Settings → Privacy & Security → Automation → " +
            "Electron → System Events. If the tumblr is missing, run " +
            "`tccutil reset AppleEvents` in a terminal, restart Marshal, then " +
            "press ⌘⌥L again and click OK on the prompt."
          ));
          return;
        }
        reject(err);
      }
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
