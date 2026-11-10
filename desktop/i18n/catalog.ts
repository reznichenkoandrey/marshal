// The UI string catalogs (#330). Pure: main reads them through ui-language.ts,
// and the build emits them as a classic script for the renderer windows.

import { en, type MessageKey } from "./en.ts";
import { uk } from "./uk.ts";

export type UiLanguage = "uk" | "en";
export type { MessageKey };
export type MessageParams = Record<string, string | number>;

export const CATALOGS: Record<UiLanguage, Record<MessageKey, string>> = { en, uk };

/** `{name}` placeholders are filled from `params`; an unknown one stays as written. */
export function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => (name in params ? String(params[name]) : match));
}

export function translate(lang: UiLanguage, key: MessageKey, params?: MessageParams): string {
  return formatMessage(CATALOGS[lang][key] ?? en[key], params);
}
