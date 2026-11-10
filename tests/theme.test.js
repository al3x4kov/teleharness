// Unit tests for src/lib/theme.js with plain global stubs (no jsdom):
// storedTheme reads globalThis.localStorage, applyTheme touches
// document.documentElement.dataset + localStorage + the theme-color meta
// (resolved through matchMedia for "system"). Each test installs its
// own stubs and restores the globals afterwards (store.test.js pattern).
// Run: node --test tests/theme.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStoredTheme, applyTheme, storedTheme } from "../src/lib/theme.js";

const THEME_COLOR_SEL = 'meta[name="theme-color"]';

function snapshotGlobals() {
  return { localStorage: globalThis.localStorage, document: globalThis.document, matchMedia: globalThis.matchMedia };
}

function restoreGlobals(prev) {
  for (const [key, value] of Object.entries(prev)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}

function installEnv(initial = {}, systemLight = false) {
  const store = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  let meta = null;
  globalThis.document = {
    documentElement: { dataset: {} },
    head: { appendChild: (el) => { meta = el; } },
    querySelector: (sel) => (sel === THEME_COLOR_SEL ? meta : null),
    createElement: () => ({}),
  };
  globalThis.matchMedia = (q) => ({
    matches: q.includes("(prefers-color-scheme: light)") ? systemLight : !systemLight,
  });
  return store;
}

test("storedTheme: dark and light pass through, junk or absent -> system", () => {
  const prev = snapshotGlobals();
  try {
    installEnv({ "zai.theme": "dark" });
    assert.equal(storedTheme(), "dark");
    installEnv({ "zai.theme": "light" });
    assert.equal(storedTheme(), "light");
    installEnv({ "zai.theme": "blue" });
    assert.equal(storedTheme(), "system", "unknown stored value must fall back");
    installEnv({});
    assert.equal(storedTheme(), "system", "no stored value means system");
  } finally {
    restoreGlobals(prev);
  }
});

test("storedTheme: missing or throwing localStorage degrades to system", () => {
  const prev = snapshotGlobals();
  try {
    delete globalThis.localStorage;
    assert.equal(storedTheme(), "system");
    globalThis.localStorage = { getItem: () => { throw new Error("denied"); } };
    assert.equal(storedTheme(), "system");
  } finally {
    restoreGlobals(prev);
  }
});

test("applyTheme('dark'/'light') sets data-theme and persists the choice", () => {
  const prev = snapshotGlobals();
  try {
    const store = installEnv();
    applyTheme("dark");
    assert.equal(globalThis.document.documentElement.dataset.theme, "dark");
    assert.equal(store.get("zai.theme"), "dark");
    assert.equal(globalThis.document.querySelector(THEME_COLOR_SEL).content, "#262624");
    applyTheme("light");
    assert.equal(globalThis.document.documentElement.dataset.theme, "light");
    assert.equal(store.get("zai.theme"), "light");
    assert.equal(globalThis.document.querySelector(THEME_COLOR_SEL).content, "#f8f8f6");
  } finally {
    restoreGlobals(prev);
  }
});

test("applyTheme('system') clears both the attribute and the stored key", () => {
  const prev = snapshotGlobals();
  try {
    const store = installEnv({ "zai.theme": "dark" }, true);
    applyTheme("system");
    assert.equal("theme" in globalThis.document.documentElement.dataset, false, "system must clear data-theme");
    assert.equal(store.has("zai.theme"), false);
    assert.equal(globalThis.document.querySelector(THEME_COLOR_SEL).content, "#f8f8f6", "system resolves against the OS preference at apply time");
  } finally {
    restoreGlobals(prev);
  }
});

test("applyTheme with an unknown id clears data-theme; the junk write self-heals on read", () => {
  const prev = snapshotGlobals();
  try {
    const store = installEnv();
    applyTheme("blue");
    assert.equal("theme" in globalThis.document.documentElement.dataset, false, "unknown id must not set a theme attribute");
    // quirk pinned as-is: the raw id is still written, but storedTheme() ignores it
    assert.equal(store.get("zai.theme"), "blue");
    assert.equal(storedTheme(), "system");
  } finally {
    restoreGlobals(prev);
  }
});

test("applyStoredTheme: boot applies the persisted choice, junk falls back to system", () => {
  const prev = snapshotGlobals();
  try {
    installEnv({ "zai.theme": "dark" });
    applyStoredTheme();
    assert.equal(globalThis.document.documentElement.dataset.theme, "dark");

    const store = installEnv({ "zai.theme": "junk" });
    applyStoredTheme();
    assert.equal("theme" in globalThis.document.documentElement.dataset, false, "junk stored value boots as system");
    assert.equal(store.has("zai.theme"), false, "the system fallback also clears the junk key");
  } finally {
    restoreGlobals(prev);
  }
});
