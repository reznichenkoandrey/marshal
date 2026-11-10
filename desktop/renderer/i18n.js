// UI language of a renderer window (#330). Loaded in <head> right after
// locales.js, which the build emits from desktop/i18n/{en,uk}.ts. The preload
// hands over the language main resolved; main pushes a change, so an open
// window switches without a reload.
//
// Markup: data-i18n (text), data-i18n-title, data-i18n-placeholder,
// data-i18n-aria-label. Code that builds text itself reads MarshalI18n.t and
// re-renders on the "marshal:language" window event.
(() => {
  const catalogs = window.MarshalLocales ?? {};
  const ATTRIBUTES = [
    ["i18nTitle", "title", "[data-i18n-title]"],
    ["i18nPlaceholder", "placeholder", "[data-i18n-placeholder]"],
    ["i18nAriaLabel", "aria-label", "[data-i18n-aria-label]"]
  ];
  const valid = (value) => value === "uk" || value === "en";
  let lang = valid(window.marshalI18n?.language) ? window.marshalI18n.language : "en";

  function t(key, params) {
    const template = catalogs[lang]?.[key] ?? catalogs.en?.[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match));
  }

  function apply(root = document) {
    document.documentElement.lang = lang;
    if (!Object.keys(catalogs).length) return;
    for (const node of root.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
    for (const [data, attribute, selector] of ATTRIBUTES) {
      for (const node of root.querySelectorAll(selector)) node.setAttribute(attribute, t(node.dataset[data]));
    }
  }

  function set(next) {
    if (!valid(next) || next === lang) return;
    lang = next;
    apply();
    window.dispatchEvent(new CustomEvent("marshal:language", { detail: lang }));
  }

  window.marshalI18n?.onChange?.(set);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => apply(), { once: true });
  else apply();

  window.MarshalI18n = { t, apply, set, language: () => lang };
})();
