// Chat titles (BUG-13.14 / BUG-083, BUG-01.27 / BUG-018) - the pure half,
// shared by the server (lib/title.js) and importable by the client.
//
// The vault-cache plugin prepends its knowledge-base snapshot to the FIRST
// user text part: `[obsidian-cache]…<terminator>\n\n---\n\n<typed text>`.
// A title must describe the typed text, never the snapshot. splitInjected is
// the server twin of src/lib/normalize.js splitInjected (same regexes, same
// degenerate-shape rule) - keep them in sync.
//
// Pure, zero dependencies, node- and browser-importable.

const INJECT_RE = /^(\[obsidian-cache\][\s\S]*?)\r?\n---\r?\n[ \t]*/;
const INJECT_TERM_RE = /^(\[obsidian-cache\][\s\S]*?(?:\n|^)(?:Правила кэша:[^\n]*|…\(снапшот обрезан, полные данные в vault\)))\r?\n\r?\n---\r?\n\r?\n[ \t]*/;

export function splitInjected(text) {
  const s = String(text ?? "");
  const m = s.match(INJECT_TERM_RE) ?? s.match(INJECT_RE);
  if (!m) return { context: null, text: s };
  const clean = s.slice(m[0].length).replace(/^\s+|\s+$/g, "");
  if (!clean) return { context: null, text: s };
  return { context: m[1].trim(), text: clean };
}

// Harness directives ([SYSTEM DIRECTIVE: …], OMO tags) are machine text, not
// the user's question.
const DIRECTIVE_MARKER = "[SYSTEM DIRECTIVE:";
const OMO_TAG_RE = /\s*<!--\s*OMO_INTERNAL_[A-Z_]+\s*-->\s*/g;
// lib/attach.js fileRefText: an attachment reference glued into the prompt.
const FILE_REF_RE = /\[Пользователь приложил файл:[^\]]*\]/g;

// The words the user actually typed: snapshot, directives and attachment
// references removed, whitespace collapsed.
export function typedText(raw) {
  let s = splitInjected(raw).text;
  // Degenerate shape (snapshot without typed text): the user typed nothing.
  if (/^\s*\[obsidian-cache\]/i.test(s)) return "";
  const i = s.indexOf(DIRECTIVE_MARKER);
  if (i >= 0) s = s.slice(0, i);
  return s.replace(OMO_TAG_RE, " ").replace(FILE_REF_RE, " ").replace(/\s+/g, " ").trim();
}

// Upstream default «New session - 2026-11-03T08:00:00.000Z», opencode child
// sessions «Child session - …», or nothing at all.
const DEFAULT_TITLE_RE = /^(new|child) session\s*-\s*\d{4}-\d{2}-\d{2}T/i;
export function isDefaultTitle(title) {
  const s = String(title ?? "").trim();
  return !s || DEFAULT_TITLE_RE.test(s);
}

export const TITLE_MAX = 60;

// Cut at a word boundary, no dangling punctuation, ellipsis when cut.
export function clipTitle(text, max = TITLE_MAX) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.4 ? cut.slice(0, sp) : cut).replace(/[\s,.;:—–-]+$/, "") + "…";
}

const capitalize = (s) => (s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s);

// Fallback title: the first phrase of the typed question, cut at a word,
// capitalized. "" when there is nothing to title from.
export function heuristicTitle(raw, max = TITLE_MAX) {
  const s = typedText(raw);
  if (!s) return "";
  // First phrase: up to the first sentence end (kept for ?/!), when that
  // phrase is meaningful on its own.
  const m = s.match(/^(.+?[.!?…])(\s|$)/);
  let phrase = m && m[1].replace(/[.…]+$/, "").trim().length >= 8 ? m[1] : s;
  phrase = phrase.replace(/[.…]+$/, "").trim();
  return capitalize(clipTitle(phrase, max));
}

// What an LLM answered → a usable title, or "" (caller falls back). Takes the
// first non-empty line, strips quotes / «Заголовок:» prefixes / trailing dot.
export function cleanLlmTitle(out, max = TITLE_MAX) {
  const line = String(out ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line || /^[{[]/.test(line)) return ""; // machine output, not a title
  let s = line
    .replace(/^(заголовок|название|title)\s*[:：-]\s*/i, "")
    .replace(/^[#*_>\s]+/, "")
    .replace(/[*_]+$/, "")
    .trim();
  // «Title». / "Title". — the dot may sit outside or inside the quotes.
  for (let k = 0; k < 2; k++) s = s.replace(/\.+$/, "").trim().replace(/^["'«“„`]+|["'»”`]+$/g, "").trim();
  if (!s || s.length < 2) return "";
  return capitalize(clipTitle(s, max));
}

// BUG-01.27: is the upstream title a retelling of the snapshot rather than
// of the question? Only when the first message carried a snapshot: the title
// shares no meaningful word with the typed text and either shares words with
// the snapshot or names the snapshot itself (Obsidian / кэш / дайджест …).
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}._-]{2,}/gu;
const words = (s) => new Set(String(s ?? "").toLowerCase().match(WORD_RE) ?? []);
const SNAPSHOT_HINT_RE = /obsidian|vault|кэш|кеш|cache|дайджест|digest|снапшот|snapshot|заметк/i;

// metaContext: the snapshot stored apart from the text (FEAT-01.32,
// metadata.kbContext) — the typed text is then the whole raw text.
export function snapshotDerivedTitle(title, rawFirstText, metaContext = null) {
  const t = String(title ?? "").trim();
  if (!t || isDefaultTitle(t)) return false;
  const split = splitInjected(rawFirstText);
  const context = split.context ?? (typeof metaContext === "string" && metaContext.trim() ? metaContext : null);
  const text = split.text;
  if (!context) return false;
  if (/^\[obsidian-cache\]/i.test(t)) return true;
  const tw = words(t);
  const typed = words(typedText(text));
  for (const w of tw) if (typed.has(w)) return false;
  const snap = words(context);
  for (const w of tw) if (snap.has(w)) return true;
  return SNAPSHOT_HINT_RE.test(t);
}

// FEAT-01.32: the knowledge-base snapshot no longer rides inside the user's
// text: the vault-cache plugin (opencode) and the Claude runner keep it on
// the user text part as metadata.kbContext. null when the part has none.
export const KB_CONTEXT_KEY = "kbContext";
export function partKbContext(part) {
  const v = part?.metadata?.[KB_CONTEXT_KEY];
  return typeof v === "string" && v.trim() ? v : null;
}

// The snapshot attached to the first user message, or null.
export function firstUserContext(messages) {
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.info?.role !== "user") continue;
    for (const p of Array.isArray(m.parts) ? m.parts : []) {
      const c = partKbContext(p);
      if (c) return c;
    }
    return null;
  }
  return null;
}

// The raw first user text of a message list ([{info, parts}], oldest first):
// the text parts of the first user message, synthetic parts skipped.
export function firstUserText(messages) {
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.info?.role !== "user") continue;
    const parts = Array.isArray(m.parts) ? m.parts : [];
    const text = parts
      .filter((p) => p?.type === "text" && typeof p.text === "string" && !p.synthetic)
      .map((p) => p.text)
      .join("\n\n");
    if (text.trim()) return text;
  }
  return "";
}
