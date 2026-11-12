// BUG-189 (BUG-16.5): перенос истории чатов opencode 1.x в отдельную базу 2.x.
//
// Конвертацию 1.x → 2.x делает сам opencode 2.2.6 (встроенный мигратор
// /api/experimental/migration/v1). Он работает только внутри одной базы, поэтому:
//   1) prepareSnapshot — снимок базы 1.x (VACUUM INTO) без следа прошлого
//      пробного запуска 2.2.5 (иначе мигратор считает работу сделанной);
//   2) снимок конвертирует opencode 2.2.6 (ops/opencode/oc2-migrate-v1.mjs);
//   3) mergeSessions — вливание результата в рабочую базу v2 по образцу
//      встроенного импорта opencode-next.db: INSERT OR IGNORE проектов, только
//      новые session_v2 + их сообщения/части + водяной знак event_sequence.
//      Существующие в цели сессии не трогаются — повторный запуск безопасен.
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";

const MIGRATION_KEY = "migration.v1-v2";

const q = (name) => `"${String(name).replaceAll('"', '""')}"`;

function columns(db, schema, table) {
  // схема — вторым аргументом: префикс `src.pragma_table_info` ищет таблицу по всем базам
  return db.prepare("SELECT name FROM pragma_table_info(?, ?)").all(table, schema).map((r) => r.name);
}

function hasTable(db, schema, table) {
  return !!db.prepare(`SELECT 1 FROM ${q(schema)}.sqlite_master WHERE type = 'table' AND name = ?`).get(table);
}

// Общие колонки источника и цели: схема 2.x между сборками дополняется
// ALTER TABLE ADD, а лишние/недостающие колонки не должны ронять перенос.
function commonColumns(db, table) {
  const dst = new Set(columns(db, "main", table));
  return columns(db, "src", table).filter((c) => dst.has(c));
}

/**
 * Снимок базы 1.x для конвертации. Источник открывается только на чтение.
 * @returns {{sessions:number, cleared:{session_v2:number}}}
 */
export function prepareSnapshot(srcPath, dstPath) {
  if (!existsSync(srcPath)) throw new Error(`source db not found: ${srcPath}`);
  for (const sfx of ["", "-wal", "-shm"]) rmSync(dstPath + sfx, { force: true });
  const src = new DatabaseSync(srcPath, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${dstPath.replaceAll("'", "''")}'`);
  } finally {
    src.close();
  }
  const db = new DatabaseSync(dstPath);
  try {
    if (!hasTable(db, "main", "session")) throw new Error("source is not an opencode 1.x db (no session table)");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN");
    let cleared = 0;
    if (hasTable(db, "main", "session_v2")) {
      if (hasTable(db, "main", "event_sequence")) {
        db.exec("DELETE FROM event_sequence WHERE aggregate_id IN (SELECT id FROM session_v2)");
      }
      cleared = Number(db.prepare("SELECT COUNT(*) AS c FROM session_v2").get().c);
      db.exec("DELETE FROM session_v2"); // каскадом session_message/session_part/…
    }
    if (hasTable(db, "main", "kv")) db.prepare("DELETE FROM kv WHERE key = ?").run(MIGRATION_KEY);
    db.exec("COMMIT");
    const sessions = Number(db.prepare("SELECT COUNT(*) AS c FROM session").get().c);
    return { sessions, cleared: { session_v2: cleared } };
  } finally {
    db.close();
  }
}

/**
 * Вливание сконвертированных сессий из srcPath в базу targetPath.
 * @param {{dryRun?: boolean, busyTimeoutMs?: number}} [opts]
 * @returns {{projects:number, sessions:number, skipped:number, messages:number, parts:number, sequences:number}}
 */
export function mergeSessions(srcPath, targetPath, { dryRun = false, busyTimeoutMs = 15000 } = {}) {
  if (!existsSync(srcPath)) throw new Error(`converted db not found: ${srcPath}`);
  if (!existsSync(targetPath)) throw new Error(`target db not found: ${targetPath}`);
  const db = new DatabaseSync(targetPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, busyTimeoutMs | 0)}`);
    db.exec(`ATTACH DATABASE '${srcPath.replaceAll("'", "''")}' AS src`);
    for (const t of ["project", "session_v2", "session_message"]) {
      if (!hasTable(db, "src", t)) throw new Error(`converted db has no ${t} — run convert first`);
      if (!hasTable(db, "main", t)) throw new Error(`target db has no ${t} — not an opencode 2.x db`);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const stats = { projects: 0, sessions: 0, skipped: 0, messages: 0, parts: 0, sequences: 0 };
      const changes = () => Number(db.prepare("SELECT changes() AS c").get().c);

      const pc = commonColumns(db, "project").map(q).join(", ");
      db.exec(`INSERT OR IGNORE INTO main.project (${pc}) SELECT ${pc} FROM src.project`);
      stats.projects = changes();

      // Новые = сессии источника, которых нет в цели. Список фиксируется ДО
      // вставки: по нему же переносятся сообщения, части и водяной знак.
      db.exec("CREATE TEMP TABLE zai_new_sessions (id TEXT PRIMARY KEY)");
      db.exec("INSERT INTO temp.zai_new_sessions SELECT id FROM src.session_v2 WHERE id NOT IN (SELECT id FROM main.session_v2)");
      stats.sessions = Number(db.prepare("SELECT COUNT(*) AS c FROM temp.zai_new_sessions").get().c);
      stats.skipped = Number(db.prepare("SELECT COUNT(*) AS c FROM src.session_v2").get().c) - stats.sessions;

      const sc = commonColumns(db, "session_v2").map(q).join(", ");
      db.exec(`INSERT INTO main.session_v2 (${sc}) SELECT ${sc} FROM src.session_v2 WHERE id IN (SELECT id FROM temp.zai_new_sessions)`);

      const mc = commonColumns(db, "session_message").map(q).join(", ");
      db.exec(`INSERT OR IGNORE INTO main.session_message (${mc}) SELECT ${mc} FROM src.session_message WHERE session_id IN (SELECT id FROM temp.zai_new_sessions)`);
      stats.messages = changes();

      if (hasTable(db, "src", "session_part") && hasTable(db, "main", "session_part")) {
        const xc = commonColumns(db, "session_part").map(q).join(", ");
        db.exec(`INSERT OR IGNORE INTO main.session_part (${xc}) SELECT ${xc} FROM src.session_part WHERE session_id IN (SELECT id FROM temp.zai_new_sessions)`);
        stats.parts = changes();
      }

      // Водяной знак: seq из источника, иначе последний seq сообщений (как
      // встроенный импорт: seq последнего сообщения, -1 у пустой сессии).
      if (hasTable(db, "main", "event_sequence")) {
        const fromSrc = hasTable(db, "src", "event_sequence")
          ? "(SELECT seq FROM src.event_sequence e WHERE e.aggregate_id = n.id)"
          : "NULL";
        db.exec(`INSERT INTO main.event_sequence (aggregate_id, seq, owner_id)
          SELECT n.id, COALESCE(${fromSrc}, (SELECT MAX(seq) FROM src.session_message m WHERE m.session_id = n.id), -1), NULL
          FROM temp.zai_new_sessions n WHERE true
          ON CONFLICT(aggregate_id) DO UPDATE SET seq = excluded.seq, owner_id = NULL`);
        stats.sequences = changes();
      }

      db.exec("DROP TABLE temp.zai_new_sessions");
      db.exec(dryRun ? "ROLLBACK" : "COMMIT");
      return stats;
    } catch (err) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    try { db.exec("DETACH DATABASE src"); } catch {}
    db.close();
  }
}

/** Счётчики для сверки: сессии и сообщения по id сессий источника. */
export function countSessions(dbPath, table = "session_v2") {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sessions = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${q(table)}`).get().c);
    const msgTable = table === "session" ? "message" : "session_message";
    const messages = hasTable(db, "main", msgTable) ? Number(db.prepare(`SELECT COUNT(*) AS c FROM ${q(msgTable)}`).get().c) : 0;
    return { sessions, messages };
  } finally {
    db.close();
  }
}
