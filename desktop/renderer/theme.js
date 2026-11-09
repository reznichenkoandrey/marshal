// Look + palette of the app (#283). Loaded in <head> of every themed window so
// the saved look is on <html> before first paint. Light/dark stays with the
// existing "marshal-appearance" key; this file owns only the look axis.
(() => {
  const LOOKS = ["hud", "classic", "liquid", "signal", "soft"];
  const PALETTES = ["blue", "teal", "green", "amber"];
  const KEYS = { look: "marshal-look", palette: "marshal-palette" };
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("marshal-appearance") : null;

  function read(key, allowed) {
    try {
      const raw = localStorage.getItem(key);
      return allowed.includes(raw) ? raw : allowed[0];
    } catch {
      return allowed[0];
    }
  }

  function current() {
    return { look: read(KEYS.look, LOOKS), palette: read(KEYS.palette, PALETTES) };
  }

  function apply({ look, palette }) {
    const root = document.documentElement;
    root.setAttribute("data-look", LOOKS.includes(look) ? look : LOOKS[0]);
    root.setAttribute("data-palette", PALETTES.includes(palette) ? palette : PALETTES[0]);
  }

  function set(next) {
    const value = { ...current(), ...next };
    try {
      localStorage.setItem(KEYS.look, value.look);
      localStorage.setItem(KEYS.palette, value.palette);
    } catch {
      // Storage unavailable: the look still applies to this window.
    }
    apply(value);
    channel?.postMessage({ look: value.look, palette: value.palette });
    return value;
  }

  apply(current());
  window.addEventListener("storage", (e) => {
    if (e.key === KEYS.look || e.key === KEYS.palette) apply(current());
  });
  window.addEventListener("focus", () => apply(current()));
  channel?.addEventListener("message", (event) => {
    if (event.data?.look) apply(event.data);
  });

  window.MarshalTheme = { LOOKS, PALETTES, current, set };
})();
