// Tiny dependency-free i18n: t(key, params) over flat per-language dictionaries
// (src/lib/i18n/en.js, ru.js). The active language is a signal — t() reads it,
// so every component that renders a t() string re-renders on a switch (no
// reload). Choice: saved preference (localStorage 'zai.lang') → browser
// language (ru* → ru, anything else → en).
//
// Plurals: a dictionary value may be an object of Intl.PluralRules categories
// ({ one, few, many, other }); t() picks the form by params.count. English
// needs one/other, Russian one/few/many (other = fractional numbers).
import { signal } from "@preact/signals";
import en, { NATIVE_NAME as EN_NAME } from "./i18n/en.js";
import ru, { NATIVE_NAME as RU_NAME } from "./i18n/ru.js";

export const LANG_KEY = "zai.lang";
const DICTS = { en, ru };
// Language selector entries — each language is shown under its own name.
export const LANGS = [
  { id: "en", label: EN_NAME },
  { id: "ru", label: RU_NAME },
];
const LOCALES = { en: "en-US", ru: "ru-RU" };

export function isLang(v) {
  return v === "en" || v === "ru";
}

// Pure detection (exported for tests): pinned > stored > browser language.
// Headless runs (Node: unit tests import src/lib directly) keep the historical
// ru default unless a pin/preference says otherwise — browsers always follow
// navigator.language.
export function detectLang({ pinned, stored, navLang, headless } = {}) {
  if (isLang(pinned)) return pinned;
  if (isLang(stored)) return stored;
  if (headless) return "ru";
  return /^ru\b/i.test(String(navLang ?? "")) ? "ru" : "en";
}

function readStored() {
  try {
    return globalThis.localStorage?.getItem?.(LANG_KEY) ?? null;
  } catch {
    return null;
  }
}

function initialLang() {
  return detectLang({
    // globalThis.__ZAI_LANG__: test harness pin (tests/components/helpers).
    pinned: globalThis.__ZAI_LANG__,
    stored: readStored(),
    navLang: globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language,
    headless: typeof process !== "undefined" && !!process.versions?.node,
  });
}

export const lang = signal(initialLang());

function syncDocument(id) {
  try {
    if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = id;
  } catch {}
}
syncDocument(lang.value);

export function setLang(id) {
  if (!isLang(id)) return;
  try {
    globalThis.localStorage?.setItem?.(LANG_KEY, id);
  } catch {}
  lang.value = id;
  syncDocument(id);
}

// BCP 47 locale of the active language — for Intl.* / toLocaleString.
export function locale() {
  return LOCALES[lang.value] ?? "en-US";
}

const pluralRules = {};
function pluralCategory(id, n) {
  const pr = (pluralRules[id] ??= new Intl.PluralRules(LOCALES[id] ?? "en-US"));
  return pr.select(Number(n) || 0);
}

function lookup(id, key) {
  return DICTS[id]?.[key];
}

export function t(key, params) {
  const id = lang.value;
  let v = lookup(id, key);
  if (v == null) v = lookup("en", key);
  if (v == null) return key;
  if (typeof v === "object") {
    const n = params?.count;
    v = v[pluralCategory(id, n)] ?? v.other ?? v.many ?? v.one ?? "";
  }
  if (typeof v === "function") return v(params ?? {});
  if (!params) return v;
  return v.replace(/\{(\w+)\}/g, (m, name) => (params[name] != null ? String(params[name]) : m));
}

// Has the key a translation in the language (tests / optional copy).
export function hasKey(key, id = lang.value) {
  return lookup(id, key) != null;
}

// Locale-aware number formatting (grouping, decimals).
export function fmtNumber(n, opts) {
  return Number(n).toLocaleString(locale(), opts);
}

export const DICTIONARIES = DICTS;
