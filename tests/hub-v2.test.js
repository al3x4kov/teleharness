// FEAT-16.3, tasks 3.3: хаб на адаптере lib/oc-client.js (опция oc).
// v2 — ОДНО глобальное соединение oc.events(): хаб раскладывает события по
// папкам из поля directory (переписыватель адаптера его кладёт), подписки
// папок — только фильтр без новых соединений; gap (zai.resync после
// реконнекта) → resync клиентам + перечитать статусы/вопросы. v1 через
// адаптер — прежние per-directory /event?directory= как есть.
// Доказательство «бит в бит» для хаба БЕЗ oc — существующие tests/hub.test.js
// и tests/hub-recovery.test.js без изменения ожиданий.
// Красная фаза — D:\zai-tmp-scripts\worker\v2hub\red.log.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EventHub } from "../lib/hub.js";
import { createOcClient } from "../lib/oc-client.js";
import { startFakeOpencodeV2 } from "./helpers/fake-opencode-v2.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const PWD = "oc2-secret";
const DIR_A = "C:\\Users\\USER\\.zai-tenants\\alice";
const DIR_B = "C:\\Users\\USER\\.zai-tenants\\bob";
const cleanups = [];
after(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCondition(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error("waitForCondition timeout");
    await sleep(20);
  }
}

// v2-хаб на фейке v2: oc из createOcClient, папки A/B как пinned-подписки.
async function hubWithOc({ hubOpts = {}, upOpts = {}, directories = [DIR_A, DIR_B] } = {}) {
  const up = await startFakeOpencodeV2({ password: PWD, ...upOpts });
  const oc = createOcClient({ api: "v2", base: up.url, password: PWD });
  const hub = new EventHub({ directoryPollMs: 100, ...hubOpts, oc });
  hub.start(up.url, { directories });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  return { hub, up, oc };
}

// Запись всего, что хаб раздаёт (фейковый res, без сокетов) — как в
// tests/hub-recovery.test.js, плюс waitFor по разобранным событиям.
function fakeClient(hub, { visible = null } = {}) {
  const res = new EventEmitter();
  res.chunks = [];
  res.writableLength = 0;
  res.destroyed = false;
  res.writableEnded = false;
  res.headers = null;
  res.writeHead = (status, headers) => { res.headers = headers; };
  res.write = (chunk) => { res.chunks.push(chunk); return true; };
  res.destroy = () => { res.destroyed = true; };
  const req = { url: "/zai/api/event", headers: {} };
  hub.handleClient(req, res, { visible });
  res.events = () =>
    res.chunks
      .join("")
      .split("\n\n")
      .map((f) => f.split("\n").find((l) => l.startsWith("data: ")))
      .filter(Boolean)
      .map((l) => JSON.parse(l.slice(6)));
  res.waitFor = (pred, ms = 5000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        let found;
        try {
          found = res.events().find(pred);
        } catch { /* полкадра — не JSON */ }
        if (found) {
          clearInterval(poll);
          resolve(found);
          return;
        }
        if (Date.now() - t0 > ms) {
          clearInterval(poll);
          reject(new Error(`waitFor timeout; have ${res.chunks.join("").slice(0, 1500)}`));
        }
      }, 20);
    });
  return res;
}

// ---- v2: один глобальный поток, раскладка по папкам --------------------------

test("v2 хаб: события двух папок из одного потока доходят до своих клиентов и не текут в чужие", async () => {
  const { hub, up } = await hubWithOc({});
  const alice = fakeClient(hub, { visible: (d) => d === DIR_A });
  const bob = fakeClient(hub, { visible: (d) => d === DIR_B });
  const admin = fakeClient(hub); // без фильтра — видит всё
  await up.waitForSubscription();
  up.emit({ type: "session.idle", location: { directory: DIR_A }, data: { sessionID: "ses_a" } });
  up.emit({ type: "session.idle", location: { directory: DIR_B }, data: { sessionID: "ses_b" } });
  await alice.waitFor((e) => e.type === "session.idle" && e.properties.sessionID === "ses_a");
  await bob.waitFor((e) => e.type === "session.idle" && e.properties.sessionID === "ses_b");
  assert.equal(alice.events().some((e) => e.properties?.sessionID === "ses_b"), false, "алисе не течёт папка Боб");
  assert.equal(bob.events().some((e) => e.properties?.sessionID === "ses_a"), false, "Бобу не течёт папка Алисы");
  await admin.waitFor((e) => e.properties?.sessionID === "ses_a");
  await admin.waitFor((e) => e.properties?.sessionID === "ses_b");
});

test("v2 хаб: busy/idle/удаление (BUG-186) работают по событиям переписывателя", async () => {
  const { hub, up } = await hubWithOc({});
  await up.waitForSubscription();
  up.emit({ type: "session.execution.started", data: { sessionID: "ses_a" } });
  await waitForCondition(() => hub.busySnapshot().ses_a); // execution.started → busy
  up.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } });
  await waitForCondition(() => !hub.busySnapshot().ses_a); // execution.succeeded → idle
  up.emit({ type: "session.execution.started", data: { sessionID: "ses_a" } });
  await waitForCondition(() => hub.busySnapshot().ses_a); // снова busy
  up.emit({ type: "session.deleted", location: { directory: DIR_A }, data: { sessionID: "ses_a" } });
  await waitForCondition(() => !hub.busySnapshot().ses_a && !hub.dialogSessions().has("ses_a")); // BUG-186
});

test("v2 хаб: обрыв потока → resync клиентам и пересинхронизация состояния (вопросы из upstream)", async () => {
  const { hub, up } = await hubWithOc({});
  const client = fakeClient(hub);
  await up.waitForSubscription();
  up.dropSubscriptions();
  await up.waitForSubscription(); // адаптер переподключился
  await client.waitFor((e) => e.type === "zai.resync"); // gap после реконнекта раздаётся клиентам
  // пересинхронизация состояния: вопрос, появившийся на фейке, попадает в снапшот
  // форма живёт только внутри идущего хода: сессия занята (BUG-195 — опрос только занятых папок)
  up.state.sessions.push({ id: "ses_gap", location: { directory: DIR_A } });
  up.state.active = { ses_gap: { type: "running" } };
  up.state.forms = [{ id: "form_gap", sessionID: "ses_gap", title: "Продолжить?", fields: [] }];
  await waitForCondition(() => hub.dialogsSnapshot().some((d) => d.id === "form_gap"), "статусы/вопросы перечитаны после gap");
});

test("BUG-195: v2 хаб опрашивает вопросы/разрешения только папок занятых сессий (не поднимает экземпляры всех папок)", async () => {
  const DIR_C = "C:\\Users\\USER\\.zai-tenants\\carol";
  const { up } = await hubWithOc({
    directories: [DIR_A], // как в проде: закреплённая папка включает опрос syncDirectories
    upOpts: {
      sessions: [
        { id: "ses_a", location: { directory: DIR_A } },
        { id: "ses_b", location: { directory: DIR_B } },
        { id: "ses_c", location: { directory: DIR_C } },
      ],
      active: { ses_b: { type: "running" } },
    },
  });
  await waitForCondition(() => up.requests.some((r) => r.path === "/api/form"), "хаб опросил формы");
  await new Promise((r) => setTimeout(r, 400)); // несколько циклов directoryPollMs=100
  const polled = new Set(up.requests.filter((r) => r.path === "/api/form" || r.path === "/api/permission/request").map((r) => r.queryEntries.find(([k]) => k === "location[directory]")?.[1]));
  assert.deepEqual([...polled], [DIR_B], "только папка занятой сессии");
});

// ---- v2: replay зависшего prompt ---------------------------------------------

test("v2 хаб: replay зависшего prompt — POST /api/session/:sid/prompt с text, модель остаётся на сессии", async () => {
  const now = Date.now();
  const { hub, up } = await hubWithOc({
    hubOpts: { stallReplayMs: 120, stallTickMs: 40, maxPromptReplays: 1, unstickSettleMs: 0 },
    directories: [DIR_A],
    upOpts: {
      sessions: [{ id: "ses_r", title: "", time: { created: now, updated: now }, location: { directory: DIR_A } }],
      messages: { ses_r: [
        { id: "u2", type: "user", text: "почему молчишь", time: { created: now - 60_000 } },
        { id: "a1", type: "assistant", agent: "build", model: { id: "glm-5.3-flash", providerID: "zai-coding-plan", variant: "max" }, time: { created: now - 120_000, completed: now - 90_000 }, content: [{ type: "text", text: "раньше" }] },
      ] },
    },
  });
  // boot seed (первый syncDirectories → listMessages адаптера) ставит pending
  await waitForCondition(() => hub.pendingSnapshot().ses_r); // хвост с unanswered-промптом найден
  await waitForCondition(() => {
    const post = up.requests.find((r) => r.method === "POST" && r.path === "/api/session/ses_r/prompt");
    return post && hub.pendingSnapshot().ses_r?.replays === 1;
  }, 5000);
  const post = up.requests.find((r) => r.method === "POST" && r.path === "/api/session/ses_r/prompt");
  assert.equal(post.body.text, "почему молчишь", "parts → text тела v2");
  assert.equal(post.body.model, undefined, "model/agent/variant в v2 живут на сессии — replay не перепривязывает");
  assert.equal(post.body.agent, undefined);
  assert.equal(post.body.variant, undefined);
  assert.equal(post.query, "", "v2 prompt — sid в пути, ?directory= не нужен");
});

// ---- v1 через адаптер: прежнее per-directory поведение -----------------------

test("v1 через адаптер: per-directory /event?directory=, события как есть, resync на реконнекте", async () => {
  const up = await startFakeOpencode({});
  const oc = createOcClient({ api: "v1", base: up.url });
  const hub = new EventHub({ directoryPollMs: 100, oc });
  hub.start(up.url, { directory: "C:\\Home" });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  const client = fakeClient(hub);
  await up.waitForSubscription("C:\\Home");
  up.emit({ type: "session.idle", properties: { sessionID: "ses_h" } }, "C:\\Home");
  await client.waitFor((e) => e.type === "session.idle" && e.properties.sessionID === "ses_h");
  up.dropSubscriptions();
  await up.waitForSubscription("C:\\Home");
  await client.waitFor((e) => e.type === "zai.resync"); // v1: resync на реконнекте (как раньше)
});
