// FEAT-01.60: серверный полнотекстовый индекс сообщений чатов (opencode + Claude/Codex/ACP).
// Хранится в data/chat-search.sqlite (node:sqlite, WAL, FTS5 trigram case_sensitive 0) —
// полностью производный индекс: при удалении файла перестраивается автоматически.
// В индекс попадают только чистые тексты вопросов пользователя (typedText: без
// [obsidian-cache], [SYSTEM DIRECTIVE:], OMO-тегов) и финальные текстовые части ответов
// (part.type === "text", !synthetic; tool и reasoning исключены).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { typedText } from "../shared/title.js";

const require = createRequire(import.meta.url);

export const MAX_QUERY_LEN = 200;
export const MAX_WORDS = 8;
export const SNIPPET_LEN = 140;
const MAX_CANDIDATES_FTS = 1500;
const MAX_CANDIDATES_SHORT = 6000;

function ms(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

// Чистая: извлекает индексируемый текст из сообщения портала ({info, parts}).
// Вопросы очищаются через typedText (без [obsidian-cache] и директив);
// ответы — только видимые text-части (без tool/reasoning/synthetic).
export function extractMessageText(msg) {
  const info = msg?.info;
  const role = info?.role;
  if (role !== "user" && role !== "assistant") return null;
  const mid = typeof info?.id === "string" && info.id ? info.id : null;
  if (!mid) return null;
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  const texts = [];
  for (const p of parts) {
    if (p?.type !== "text" || p.synthetic) continue;
    if (typeof p.text !== "string" || !p.text.trim()) continue;
    texts.push(p.text);
  }
  if (texts.length === 0) return null;
  const joined = texts.join("\n");
  const clean = role === "user"
    ? typedText(joined)
    : joined.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const created = ms(info?.time?.created ?? info?.time?.completed);
  return { mid, role, created, text: clean };
}

// Чистая: разбор поискового запроса на слова и FTS5-термы (trigram требует ≥ 3 символов).
export function tokenizeQuery(q) {
  const raw = String(q ?? "").trim().slice(0, MAX_QUERY_LEN);
  if (!raw) return { raw: "", words: [], ftsQuery: null };
  const seen = new Set();
  const words = [];
  for (const w of raw.toLowerCase().split(/\s+/)) {
    if (!w || seen.has(w)) continue;
    seen.add(w);
    words.push(w);
    if (words.length >= MAX_WORDS) break;
  }
  const ftsTerms = words
    .filter((w) => [...w].length >= 3)
    .map((w) => '"' + w.replace(/"/g, '""') + '"');
  return {
    raw,
    words,
    ftsQuery: ftsTerms.length > 0 ? ftsTerms.join(" AND ") : null,
  };
}

// Чистая: строит фрагмент текста вокруг первого совпадения слова из запроса.
export function buildSnippet(text, words, maxLen = SNIPPET_LEN) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length <= maxLen) return s;
  const low = s.toLowerCase();
  let hitIdx = -1;
  for (const w of words ?? []) {
    if (!w) continue;
    const i = low.indexOf(w.toLowerCase());
    if (i >= 0 && (hitIdx < 0 || i < hitIdx)) hitIdx = i;
  }
  if (hitIdx < 0) hitIdx = 0;
  const lead = Math.floor(maxLen * 0.35);
  let start = Math.max(0, hitIdx - lead);
  if (start > 0) {
    const sp = s.indexOf(" ", start);
    if (sp > start && sp < hitIdx) start = sp + 1;
  }
  let end = Math.min(s.length, start + maxLen);
  if (end < s.length) {
    const sp = s.lastIndexOf(" ", end);
    if (sp > Math.max(start + 20, hitIdx)) end = sp;
  }
  return (start > 0 ? "…" : "") + s.slice(start, end).trim() + (end < s.length ? "…" : "");
}

function claudeSignature(msgs) {
  if (!Array.isArray(msgs) || msgs.length === 0) return "0";
  let chars = 0;
  let lastId = "";
  for (const m of msgs) {
    lastId = m?.info?.id ?? lastId;
    for (const p of m?.parts ?? []) {
      if (p?.type === "text" && typeof p.text === "string") chars += p.text.length;
    }
  }
  return `${msgs.length}:${lastId}:${chars}`;
}

function sessionUpdatedMs(s) {
  return ms(s?.time?.updated ?? s?.time?.created);
}

const sleep = (delay) => new Promise((r) => setTimeout(r, delay));

export class ChatSearchIndex {
  #db = null;
  #dbPath;
  #log;
  #now;
  #deps;
  #dirty = new Set();
  #stopped = false;
  #bgPromise = null;
  #bgTimer = null;
  #error = null;
  #total = 0;
  #indexed = 0;
  #ready = false;
  #stmts = null;

  constructor({ dbPath, log = () => {}, now = Date.now, deps = {} } = {}) {
    this.#dbPath = dbPath;
    this.#log = log;
    this.#now = now;
    this.#deps = {
      ocSessions: null,
      ocMessages: null,
      claudeSessions: null,
      batchSize: 6,
      pauseMs: 25,
      ...deps,
    };
    this.#open();
  }

  get db() {
    return this.#db;
  }

  #open() {
    if (!this.#dbPath) return;
    try {
      if (this.#dbPath !== ":memory:") mkdirSync(path.dirname(this.#dbPath), { recursive: true });
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(this.#dbPath);
      db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sid TEXT NOT NULL,
          source TEXT NOT NULL,
          mid TEXT NOT NULL,
          role TEXT NOT NULL,
          created INTEGER NOT NULL,
          text TEXT NOT NULL,
          UNIQUE(sid, source, mid)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_sid_created ON messages(sid, created DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created DESC);
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          text,
          content='messages',
          content_rowid='id',
          tokenize='trigram case_sensitive 0'
        );
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
          INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
        END;
        CREATE TABLE IF NOT EXISTS sessions_sync (
          sid TEXT PRIMARY KEY,
          oc_updated INTEGER NOT NULL DEFAULT 0,
          claude_sig TEXT NOT NULL DEFAULT '',
          indexed_at INTEGER NOT NULL DEFAULT 0
        );
      `);
      this.#db = db;
      this.#stmts = {
        getSync: db.prepare("SELECT oc_updated, claude_sig FROM sessions_sync WHERE sid = ?"),
        upsertSync: db.prepare(`
          INSERT INTO sessions_sync(sid, oc_updated, claude_sig, indexed_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(sid) DO UPDATE SET
            oc_updated = excluded.oc_updated,
            claude_sig = excluded.claude_sig,
            indexed_at = excluded.indexed_at
        `),
        delSource: db.prepare("DELETE FROM messages WHERE sid = ? AND source = ?"),
        insMsg: db.prepare("INSERT OR REPLACE INTO messages(sid, source, mid, role, created, text) VALUES (?, ?, ?, ?, ?, ?)"),
        delSidMsgs: db.prepare("DELETE FROM messages WHERE sid = ?"),
        delSidSync: db.prepare("DELETE FROM sessions_sync WHERE sid = ?"),
        resetOcUpdated: db.prepare("UPDATE sessions_sync SET oc_updated = 0 WHERE sid = ?"),
        searchFts: db.prepare(`
          SELECT m.sid, m.mid, m.role, m.created, m.text
          FROM messages_fts f
          JOIN messages m ON m.id = f.rowid
          WHERE messages_fts MATCH ?
          ORDER BY m.created DESC
          LIMIT ?
        `),
        searchShort: db.prepare(`
          SELECT sid, mid, role, created, text
          FROM messages
          ORDER BY created DESC
          LIMIT ?
        `),
      };
      this.#error = null;
    } catch (err) {
      this.#error = String(err?.message ?? err).slice(0, 200);
      this.#log(`[teleharness-search] open failed: ${this.#error}`);
      this.#db = null;
      this.#stmts = null;
    }
  }

  status() {
    return {
      ready: this.#ready,
      indexed: this.#indexed,
      total: this.#total,
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  // Заменяет индексированные сообщения одного источника (oc или claude) для сессии sid.
  replaceSourceMessages(sid, source, messages, { ocUpdated = null, claudeSig = null } = {}) {
    if (!this.#db || !sid) return;
    const rows = [];
    for (const m of Array.isArray(messages) ? messages : []) {
      const ex = extractMessageText(m);
      if (ex) rows.push(ex);
    }
    try {
      const prev = this.#stmts.getSync.get(sid) ?? { oc_updated: 0, claude_sig: "" };
      const nextOc = ocUpdated != null ? ocUpdated : prev.oc_updated;
      const nextClaude = claudeSig != null ? claudeSig : prev.claude_sig;
      this.#db.exec("BEGIN");
      try {
        this.#stmts.delSource.run(sid, source);
        for (const r of rows) {
          this.#stmts.insMsg.run(sid, source, r.mid, r.role, r.created, r.text);
        }
        this.#stmts.upsertSync.run(sid, nextOc, nextClaude, this.#now());
        this.#db.exec("COMMIT");
      } catch (err) {
        try { this.#db.exec("ROLLBACK"); } catch {}
        throw err;
      }
      this.#dirty.delete(sid);
    } catch (err) {
      this.#log(`[teleharness-search] index ${sid} (${source}) failed: ${err?.message ?? err}`);
    }
  }

  syncClaudeSession(sid, messages) {
    if (!this.#db || !sid) return false;
    const list = Array.isArray(messages) ? messages : [];
    const sig = claudeSignature(list);
    try {
      const prev = this.#stmts.getSync.get(sid);
      if (prev && prev.claude_sig === sig && !this.#dirty.has(sid)) return false;
    } catch {}
    this.replaceSourceMessages(sid, "claude", list, { claudeSig: sig });
    return true;
  }

  syncAllClaude() {
    if (!this.#db || typeof this.#deps.claudeSessions !== "function") return 0;
    let changed = 0;
    try {
      const map = this.#deps.claudeSessions() ?? {};
      for (const [sid, entry] of Object.entries(map)) {
        if (this.syncClaudeSession(sid, entry?.messages ?? [])) changed += 1;
      }
    } catch (err) {
      this.#log(`[teleharness-search] syncAllClaude failed: ${err?.message ?? err}`);
    }
    return changed;
  }

  async syncOcSession(sid, { directory = null, updated = 0, force = false } = {}) {
    if (!this.#db || !sid || typeof this.#deps.ocMessages !== "function") return false;
    const targetUpdated = Math.max(Number(updated) || 0, 1);
    if (!force && !this.#dirty.has(sid)) {
      try {
        const prev = this.#stmts.getSync.get(sid);
        if (prev && prev.oc_updated >= targetUpdated) return false;
      } catch {}
    }
    const msgs = await this.#deps.ocMessages(sid, directory);
    if (!Array.isArray(msgs)) return false;
    this.replaceSourceMessages(sid, "oc", msgs, { ocUpdated: targetUpdated });
    return true;
  }

  markDirty(sid) {
    if (!sid) return;
    this.#dirty.add(sid);
    if (this.#db) {
      try { this.#stmts.resetOcUpdated.run(sid); } catch {}
    }
  }

  forget(sid) {
    if (!sid) return;
    this.#dirty.delete(sid);
    if (!this.#db) return;
    try {
      this.#db.exec("BEGIN");
      try {
        this.#stmts.delSidMsgs.run(sid);
        this.#stmts.delSidSync.run(sid);
        this.#db.exec("COMMIT");
      } catch (err) {
        try { this.#db.exec("ROLLBACK"); } catch {}
        throw err;
      }
    } catch (err) {
      this.#log(`[teleharness-search] forget ${sid} failed: ${err?.message ?? err}`);
    }
  }

  // Фоновая первичная индексация всех сессий (не блокирует запуск портала).
  start() {
    if (this.#stopped || !this.#db || this.#bgPromise) return this.#bgPromise;
    this.#bgPromise = (async () => {
      try {
        this.syncAllClaude();
        if (typeof this.#deps.ocSessions !== "function" || typeof this.#deps.ocMessages !== "function") {
          this.#ready = true;
          return;
        }
        let list = [];
        try {
          list = (await this.#deps.ocSessions()) ?? [];
        } catch (err) {
          this.#log(`[teleharness-search] ocSessions failed: ${err?.message ?? err}`);
          this.#scheduleRetry();
          return;
        }
        const sorted = [...list]
          .filter((s) => typeof s?.id === "string" && s.id)
          .sort((a, b) => sessionUpdatedMs(b) - sessionUpdatedMs(a));
        this.#total = sorted.length;
        this.#indexed = 0;
        const batch = Math.max(1, this.#deps.batchSize);
        for (let i = 0; i < sorted.length; i += batch) {
          if (this.#stopped) return;
          const slice = sorted.slice(i, i + batch);
          await Promise.all(slice.map(async (s) => {
            if (this.#stopped) return;
            try {
              await this.syncOcSession(s.id, { directory: s.directory ?? null, updated: sessionUpdatedMs(s) });
            } catch {}
            this.#indexed += 1;
          }));
          if (this.#deps.pauseMs > 0 && i + batch < sorted.length) await sleep(this.#deps.pauseMs);
        }
        this.#ready = true;
      } finally {
        this.#bgPromise = null;
      }
    })();
    return this.#bgPromise;
  }

  #scheduleRetry() {
    if (this.#stopped || this.#bgTimer) return;
    this.#bgTimer = setTimeout(() => {
      this.#bgTimer = null;
      if (!this.#stopped) this.start();
    }, 30_000);
    this.#bgTimer.unref?.();
  }

  // Быстрая синхронизация свежих/грязных сессий перед выдачей поиска.
  async ensureFresh(allowedSessions, { budget = 15, timeoutMs = 2500 } = {}) {
    if (!this.#db) return;
    this.syncAllClaude();
    if (typeof this.#deps.ocMessages !== "function" || !Array.isArray(allowedSessions) || allowedSessions.length === 0) return;
    const stale = [];
    for (const s of allowedSessions) {
      if (!s?.id) continue;
      const upd = sessionUpdatedMs(s);
      let need = this.#dirty.has(s.id);
      if (!need) {
        try {
          const prev = this.#stmts.getSync.get(s.id);
          if (!prev || prev.oc_updated < Math.max(upd, 1)) need = true;
        } catch {
          need = true;
        }
      }
      if (need) stale.push({ id: s.id, directory: s.directory ?? null, updated: upd, dirty: this.#dirty.has(s.id) });
    }
    if (stale.length === 0) return;
    stale.sort((a, b) => (b.dirty - a.dirty) || (b.updated - a.updated));
    const slice = stale.slice(0, budget);
    const deadline = this.#now() + timeoutMs;
    const conc = 4;
    for (let i = 0; i < slice.length; i += conc) {
      if (this.#stopped || this.#now() >= deadline) break;
      await Promise.all(slice.slice(i, i + conc).map(async (item) => {
        try {
          await this.syncOcSession(item.id, { directory: item.directory, updated: item.updated, force: item.dirty });
        } catch {}
      }));
    }
  }

  search(query, { allowedIds, limit = 30 } = {}) {
    const { raw, words, ftsQuery } = tokenizeQuery(query);
    if (!this.#db) return { query: raw, hits: [], indexing: this.status(), unavailable: true };
    const allowed = allowedIds instanceof Set ? allowedIds : new Set(Array.isArray(allowedIds) ? allowedIds : []);
    if (!raw || words.length === 0 || allowed.size === 0) {
      return { query: raw, hits: [], indexing: this.status() };
    }
    const maxHits = Math.min(Math.max(Number(limit) || 30, 1), 100);
    let rows = [];
    try {
      if (ftsQuery) {
        rows = this.#stmts.searchFts.all(ftsQuery, MAX_CANDIDATES_FTS);
      } else {
        rows = this.#stmts.searchShort.all(MAX_CANDIDATES_SHORT);
      }
    } catch (err) {
      this.#log(`[teleharness-search] query failed: ${err?.message ?? err}`);
      try {
        rows = this.#stmts.searchShort.all(MAX_CANDIDATES_SHORT);
      } catch {
        return { query: raw, hits: [], indexing: this.status(), unavailable: true };
      }
    }

    const bySession = new Map();
    for (const r of rows) {
      if (!allowed.has(r.sid)) continue;
      const low = r.text.toLowerCase();
      let allMatch = true;
      for (const w of words) {
        if (!low.includes(w)) { allMatch = false; break; }
      }
      if (!allMatch) continue;
      const existing = bySession.get(r.sid);
      if (!existing) {
        bySession.set(r.sid, {
          sessionId: r.sid,
          messageId: r.mid,
          role: r.role,
          created: r.created,
          snippet: buildSnippet(r.text, words),
          matchCount: 1,
        });
      } else {
        existing.matchCount += 1;
        if (r.created > existing.created) {
          existing.messageId = r.mid;
          existing.role = r.role;
          existing.created = r.created;
          existing.snippet = buildSnippet(r.text, words);
        }
      }
    }

    const hits = [...bySession.values()]
      .sort((a, b) => b.created - a.created)
      .slice(0, maxHits);

    return { query: raw, hits, indexing: this.status() };
  }

  stop() {
    this.#stopped = true;
    if (this.#bgTimer) {
      clearTimeout(this.#bgTimer);
      this.#bgTimer = null;
    }
    try { this.#db?.close(); } catch {}
    this.#db = null;
    this.#stmts = null;
  }
}
