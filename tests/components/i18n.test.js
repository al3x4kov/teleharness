// i18n (src/lib/i18n.js): language detection (pin > saved > navigator),
// persistence in localStorage 'zai.lang' + <html lang>, a live switch in
// Settings → Appearance re-renders labels without reload, plurals, and the
// en/ru dictionaries have exactly the same keys.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    SettingsView: "src/components/views/SettingsView.jsx",
    i18n: "src/lib/i18n.js#t",
    lang: "src/lib/i18n.js#lang",
    setLang: "src/lib/i18n.js#setLang",
    detectLang: "src/lib/i18n.js#detectLang",
    LANG_KEY: "src/lib/i18n.js#LANG_KEY",
    DICTIONARIES: "src/lib/i18n.js#DICTIONARIES",
    groupSessionsByDate: "src/lib/normalize.js#groupSessionsByDate",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.setLang("ru");
  localStorage.removeItem(ui.LANG_KEY);
  ui.store.me.value = null;
  installFetch();
});

test("detectLang: pin > saved preference > navigator.language (ru* → ru, else en)", () => {
  const d = ui.detectLang;
  assert.equal(d({ navLang: "ru-RU" }), "ru");
  assert.equal(d({ navLang: "ru" }), "ru");
  assert.equal(d({ navLang: "en-US" }), "en");
  assert.equal(d({ navLang: "de-DE" }), "en");
  assert.equal(d({ navLang: "" }), "en");
  assert.equal(d({ navLang: undefined }), "en");
  assert.equal(d({ stored: "en", navLang: "ru-RU" }), "en", "saved choice beats the browser");
  assert.equal(d({ stored: "ru", navLang: "en-US" }), "ru");
  assert.equal(d({ stored: "fr", navLang: "ru-RU" }), "ru", "junk in storage is ignored");
  assert.equal(d({ pinned: "en", stored: "ru", navLang: "ru" }), "en");
  assert.equal(d({ headless: true }), "ru", "Node (unit tests) keeps the legacy ru default");
  assert.equal(d({ headless: true, stored: "en" }), "en");
});

test("setLang: persists to localStorage 'zai.lang', sets <html lang>, ignores unknown ids", () => {
  ui.setLang("en");
  assert.equal(localStorage.getItem("zai.lang"), "en");
  assert.equal(document.documentElement.lang, "en");
  assert.equal(ui.lang.value, "en");
  ui.setLang("xx");
  assert.equal(ui.lang.value, "en");
  ui.setLang("ru");
  assert.equal(localStorage.getItem("zai.lang"), "ru");
  assert.equal(document.documentElement.lang, "ru");
});

test("t(): interpolation, plurals per language, fallback to the key", () => {
  ui.setLang("ru");
  assert.equal(ui.i18n("projects.chatCount", { count: 1 }), "1 чат");
  assert.equal(ui.i18n("projects.chatCount", { count: 3 }), "3 чата");
  assert.equal(ui.i18n("projects.chatCount", { count: 11 }), "11 чатов");
  assert.equal(ui.i18n("projects.chatCount", { count: 21 }), "21 чат");
  ui.setLang("en");
  assert.equal(ui.i18n("projects.chatCount", { count: 1 }), "1 chat");
  assert.equal(ui.i18n("projects.chatCount", { count: 3 }), "3 chats");
  assert.equal(ui.i18n("common.untitled"), "Untitled");
  assert.equal(ui.i18n("no.such.key"), "no.such.key");
});

test("date groups follow the language (Today / Сегодня)", () => {
  const now = Date.now();
  ui.setLang("en");
  assert.equal(ui.groupSessionsByDate([{ id: "a", time: { updated: now } }], now)[0].label, "Today");
  ui.setLang("ru");
  assert.equal(ui.groupSessionsByDate([{ id: "a", time: { updated: now } }], now)[0].label, "Сегодня");
});

test("Settings → Appearance: «English» switches the screen to English without reload, «Русский» back", async () => {
  ui.store.me.value = { id: "u", name: "u", role: "user" };
  location.hash = "#/settings/appearance";
  const { root } = t$.mount(ui.SettingsView, { section: "appearance" });
  await t$.flush();
  const group = $(root, ".is-lang");
  assert.ok(group, "language selector next to the theme control");
  assert.equal(group.getAttribute("aria-label"), "Язык");
  assert.deepEqual($$(group, ".seg-btn").map((b) => b.textContent), ["English", "Русский"]);
  assert.ok(byText(root, ".row-title", "Тема"));

  t$.click(byText(group, ".seg-btn", "English"));
  await t$.flush();
  assert.equal(ui.lang.value, "en");
  assert.equal(localStorage.getItem("zai.lang"), "en");
  assert.equal(document.documentElement.lang, "en");
  assert.ok(byText(root, ".row-title", "Theme"), "label re-rendered in English");
  assert.equal($(root, ".is-lang").getAttribute("aria-label"), "Language");
  assert.equal(byText(root, ".row-title", "Тема"), null);
  assert.equal($(root, '.is-lang .seg-btn[aria-checked="true"]').textContent, "English");
  assert.equal(/[А-Яа-яЁё]/.test(root.textContent.replace("Русский", "")), false, "no Russian left on the screen");

  t$.click(byText($(root, ".is-lang"), ".seg-btn", "Русский"));
  await t$.flush();
  assert.ok(byText(root, ".row-title", "Тема"));
});

test("dictionaries: every ru key exists in en and vice versa; plural shapes and placeholders match", () => {
  const { en, ru } = ui.DICTIONARIES;
  const enKeys = Object.keys(en);
  const ruKeys = Object.keys(ru);
  assert.deepEqual(ruKeys.filter((k) => !(k in en)), [], "ru keys missing in en");
  assert.deepEqual(enKeys.filter((k) => !(k in ru)), [], "en keys missing in ru");
  assert.ok(enKeys.length > 300);
  const holes = (v) => [...new Set(JSON.stringify(v).match(/\{\w+\}/g) ?? [])].sort();
  for (const k of enKeys) {
    // A plural entry may be a plain string in one language («Файлы: {count}»).
    if (typeof en[k] === "object") assert.ok(en[k].one != null && en[k].other != null, `${k}: en one/other`);
    if (typeof ru[k] === "object") assert.ok(ru[k].one != null && ru[k].few != null && ru[k].many != null, `${k}: ru one/few/many`);
    assert.deepEqual(holes(en[k]), holes(ru[k]), `${k}: same {placeholders}`);
    assert.equal(/[А-Яа-яЁё]/.test(JSON.stringify(en[k])), false, `${k}: en value has no Cyrillic`);
  }
});
