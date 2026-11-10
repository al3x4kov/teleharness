// FEAT-01.57 «Изменить» / «Сгенерировать заново» and FEAT-01.58 «Отменить
// ход» end-to-end: the REAL server.js against a fake opencode upstream and
// the fake claude CLI (tests/fixtures/claude-fake.mjs with CLAUDE_CONFIG_DIR:
// transcripts on disk, --fork-session, PreToolUse hooks of --settings).
// Run: node --test tests/rewind-server.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { backup } from "../lib/turn-undo-hook.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const HOME = mkdtempSync(path.join(tmpdir(), "zai-rewind-home-"));
const DATA = mkdtempSync(path.join(tmpdir(), "zai-rewind-data-"));
const CLAUDE_CFG = mkdtempSync(path.join(tmpdir(), "zai-rewind-cfg-"));
const ADMIN_TOKEN = "r".repeat(20) + "-rewind-srv-test-" + "7".repeat(24);
const HAIKU = { providerID: "anthropic", modelID: "claude-haiku-4-5" };
const textOf = (m) => (m?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n\n");

// --- fake opencode: sessions, an opencode chat with two turns, revert state ---
const up = { hits: [], sessions: new Map(), created: 0 };
up.sessions.set("ses_oc", { id: "ses_oc", directory: HOME, title: "opencode chat", time: { created: 1, updated: 2 } });
const OC_MESSAGES = [
  { info: { id: "msg_u1", sessionID: "ses_oc", role: "user", time: { created: 1000 } }, parts: [{ type: "text", text: "первый вопрос" }] },
  { info: { id: "msg_a1", sessionID: "ses_oc", role: "assistant", time: { created: 1100, completed: 1200 } }, parts: [{ type: "text", text: "первый ответ" }] },
  { info: { id: "msg_u2", sessionID: "ses_oc", role: "user", time: { created: 2000 } }, parts: [{ type: "text", text: "поправь a.txt" }] },
  {
    info: { id: "msg_a2", sessionID: "ses_oc", role: "assistant", time: { created: 2100, completed: 2200 } },
    parts: [{ type: "patch", hash: "h1", files: [path.join(HOME, "a.txt")] }, { type: "text", text: "поправил" }],
  },
];
// opencode без снапшота (папка вне git): ни session.diff, ни patch-частей — только tool write
const OC_NOSNAP = [
  { info: { id: "msg_n1", sessionID: "ses_nosnap", role: "user", time: { created: 3000 } }, parts: [{ type: "text", text: "создай oc.txt" }] },
  { info: { id: "msg_n2", sessionID: "ses_nosnap", role: "assistant", time: { created: 3100, completed: 3200 } }, parts: [{ type: "tool", tool: "write", state: { status: "completed", input: { filePath: path.join(HOME, "oc.txt"), content: "A" } } }, { type: "text", text: "ок" }] },
];
let diffAnswer = [{ file: "a.txt", status: "modified", additions: 1, deletions: 1 }];
const OC_EXTRA = new Map(); // BUG-146: histories of more opencode chats
const FAIL_REVERT = new Set(); // sessions whose upstream revert answers 500
let snapshotOff = false; // BUG-145: upstream GET /config → {snapshot:false}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    up.hits.push({ method: req.method, path: url.pathname, query: url.search, body });
    const json = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const t = setInterval(() => res.write(": ping\n\n"), 1000);
      req.on("close", () => clearInterval(t));
      return;
    }
    if (req.method === "GET" && url.pathname === "/session") return json(200, [...up.sessions.values()]);
    if (req.method === "POST" && url.pathname === "/session") {
      const id = `ses_c${++up.created}`;
      const rec = { id, directory: url.searchParams.get("directory") ?? HOME, title: "New session - 2026-11-04T10:00:00.000Z", time: { created: Date.now(), updated: Date.now() } };
      up.sessions.set(id, rec);
      return json(200, rec);
    }
    const m = /^\/session\/([^/]+)(?:\/(.+))?$/.exec(url.pathname);
    if (m) {
      const rec = up.sessions.get(m[1]);
      if (!rec) return json(404, { error: "not found" });
      const sub = m[2] ?? "";
      if (req.method === "DELETE" && !sub) {
        up.sessions.delete(m[1]);
        return json(200, true);
      }
      if (req.method === "GET" && !sub) return json(200, rec);
      if (sub === "message") return json(200, m[1] === "ses_oc" || m[1] === "ses_gitoc" ? OC_MESSAGES : m[1] === "ses_nosnap" ? OC_NOSNAP : OC_EXTRA.get(m[1]) ?? []);
      if (sub === "diff") return json(200, diffAnswer);
      if (sub === "revert" && req.method === "POST" && FAIL_REVERT.has(m[1])) return json(500, { error: "boom" });
      if (sub === "revert" && req.method === "POST") {
        rec.revert = { messageID: JSON.parse(body).messageID, snapshot: "snap", diff: "--- secret diff" };
        return json(200, rec);
      }
      if (sub === "unrevert" && req.method === "POST") {
        delete rec.revert;
        return json(200, rec);
      }
    }
    if (req.method === "GET" && url.pathname === "/config") return json(200, snapshotOff ? { snapshot: false } : {});
    if (url.pathname === "/provider") return json(200, { connected: ["zai-coding-plan"], all: [], default: {} });
    json(200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const srv = await spawnPortal({
  upstream: `http://127.0.0.1:${server.address().port}`,
  env: {
    ZAI_HOME: HOME,
    ZAI_CHAT_DIR: HOME,
    ZAI_DATA_DIR: DATA,
    ZAI_ADMIN_TOKEN: ADMIN_TOKEN,
    ZAI_CLAUDE_BIN: FIXTURE,
    ZAI_CLAUDE_TIMEOUT_MS: "8000",
    ZAI_TITLE_LLM: "0",
    CLAUDE_CONFIG_DIR: CLAUDE_CFG,
  },
});
after(async () => {
  await srv.stop();
  server.close();
  for (const d of [HOME, DATA, CLAUDE_CFG]) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
const base = srv.base;
const login = await fetch(`${base}/zai/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ADMIN_TOKEN }) });
assert.equal(login.status, 200);
const AUTH = login.headers.getSetCookie().join("\n").match(/zai_t=[^;]+/)[0];
const call = (p, opts = {}) => fetch(`${base}${p}`, { ...opts, headers: { ...(opts.headers ?? {}), cookie: AUTH } });
const post = (p, obj) => call(p, { method: "POST", headers: { "content-type": "application/json" }, body: obj === undefined ? undefined : JSON.stringify(obj) });
const D = "?directory=" + encodeURIComponent(HOME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function history(id) {
  const r = await call(`/zai/api/session/${id}/message${D}`);
  return r.ok ? r.json() : [];
}
// Prompt and wait until the chat has `count` messages with an answer last.
async function ask(id, text, count) {
  const r = await post(`/zai/api/session/${id}/prompt${D}`, { model: HAIKU, parts: [{ type: "text", text }] });
  assert.equal(r.status, 204);
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    const h = await history(id);
    if (h.length >= count && h.at(-1)?.info?.role === "assistant" && h.at(-1).info.time?.completed) return h;
  }
  throw new Error(`turn «${text}» did not finish`);
}
const lastUser = (h) => [...h].reverse().find((m) => m.info.role === "user").info.id;
async function listed(id) {
  return (await (await call("/zai/api/session")).json()).find((s) => s.id === id);
}

async function newClaudeChat() {
  const r = await post(`/zai/api/session${D}`, { model: HAIKU });
  assert.equal(r.status, 200);
  return (await r.json()).id;
}

test("Claude: «Отменить ход» rolls an edited file back, «Вернуть» brings it back", async () => {
  const id = await newClaudeChat();
  writeFileSync(path.join(HOME, "note.txt"), "первый");
  await ask(id, "Привет A", 2);
  const h = await ask(id, "EDITFILE note.txt второй", 4);
  assert.equal(readFileSync(path.join(HOME, "note.txt"), "utf8"), "второй");
  const turn = lastUser(h);

  const preview = await call(`/zai/api/session/${id}/revert?messageID=${turn}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), { engine: "claude", files: [{ path: "note.txt", action: "restore" }], shell: true });

  const rv = await post(`/zai/api/session/${id}/revert`, { messageID: turn });
  assert.equal(rv.status, 200);
  const rvBody = await rv.json();
  assert.deepEqual(rvBody.revert.messageID, turn);
  assert.deepEqual(rvBody.files, [{ path: "note.txt", action: "restore" }]);
  assert.equal(readFileSync(path.join(HOME, "note.txt"), "utf8"), "первый", "the file is back to its state before the turn");
  assert.equal((await listed(id)).revert.messageID, turn, "the chat list carries the hidden turn");
  assert.equal((await history(id)).length, 4, "messages stay until the next prompt (the client hides them)");

  const un = await post(`/zai/api/session/${id}/unrevert`);
  assert.equal(un.status, 200);
  assert.equal(readFileSync(path.join(HOME, "note.txt"), "utf8"), "второй", "«Вернуть» puts the turn's result back");
  assert.equal((await listed(id)).revert, undefined);
  assert.equal((await post(`/zai/api/session/${id}/unrevert`)).status, 409, "nothing to restore twice");
});

test("Claude: after «Отменить ход» the next turn forks a cut transcript — the model does not remember the dropped turn", async () => {
  const id = await newClaudeChat();
  await ask(id, "запомни PELICAN", 2);
  let h = await ask(id, "запомни OTTER", 4);
  assert.equal((await post(`/zai/api/session/${id}/revert`, { messageID: lastUser(h) })).status, 200);
  h = await ask(id, "HISTORY 1", 4);
  assert.deepEqual(h.map((m) => m.info.role), ["user", "assistant", "user", "assistant"], "the hidden turn is gone for good");
  assert.equal(textOf(h[2]), "HISTORY 1");
  assert.deepEqual(JSON.parse(textOf(h[3])), ["запомни PELICAN"], "the CLI history ends before the dropped question");
  assert.equal((await listed(id)).revert, undefined);

  // «Сгенерировать заново» / «Изменить»: revert the last turn and send again.
  assert.equal((await post(`/zai/api/session/${id}/revert`, { messageID: lastUser(h) })).status, 200);
  h = await ask(id, "HISTORY 2", 4);
  assert.deepEqual(JSON.parse(textOf(h[3])), ["запомни PELICAN"], "the regenerated turn starts from the same point");
  // the next ordinary turn resumes the fork: the history grows normally
  h = await ask(id, "HISTORY 3", 6);
  assert.deepEqual(JSON.parse(textOf(h[5])), ["запомни PELICAN", "HISTORY 2"]);
  // no cut copies are left behind in the CLI project folder
  const proj = path.join(CLAUDE_CFG, "projects", HOME.replace(/[^A-Za-z0-9]/g, "-"));
  const uuids = readdirSync(proj).filter((n) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(n));
  assert.deepEqual(uuids, [], "the cut copy is removed after its resume");
});

test("Claude: editing the first question starts a fresh CLI session", async () => {
  const id = await newClaudeChat();
  let h = await ask(id, "запомни FIRST", 2);
  assert.equal((await post(`/zai/api/session/${id}/revert`, { messageID: lastUser(h) })).status, 200);
  h = await ask(id, "HISTORY", 2);
  assert.deepEqual(JSON.parse(textOf(h[1])), [], "nothing remembered");
});

test("Claude: a file the turn created is deleted by undo; only the last turn, never while busy", async () => {
  const id = await newClaudeChat();
  await ask(id, "Привет", 2);
  const h = await ask(id, "WRITEFILE fresh.txt новый", 4);
  assert.equal(existsSync(path.join(HOME, "fresh.txt")), true);
  const first = h[0].info.id;
  assert.equal((await call(`/zai/api/session/${id}/revert?messageID=${first}`)).status, 409, "not the last turn");
  assert.equal((await post(`/zai/api/session/${id}/revert`, { messageID: first })).status, 409);
  assert.equal((await post(`/zai/api/session/${id}/revert`, {})).status, 400, "messageID required");

  const preview = await (await call(`/zai/api/session/${id}/revert?messageID=${lastUser(h)}`)).json();
  assert.deepEqual(preview.files, [{ path: "fresh.txt", action: "delete" }]);
  assert.equal((await post(`/zai/api/session/${id}/revert`, { messageID: lastUser(h) })).status, 200);
  assert.equal(existsSync(path.join(HOME, "fresh.txt")), false, "a created file is removed");
  assert.equal((await post(`/zai/api/session/${id}/unrevert`)).status, 200);
  assert.equal(readFileSync(path.join(HOME, "fresh.txt"), "utf8"), "новый", "and comes back with «Вернуть»");

  // busy: a running turn blocks every rewind
  const r = await post(`/zai/api/session/${id}/prompt${D}`, { model: HAIKU, parts: [{ type: "text", text: "WAIT подожди" }] });
  assert.equal(r.status, 204);
  await sleep(150);
  const busyId = lastUser(await history(id));
  assert.equal((await post(`/zai/api/session/${id}/revert`, { messageID: busyId })).status, 409, "turn in progress");
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const hh = await history(id);
    if (hh.length >= 6 && hh.at(-1).info.time?.completed) break;
  }
});

test("Claude: a file changed after the turn is not clobbered by undo", async () => {
  const id = await newClaudeChat();
  writeFileSync(path.join(HOME, "late.txt"), "до");
  const h = await ask(id, "EDITFILE late.txt ход", 2);
  writeFileSync(path.join(HOME, "late.txt"), "правка человека");
  const preview = await (await call(`/zai/api/session/${id}/revert?messageID=${lastUser(h)}`)).json();
  assert.deepEqual(preview.files, [{ path: "late.txt", action: "restore", skipped: "changed-after" }]);
  const rv = await (await post(`/zai/api/session/${id}/revert`, { messageID: lastUser(h) })).json();
  assert.deepEqual(rv.files, []);
  assert.equal(rv.skipped[0].skipped, "changed-after");
  assert.equal(readFileSync(path.join(HOME, "late.txt"), "utf8"), "правка человека");
});

test("Claude: deleting the chat removes its turn backups", async () => {
  const id = await newClaudeChat();
  await ask(id, "WRITEFILE gone.txt x", 2);
  assert.equal(existsSync(path.join(DATA, "turn-undo", id)), true, "the turn has a backup folder");
  const r = await call(`/zai/api/session/${id}${D}`, { method: "DELETE" });
  assert.equal(r.status, 200);
  assert.equal(existsSync(path.join(DATA, "turn-undo", id)), false);
});

test("opencode: preview from session.diff, revert/unrevert go upstream directory-pinned; the list shows only messageID", async () => {
  assert.equal((await call(`/zai/api/session/ses_oc/revert?messageID=msg_u1`)).status, 409, "not the last turn");
  const pv = await call(`/zai/api/session/ses_oc/revert?messageID=msg_u2`);
  assert.equal(pv.status, 200);
  assert.deepEqual(await pv.json(), { engine: "opencode", files: [{ path: "a.txt", action: "restore" }], shell: false });

  // no session.diff → the turn's patch parts
  diffAnswer = [];
  const pv2 = await (await call(`/zai/api/session/ses_oc/revert?messageID=msg_u2`)).json();
  assert.deepEqual(pv2.files, [{ path: "a.txt", action: "restore" }]);
  diffAnswer = [{ file: "a.txt", status: "modified", additions: 1, deletions: 1 }];

  const rv = await post(`/zai/api/session/ses_oc/revert`, { messageID: "msg_u2" });
  assert.equal(rv.status, 200);
  const hit = up.hits.filter((x) => x.path === "/session/ses_oc/revert" && x.method === "POST").at(-1);
  assert.deepEqual(JSON.parse(hit.body), { messageID: "msg_u2" });
  assert.match(hit.query, /directory=/);
  const rec = await listed("ses_oc");
  assert.deepEqual(rec.revert, { messageID: "msg_u2" }, "snapshot and diff stay server-side");
  assert.equal((await post(`/zai/api/session/ses_oc/revert`, { messageID: "msg_u2" })).status, 200, "same revert again is a no-op");

  const un = await post(`/zai/api/session/ses_oc/unrevert`);
  assert.equal(un.status, 200);
  assert.ok(up.hits.some((x) => x.path === "/session/ses_oc/unrevert" && x.method === "POST"));
  assert.equal((await listed("ses_oc")).revert, undefined);
  assert.equal((await post(`/zai/api/session/ses_oc/unrevert`)).status, 409, "nothing to restore");
});

test("tenant: someone else's chat is out of scope for preview, revert and unrevert", async () => {
  const t = await (await post("/zai/api/admin/users", { name: "rewindtenant" })).json();
  assert.ok(t.token);
  const tc = (p, opts = {}) => fetch(`${base}${p}`, { ...opts, headers: { ...(opts.headers ?? {}), authorization: `Bearer ${t.token}`, "content-type": "application/json" } });
  const before = up.hits.length;
  for (const [p, method, body] of [
    ["/zai/api/session/ses_oc/revert?messageID=msg_u2", "GET"],
    ["/zai/api/session/ses_oc/revert", "POST", { messageID: "msg_u2" }],
    ["/zai/api/session/ses_oc/unrevert", "POST"],
  ]) {
    const r = await tc(p, { method, body: body ? JSON.stringify(body) : undefined });
    assert.ok(r.status === 403 || r.status === 404, `${method} ${p} → ${r.status}`);
  }
  assert.equal(up.hits.slice(before).some((x) => /revert|unrevert|diff/.test(x.path)), false, "nothing reached upstream");
});

test("BUG-145: opencode chat in a git work tree — no file rollback: preview blocked, revert/unrevert 409 git-dir, nothing goes upstream", async () => {
  const GIT = mkdtempSync(path.join(tmpdir(), "zai-rewind-git-"));
  mkdirSync(path.join(GIT, ".git"));
  const SUB = path.join(GIT, "sub");
  mkdirSync(SUB);
  up.sessions.set("ses_gitoc", { id: "ses_gitoc", directory: SUB, title: "git chat", time: { created: 3, updated: 4 } });
  try {
    await call("/zai/api/session"); // index refresh
    const before = up.hits.length;
    const pv = await call(`/zai/api/session/ses_gitoc/revert?messageID=msg_u2&directory=${encodeURIComponent(SUB)}`);
    assert.equal(pv.status, 200);
    assert.deepEqual(await pv.json(), { engine: "opencode", files: [], shell: false, blocked: "git-dir" });
    const rv = await post(`/zai/api/session/ses_gitoc/revert?directory=${encodeURIComponent(SUB)}`, { messageID: "msg_u2" });
    assert.equal(rv.status, 409);
    assert.equal((await rv.json()).error, "git-dir");
    const un = await post(`/zai/api/session/ses_gitoc/unrevert?directory=${encodeURIComponent(SUB)}`);
    assert.equal(un.status, 409);
    assert.ok(!up.hits.slice(before).some((x) => /\/session\/ses_gitoc\/(revert|unrevert)/.test(x.path)), "revert never reached opencode");
  } finally {
    up.sessions.delete("ses_gitoc");
    rmSync(GIT, { recursive: true, force: true });
  }
});

test("BUG-145: git work tree + opencode snapshot:false — rollback from the plugin's backups only, a foreign uncommitted file stays", async () => {
  const GIT = mkdtempSync(path.join(tmpdir(), "zai-rewind-git2-"));
  mkdirSync(path.join(GIT, ".git"));
  const SUB = path.join(GIT, "sub");
  mkdirSync(SUB);
  const edited = path.join(SUB, "g.txt");
  const foreign = path.join(GIT, "tracked.txt");
  writeFileSync(edited, "A");
  writeFileSync(foreign, "dirty-before");
  backup(path.join(DATA, "turn-undo", "ses_gitok", "msg_g1"), edited);
  writeFileSync(edited, "B");
  OC_EXTRA.set("ses_gitok", [
    { info: { id: "msg_g1", sessionID: "ses_gitok", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "замени A на B" }] },
    { info: { id: "msg_ga", sessionID: "ses_gitok", role: "assistant", time: { created: 2, completed: 3 } }, parts: [{ type: "tool", tool: "edit", state: { status: "completed", input: { filePath: edited, oldString: "A", newString: "B" } } }] },
  ]);
  up.sessions.set("ses_gitok", { id: "ses_gitok", directory: SUB, title: "git ok", time: { created: 9, updated: 10 } });
  const Q = `directory=${encodeURIComponent(SUB)}`;
  const saved = diffAnswer;
  diffAnswer = [];
  snapshotOff = true;
  try {
    await call("/zai/api/session");
    const pv = await call(`/zai/api/session/ses_gitok/revert?messageID=msg_g1&${Q}`);
    assert.equal(pv.status, 200);
    const body = await pv.json();
    assert.equal(body.blocked, undefined);
    assert.deepEqual(body.files.map((f) => f.path), ["g.txt"]);
    const rv = await post(`/zai/api/session/ses_gitok/revert?${Q}`, { messageID: "msg_g1" });
    assert.equal(rv.status, 200);
    assert.equal(readFileSync(edited, "utf8"), "A");
    assert.equal(readFileSync(foreign, "utf8"), "dirty-before");
    const un = await post(`/zai/api/session/ses_gitok/unrevert?${Q}`);
    assert.equal(un.status, 200);
    assert.equal(readFileSync(edited, "utf8"), "B");
    assert.equal(readFileSync(foreign, "utf8"), "dirty-before");
  } finally {
    snapshotOff = false;
    diffAnswer = saved;
    up.sessions.delete("ses_gitok");
    rmSync(GIT, { recursive: true, force: true });
  }
});

test("opencode без снапшота: превью честно перечисляет файлы хода как «не откатится» (no-snapshot)", async () => {
  up.sessions.set("ses_nosnap", { id: "ses_nosnap", directory: HOME, title: "no snapshot", time: { created: 5, updated: 6 } });
  const saved = diffAnswer;
  diffAnswer = [];
  try {
    await call("/zai/api/session");
    const pv = await call(`/zai/api/session/ses_nosnap/revert${D}&messageID=msg_n1`);
    assert.equal(pv.status, 200);
    const body = await pv.json();
    assert.equal(body.engine, "opencode");
    assert.deepEqual(body.files, [{ path: "oc.txt", action: "restore", skipped: "no-snapshot" }]);
  } finally {
    diffAnswer = saved;
    up.sessions.delete("ses_nosnap");
  }
});

// --- BUG-146: opencode outside git — the vault-cache plugin's backups -------
// The plugin (ops/opencode/vault-cache.ts) keeps the files of a turn in
// <ZAI_TURN_UNDO_ROOT = DATA/turn-undo>/<session>/<question>/ in the format of
// lib/turn-undo-hook.mjs backup(); here the backup is made by that function
// directly, then the "tool" changes the files.
test("BUG-146: opencode вне git — «Отменить ход» восстанавливает файлы хода из бэкапов плагина, «Вернуть» возвращает, чужой файл не трогается", async () => {
  const edited = path.join(HOME, "oc2.txt");
  const created = path.join(HOME, "oc-new.txt");
  const foreign = path.join(HOME, "foreign.txt");
  writeFileSync(edited, "A");
  writeFileSync(foreign, "чужое-до");
  const turnDir = path.join(DATA, "turn-undo", "ses_ocb", "msg_b1");
  backup(turnDir, edited);
  backup(turnDir, created);
  writeFileSync(edited, "B"); // the turn's edit
  writeFileSync(created, "N"); // the turn's write
  writeFileSync(foreign, "чужое-после"); // someone else, not the turn
  OC_EXTRA.set("ses_ocb", [
    { info: { id: "msg_b0", sessionID: "ses_ocb", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "создай oc2.txt с A" }] },
    { info: { id: "msg_a0", sessionID: "ses_ocb", role: "assistant", time: { created: 2, completed: 3 } }, parts: [{ type: "text", text: "ок" }] },
    { info: { id: "msg_b1", sessionID: "ses_ocb", role: "user", time: { created: 4 } }, parts: [{ type: "text", text: "замени A на B" }] },
    {
      info: { id: "msg_a1", sessionID: "ses_ocb", role: "assistant", time: { created: 5, completed: 6 } },
      parts: [
        { type: "tool", tool: "edit", state: { status: "completed", input: { filePath: edited, oldString: "A", newString: "B" } } },
        { type: "tool", tool: "write", state: { status: "completed", input: { filePath: created, content: "N" } } },
        { type: "tool", tool: "write", state: { status: "completed", input: { filePath: path.join(HOME, "nobackup.txt"), content: "x" } } },
      ],
    },
  ]);
  up.sessions.set("ses_ocb", { id: "ses_ocb", directory: HOME, title: "opencode backups", time: { created: 7, updated: 8 } });
  const saved = diffAnswer;
  diffAnswer = [];
  try {
    await call("/zai/api/session");
    const pv = await call(`/zai/api/session/ses_ocb/revert${D}&messageID=msg_b1`);
    assert.equal(pv.status, 200);
    const body = await pv.json();
    assert.equal(body.engine, "opencode");
    assert.deepEqual(
      body.files.sort((a, b) => a.path.localeCompare(b.path)),
      [
        { path: "nobackup.txt", action: "restore", skipped: "no-snapshot" },
        { path: "oc-new.txt", action: "delete" },
        { path: "oc2.txt", action: "restore" },
      ],
    );

    const before = up.hits.length;
    const rv = await post(`/zai/api/session/ses_ocb/revert${D}`, { messageID: "msg_b1" });
    assert.equal(rv.status, 200);
    const out = await rv.json();
    assert.deepEqual(out.files.map((f) => f.path).sort(), ["oc-new.txt", "oc2.txt"]);
    assert.deepEqual(out.skipped, [{ path: "nobackup.txt", action: "restore", skipped: "no-snapshot" }]);
    assert.equal(readFileSync(edited, "utf8"), "A", "the edit is undone");
    assert.equal(existsSync(created), false, "the created file is gone");
    assert.equal(readFileSync(foreign, "utf8"), "чужое-после", "a file the turn did not touch stays");
    assert.ok(up.hits.slice(before).some((x) => x.path === "/session/ses_ocb/revert" && x.method === "POST"), "opencode hides the messages");

    const un = await post(`/zai/api/session/ses_ocb/unrevert${D}`);
    assert.equal(un.status, 200);
    assert.deepEqual((await un.json()).files.map((f) => f.path).sort(), ["oc-new.txt", "oc2.txt"]);
    assert.equal(readFileSync(edited, "utf8"), "B", "«Вернуть» brings the edit back");
    assert.equal(readFileSync(created, "utf8"), "N");
    assert.equal(readFileSync(foreign, "utf8"), "чужое-после");
    assert.ok(up.hits.some((x) => x.path === "/session/ses_ocb/unrevert" && x.method === "POST"));
  } finally {
    diffAnswer = saved;
  }
});

test("BUG-146: upstream revert fails — the files the portal rolled back come back", async () => {
  const f = path.join(HOME, "oc3.txt");
  writeFileSync(f, "before");
  backup(path.join(DATA, "turn-undo", "ses_ocfail", "msg_f1"), f);
  writeFileSync(f, "after");
  up.sessions.set("ses_ocfail", { id: "ses_ocfail", directory: HOME, title: "fail", time: { created: 9, updated: 10 } });
  OC_EXTRA.set("ses_ocfail", [{ info: { id: "msg_f1", sessionID: "ses_ocfail", role: "user", time: { created: 1 } }, parts: [] }]);
  FAIL_REVERT.add("ses_ocfail");
  try {
    await call("/zai/api/session");
    const rv = await post(`/zai/api/session/ses_ocfail/revert${D}`, { messageID: "msg_f1" });
    assert.equal(rv.status, 502);
    assert.equal(readFileSync(f, "utf8"), "after", "the turn stays — so do its files");
  } finally {
    FAIL_REVERT.delete("ses_ocfail");
    up.sessions.delete("ses_ocfail");
  }
});

test("BUG-146: удаление opencode-чата и gc чистят его бэкапы; бэкапы живого opencode-чата gc не трогает", async () => {
  const live = path.join(DATA, "turn-undo", "ses_ocb", "msg_b1");
  const orphan = path.join(DATA, "turn-undo", "ses_gone_oc", "msg_z");
  mkdirSync(orphan, { recursive: true });
  assert.equal(existsSync(live), true);
  const gc = await post("/zai/api/admin/gc");
  assert.equal(gc.status, 200);
  assert.equal(existsSync(orphan), false, "a chat opencode no longer knows");
  assert.equal(existsSync(live), true, "a live opencode chat keeps its last turn");
  const del = await call(`/zai/api/session/ses_ocb${D}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(existsSync(path.join(DATA, "turn-undo", "ses_ocb")), false);
});
