// The app-wide UI language (#330): the `assistantLanguage` setting, `auto`
// meaning the first of macOS's preferred languages that Marshal speaks.

import { app, ipcMain, webContents } from "electron";

import { resolveAssistantLanguage } from "../assistant/strip.ts";
import { loadSettings } from "../settings-store.ts";
import { translate, type MessageKey, type MessageParams, type UiLanguage } from "./catalog.ts";

export const UI_LANGUAGE_CHANNEL = "marshal:ui-language";

export function uiLanguage(): UiLanguage {
  return resolveAssistantLanguage(loadSettings().assistantLanguage, app.getPreferredSystemLanguages());
}

export function t(key: MessageKey, params?: MessageParams): string {
  return translate(uiLanguage(), key, params);
}

let announced: UiLanguage | null = null;

/** Preloads ask once, synchronously, so a window paints in the right language. */
export function registerUiLanguageIpc(): void {
  announced = uiLanguage();
  ipcMain.on(UI_LANGUAGE_CHANNEL, (event) => {
    event.returnValue = uiLanguage();
  });
}

/** After a settings change: every open window switches without a reload. */
export function broadcastUiLanguage(): void {
  const lang = uiLanguage();
  if (lang === announced) return;
  announced = lang;
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) contents.send(UI_LANGUAGE_CHANNEL, lang);
  }
}
