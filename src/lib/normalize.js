// Pure data helpers for the zai chat engine: no fetch, no signals, no DOM.
// Also the single ru number formatter (fmtNum/fmtBytes/fmtDecimal), turn
// grouping for the chat feed and file-kind helpers for the FileViewer.
// Every function returns new values; inputs are never mutated. Tolerant of
// unknown/future field shapes — never throws on odd payloads.
// Fixture-verified deviation: opencode capabilities.input is an object
// ({text,audio,image,video,pdf:bool}), not a string array; both are supported.

// The vault-cache plugin (C:\Users\USER\.config\opencode\vault-cache.ts)
// prepends its knowledge-base snapshot to the FIRST user text part of a
// session, in the exact shape `<snapshot>\n\n---\n\n<real user text>` where
// the snapshot starts with the literal marker `[obsidian-cache]`. The model
// needs it as context; the human typed only what follows the `---` line.
// splitInjected separates the two so the UI can show just the user's words
// (with the snapshot reachable behind a collapsed chip).
import { lang, t } from "./i18n.js";

const INJECT_RE = /^(\[obsidian-cache\][\s\S]*?)\r?\n---\r?\n[ \t]*/;
// The snapshot itself may contain `---` lines (it quotes the tail of the last
// session digest, whose entries are separated by `---`). The lazy INJECT_RE
// then cut INSIDE the snapshot and the rest of it leaked into the user's
// bubble (dogfood 2026-11-02, BUG-010). The plugin always ends the snapshot
// with one of two terminators — the «Правила кэша: …» line or the truncation
// marker — and puts the separator right after it, so anchor on that first.
const INJECT_TERM_RE = /^(\[obsidian-cache\][\s\S]*?(?:\n|^)(?:Правила кэша:[^\n]*|…\(снапшот обрезан, полные данные в vault\)))\r?\n\r?\n---\r?\n\r?\n[ \t]*/;

// Orchestration directives (harness continuation payloads) ride inside or as
// whole user messages. Live example 2026-10-31: «продолжай» + [SYSTEM DIRECTIVE:
// OH-MY-OPENCODE …] rendered as one right-aligned user bubble — machine text
// reading as the human's words. splitDirective separates them for display.
const DIRECTIVE_MARKER = "[SYSTEM DIRECTIVE:";
const OMO_TAG_RE = /\s*<!--\s*OMO_INTERNAL_[A-Z_]+\s*-->\s*/g;

export function splitDirective(text) {
  const s = String(text ?? "");
  const idx = s.indexOf(DIRECTIVE_MARKER);
  if (idx === -1) {
    const cleaned = s.replace(OMO_TAG_RE, " ").replace(/\s+$/, "");
    return { text: cleaned, directive: null, full: false };
  }
  const directive = s.slice(idx).replace(OMO_TAG_RE, " ").trim();
  const head = s.slice(0, idx).replace(OMO_TAG_RE, " ").trim();
  return { text: head, directive, full: head.length === 0 };
}

export function splitInjected(text) {
  const s = String(text ?? "");
  const m = s.match(INJECT_TERM_RE) ?? s.match(INJECT_RE);
  if (!m) return { context: null, text: s };
  const clean = s.slice(m[0].length).replace(/^\s+|\s+$/g, "");
  // Degenerate shape (marker without the real text after ---): show as-is.
  if (!clean) return { context: null, text: s };
  return { context: m[1].trim(), text: clean };
}


// Labels resolve at call time (t) so a language switch re-renders them.
const GROUPS = ["today", "yesterday", "week", "older"].map((key) => ({ key }));

const DAY = 86400e3;

export function parseTime(t) {
  const n = Number(t);
  if (!Number.isFinite(n)) return NaN;
  return n < 1e12 ? n * 1000 : n;
}

function updatedMs(session) {
  const ms = parseTime(session?.time?.updated);
  return Number.isFinite(ms) ? ms : 0;
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// now is injectable for deterministic tests; UI callers omit it.
export function groupSessionsByDate(sessions, now = Date.now()) {
  const today0 = startOfDay(now);
  const buckets = new Map(GROUPS.map((g) => [g.key, { ...g, items: [] }]));
  for (const s of sessions ?? []) {
    const t = updatedMs(s);
    const key = t >= today0 ? "today" : t >= today0 - DAY ? "yesterday" : t >= today0 - 7 * DAY ? "week" : "older";
    buckets.get(key).items.push(s);
  }
  return GROUPS.map((g) => buckets.get(g.key))
    .filter((g) => g.items.length > 0)
    .map((g) => ({ key: g.key, label: t(`format.group.${g.key}`), items: g.items.slice().sort((a, b) => updatedMs(b) - updatedMs(a)) }));
}

function imageSupported(input) {
  if (Array.isArray(input)) return input.includes("image");
  if (input && typeof input === "object") return input.image === true;
  return false;
}

// resp.default maps providerID -> default model id. Models keep their raw
// status (non-active stay in the list, flagged) so the UI can filter.
// Only CONNECTED providers' models are kept: the catalog lists ~230 providers
// (~9k models) the user has no tokens for — showing them in the picker made
// every second model "dead" (2026-10-31 feedback).
export function normalizeProviders(resp) {
  const defaults = resp?.default ?? {};
  const connected = Array.isArray(resp?.connected) ? resp.connected : [];
  const allow = new Set(connected.length > 0 ? connected : null); // empty list = no filtering (mock/older servers)
  const models = [];
  for (const provider of resp?.all ?? []) {
    if (allow.size > 0 && !allow.has(provider.id)) continue;
    for (const model of Object.values(provider.models ?? {})) {
      const providerID = model.providerID ?? provider.id;
      if (allow.size > 0 && !allow.has(providerID)) continue;
      models.push({
        id: model.id,
        providerID,
        label: `${model.name ?? model.id} (${providerID})`,
        imageInput: imageSupported(model.capabilities?.input),
        contextLimit: model.limit?.context,
        status: model.status,
      });
    }
  }
  const isDefault = (m) => defaults[m.providerID] === m.id;
  models.sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)) || a.label.localeCompare(b.label));
  return { models, defaults, connected };
}

// ISSUE-007: opencode's own service agents (compaction/summary/title, flagged
// hidden:true upstream) are machinery, never a choice in the sheets.
const SERVICE_AGENTS = new Set(["compaction", "summary", "title"]);

export function normalizeAgents(list) {
  const seen = new Set();
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a.name !== "string" || a.hidden === true || SERVICE_AGENTS.has(a.name) || seen.has(a.name)) continue;
    seen.add(a.name);
    out.push({ name: a.name, description: a.description, mode: a.mode });
  }
  return out;
}

// A partial update (portal-side session.updated of a Claude chat carries only
// {id, directory, time.updated}) keeps the rest of the record; time merges
// per field and updated never goes back (a stale record must not push a
// chat down the list, BUG-13.16).
// BUG-088: a chat title never goes BACK to the upstream default
// («New session - <ISO>») once a real one is known — a stale list response
// or a late upstream frame used to flash the raw question (displayTitle's
// fallback) for a few seconds after the auto-title. A human rename to
// anything non-default still wins.
const DEFAULT_TITLE_RE = /^new session\s*-\s*\d{4}-\d{2}-\d{2}T/i;
export function isDefaultSessionTitle(t) {
  const s = String(t ?? "").trim();
  return !s || DEFAULT_TITLE_RE.test(s);
}
export function keepTitle(prev, next) {
  return typeof next === "string" && isDefaultSessionTitle(next) && typeof prev === "string" && !isDefaultSessionTitle(prev) ? prev : next;
}

// A full list refetch merged over the live list: titles never downgrade
// (BUG-088), time.updated never goes back (BUG-085); order = the fetched one
// re-sorted by activity.
export function mergeSessionList(prev, fetched) {
  if (!Array.isArray(fetched)) return [];
  const byId = new Map((prev ?? []).map((s) => [s?.id, s]));
  return fetched
    .map((s) => {
      const old = byId.get(s?.id);
      return old ? mergeSession(old, s, { replace: true }) : s;
    })
    .sort((a, b) => updatedMs(b) - updatedMs(a));
}

function mergeSession(s, info, { replace = false } = {}) {
  const out = replace ? { ...info } : { ...s, ...info };
  // FEAT-01.57/01.58: a hidden last turn ends with «Вернуть» or the next
  // prompt — a full upstream record without `revert` (opencode omits the
  // field) or an explicit revert:null clears it; a partial portal bump
  // (no title) keeps it.
  if (!out.revert?.messageID && ("revert" in info || typeof info.title === "string")) delete out.revert;
  if ("title" in info) out.title = keepTitle(s.title, info.title);
  if (info.time || s.time) {
    out.time = { ...s.time, ...info.time };
    if (updatedMs(s) > updatedMs(out)) out.time.updated = s.time.updated;
  }
  return out;
}

// FEAT-01.57/01.58: the feed with a hidden last turn. → {shown, hidden}:
// shown = the messages before revert.messageID (its question and everything
// after it are hidden), hidden = how many are hidden. Optimistic tmp
// bubbles (a send in flight after the revert) stay visible.
export function revertCut(messages, revert) {
  const list = messages ?? [];
  const id = revert?.messageID;
  const at = id ? list.findIndex((m) => m?.info?.id === id) : -1;
  if (at < 0) return { shown: list, hidden: 0 };
  const tail = list.slice(at);
  const keep = tail.filter((m) => String(m?.info?.id ?? "").startsWith("tmp-"));
  return { shown: [...list.slice(0, at), ...keep], hidden: tail.length - keep.length };
}

export function upsertSession(list, info) {
  if (!info?.id) return [...(list ?? [])];
  const next = [];
  let replaced = false;
  for (const s of list ?? []) {
    if (s.id === info.id) {
      next.push(mergeSession(s, info));
      replaced = true;
    } else next.push(s);
  }
  if (!replaced) next.push({ ...info });
  return next.sort((a, b) => updatedMs(b) - updatedMs(a));
}

export function makeMessage(info, parts = []) {
  return { info: { ...info }, parts: [...parts] };
}

// Insert or replace a part by part.id; existing order is kept, new parts append.
// An id-less part is an optimistic local placeholder (send() builds them): the
// first server part of the same type replaces it in place, so the injected
// server text does not duplicate the typed text in the user bubble.
export function upsertPart(msg, part) {
  if (!part?.id) return msg;
  const parts = [...(msg.parts ?? [])];
  let idx = parts.findIndex((p) => p.id === part.id);
  // FEAT-06.2: a synthetic placeholder (voice hint) is replaced only by the
  // synthetic server part — never by the typed text, whatever arrives first.
  if (idx === -1) idx = parts.findIndex((p) => !p.id && p.type === part.type && !p.synthetic === !part.synthetic);
  if (idx === -1) idx = parts.findIndex((p) => !p.id && p.type === part.type && (!p.synthetic || part.synthetic));
  if (idx === -1) parts.push({ ...part });
  else parts[idx] = { ...parts[idx], ...part };
  return { info: msg.info, parts };
}

// Server sometimes streams deltas before the part exists: synthesize a
// placeholder part so later message.part.updated can replace it wholesale.
export function applyDelta(msg, { partID, field, delta }) {
  if (!partID || !field) return msg;
  const parts = (msg.parts ?? []).map((p) =>
    p.id === partID ? { ...p, [field]: `${p[field] ?? ""}${delta}` } : p,
  );
  if (parts.some((p) => p.id === partID)) return { info: msg.info, parts };
  const created = { id: partID, type: field === "text" ? "text" : "reasoning", [field]: `${delta}` };
  return { info: msg.info, parts: [...parts, created] };
}

// Dialog requests, live-verified against opencode 1.19.5:
//   permission.asked {id:"per_..", sessionID, permission:"bash",
//     patterns:["rm *"], metadata:{command}, always:["rm *"], tool:{...}}
//   question.asked {id:"que_..", sessionID,
//     questions:[{question, header, options:[{label, description}]}], tool:{...}}
// Tolerant fallbacks keep older/odd shapes parseable; an event without a
// repliable id is dropped — a dialog we cannot answer is noise.
export function extractDialog(evt) {
  const type = evt?.type;
  if (typeof type !== "string") return null;
  const kind = type.startsWith("permission") ? "permission" : type.startsWith("question") ? "question" : null;
  if (!kind) return null;
  const p = evt.properties ?? {};
  const id = p.id ?? p.requestID ?? null;
  if (!id) return null;
  if (kind === "permission") {
    const patterns = Array.isArray(p.patterns) ? p.patterns : p.pattern ? [p.pattern] : [];
    return {
      kind,
      id,
      sessionID: p.sessionID ?? null,
      permission: p.permission ?? null,
      command: p.metadata?.command ?? p.command ?? patterns[0] ?? null,
      patterns,
      always: Array.isArray(p.always) ? p.always : [],
      raw: evt,
    };
  }
  const questions = Array.isArray(p.questions)
    ? p.questions
    : p.question
      ? [{ question: p.question, options: [] }]
      : [];
  return { kind, id, sessionID: p.sessionID ?? null, questions, raw: evt };
}

// GET /zai/api/dialogs records (server merges upstream /permission + /question
// listings with the hub snapshot) carry the same payload as SSE ask events but
// under a flat shape: {kind, id, sessionID, permission?, metadata?, always?,
// questions?, askedAt?, directory?}. Route each through extractDialog via a
// synthetic ask event so the dialog cards get one consistent shape; askedAt
// rides along (null when only upstream knows about it). Junk records drop.
export function normalizeDialogRecords(list) {
  const out = [];
  for (const rec of Array.isArray(list) ? list : []) {
    if (!rec || (rec.kind !== "permission" && rec.kind !== "question")) continue;
    const evt = extractDialog({ type: `${rec.kind}.asked`, properties: rec });
    if (!evt) continue;
    out.push({ ...evt, askedAt: typeof rec.askedAt === "number" ? rec.askedAt : null });
  }
  return out;
}

// postResult may be {info, parts}, a bare info object, or nullish.
export function mergePostIntoMessages(messages, postResult) {
  const info = postResult?.info ?? postResult;
  if (!info?.id) return [...(messages ?? [])];
  const idx = (messages ?? []).findIndex((m) => m.info.id === info.id);
  if (idx === -1) return [...messages, makeMessage(info, postResult?.parts ?? [])];
  const next = [...messages];
  const parts = (postResult?.parts ?? []).length > 0 ? postResult.parts : next[idx].parts;
  next[idx] = { info: { ...next[idx].info, ...info }, parts };
  return next;
}

// ---- projects (Claude-style: a project = a directory of chats) -------------

// "C:\Users\USER\AppData\Local\Temp\oc_test" -> "oc_test"; a bare drive/root
// ("C:\") falls back to the input. Accepts both separators.
export function dirBasename(dir) {
  const s = String(dir ?? "").trim();
  if (!s) return "";
  const trimmed = s.replace(/[\\/]+$/, "");
  if (!trimmed) return s;
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

// Junk directories are never shown as projects: system folders and temp
// harness dirs (the C:\Windows\System32 sessions appeared after the
// 2026-10-31 watchdog incident; Temp\oc_* are recorded test runs). A path
// segment boundary is required, so "D:\Portal\template" stays visible.
// extra is an exact-string list (localStorage "zai.hiddenDirs").
const DEFAULT_HIDDEN_DIR_RE = [/\\windows([\\/]|$)/i, /\\temp([\\/]|$)/i];

export function isHiddenDir(dir, extra = []) {
  const s = String(dir ?? "");
  if (!s) return true;
  if (DEFAULT_HIDDEN_DIR_RE.some((re) => re.test(s))) return true;
  return (extra ?? []).some((x) => typeof x === "string" && x.toLowerCase() === s.toLowerCase());
}

// Group the cross-directory session list into project cards. Sessions without
// a usable directory are dropped (they belong to no visible project).
// extraDirs are user-added project folders without chats yet — they appear
// as empty cards (count 0, sorted last). Output:
// [{directory, name, path, count, lastUpdated, sessions}] sorted by
// lastUpdated desc; inner sessions sorted the same way. Never mutates input.
export function buildProjects(list, { hidden = [], extraDirs = [] } = {}) {
  const groups = new Map();
  for (const s of list ?? []) {
    const dir = typeof s?.directory === "string" && s.directory ? s.directory : null;
    if (!dir || isHiddenDir(dir, hidden)) continue;
    let g = groups.get(dir);
    if (!g) {
      g = { directory: dir, name: dirBasename(dir), path: dir, count: 0, lastUpdated: 0, sessions: [] };
      groups.set(dir, g);
    }
    g.count += 1;
    const ms = parseTime(s?.time?.updated);
    g.lastUpdated = Math.max(g.lastUpdated, Number.isFinite(ms) ? ms : 0);
    g.sessions.push(s);
  }
  // User-added folders with no sessions yet (case-insensitive dedupe).
  for (const dir of extraDirs ?? []) {
    if (typeof dir !== "string" || !dir || isHiddenDir(dir, hidden)) continue;
    const low = dir.toLowerCase();
    if ([...groups.keys()].some((k) => k.toLowerCase() === low)) continue;
    groups.set(dir, { directory: dir, name: dirBasename(dir), path: dir, count: 0, lastUpdated: 0, sessions: [] });
  }
  const byRecency = (a, b) => b.lastUpdated - a.lastUpdated;
  const bySessionRecency = (a, b) => (parseTime(b?.time?.updated) || 0) - (parseTime(a?.time?.updated) || 0);
  return [...groups.values()]
    .sort(byRecency)
    .map((g) => ({ ...g, sessions: g.sessions.slice().sort(bySessionRecency) }));
}

// ---- chat artifacts (paths the agent produced or mentioned) ----------------

// Windows paths ("D:\Projects\app\report.md") — no whitespace/quotes inside,
// a known artifact extension at the end.
const ARTIFACT_EXT = "md|markdown|txt|log|csv|json|xml|ya?ml|html?|htm|pdf|png|jpe?g|gif|webp|svg|avif|bmp|xlsx?|docx?|pptx?|zip|mp4|webm|mkv|mov|mp3|wav|ogg|js|jsx|ts|tsx|css|py|sh|ps1|bat";
const WIN_PATH_RE = new RegExp(`[A-Za-z]:\\\\(?:[^\\\\\\s"'‘“”\`<>|]+\\\\)*[^\\\\\\s"'‘“”\`<>|]*\\.(?:${ARTIFACT_EXT})\\b`, "gi");
// Unix-style absolutes ("real" fs paths — no spaces).
const UX_PATH_RE = new RegExp(`(?:^|[\\s("'‘“\`])((?:\\/(?:home|Users|tmp|mnt|media|opt|var|root)\\/)[^\\s"'‘“”\`<>|)]*\\.(?:${ARTIFACT_EXT}))\\b`, "gi");
// Workspace upload refs: sanitization keeps spaces and balanced parens —
// "my report (2).pdf" is a legal stored name, so this branch allows both
// (lazy stop at the first artifact extension).
const UPLOAD_PATH_RE = new RegExp(`(?:^|[\\s("'‘“\`])((?:\\.{1,2}[\\\\\\/])?\\.zai-uploads[\\\\\\/](?:[^()]|\\([^)]*\\))*?\\.(?:${ARTIFACT_EXT}))\\b`, "gi");

// FEAT-05.29: файл, который агент ПОКАЗЫВАЕТ пользователю, — ссылка или картинка
// markdown с локальным абсолютным путём: [имя](D:\\dir\\a.png), ![имя](<D:\\my dir\\a b.png>),
// [имя](/home/u/a.pdf), [имя](file:///D:/dir/a.png). Такой файл становится карточкой
// из исходного места (сервер сам проверяет, доступен ли он учётной записи).
// Голый путь в тексте показом НЕ считается — упомянутые исходники и логи не карточки.
const PRESENTED_RE = /!?\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^)\n]+?))\s*\)/g;
const CARD_CAP = 40; // владелец 2026-11-11: лимит 8 снят; потолок — от злоупотребления

function localTarget(raw) {
  let t = String(raw ?? "").trim();
  if (/^file:\/\/\//i.test(t)) {
    try {
      t = decodeURIComponent(t.replace(/^file:\/\/\//i, ""));
    } catch {
      return null;
    }
    t = /^[A-Za-z]:/.test(t) ? t.replace(/\//g, "\\") : "/" + t;
  }
  const win = /^[A-Za-z]:[\\/]/.test(t);
  if (!win && !(t.startsWith("/") && !t.startsWith("//"))) return null;
  if (/[*?"<>|]/.test(win ? t.slice(2) : t)) return null; // маски и запрещённые в именах знаки
  if (/(^|[\\/])\.\.([\\/]|$)/.test(t)) return null; // без «..»
  const name = t.split(/[\\/]/).pop() ?? "";
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) return null; // у файла есть расширение; папка — не файл
  return t;
}

// → [{ path, label }] в порядке появления, без повторов.
export function extractPresentedFiles(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? "").matchAll(PRESENTED_RE)) {
    const p = localTarget(m[2] ?? m[3]);
    if (!p) continue;
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ path: p, label: (m[1] ?? "").trim() });
  }
  return out;
}

// FEAT-05.29: текст ответа без путей сервера (пользователю чата они ни о чём не говорят).
// Ссылка на локальный файл → её название (пустое → имя файла); полный путь файла,
// у которого есть карточка, → имя файла. Обычные ссылки и чужие пути не трогаются.
export function hideServerPaths(text, cardPaths = []) {
  let s = String(text ?? "");
  if (!s) return s;
  // строка, в которой только ссылка на файл с карточкой (можно с маркером списка),
  // убирается целиком: карточка уже показывает этот файл, имя под ней — повтор
  const carded = new Set((cardPaths ?? []).map((p) => String(p).toLowerCase()));
  if (carded.size > 0) {
    s = s
      .split("\n")
      .filter((line) => {
        const m = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^)\n]+?))\s*\)[\s.,;]*$/.exec(line);
        if (!m) return true;
        const p = localTarget(m[1] ?? m[2]);
        return !(p && carded.has(p.toLowerCase()));
      })
      .join("\n");
  }
  s = s.replace(PRESENTED_RE, (all, label, a, b) => {
    const p = localTarget(a ?? b);
    if (!p) return all;
    return (label ?? "").trim() || p.split(/[\\/]/).pop();
  });
  for (const p of cardPaths ?? []) {
    if (typeof p !== "string" || !p) continue;
    const name = p.split(/[\\/]/).pop();
    // путь в тексте может быть с любыми слэшами и в любом регистре
    const re = new RegExp(p.split(/[\\/]+/).map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\\\/]+"), "gi");
    s = s.replace(re, () => name);
  }
  return s;
}

// Unique artifact-ish paths in the order they appear, capped to keep the
// chip row light. Used by MessageBubble; the FileViewer resolves each
// against the session directory (the server re-checks containment).
export function extractFilePaths(text, cap = 40) {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    const v = String(s ?? "").trim();
    // BUG-155: «…\*.svg», «chart?.png» are glob masks (Windows names cannot hold * ?), not files
    if (!v || /[*?]/.test(v)) return;
    const k = v.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };
  const s = String(text ?? "");
  for (const m of s.matchAll(WIN_PATH_RE)) push(m[1] ?? m[0]);
  for (const m of s.matchAll(UX_PATH_RE)) push(m[1]);
  for (const m of s.matchAll(UPLOAD_PATH_RE)) push(m[1]);
  return out.slice(0, cap);
}

// Artifact chips for an assistant message: files the agent handed over via
// write/edit completions PLUS artifact paths it mentioned in the final text —
// script-generated files (png/pdf/xlsx через bash) так попадали в чипы до
// аудита утечек 2026-11-01 и снова должны (репорт 2026-11-02: из 4 файлов
// чипы получили только 2 write-овских). Оба источника жёстко скоупятся
// папкой сессии: упомянутый D:\... вне сессии по-прежнему не чип (guard
// аудита сохранён); неизвестная директория прячет всё (нельзя проверить).
export function collectArtifacts(parts, texts, sessionDir, cap = CARD_CAP) {
  return collectArtifactEntries(parts, texts, sessionDir, cap).map((e) => e.path);
}

// Same list with the source of each path (ISSUE-003): guessed=true marks a
// bare/relative picture name taken from the answer TEXT and glued to the
// session folder — nobody checked that it exists, so a preview that fails to
// load is hidden entirely instead of a «Картинка недоступна» card. Absolute
// paths from the text and write/edit files keep the broken-card face.
export function collectArtifactEntries(parts, texts, sessionDir, cap = CARD_CAP) {
  const out = [];
  const entries = [];
  const seen = new Set();
  // FEAT-05.29: показанные ссылкой файлы — первыми и БЕЗ привязки к папке чата
  // (доступность проверяет сервер). presented: true — карточке нужна эта проверка.
  for (const f of extractPresentedFiles((texts ?? []).join("\n"))) {
    if (out.length >= cap) break;
    if (isScratchPath(f.path)) continue;
    const k = f.path.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f.path);
    entries.push({ path: f.path, guessed: false, presented: true });
  }
  const add = (p, guessed = false) => {
    if (typeof p !== "string" || !p || out.length >= cap) return;
    if (/[*?]/.test(p)) return; // BUG-155: glob mask, not a file
    if (!isUnderPath(p, sessionDir)) return;
    if (isScratchPath(p)) return;
    const k = p.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(p);
    entries.push({ path: p, guessed });
  };
  for (const p of parts ?? []) {
    if (p?.type === "tool" && /^(write|edit)$/i.test(String(p.tool ?? "")) && p.state?.status === "completed") {
      const f = p.state.input?.filePath ?? p.state.input?.file_path ?? p.state.input?.path;
      if (typeof f === "string") add(f);
    }
  }
  const joined = (texts ?? []).join("\n");
  for (const p of extractFilePaths(joined)) add(p);
  // BUG-05.13 / BUG-079: a picture made ONLY by a command (`python plot.py
  // --out chart.png`, `magick … D:\proj\out.png`) — no write/edit, the answer
  // may not name it. Image paths from the input of COMPLETED shell calls,
  // resolved against the tool's working folder (else the session folder).
  // Nobody checked the file exists (the same command may have only READ
  // it, or failed to write) — marked guessed: a 404 hides the card.
  if (sessionDir) {
    for (const p of parts ?? []) {
      for (const f of commandImagePaths(p, sessionDir)) add(f, true);
    }
  }
  // ISSUE-010: a picture the agent named WITHOUT a folder («готово: red.png»,
  // `charts/out.png`) lives in the session folder — resolve it there. Images
  // only, no «..»: anything else still needs the full path.
  if (sessionDir) {
    const base = String(sessionDir).replace(/[\\/]+$/, "");
    for (const m of joined.matchAll(REL_IMG_RE)) {
      const rel = m[1];
      if (/(^|[\\/])\.\.([\\/]|$)/.test(rel) || /^(\.[\\/])?\.zai-uploads[\\/]/i.test(rel)) continue;
      // The same file also given with its full path (a table «name | path»)
      // is already a chip — the bare name is its label, not a second file.
      const bn = rel.split(/[\\/]/).pop().toLowerCase();
      if (out.some((p) => p.split(/[\\/]/).pop().toLowerCase() === bn)) continue;
      add(`${base}\\${rel.replace(/^\.[\\/]/, "").replace(/\//g, "\\")}`, true);
    }
  }
  return entries;
}

const REL_IMG_RE = /(?:^|[\s("'`«])((?:\.[\\/])?(?:[\w.-]+[\\/])*[\w-][\w.-]*\.(?:png|jpe?g|gif|webp|svg))(?=$|[\s)"'`».,:;!?])/gim;

// ---- image paths in a shell command (BUG-05.13) ----------------------------
const SHELL_TOOL_RE = /^(bash|shell|sh|zsh|cmd|powershell|pwsh|exec|run_command|run_shell_command|terminal)$/i;
const CMD_IMG_EXT = "png|jpe?g|gif|webp|svg";
// A quoted argument ending in an image extension — spaces allowed inside
// ("D:\My dir\a b.png", 'chart.png' in `python -c "…savefig('chart.png')"`).
const CMD_QUOTED_IMG_RE = new RegExp(`(["'])([^"'\\n]*?\\.(?:${CMD_IMG_EXT}))\\1`, "gi");
// A bare argument: absolute (C:\x\y.png, C:/x/y.png) or relative (out.png,
// ./charts/a.png, --out=chart.png, > shot.png). Never part of a URL or a
// variable ($out.png) — the char before the path must be a separator.
const CMD_BARE_IMG_RE = new RegExp(
  `(?:^|[\\s=(>|;&,])((?:[A-Za-z]:)?[\\\\/]?(?:[\\w.-]+[\\\\/])*[\\w-][\\w.-]*\\.(?:${CMD_IMG_EXT}))(?=$|[\\s)"'\`;,|&<>])`,
  "gi",
);
// A leading `cd [/d] <dir> &&|;` moves the command's working folder.
const CMD_CD_RE = /^\s*(?:cd|set-location|pushd)\s+(?:\/d\s+)?(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;|\|\|)/i;

const isAbsWin = (p) => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]/.test(p);
const toWin = (p) => String(p).replace(/\//g, "\\");
// BUG-098: Git Bash / MSYS paths «/d/Portal/x.png» (and «/mnt/d/…») are the
// drive D: — not a path under the chat folder (that gave 404s).
const fromMsys = (p) => {
  const m = /^\/(?:mnt\/)?([A-Za-z])(\/.*|$)/.exec(String(p ?? ""));
  return m ? `${m[1].toUpperCase()}:${toWin(m[2] || "\\")}` : p;
};

// Join a relative path onto a Windows folder; null for «..» (never escapes)
// and for upload refs (the user's own attachments, not results).
function joinRel(base, rel) {
  const r = String(rel).replace(/^\.[\\/]/, "");
  if (/(^|[\\/])\.\.([\\/]|$)/.test(r) || /^\.zai-uploads[\\/]/i.test(r)) return null;
  return `${String(base).replace(/[\\/]+$/, "")}\\${toWin(r)}`;
}

// Image paths a COMPLETED shell tool call names in its command, resolved to
// absolute paths (unscoped — the caller checks the session folder / Temp).
export function commandImagePaths(part, sessionDir) {
  if (part?.type !== "tool" || !SHELL_TOOL_RE.test(String(part.tool ?? ""))) return [];
  if (part.state?.status !== "completed") return [];
  const input = part.state?.input ?? {};
  const command = typeof input.command === "string" ? input.command : Array.isArray(input.command) ? input.command.join(" ") : "";
  if (!command || !sessionDir) return [];
  // Working folder: the tool's own (opencode bash `workdir`, others `cwd`),
  // then a leading `cd`, else the session folder; relative ones join it.
  const resolveDir = (d) => {
    const s = typeof d === "string" ? fromMsys(d.trim()) : "";
    if (!s) return null;
    return isAbsWin(s) ? toWin(s) : joinRel(sessionDir, s);
  };
  let base = resolveDir(input.workdir ?? input.cwd ?? input.directory) ?? toWin(sessionDir);
  const cd = CMD_CD_RE.exec(command);
  if (cd) {
    const d = fromMsys(cd[1] ?? cd[2] ?? cd[3]);
    base = (isAbsWin(d) ? toWin(d) : joinRel(base, d)) ?? base;
  }
  const raw = [];
  const bare = command.replace(CMD_QUOTED_IMG_RE, (m, q, inner) => {
    raw.push(inner);
    return " ".repeat(m.length);
  });
  for (const m of bare.matchAll(CMD_BARE_IMG_RE)) raw.push(m[1]);
  const out = [];
  for (const r of raw) {
    let s = r.trim();
    if (!s || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) continue; // URL
    // BUG-086: shell variables. A leading working-folder variable ($PWD,
    // ${PWD}, $(pwd), %CD%) means the command's folder; any other variable
    // ($env:X, $out, %TEMP%) is unknown here — skip it, never request a
    // literal «$PWD\dot.png» (404 in the console).
    s = s.replace(/^(?:\$\{?pwd\}?|\$\(pwd\)|%cd%)(?=[\\/])/i, () => base);
    if (/\$|%[A-Za-z_][\w()]*%/.test(s)) continue;
    // BUG-098: a glob («ls *.png», «rm shot-?.jpg») names no single file.
    if (/[*?]/.test(s)) continue;
    s = fromMsys(s);
    if (isAbsWin(s)) out.push(toWin(s));
    else if (/^[\\/]/.test(s)) out.push(s); // root/unix path: kept as is, the scope check decides
    else {
      const j = joinRel(base, s);
      if (j) out.push(j);
    }
  }
  return out;
}

// Scratch folders: helper scripts the agent writes there are working files,
// not results the user asked for (BUG-012 — gen-qa.ps1 from
// AppData\Local\Temp\opencode showed up next to the four requested files).
// Only SYSTEM temp roots count (BUG-01.37 п.6): a project's own `tmp` folder
// (D:\proj\tmp\report.pdf) holds legitimate results and keeps its chip.
const SCRATCH_DIR_RE = /(^|[\\/])(appdata[\\/]local[\\/]temp|windows[\\/]temp)[\\/]|^(?:[A-Za-z]:)?[\\/](?:tmp|temp)[\\/]/i;
export function isScratchPath(p) {
  return SCRATCH_DIR_RE.test(String(p ?? ""));
}

// Windows/Unix path containment for chip scoping: case-insensitive,
// separator-normalized, boundary-safe ("D:\\ObsidianX" is NOT under
// "D:\\Obsidian"). Empty dir → false (cannot verify scope → hide).
export function isUnderPath(filePath, dir) {
  const norm = (p) => String(p ?? "").replace(/[\\/]+$/, "").toLowerCase().replace(/\\/g, "/");
  const f = norm(filePath);
  const d = norm(dir);
  if (!f || !d) return false;
  return f.startsWith(d + "/");
}

// «Новый проект» path check (BUG-013): only an absolute folder outside the
// Windows system tree. A relative path resolves against the service cwd —
// C:\WINDOWS\system32 — which is exactly where П12 says chats must never go.
// Returns null when OK, otherwise the message for the modal.
const SYSTEM_DIR_RE = /^[A-Za-z]:[\\/](windows|program files( \(x86\))?|programdata)([\\/]|$)/i;
export function validateProjectDir(dir) {
  const s = String(dir ?? "").trim();
  if (!s) return t("project.dir.empty");
  if (/(^|[\\/])\.\.([\\/]|$)/.test(s)) return t("project.dir.dotdot");
  // POSIX servers (macOS/Linux): an absolute «/…» path is fine too.
  if (!/^[A-Za-z]:[\\/]/.test(s) && !/^\\\\[^\\/]+[\\/][^\\/]+/.test(s) && !/^\/[^\\/]/.test(s)) {
    return t("project.dir.absolute");
  }
  if (SYSTEM_DIR_RE.test(s)) return t("project.dir.system");
  return null;
}

// "C:\Users\USER" reads as a person's name on a project card; a home folder
// (<root>\Users\<name> or <root>/home/<name>) shows as «Домашняя папка».
export function projectDisplayName(dir) {
  if (/[\\/](?:users|home)[\\/]+[^\\/]+$/i.test(String(dir ?? ""))) return t("project.home");
  return dirBasename(dir);
}

// ---- multi-agent (opencode "task" tool = a subagent run) -------------------

// opencode 1.19.5 live contract: tool:"task", state.input.{description,
// subagent_type, run_in_background, prompt}, state.metadata.{agent,
// sessionId, model}, state.time.{start,end}. Tolerant of future shapes.
export function isAgentTool(part) {
  return part?.type === "tool" && /^(task|agent|subagent)$/i.test(String(part.tool ?? ""));
}

// Медиа из tool-результата: read возвращает картинки как state.attachments
// (data:URL). До рендера они не доживали — ToolCard показывал только текст
// state.output, файл нельзя было ни увидеть, ни скачать (репорт 2026-11-02).
// Возвращает нормализованный список {url, mime, name} по всем вложениям части.
const ATTACH_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };

export function attachmentName(att, input, i) {
  const p = String(input?.filePath ?? input?.file_path ?? input?.path ?? "");
  const base = p.split(/[\\/]/).pop() ?? "";
  if (base && /\.[a-z0-9]{1,8}$/i.test(base)) return base;
  return (base || `attachment-${i + 1}`) + (ATTACH_EXT[att?.mime] ?? "");
}

export function toolMedia(part) {
  const atts = Array.isArray(part?.state?.attachments) ? part.state.attachments : [];
  const out = [];
  for (let i = 0; i < atts.length; i += 1) {
    const a = atts[i];
    if (!a || typeof a.url !== "string" || !/^(data:|blob:)/.test(a.url)) continue;
    out.push({ url: a.url, mime: a.mime ?? "application/octet-stream", name: attachmentName(a, part?.state?.input, i) });
  }
  return out;
}

// Loop protection (user report 2026-11-01: a stuck agent spammed dozens of
// identical tool calls — the chat drowned in identical cards). Consecutive
// tool parts with the SAME signature collapse into one render item carrying
// a repeat count. Signature = tool name + stable input fingerprint, so a
// real retry with different arguments still shows separately.
function toolSignature(part) {
  const input = part?.state?.input ?? {};
  const key =
    input.command ?? input.prompt ?? input.description ?? input.filePath ??
    input.file_path ?? input.path ?? input.url ?? input.query ?? "";
  return `${String(part?.tool ?? "")}|${String(part?.state?.title ?? "")}|${String(key).slice(0, 400)}`;
}

// Returns render items: {part, count} for tools (count ≥ 1), plain {part}
// for everything else. Pure; input never mutated.
export function collapseToolRuns(parts) {
  const out = [];
  let run = null;
  for (const p of parts ?? []) {
    if (p?.type === "tool") {
      const sig = toolSignature(p);
      if (run && run.sig === sig) {
        run.count += 1;
        // Keep the FRESHEST part of the run (its status/output wins).
        run.part = p;
        continue;
      }
      run = { sig, part: p, count: 1 };
      out.push(run);
      continue;
    }
    run = null;
    out.push({ part: p });
  }
  return out;
}

// Whole seconds → «34с» / «2м 05с» / «1ч 12м» (en: 34s / 2m 05s / 1h 12m).
export function fmtSpan(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return t("format.dur.s", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("format.dur.ms", { m, s: String(s % 60).padStart(2, "0") });
  return t("format.dur.hm", { h: Math.floor(m / 60), m: m % 60 });
}

// "34с" / "2м 05с" / "1ч 12м" — compact elapsed for cards and chips.
// precise=true (tool cards): sub-10s runs keep one decimal, ru comma —
// «4,2с», «0,3с» (a build step of 0.3s used to read as «0с»).
export function fmtElapsed(ms, precise = false) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  if (precise && n > 0 && n < 9950) return t("format.dur.s", { n: fmtDecimal(n / 1000, 1) });
  return fmtSpan(Math.round(n / 1000));
}

// "14:05" — clock time of a stage start (ru 24h). Accepts epoch s or ms
// (same tolerance as parseTime); invalid/absent → "" (the caller omits it).
// t<=0 counts as absent: Number(null) is 0, and epoch-1970 is never a real
// stage start (the test caught exactly this — "03:00" from null).
export function fmtClock(ms) {
  const t = parseTime(ms);
  if (!Number.isFinite(t) || t <= 0) return "";
  return new Date(t).toLocaleTimeString(lang.value === "ru" ? "ru" : "en-GB", { hour: "2-digit", minute: "2-digit" });
}

// "Без названия" — a harness-spawned session carries the upstream default
// «New session - <ISO-instant>»; raw machine text in a chat list (C2).
// BUG-01.27 (client half): upstream titles the chat from the first user part,
// and the vault-cache plugin glues its snapshot INTO that part — the title
// then retells the snapshot («zai.home.example.net HTTPS IPv6») instead of
// the question. With firstText (the raw first user text, snapshot included)
// a title that shares words with the snapshot but none with the typed text
// is replaced by the start of the typed text. Without firstText only the
// obvious cases are caught (a title that IS the snapshot marker).
const TITLE_WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}._-]{2,}/gu;
const titleWords = (s) => new Set((String(s ?? "").toLowerCase().match(TITLE_WORD_RE) ?? []));

export function titleFromText(text, max = 60) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,.;:—-]+$/, "") + "…";
}

// Raw text of the first user message (snapshot included) — the firstText of
// displayTitle. Failed (never sent) bubbles do not count. null = unknown.
export function firstUserText(messages) {
  const m = (messages ?? []).find((x) => x?.info?.role === "user" && !x.info.failed);
  if (!m) return null;
  const text = (m.parts ?? []).filter((p) => p?.type === "text" && typeof p.text === "string" && !p.synthetic).map((p) => p.text).join("\n");
  return text || null;
}

export function displayTitle(title, firstText = null) {
  const s = String(title ?? "").trim();
  if (!s || /^new session\s*-\s*\d{4}-\d{2}-\d{2}T/i.test(s)) {
    return firstText ? titleFromText(splitInjected(firstText).text) || t("common.untitled") : t("common.untitled");
  }
  if (/^\[obsidian-cache\]/i.test(s)) {
    const typed = firstText ? splitInjected(firstText) : null;
    return typed?.context ? titleFromText(typed.text) : t("common.untitled");
  }
  if (firstText) {
    const { context, text } = splitInjected(firstText);
    if (context && text) {
      const tw = titleWords(s);
      const typed = titleWords(text);
      const snap = titleWords(context);
      let hitTyped = 0;
      let hitSnap = 0;
      for (const w of tw) {
        if (typed.has(w)) hitTyped += 1;
        if (snap.has(w)) hitSnap += 1;
      }
      if (hitTyped === 0 && hitSnap > 0) return titleFromText(text);
    }
  }
  return s;
}

// ---- ru number formatting (one helper for every counter in the chat) ------
// «2,3k», «18,7k», «419k», «1,2M», «8,9 МБ» — comma decimals (D-04/BUG-01.41
// п.3: «1.2k» next to «2,6M» read as two different products).

export function fmtDecimal(n, digits = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const s = v.toFixed(digits);
  const out = digits > 0 ? s.replace(/\.?0+$/, "") : s;
  return lang.value === "ru" ? out.replace(".", ",") : out;
}

export function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  if (a < 1000) return String(Math.round(v));
  if (a < 100_000) return fmtDecimal(v / 1000, 1) + "k";
  if (a < 999_500) return Math.round(v / 1000) + "k";
  return fmtDecimal(v / 1e6, 1) + "M";
}

export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "";
  if (v >= 1024 * 1024 * 1024) return t("format.size.gb", { n: fmtDecimal(v / (1024 * 1024 * 1024), 1) });
  if (v >= 1024 * 1024) return t("format.size.mb", { n: fmtDecimal(v / (1024 * 1024), 1) });
  if (v >= 1024) return t("format.size.kb", { n: Math.round(v / 1024) });
  return t("format.size.b", { n: Math.round(v) });
}

// Decoded size of a data: URL (ISSUE-012 «PNG · W×H · 315 Б»): base64
// payloads lose their «=» padding; a plain (percent-encoded) payload counts
// its decoded UTF-8 bytes. Not a data: URL → null.
export function dataUrlBytes(url) {
  const s = String(url ?? "");
  const comma = s.indexOf(",");
  if (!/^data:/i.test(s) || comma < 0) return null;
  const head = s.slice(0, comma);
  const body = s.slice(comma + 1);
  if (/;base64$/i.test(head)) {
    const b = body.replace(/\s+/g, "");
    const pad = b.endsWith("==") ? 2 : b.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((b.length * 3) / 4) - pad);
  }
  try {
    return new TextEncoder().encode(decodeURIComponent(body)).length;
  } catch {
    return body.length;
  }
}

// ---- turns (one user message + every assistant step after it) -------------
// opencode splits one answer into several assistant messages (one per step).
// The copy button, the meta line and the author belong to the TURN, not to
// each step (R-02/R-03: 33 copy icons in one chat, «419k ток» with cache).
// Returns Map<assistantMessageId, {first, last, closed, text, tokensIn,
// tokensOut, tokensTotal, completedAt, durationMs}> — the same object for
// every step of the turn. closed: the turn can no longer grow (a later user
// message exists, or the session is idle and the last step completed).
export function buildTurns(messages, { busy = false } = {}) {
  const out = new Map();
  const list = Array.isArray(messages) ? messages : [];
  let i = 0;
  while (i < list.length) {
    const m = list[i];
    if (m?.info?.role !== "assistant") {
      i += 1;
      continue;
    }
    const user = i > 0 && list[i - 1]?.info?.role === "user" ? list[i - 1] : null;
    const steps = [];
    while (i < list.length && list[i]?.info?.role === "assistant") steps.push(list[i++]);
    const tail = i >= list.length;
    const lastInfo = steps[steps.length - 1].info ?? {};
    const completedAt = parseTime(lastInfo.time?.completed);
    const turn = {
      first: steps[0].info?.id ?? null,
      last: lastInfo.id ?? null,
      closed: Number.isFinite(completedAt) && (!tail || !busy),
      text: "",
      tokensIn: 0,
      tokensOut: 0,
      tokensTotal: 0,
      completedAt: Number.isFinite(completedAt) ? completedAt : null,
      durationMs: null,
    };
    const texts = [];
    for (const s of steps) {
      const t = s.info?.tokens ?? {};
      turn.tokensIn += Number(t.input) || 0;
      turn.tokensOut += (Number(t.output) || 0) + (Number(t.reasoning) || 0);
      turn.tokensTotal += Number(t.total) || 0;
      for (const p of s.parts ?? []) {
        if (p?.type === "text" && !p.synthetic) {
          const v = String(p.text ?? "").trim();
          if (v) texts.push(v);
        }
      }
    }
    turn.text = texts.join("\n\n");
    const startAt = parseTime(user?.info?.time?.created ?? steps[0].info?.time?.created);
    if (turn.completedAt != null && Number.isFinite(startAt) && turn.completedAt >= startAt) {
      turn.durationMs = turn.completedAt - startAt;
    }
    for (const s of steps) if (s.info?.id != null) out.set(s.info.id, turn);
  }
  return out;
}

// «↑12,4k ↓48,2k · 14:34 · 3м 05с» — input without cache reads, output with
// reasoning; a record that only knows `total` (older fixtures, Claude runs)
// falls back to «12,9k ток». Empty pieces are dropped.
export function turnMetaLine(turn) {
  if (!turn) return "";
  const bits = [];
  if (turn.tokensIn > 0 || turn.tokensOut > 0) {
    bits.push([turn.tokensIn > 0 ? `↑${fmtNum(turn.tokensIn)}` : "", turn.tokensOut > 0 ? `↓${fmtNum(turn.tokensOut)}` : ""].filter(Boolean).join(" "));
  } else if (turn.tokensTotal > 0) bits.push(t("format.tokens", { n: fmtNum(turn.tokensTotal) }));
  const clock = fmtClock(turn.completedAt);
  if (clock) bits.push(clock);
  if (turn.durationMs != null) bits.push(fmtElapsed(turn.durationMs));
  return bits.join(" · ");
}

// Turn author: a Claude chat is answered by the Claude MODEL — never by the
// opencode agent name an old record or a default may carry (R-08: «Sisyphus -
// ultraworker» над ответом Claude). opencode keeps the agent.
// BUG-087: a Claude answer given by a portal agent (info.agent = its id,
// FEAT-13.17) is signed «<model> · <agent name>» so the history shows which
// answers came from Workflow; claudeAgents = [{id, name}] (names), the id is
// the fallback. An opencode agent name on a Claude record is still ignored.
const CLAUDE_AGENT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/; // = shared/engine.js CLAUDE_AGENT_ID (normalize stays import-free)
export function turnAuthor(info, { engine = null, modelLabel = null, claudeAgents = null } = {}) {
  const claude = engine === "claude" || info?.providerID === "anthropic";
  if (claude) {
    const base = modelLabel || info?.modelID || "Claude";
    const id = typeof info?.agent === "string" && CLAUDE_AGENT_ID_RE.test(info.agent) ? info.agent : null;
    if (!id) return { name: base, claude: true };
    const hit = (Array.isArray(claudeAgents) ? claudeAgents : []).find((a) => a?.id === id);
    const agentName = hit?.name || id.charAt(0).toUpperCase() + id.slice(1);
    return { name: `${base} · ${agentName}`, claude: true, agent: id };
  }
  const agent = typeof info?.agent === "string" && info.agent ? info.agent : null;
  return { name: agent, claude: false };
}

// Queued follow-ups (R-13/FEAT-01.29): a user message sent while the previous
// turn is still running waits upstream until that turn ends. Explicit flag
// info.queued (store, Г4a) wins; otherwise inferred: session busy, an earlier
// assistant step has not completed, and no assistant answered this message
// yet. Returns Set of user message ids.
export function queuedUserIds(messages, busy = false) {
  const out = new Set();
  const list = Array.isArray(messages) ? messages : [];
  let openAssistant = false;
  for (let i = 0; i < list.length; i += 1) {
    const info = list[i]?.info ?? {};
    if (info.role === "assistant") {
      openAssistant = info.time?.completed == null;
      continue;
    }
    if (info.role !== "user" || info.failed) continue;
    if (info.queued === true) {
      out.add(info.id);
      continue;
    }
    const answered = list.slice(i + 1).some((m) => m?.info?.role === "assistant" && (m.info.parentID === info.id || m.info.time?.created >= (info.time?.created ?? Infinity)));
    if (busy && openAssistant && !answered) out.add(info.id);
  }
  return out;
}

// ---- tool cards ----------------------------------------------------------
// Harness env prefix (BUG-01.33): `$env:CI='true'; $env:X="y"; npm test`,
// `export A=b && cmd`, `set "A=b" && cmd`, `A=b B=c cmd` — the assignments are
// agent plumbing, not the step. Returns {command, env:[{name, value}]}.
const ENV_STEP_RES = [
  /^\$env:([A-Za-z_][\w]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s;]*))\s*(?:;|&&|\r?\n)\s*/,
  /^export\s+([A-Za-z_]\w*)=(?:'([^']*)'|"([^"]*)"|([^\s;&]*))\s*(?:;|&&|\r?\n)\s*/,
  /^set\s+"?([A-Za-z_]\w*)=([^"&\r\n]*?)"?\s*(?:&&|&|\r?\n)\s*/i,
  /^([A-Za-z_]\w*)=(?:'([^']*)'|"([^"]*)"|([^\s;&'"]*))\s+(?=\S)/,
];

export function splitEnvPrefix(command) {
  let rest = String(command ?? "");
  const env = [];
  for (let guard = 0; guard < 32; guard += 1) {
    const lead = rest.match(/^\s*/)[0];
    const s = rest.slice(lead.length);
    let hit = null;
    for (const re of ENV_STEP_RES) {
      const m = s.match(re);
      if (m) {
        hit = m;
        break;
      }
    }
    if (!hit) break;
    env.push({ name: hit[1], value: hit[2] ?? hit[3] ?? hit[4] ?? "" });
    rest = s.slice(hit[0].length);
  }
  if (env.length === 0) return { command: String(command ?? ""), env };
  return { command: rest.trim(), env };
}

// Step description for the card header: opencode bash takes a `description`
// argument («Построить график»); the state title is the raw command for bash,
// so it only counts when it differs from the command.
export function toolStepDesc(part) {
  const st = part?.state ?? {};
  const input = st.input ?? {};
  const d = typeof input.description === "string" ? input.description.trim() : "";
  if (d) return d;
  const title = typeof st.title === "string" ? st.title.trim() : "";
  const cmd = typeof input.command === "string" ? input.command.trim() : "";
  const fp = String(input.filePath ?? input.file_path ?? input.path ?? "");
  if (!title || title === cmd || title === fp || /^[A-Za-z]:[\\/]|^\//.test(title)) return "";
  return title.length > 80 ? title.slice(0, 79) + "…" : title;
}

// A tool part parked on a permission request (R-15): matched by the asking
// call id, or — for records without tool refs — by the same command in the
// same session while the part has not finished.
export function isAwaitingPermission(part, dialogList, sessionID = null) {
  const st = part?.state ?? {};
  if (st.status === "completed" || st.status === "error") return false;
  for (const d of Array.isArray(dialogList) ? dialogList : []) {
    if (d?.kind !== "permission") continue;
    const tool = d.raw?.properties?.tool ?? {};
    if (part?.callID && tool.callID && tool.callID === part.callID) return true;
    if (tool.callID) continue;
    const cmd = st.input?.command;
    if (cmd && d.command && d.command === cmd && (!sessionID || !d.sessionID || d.sessionID === sessionID)) return true;
  }
  return false;
}

// ---- files: kinds, badges, names -----------------------------------------

export function fileExt(name) {
  return (/\.([a-z0-9]{1,8})$/i.exec(String(name ?? ""))?.[1] ?? "").toLowerCase();
}

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"];
// mkv/mov are NOT here: the file API serves them as octet-stream + nosniff and
// most browsers cannot play them anyway — an honest download card beats a
// silently dead player (FV-10).
const VIDEO_EXT = ["mp4", "webm", "m4v"];
const AUDIO_EXT = ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"];
const TEXT_EXT = [
  "txt", "log", "json", "jsonl", "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "properties",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "css", "scss", "py", "sh", "ps1", "psm1", "bat", "cmd",
  "sql", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "rb", "php", "swift", "lua",
  "diff", "patch", "gitignore", "dockerfile", "gradle", "vue", "svelte", "graphql", "proto", "r",
];

// Viewer kind for a file name: image|pdf|html|md|csv|xlsx|docx|video|audio|text|binary.
export function fileKindOf(name) {
  const ext = fileExt(name);
  if (IMAGE_EXT.includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (ext === "docx") return "docx";
  if (VIDEO_EXT.includes(ext)) return "video";
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (TEXT_EXT.includes(ext)) return "text";
  return "binary";
}

export function isImageName(name) {
  return IMAGE_EXT.includes(fileExt(name)) && fileExt(name) !== "ico";
}

// Chip badge (FV-17/R-06): the extension, at most 5 chars, or null.
export function fileBadge(name) {
  const ext = fileExt(name);
  return ext && ext.length <= 5 ? ext : null;
}

// File card in the answer (FEAT-05.17, Claude-app look): the type in words
// + the extension in caps («Код · HTML», «Документ · MD», «Файл · DRAWIO»)
// and the name without its extension. kind drives the tile colour/icon.
const CARD_KINDS = [
  ["code", ["html", "htm", "js", "mjs", "cjs", "jsx", "ts", "tsx", "css", "scss", "json", "jsonl", "xml",
    "yml", "yaml", "toml", "ini", "py", "sh", "ps1", "psm1", "bat", "cmd", "sql", "go", "rs", "java", "kt", "c", "h",
    "cpp", "hpp", "cs", "rb", "php", "swift", "lua", "vue", "svelte", "graphql", "proto", "r", "diff", "patch", "ipynb"]],
  ["doc", ["md", "markdown", "txt", "log", "pdf", "doc", "docx", "rtf", "odt", "pages", "tex", "epub"]],
  ["sheet", ["xlsx", "xlsm", "xls", "csv", "tsv", "ods", "numbers"]],
  ["slides", ["pptx", "ppt", "odp", "key"]],
  ["image", IMAGE_EXT],
  ["video", [...VIDEO_EXT, "mov", "mkv", "avi"]],
  ["audio", AUDIO_EXT],
  ["archive", ["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz"]],
];
export function fileCardInfo(name) {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const ext = fileExt(base);
  const stem = ext && base.length > ext.length + 1 ? base.slice(0, -(ext.length + 1)) : base;
  const hit = CARD_KINDS.find(([, list]) => list.includes(ext));
  const kind = hit?.[0] ?? "file";
  const label = t(`files.kind.${kind}`);
  return { kind, label, ext: ext.toUpperCase(), stem: stem || base, sub: ext ? `${label} · ${ext.toUpperCase()}` : label };
}

// Header name (FV-12): long names lose the MIDDLE, the extension stays.
export function middleEllipsis(name, max = 40) {
  const s = String(name ?? "");
  if (s.length <= max) return s;
  const ext = /\.[^.\s]{1,8}$/.exec(s)?.[0] ?? "";
  const room = Math.max(4, max - ext.length - 1);
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  const stem = s.slice(0, s.length - ext.length);
  return stem.slice(0, head) + "…" + (tail > 0 ? stem.slice(-tail) : "") + ext;
}

// Human type line for the viewer header: «Таблица Excel · 84 КБ».
const KIND_LABEL = {
  image: () => t("files.kind.image"), pdf: () => "PDF", html: () => t("files.type.html"), md: () => "Markdown",
  csv: () => t("files.type.csv"), xlsx: () => t("files.type.xlsx"), docx: () => t("files.type.docx"),
  video: () => t("files.kind.video"), audio: () => t("files.kind.audio"), text: () => t("files.type.text"),
  binary: () => t("files.kind.file"),
};
export function fileTypeLabel(name) {
  const kind = fileKindOf(name);
  const ext = fileExt(name);
  if (kind === "text" && ext) return t("files.type.textExt", { ext });
  if (kind === "binary" && ext) return t("files.type.binaryExt", { ext: ext.toUpperCase() });
  return KIND_LABEL[kind]?.() ?? t("files.kind.file");
}

// FV-03/FV-04: one honest error screen per cause. status: HTTP code, 0/null
// = network failure.
export function fileErrorInfo(status) {
  const s = Number(status) || 0;
  const info = (id, retry) => ({ title: t(`files.err.${id}.title`), text: t(`files.err.${id}.text`, { status: s }), retry });
  if (s === 404) return info("404", true);
  if (s === 403) return info("403", false);
  if (s === 401) return info("401", false);
  if (s >= 500) return info("5xx", true);
  if (s > 0) return info("other", true);
  return info("net", true);
}

// ---- CSV (FV-06/07) ------------------------------------------------------
// Delimiter sniffed from the first line outside quotes: Excel RU exports use
// «;», .tsv uses TAB, the rest «,».
export function detectCsvDelimiter(text, name = "") {
  if (fileExt(name) === "tsv") return "\t";
  const s = String(text ?? "");
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < s.length && i < 4096; i += 1) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "\n") break;
    else if (!quoted && c in counts) counts[c] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ",";
}

// RFC-4180-ish parse: quoted cells, escaped quotes, CRLF, BOM.
export function parseCsv(text, delim = ",") {
  const src = String(text ?? "").replace(/^﻿/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}

// Right-align numbers in tables: «1 234,5», «-12.3», «45%», «1e3».
export function isNumericCell(v) {
  const s = String(v ?? "").trim().replace(/[   ]/g, "");
  return s.length > 0 && /^[-+]?(\d+([.,]\d+)?|[.,]\d+)([eE][-+]?\d+)?%?$/.test(s);
}

// FV-19: a relative src/href inside a viewed markdown file resolves against
// that file's folder (and then goes through /api/file). Absolute URLs,
// anchors, data: and root paths are left alone (null).
export function resolveRelativePath(baseFile, rel) {
  const r = String(rel ?? "").trim();
  if (!r || /^[a-z][a-z0-9+.-]*:/i.test(r) || r.startsWith("#") || r.startsWith("/") || r.startsWith("\\") || r.startsWith("//")) return null;
  let clean = r.split("#")[0].split("?")[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {}
  if (!clean) return null;
  const base = String(baseFile ?? "");
  const sep = base.includes("\\") ? "\\" : "/";
  const dirParts = base.split(/[\\/]/).slice(0, -1);
  for (const seg of clean.split(/[\\/]/)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (dirParts.length > 1) dirParts.pop();
      continue;
    }
    dirParts.push(seg);
  }
  return dirParts.join(sep);
}

// ---- subagent-spawned sessions (junk in «Чаты») ----------------------------
// opencode itself marks tool-spawned sessions with parentID (= the chat that
// spawned them) and runs them under subagent-mode agents. Both are structural
// markers, unlike titles — a spawned session may carry ANY title («Find
// GitHub manual QA tester skills…» leaked past a title heuristic on
// 2026-11-01, user report). Hide on parentID; the agent-mode check covers
// records without a parent (belt and braces, fires once /agent loads).
export function isSubagentSession(s, agentList) {
  if (s?.parentID != null) return true;
  const known = agentList ?? [];
  if (known.length === 0) return false;
  const name = String(s?.agent ?? "");
  return known.some((a) => a.name === name && a.mode === "subagent");
}

// ---- MCP servers (live contract, opencode 1.19.5 GET /mcp) -----------------
// Response: Record<name, {status: "connected"|"disabled"|"failed"|
// "needs_auth"|"needs_client_registration", error?}>. The server type is NOT
// in the status payload (that lives in GET /config → mcp) — we only surface
// name + state here.

export function normalizeMcp(resp) {
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) return [];
  return Object.entries(resp)
    .filter(([, st]) => st != null && typeof st === "object")
    .map(([name, st]) => ({
      name,
      status: typeof st.status === "string" ? st.status : "unknown",
      error: typeof st.error === "string" ? st.error : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
