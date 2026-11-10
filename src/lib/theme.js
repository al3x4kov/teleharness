// Theme persistence: data-theme on <html> + localStorage 'zai.theme'.
// "system" clears the attribute so the CSS media query follows the OS.
// Applied at app boot (main.jsx) — NOT only when Settings mounts: a reloaded
// tab (iOS discards them aggressively) used to boot light regardless of the
// stored dark choice (bug 2026-10-31: «выбираешь тёмную — переходишь в Чаты —
// сбрасывается», actually any fresh document load).
export function storedTheme() {
  try {
    const v = globalThis.localStorage?.getItem?.("zai.theme");
    return v === "dark" || v === "light" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(id) {
  const el = document.documentElement;
  if (id === "dark" || id === "light") el.dataset.theme = id;
  else delete el.dataset.theme;
  try {
    if (id === "system") localStorage.removeItem("zai.theme");
    else localStorage.setItem("zai.theme", id);
  } catch {}
  // Browser chrome (mobile address bar) follows the resolved theme.
  const light = id === "light" || (id !== "dark" && matchMedia("(prefers-color-scheme: light)").matches);
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = light ? "#f8f8f6" : "#262624";
}

export function applyStoredTheme() {
  applyTheme(storedTheme());
}
