#!/usr/bin/env node
// BUG-189 (BUG-16.5): перенос истории чатов opencode 1.x в отдельную базу opencode 2.x.
//
//   node ops/opencode/oc2-migrate-v1.mjs --target=<opencode.db v2> [--step=all|snapshot|convert|merge|verify]
//        [--source=C:\Users\USER\.local\share\opencode\opencode.db] [--work=D:\zai-tmp-scripts\oc2-migrate]
//        [--bin=D:\Portal\zai-oc2\bin\opencode.exe] [--port=4197] [--dry-run]
//
// Шаги:
//   snapshot — VACUUM INTO базы 1.x в <work>\data\opencode\opencode.db + сброс следа пробного 2.2.5;
//   convert  — временный serve 2.2.6 на снимке (своя зона XDG, порт --port, пустой конфиг —
//              без плагинов и MCP), встроенная миграция POST /api/experimental/migration/v1;
//   merge    — резервная копия цели (<target>.pre-v1-merge-<время>.db) и вливание (lib/oc2-migrate.js);
//   verify   — сверка: каждая сессия 1.x есть в цели, число сообщений > 0 там, где они были.
// База 1.x только читается. Ход модели не запускается, ключи провайдера не нужны.
// Лог — <work>\migrate.log (без секретов: пароль временного serve случайный и не пишется).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { countSessions, mergeSessions, prepareSnapshot } from "../../lib/oc2-migrate.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const SOURCE = args.source ?? "C:\\Users\\USER\\.local\\share\\opencode\\opencode.db";
const WORK = args.work ?? "D:\\zai-tmp-scripts\\oc2-migrate";
const BIN = args.bin ?? "D:\\Portal\\zai-oc2\\bin\\opencode.exe";
const PORT = Number(args.port ?? 4197);
const TARGET = args.target;
const STEP = args.step ?? "all";
const DRY = !!args["dry-run"];
const SNAP = path.join(WORK, "data", "opencode", "opencode.db");
const LOG = path.join(WORK, "migrate.log");

mkdirSync(path.dirname(SNAP), { recursive: true });
const log = (msg, obj) => {
  const line = `${new Date().toISOString()} ${msg}${obj === undefined ? "" : " " + JSON.stringify(obj)}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
};

const PROD_PORTS = new Set([4096, 4097, 4098, 4100, 4101, 4170, 4172, 4174, 4196]);

async function convert() {
  if (PROD_PORTS.has(PORT)) throw new Error(`port ${PORT} belongs to a live service`);
  if (!existsSync(BIN)) throw new Error(`opencode binary not found: ${BIN}`);
  if (!existsSync(SNAP)) throw new Error(`snapshot not found: ${SNAP} — run --step=snapshot`);
  const cfg = path.join(WORK, "config", "opencode");
  mkdirSync(cfg, { recursive: true });
  // пустой конфиг: ни плагинов, ни MCP, ни автообновления
  writeFileSync(path.join(cfg, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", update: "disable" }, null, 2));
  for (const d of ["state", "home"]) mkdirSync(path.join(WORK, d), { recursive: true });
  const password = randomBytes(18).toString("base64url");
  const auth = "Basic " + Buffer.from("opencode:" + password).toString("base64");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(WORK, "config"),
    XDG_DATA_HOME: path.join(WORK, "data"),
    XDG_STATE_HOME: path.join(WORK, "state"),
    HOME: path.join(WORK, "home"),
    USERPROFILE: path.join(WORK, "home"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_SERVER_PASSWORD: password,
  };
  delete env.OPENCODE_CONFIG;
  delete env.OPENCODE_DB;
  log("convert: start serve", { bin: BIN, port: PORT, data: env.XDG_DATA_HOME });
  const child = spawn(BIN, ["serve", "--hostname", "127.0.0.1", "--port", String(PORT)], {
    env, cwd: WORK, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const out = [];
  child.stdout.on("data", (d) => out.push(String(d)));
  child.stderr.on("data", (d) => out.push(String(d)));
  const base = `http://127.0.0.1:${PORT}`;
  const call = async (method, p) => {
    const r = await fetch(base + p, { method, headers: { authorization: auth, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  try {
    const t0 = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new Error(`serve exited ${child.exitCode}: ${out.join("").slice(-800)}`);
      try { if ((await call("GET", "/api/experimental/migration/v1")).status === 200) break; } catch {}
      if (Date.now() - t0 > 90_000) throw new Error("serve did not become healthy in 90 s");
      await new Promise((r) => setTimeout(r, 1000));
    }
    // 2.2.6 запускает миграцию V1 сам при старте (живьём 2026-11-08: сразу
    // «running», POST на этот адрес — 404). Ждём completed/idle.
    let st = await call("GET", "/api/experimental/migration/v1");
    log("convert: status at start", st.body);
    if (st.body?.status !== "completed") {
      const t1 = Date.now();
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        st = await call("GET", "/api/experimental/migration/v1");
        if (st.body?.status === "completed") break;
        if (st.body?.status === "error") throw new Error("v1 migration failed: " + JSON.stringify(st.body));
        if (st.body?.status === "idle" || st.body?.status === "required") {
          // idle = фоновая задача закончилась; проверяем по таблице
          if (countSessions(SNAP).sessions > 0 && st.body?.status === "idle") break;
        }
        if (Date.now() - t1 > 20 * 60_000) throw new Error("v1 migration did not finish in 20 min: " + JSON.stringify(st.body));
        if ((Date.now() - t1) % 20_000 < 2100) log("convert: progress", st.body);
      }
    }
    log("convert: done", { status: st.body, converted: countSessions(SNAP), v1: countSessions(SNAP, "session") });
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
    const tail = out.join("").split(/\r?\n/).filter((l) => /migrat|error|warn/i.test(l)).slice(-30);
    if (tail.length) log("convert: serve log (migration/warn/error lines)", tail);
  }
}

function merge() {
  if (!TARGET) throw new Error("--target=<opencode.db v2> is required");
  if (path.resolve(TARGET).toLowerCase() === path.resolve(SOURCE).toLowerCase()) throw new Error("target must not be the 1.x db");
  if (!DRY) {
    const bak = `${TARGET}.pre-v1-merge-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
    const db = new DatabaseSync(TARGET, { readOnly: true });
    try { db.exec(`VACUUM INTO '${bak.replaceAll("'", "''")}'`); } finally { db.close(); }
    log("merge: target backup", { backup: bak });
  }
  const before = countSessions(TARGET);
  const stats = mergeSessions(SNAP, TARGET, { dryRun: DRY });
  log(DRY ? "merge: dry-run" : "merge: done", { target: TARGET, before, stats, after: countSessions(TARGET) });
}

function verify() {
  if (!TARGET) throw new Error("--target=<opencode.db v2> is required");
  const src = new DatabaseSync(SOURCE, { readOnly: true });
  const v1 = src.prepare("SELECT s.id, s.directory, s.title, (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msgs FROM session s").all();
  src.close();
  const db = new DatabaseSync(TARGET, { readOnly: true });
  const get = db.prepare("SELECT directory, title, (SELECT COUNT(*) FROM session_message m WHERE m.session_id = s.id) AS msgs FROM session_v2 s WHERE id = ?");
  const missing = [], empty = [], moved = [];
  const byDir = {};
  for (const s of v1) {
    const t = get.get(s.id);
    if (!t) { missing.push(s.id); continue; }
    if (s.msgs > 0 && t.msgs === 0) empty.push(s.id);
    if (String(t.directory).toLowerCase() !== String(s.directory).toLowerCase()) moved.push({ id: s.id, from: s.directory, to: t.directory });
    byDir[t.directory] = (byDir[t.directory] ?? 0) + 1;
  }
  db.close();
  const ok = missing.length === 0 && empty.length === 0;
  log(`verify: ${ok ? "OK" : "FAIL"}`, { v1: v1.length, missing, empty, moved, byDir });
  if (!ok) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    log(`run step=${STEP}${DRY ? " dry-run" : ""}`, { source: SOURCE, work: WORK, target: TARGET ?? null });
    if (STEP === "all" || STEP === "snapshot") log("snapshot", prepareSnapshot(SOURCE, SNAP));
    if (STEP === "all" || STEP === "convert") await convert();
    if (STEP === "all" || STEP === "merge") merge();
    if (STEP === "all" || STEP === "verify") verify();
  } catch (err) {
    log("FAILED", { error: String(err?.stack ?? err) });
    process.exitCode = 2;
  }
}
