// TASK-12.31: пакет мелких серверных находок ревью 2026-11-10 (SRV-23, 25, 28, 29, 30, 31, 32).
// SRV-26 отклонена — причина в карточке задачи.
// Run: node --test tests/server-low-findings.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setCapped } from "../lib/capped-map.js";
import { TurnUndo } from "../lib/turn-undo.js";
import { backup } from "../lib/turn-undo-hook.mjs";
import { adminRoutes } from "../routes/admin.js";
import { catalogRoutes, fetchMcpStatus } from "../routes/catalog.js";
import { dispatchRoute } from "../routes/router.js";
import { PushStore } from "../lib/push.js";

const TMP = mkdtempSync(path.join(tmpdir(), "zai-low-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const fakeRes = () => ({ status: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; } });
const sendJson = (res, status, obj) => { res.status = status; res.body = obj; };

test("SRV-23: кэш с потолком — старейшая запись вытесняется, обновление ключа его освежает", () => {
  const m = new Map();
  for (let i = 0; i < 5; i++) setCapped(m, "k" + i, i, 3);
  assert.deepEqual([...m.keys()], ["k2", "k3", "k4"]);
  setCapped(m, "k2", 22, 3); // обновили — стал самым свежим
  setCapped(m, "k5", 5, 3);
  assert.deepEqual([...m.keys()], ["k4", "k2", "k5"]);
  assert.equal(m.get("k2"), 22);
});

test("SRV-25: файл изменён между планом отката и применением — не затирается, уходит в skipped", () => {
  const root = path.join(TMP, "undo");
  const work = path.join(TMP, "work");
  mkdirSync(work, { recursive: true });
  const a = path.join(work, "a.txt");
  const b = path.join(work, "b.txt");
  writeFileSync(a, "a0");
  writeFileSync(b, "b0");
  const undo = new TurnUndo({ root });
  const dir = undo.startTurn("ses_1", "t1");
  backup(dir, a);
  backup(dir, b);
  writeFileSync(a, "a1");
  writeFileSync(b, "b1");
  undo.seal("ses_1", "t1");
  // человек правит b уже после того, как план посчитан
  const out = undo.revert("ses_1", "t1", { afterPlan: () => writeFileSync(b, "b-человек") });
  assert.equal(readFileSync(a, "utf8"), "a0", "неизменённый после плана файл откатан");
  assert.equal(readFileSync(b, "utf8"), "b-человек", "правка человека цела");
  assert.deepEqual(out.skipped.map((s) => [path.basename(s.path), s.skipped]), [["b.txt", "changed-after"]]);
});

test("SRV-28: битый percent-encoding в /admin/users/:id/token → 400, а не 500", () => {
  let err500 = false;
  const routes = adminRoutes({ sendJson, apiError: () => { err500 = true; }, regenerateToken: () => "t", closeUserStreams: () => {} });
  const route = routes.find((r) => r.path instanceof RegExp && r.path.source.includes("token"));
  const res = fakeRes();
  route.handler({ req: { method: "POST" }, res, match: ["", "%zz"] });
  assert.equal(res.status, 400);
  assert.equal(err500, false);
});

test("SRV-29: молчащий upstream — /mcp отвечает в пределах бюджета, а не через два полных ожидания", async () => {
  const calls = [];
  const oc = { mcpStatus: ({ timeoutMs }) => { calls.push(timeoutMs); return new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { status: 0 })), timeoutMs)); } };
  const t0 = Date.now();
  const out = await fetchMcpStatus({ oc, instanceHealth: { warmTimeoutMs: 120_000, heal: async () => {} }, errLog: () => {}, mcpBudgetMs: 300, mcpMinAttemptMs: 200 }, "D:\\x");
  assert.equal(out, null);
  assert.ok(Date.now() - t0 < 1500, `ответ за ${Date.now() - t0} мс`);
  assert.equal(calls.length, 1, "на вторую попытку бюджета не осталось");
  assert.ok(calls[0] <= 300, "таймаут попытки не больше бюджета");
});

test("SRV-29: отравленная папка (503) — лечение и вторая попытка в остатке бюджета", async () => {
  let n = 0, healed = 0;
  const oc = { mcpStatus: async () => { if (n++ === 0) throw Object.assign(new Error("x"), { status: 503 }); return { a: { status: "connected" } }; } };
  const out = await fetchMcpStatus({ oc, instanceHealth: { warmTimeoutMs: 120_000, heal: async () => { healed++; } }, errLog: () => {}, mcpBudgetMs: 5000, mcpMinAttemptMs: 100, mcpRetryDelayMs: 1 }, "D:\\x");
  assert.deepEqual(out, { a: { status: "connected" } });
  assert.equal(healed, 1);
});

test("SRV-30: два параллельных GET /status с истёкшим кэшем — один пересчёт", async () => {
  let fanouts = 0;
  const deps = {
    sendJson, errLog: () => {}, statusTtlMs: 3000,
    hub: { epoch: "e", directories: () => [], stalledSnapshot: () => ({}), busySnapshot: () => ({}) },
    claude: { liveness: () => ({}) },
    oc: { busyMap: async () => { fanouts++; await new Promise((r) => setTimeout(r, 30)); return { ses_1: { type: "busy" } }; } },
    fetchSessionIndex: async () => new Map(), dirAllowed: () => true,
  };
  const route = catalogRoutes(deps).find((r) => r.path === "/zai/api/status");
  const r1 = fakeRes(), r2 = fakeRes();
  await Promise.all([route.handler({ res: r1, user: {}, admin: true }), route.handler({ res: r2, user: {}, admin: true })]);
  assert.equal(fanouts, 1);
  assert.deepEqual(r1.body, { ses_1: { type: "busy" } });
  assert.deepEqual(r2.body, r1.body);
});

test("SRV-31: относительный ?directory= отклоняется и при наличии папки по умолчанию; пустой — берёт её", async () => {
  let got = null;
  const table = [{ method: "GET", path: "/zai/api/file", scope: "dirQuery", dirDefault: () => "D:\\home", handler: ({ dir }) => { got = dir; } }];
  const deps = { sendJson, dirAllowed: () => true };
  const call = async (q) => { const res = fakeRes(); got = null; await dispatchRoute(table, { req: { method: "GET" }, res, url: new URL("http://x/zai/api/file" + q), user: {}, admin: true }, deps); return res; };
  assert.equal((await call("?directory=relative%5Cpath")).status, 400);
  assert.equal(got, null, "обработчик не вызван");
  await call("");
  assert.equal(got, "D:\\home");
  await call("?directory=" + encodeURIComponent(process.platform === "win32" ? "D:\\abs" : "/abs"));
  assert.equal(got, process.platform === "win32" ? "D:\\abs" : "/abs");
});

test("SRV-32: push — смена владельца подписки сбрасывает «чат открыт» прежнего владельца", () => {
  const store = new PushStore({ file: path.join(TMP, "push.json") });
  const sub = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };
  const rec = store.add("alice", sub);
  store.setPresence("alice", sub.endpoint, "ses_1", 1000);
  assert.equal(store.present(rec.id, "ses_1", 1500), true);
  store.add("bob", sub);
  assert.equal(store.present(rec.id, "ses_1", 1500), false, "пуши нового владельца по этому чату не подавляются");
});
