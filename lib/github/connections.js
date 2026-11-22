// FEAT-20.3 (1.3/1.4): хранилище подключений GitHub — data/github-triggers.sqlite.
// Схема design.md; таблицы триггеров/inbox/журнала достраивают ту же базу.
// token_enc хранится только шифрованым (lib/github/secrets.js); наружу — last4.
import { createRequire } from "node:module";

export function connectionService(databasePath, { now = () => Date.now() } = {}) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS connections(
      owner TEXT PRIMARY KEY, login TEXT NOT NULL, token_enc TEXT NOT NULL, token_last4 TEXT NOT NULL,
      expires_at INTEGER, permissions_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL,
      checked_at INTEGER NOT NULL, warned_at INTEGER, expired_notified_at INTEGER,
      revision INTEGER NOT NULL DEFAULT 1)`);
  const projection = `SELECT owner, login, token_enc AS tokenEnc, token_last4 AS tokenLast4, expires_at AS expiresAt,
    permissions_json AS permissions, status, checked_at AS checkedAt, warned_at AS warnedAt,
    expired_notified_at AS expiredNotifiedAt, revision FROM connections`;
  const parse = (row) => row && { ...row, permissions: safeJson(row.permissions) };
  const safeJson = (s) => {
    try { return JSON.parse(s) ?? {}; } catch { return {}; }
  };
  // Колонки, доступные update(); permissions идёт как объект → permissions_json.
  const COLUMN = {
    login: "login", tokenEnc: "token_enc", tokenLast4: "token_last4", expiresAt: "expires_at",
    permissions: "permissions_json", status: "status", checkedAt: "checked_at",
    warnedAt: "warned_at", expiredNotifiedAt: "expired_notified_at",
  };

  function get(owner) {
    return parse(db.prepare(`${projection} WHERE owner=?`).get(owner) ?? null);
  }
  // Новое подключение: предупреждения сбрасываются — свежий токен не «истекает».
  function save(owner, rec) {
    db.prepare(`INSERT INTO connections(owner, login, token_enc, token_last4, expires_at, permissions_json, status, checked_at, warned_at, expired_notified_at, revision)
      VALUES(?,?,?,?,?,?,?,?,NULL,NULL,1)
      ON CONFLICT(owner) DO UPDATE SET login=excluded.login, token_enc=excluded.token_enc, token_last4=excluded.token_last4,
        expires_at=excluded.expires_at, permissions_json=excluded.permissions_json, status=excluded.status,
        checked_at=excluded.checked_at, warned_at=NULL, expired_notified_at=NULL, revision=connections.revision+1`)
      .run(owner, rec.login, rec.tokenEnc, rec.tokenLast4, rec.expiresAt ?? null, JSON.stringify(rec.permissions ?? {}), rec.status, rec.checkedAt ?? now());
    return get(owner);
  }
  function update(owner, fields) {
    const sets = [];
    const args = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = COLUMN[k];
      if (!col) continue;
      sets.push(`${col}=?`);
      args.push(k === "permissions" ? JSON.stringify(v) : v);
    }
    if (!sets.length) return get(owner);
    args.push(owner);
    db.prepare(`UPDATE connections SET ${sets.join(", ")} WHERE owner=?`).run(...args);
    return get(owner);
  }
  function remove(owner) {
    return db.prepare("DELETE FROM connections WHERE owner=?").run(owner).changes > 0;
  }
  // Список без шифротокенов (admin-обзор) — секрет остаётся в get().
  function list() {
    return db.prepare(`SELECT owner, login, token_last4 AS tokenLast4, expires_at AS expiresAt,
      permissions_json AS permissions, status, checked_at AS checkedAt, warned_at AS warnedAt,
      expired_notified_at AS expiredNotifiedAt, revision FROM connections ORDER BY owner`).all().map(parse);
  }
  // Для часового обхода (watchdog): с tokenEnc, чтобы перепроверить токен у GitHub.
  function listWithTokens() {
    return db.prepare(`${projection} ORDER BY owner`).all().map(parse);
  }
  function count() {
    return db.prepare("SELECT COUNT(*) AS n FROM connections").get().n;
  }
  // Ротация ключа (кр. 1): map(старый tokenEnc, owner) → новый tokenEnc.
  function rotateSecrets(map) {
    const rows = db.prepare("SELECT owner, token_enc FROM connections").all();
    for (const row of rows) {
      db.prepare("UPDATE connections SET token_enc=? WHERE owner=?").run(map(row.token_enc, row.owner), row.owner);
    }
    return rows.length;
  }
  return { get, save, update, remove, list, listWithTokens, count, rotateSecrets };
}
