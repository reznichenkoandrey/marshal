// Look, palette and light/dark of the app (#283). Loaded in <head> of every
// themed window so the saved theme is on <html> before first paint. Settings in
// the assistant home (#317) change it through `set` / `setAppearance`; every
// other open window follows over the BroadcastChannel.
(() => {
  const LOOKS = ["lumen", "hud", "classic", "liquid", "signal", "soft"];
  const PALETTES = ["blue", "teal", "green", "amber"];
  const APPEARANCES = ["system", "light", "dark"];
  const KEYS = { look: "marshal-look", palette: "marshal-palette", appearance: "marshal-appearance" };
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

  function applyAppearance(value) {
    const root = document.documentElement;
    if (value === "light" || value === "dark") root.setAttribute("data-theme", value);
    else root.removeAttribute("data-theme");
  }

  function applyAll() {
    apply(current());
    applyAppearance(read(KEYS.appearance, APPEARANCES));
  }

  applyAll();
  window.addEventListener("storage", (e) => {
    if (Object.values(KEYS).includes(e.key)) applyAll();
  });
  window.addEventListener("focus", applyAll);
  channel?.addEventListener("message", (event) => {
    if (event.data?.look) apply(event.data);
    if (event.data?.appearance) applyAppearance(event.data.appearance);
  });

  function setAppearance(value) {
    const next = APPEARANCES.includes(value) ? value : APPEARANCES[0];
    try {
      localStorage.setItem(KEYS.appearance, next);
    } catch {
      // Storage unavailable: the choice still applies to this window.
    }
    applyAppearance(next);
    channel?.postMessage({ appearance: next });
  }

  window.MarshalTheme = {
    LOOKS,
    PALETTES,
    current,
    set,
    appearance: () => read(KEYS.appearance, APPEARANCES),
    setAppearance
  };
})();
