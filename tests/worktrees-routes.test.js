// FEAT-20.7: /teleharness/api/worktrees/* на НАСТОЯЩЕМ server.js (фейковый opencode,
// фейковый Claude CLI, настоящие временные репозитории):
//   - пустой чат копию не создаёт; заявка → первый ход Claude идёт в копии
//     (файл агента — в копии, не в основной), ветка teleharness/… от main;
//   - лист копии: ветка, файлы, порт; Git чата показывает копию;
//   - слияние с тестами (команда задана) → main сдвинута; idemKey; журнал;
//   - «На ревью» → пункт ревью «ветка» (FEAT-20.1);
//   - удаление чата с несохранённой работой → по умолчанию ветка сохраняется;
//   - тенант: копия в папке чата, чужая копия → 404, чужая папка → 403,
//     не-git папка → «Папка не под git», «Создать репозиторий».
// Run: node --test --test-concurrency=1 tests/worktrees-routes.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLAUDE_FAKE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const ADMIN = "w".repeat(24) + "-wt-server-" + "7".repeat(24);
const TMP = mkdtempSync(path.join(os.tmpdir(), "teleharness-wt-srv-"));
const DATA = path.join(TMP, "data");
mkdirSync(DATA);
const OPUS = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const sh = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Seed", "-c", "user.email=seed@x", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function initRepo(dir, files = { "a.txt": "one\n" }) {
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  for (const [n, t] of Object.entries(files)) writeFileSync(path.join(dir, n), t);
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

let up, srv, alice, repo, created = 0, aliceWt = null;
function api(p, { method = "GET", body, token = ADMIN } = {}) {
  return fetch(srv.base + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const enc = encodeURIComponent;
async function waitFor(fn, ms = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function newChat(dir, token = ADMIN) {
  const r = await j(await api(`/teleharness/api/session?directory=${enc(dir)}`, { method: "POST", body: { model: OPUS }, token }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id;
}
async function answered(sid, n, token = ADMIN) {
  return waitFor(async () => {
    const m = await (await api(`/teleharness/api/session/${sid}/message`, { token })).json();
    const a = Array.isArray(m) ? m.filter((x) => x.info?.role === "assistant" && x.info?.time?.completed) : [];
    return a.length >= n ? a.at(-1) : null;
  });
}

before(async () => {
  repo = initRepo(path.join(TMP, "proj"));
  up = await startFakeOpencode();
  up.route("POST", "/session", (_req, body, url) => {
    const id = `ses_w${++created}`;
    const directory = url.searchParams.get("directory");
    up.state.sessions.push({ id, directory, title: "" });
    return { json: { id, directory } };
  });
  up.route("GET", "/agent", () => ({ json: [{ name: "Sandbox", mode: "primary", permission: [{ permission: "*", pattern: "*", action: "allow" }, { permission: "task", pattern: "*", action: "deny" }, { permission: "external_directory", pattern: "*", action: "deny" }] }] }));
  srv = await spawnPortal({ upstream: up.url, env: { TELEHARNESS_ADMIN_TOKEN: ADMIN, TELEHARNESS_DATA_DIR: DATA, TELEHARNESS_CLAUDE_BIN: CLAUDE_FAKE, TELEHARNESS_CLAUDE_TIMEOUT_MS: "8000", TELEHARNESS_TENANT_AGENT: "Sandbox" } });
  alice = await (await api("/teleharness/api/admin/users", { method: "POST", body: { name: "wt-alice", engines: ["opencode", "claude"] } })).json();
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
  rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("admin: plan, empty chat creates nothing, first Claude turn runs in the copy; Git of the chat is the copy", async () => {
  const sid = await newChat(repo);
  const plan = await j(await api(`/teleharness/api/worktrees/plan?sid=${sid}`));
  assert.equal(plan.status, 200);
  assert.equal(plan.body.repo, true);
  assert.equal(plan.body.base, "main");
  const pend = await j(await api(`/teleharness/api/worktrees/pending?sid=${sid}`, { method: "POST", body: { on: true, remember: true } }));
  assert.equal(pend.status, 200, JSON.stringify(pend.body));
  let st = await j(await api(`/teleharness/api/worktrees?sid=${sid}`));
  assert.equal(st.body.item, null);
  assert.ok(st.body.pending);
  assert.equal(sh(repo, "branch", "--list", "teleharness/*").trim(), "", "пустой чат — без ветки");
  const p = await api(`/teleharness/api/session/${sid}/prompt`, { method: "POST", body: { model: OPUS, parts: [{ type: "text", text: "WRITEFILE agent.txt из копии" }] } });
  assert.ok([200, 204].includes(p.status), String(p.status));
  await answered(sid, 1);
  st = await j(await api(`/teleharness/api/worktrees?sid=${sid}`));
  const it = st.body.item;
  assert.match(it.branch, /^teleharness\/writefile-agent-txt-iz-kopii-[a-z0-9]{4}$/);
  assert.equal(it.base, "main");
  assert.equal(it.port >= 43000, true);
  assert.ok(existsSync(path.join(it.path, "agent.txt")), "файл агента — в копии");
  assert.equal(existsSync(path.join(repo, "agent.txt")), false, "основная копия не тронута");
  assert.deepEqual(it.files.map((f) => f.path), ["agent.txt"]);
  const git = await j(await api(`/teleharness/api/git/status?sid=${sid}`));
  assert.equal(git.body.branch, it.branch);
  // переключатель после первого сообщения недоступен
  const late = await j(await api(`/teleharness/api/worktrees/pending?sid=${sid}`, { method: "POST", body: { on: true } }));
  assert.equal(late.status, 409);
  // запомнено на проект
  assert.equal((await j(await api("/teleharness/api/me/worktrees"))).body.defaultByProject[repo], true);
});

test("admin: merge with tests (idempotent), op journal, main advanced; review of the branch; undo", async () => {
  const sid = await newChat(repo);
  await api(`/teleharness/api/worktrees/pending?sid=${sid}`, { method: "POST", body: { on: true } });
  await api(`/teleharness/api/session/${sid}/prompt`, { method: "POST", body: { model: OPUS, parts: [{ type: "text", text: "WRITEFILE merged.txt готово" }] } });
  await answered(sid, 1);
  const it = (await j(await api(`/teleharness/api/worktrees?sid=${sid}&overlaps=0`))).body.item;
  // без команды тестов → нужен выбор
  const no = await j(await api(`/teleharness/api/worktrees/${it.id}/merge`, { method: "POST", body: { commitDirty: true } }));
  assert.equal(no.status, 409);
  assert.equal(no.body.kind, "no-tests");
  // ревью ветки (FEAT-20.1, пункт «ветка»)
  const rv = await j(await api(`/teleharness/api/worktrees/${it.id}/review`, { method: "POST", body: {} }));
  assert.equal(rv.status, 200, JSON.stringify(rv.body));
  const list = await j(await api("/teleharness/api/review"));
  const item = (list.body.items ?? list.body).find?.((x) => x.id === rv.body.id);
  assert.equal(item?.source, "branch");
  const before = sh(repo, "rev-parse", "main").trim();
  const body = { commitDirty: true, testCmd: "node -e \"process.exit(require('fs').existsSync('merged.txt')?0:1)\"", message: "Готово: merged.txt", idemKey: "idem-key-0001" };
  const m1 = await j(await api(`/teleharness/api/worktrees/${it.id}/merge`, { method: "POST", body }));
  assert.equal(m1.status, 202, JSON.stringify(m1.body));
  const m2 = await j(await api(`/teleharness/api/worktrees/${it.id}/merge`, { method: "POST", body }));
  assert.equal(m2.body.opId, m1.body.opId, "повтор с тем же ключом — та же операция");
  const op = await waitFor(async () => {
    const o = (await j(await api(`/teleharness/api/worktrees/ops/${m1.body.opId}`))).body;
    return ["done", "failed"].includes(o.phase) ? o : null;
  });
  assert.equal(op.phase, "done", JSON.stringify(op));
  assert.equal(op.test.passed, true);
  assert.notEqual(sh(repo, "rev-parse", "main").trim(), before);
  assert.equal(readFileSync(path.join(repo, "merged.txt"), "utf8"), "готово");
  const log = await j(await api(`/teleharness/api/worktrees/ops/${m1.body.opId}?log=1`));
  assert.equal(log.status, 200);
  const st = (await j(await api(`/teleharness/api/worktrees/${it.id}`))).body;
  assert.equal(st.state, "merged");
  assert.equal(st.canUndoMerge, true);
  const u = await j(await api(`/teleharness/api/worktrees/${it.id}/undo-merge`, { method: "POST", body: {} }));
  assert.equal(u.status, 200);
  assert.equal(sh(repo, "rev-parse", "main").trim(), before);
});

test("delete chat with unsaved work: default keeps the branch with a WIP commit; branches without chat; delete branch", async () => {
  const sid = await newChat(repo);
  await api(`/teleharness/api/worktrees/pending?sid=${sid}`, { method: "POST", body: { on: true, branch: "Keep Me" } });
  await api(`/teleharness/api/session/${sid}/prompt`, { method: "POST", body: { model: OPUS, parts: [{ type: "text", text: "WRITEFILE wip.txt несохранённое" }] } });
  await answered(sid, 1);
  const it = (await j(await api(`/teleharness/api/worktrees?sid=${sid}&overlaps=0`))).body.item;
  assert.equal(it.branch, "teleharness/keep-me");
  const un = (await j(await api(`/teleharness/api/worktrees/${it.id}/unsaved`))).body;
  assert.deepEqual(un, { uncommitted: 1, commits: 0, merged: false });
  const auto = await j(await api(`/teleharness/api/worktrees/${it.id}?mode=auto`, { method: "DELETE" }));
  assert.equal(auto.status, 409);
  assert.equal(auto.body.kind, "unsaved");
  const all = await j(await api(`/teleharness/api/worktrees/${it.id}?mode=all`, { method: "DELETE" }));
  assert.equal(all.status, 400, "«Удалить всё» без подтверждения");
  const del = await api(`/teleharness/api/session/${sid}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(existsSync(it.path), false);
  assert.match(sh(repo, "log", "-1", "--format=%s", "teleharness/keep-me"), /WIP: сохранено при удалении чата/);
  const listing = (await j(await api(`/teleharness/api/worktrees?directory=${enc(repo)}`))).body;
  assert.ok(listing.branches.some((b) => b.name === "teleharness/keep-me"));
  const db = await j(await api(`/teleharness/api/worktrees/branches?directory=${enc(repo)}&name=${enc("teleharness/keep-me")}`, { method: "DELETE" }));
  assert.equal(db.status, 200);
  const bad = await j(await api(`/teleharness/api/worktrees/branches?directory=${enc(repo)}&name=main`, { method: "DELETE" }));
  assert.equal(bad.status, 400);
});

test("tenant: not-git → reason + init; own repo copy in the chat folder; foreign copy 404; foreign folder 403", async () => {
  const home = alice.user.directories[0];
  mkdirSync(home, { recursive: true });
  const sid = await newChat(home, alice.token);
  let plan = (await j(await api(`/teleharness/api/worktrees/plan?sid=${sid}`, { token: alice.token }))).body;
  assert.equal(plan.repo, false);
  assert.equal(plan.reason, "not-git");
  const init = await j(await api(`/teleharness/api/worktrees/init?directory=${enc(home)}`, { method: "POST", body: {}, token: alice.token }));
  assert.equal(init.status, 200, JSON.stringify(init.body));
  plan = (await j(await api(`/teleharness/api/worktrees/plan?sid=${sid}`, { token: alice.token }))).body;
  assert.equal(plan.repo, true);
  assert.equal(plan.limits.max, 5);
  const inst = await j(await api(`/teleharness/api/worktrees/pending?sid=${sid}`, { method: "POST", body: { on: true, deps: "install" }, token: alice.token }));
  assert.equal(inst.status, 403, "тенант не ставит зависимости с сетью");
  await api(`/teleharness/api/worktrees/pending?sid=${sid}`, { method: "POST", body: { on: true }, token: alice.token });
  const tp = await j(await api(`/teleharness/api/session/${sid}/prompt`, { method: "POST", body: { model: OPUS, parts: [{ type: "text", text: "WRITEFILE t.txt тенант" }] }, token: alice.token }));
  assert.ok([200, 204].includes(tp.status), JSON.stringify(tp));
  await answered(sid, 1, alice.token);
  const it = (await j(await api(`/teleharness/api/worktrees?sid=${sid}&overlaps=0`, { token: alice.token }))).body.item;
  assert.ok(it, "копия тенанта создана");
  aliceWt = it;
  assert.equal(it.path, undefined, "тенанту — без серверного пути");
  const chatFolder = path.join(home, "chats", sid.slice(4));
  assert.ok(existsSync(path.join(chatFolder, "t.txt")), "ход тенанта — в папке чата = копии");
  assert.ok(existsSync(path.join(chatFolder, ".git")));
  // admin-копия чужая для тенанта
  const adminSid = await newChat(repo);
  await api(`/teleharness/api/worktrees/pending?sid=${adminSid}`, { method: "POST", body: { on: true } });
  await api(`/teleharness/api/session/${adminSid}/prompt`, { method: "POST", body: { model: OPUS, parts: [{ type: "text", text: "WRITEFILE z.txt z" }] } });
  await answered(adminSid, 1);
  const adminIt = (await j(await api(`/teleharness/api/worktrees?sid=${adminSid}&overlaps=0`))).body.item;
  assert.equal((await api(`/teleharness/api/worktrees/${adminIt.id}`, { token: alice.token })).status, 404);
  assert.equal((await api(`/teleharness/api/worktrees/${adminIt.id}/merge`, { method: "POST", body: {}, token: alice.token })).status, 404);
  assert.equal((await api(`/teleharness/api/worktrees?directory=${enc(repo)}`, { token: alice.token })).status, 403);
  assert.equal((await api(`/teleharness/api/worktrees/plan?directory=${enc(repo)}`, { token: alice.token })).status, 403);
  // admin видит копию тенанта
  assert.equal((await api(`/teleharness/api/worktrees/${it.id}`)).status, 200);
  // слияние тенанта без тестов — с причиной (Q3 «а»)
  const m = await j(await api(`/teleharness/api/worktrees/${it.id}/merge`, { method: "POST", body: { commitDirty: true, skipTests: true, reason: "проверю сам" }, token: alice.token }));
  assert.equal(m.status, 202, JSON.stringify(m.body));
  const op = await waitFor(async () => {
    const o = (await j(await api(`/teleharness/api/worktrees/ops/${m.body.opId}`, { token: alice.token }))).body;
    return ["done", "failed"].includes(o.phase) ? o : null;
  });
  assert.equal(op.phase, "done", JSON.stringify(op));
  assert.equal(readFileSync(path.join(home, "t.txt"), "utf8"), "тенант");
});

// BUG-276 (BUG-20.14): удаление аккаунта тенанта оставляло его копию в реестре
// (state ready, путь в удалённой папке); удалить её было нельзя — 503 «git не установлен».
test("BUG-276: удаление аккаунта тенанта снимает его рабочие копии из реестра; папка не создаётся заново", async () => {
  assert.ok(aliceWt?.id, "копия тенанта из предыдущего теста");
  const home = alice.user.directories[0];
  const del = await j(await api(`/teleharness/api/admin/users/${enc(alice.user.id)}`, { method: "DELETE" }));
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const index = JSON.parse(readFileSync(path.join(DATA, "worktrees", "index.json"), "utf8"));
  assert.equal(index.items.some((x) => x.id === aliceWt.id), false, "записи копии удалённого аккаунта нет");
  assert.equal((await api(`/teleharness/api/worktrees/${aliceWt.id}`)).status, 404);
  assert.equal(existsSync(home), false, "папка тенанта не воссоздана уборкой копии");
});
