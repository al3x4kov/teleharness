// @suite: server — импортирует lib/hub.js и спавнит server.js (server-набор, BUG-222/QA-05)
// FEAT-20.37: план хода в хабе — todo.updated/teleharness.plan → #todos {open,total,todos},
// follow-up teleharness.plan подписчикам, сброс на новом запросе, planOf() и
// GET /teleharness/api/session/:id/plan (admin/тенант/404).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { EventHub } from "../lib/hub.js";
import { makeTmpRoot } from "./helpers/env.mjs";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const DIR = "C:\\Home";

// ---- юнит: книжность хаба (emit → #noteEvent → planOf), без сети -------------

const teleharnessPlanEvents = (hub) => {
  const seen = [];
  hub.onEvent((data) => {
    try {
      const e = JSON.parse(data);
      if (e.type === "teleharness.plan") seen.push(e);
    } catch {}
  });
  return seen;
};

test("FEAT-20.37: todo.updated → подписчику уходит teleharness.plan, planOf отдаёт нормализованные этапы", () => {
  const hub = new EventHub({});
  const seen = teleharnessPlanEvents(hub);
  hub.emit(
    {
      type: "todo.updated",
      properties: {
        sessionID: "ses_p1",
        todos: [
          { id: 7, content: "Разобраться", status: "completed" },
          { content: "Починить", status: "in_progress" },
          { content: "Проверить", status: "weird" }, // мусорный статус → pending
        ],
      },
    },
    DIR,
  );
  assert.equal(seen.length, 1, "follow-up teleharness.plan после todo.updated");
  assert.equal(seen[0].properties.sessionID, "ses_p1");
  assert.deepEqual(seen[0].properties.todos, [
    { id: "7", content: "Разобраться", status: "completed" },
    { id: "2", content: "Починить", status: "in_progress" },
    { id: "3", content: "Проверить", status: "pending" },
  ]);
  assert.deepEqual(hub.planOf("ses_p1"), seen[0].properties.todos);
});

test("FEAT-20.37: opencode v2 message.part.updated (tool=todowrite) → teleharness.plan и planOf без дублей", () => {
  const hub = new EventHub({});
  const seen = teleharnessPlanEvents(hub);
  const part = {
    id: "prt_1",
    messageID: "msg_1",
    type: "tool",
    tool: "todowrite",
    state: {
      status: "running",
      input: {
        todos: [
          { id: "a", content: "Шаг 1", status: "completed" },
          { id: "b", content: "Шаг 2", status: "in_progress" },
          { id: "c", content: "Отменён", status: "cancelled" },
        ],
      },
    },
  };
  hub.emit({ type: "message.part.updated", properties: { sessionID: "ses_v2", part } }, DIR);
  // Повторный кадр с тем же списком (например переход running → completed) не дублирует teleharness.plan
  hub.emit({
    type: "message.part.updated",
    properties: { sessionID: "ses_v2", part: { ...part, state: { ...part.state, status: "completed" } } },
  }, DIR);
  assert.equal(seen.length, 1, "один teleharness.plan на неизменившийся список todos");
  assert.deepEqual(hub.planOf("ses_v2"), [
    { id: "a", content: "Шаг 1", status: "completed" },
    { id: "b", content: "Шаг 2", status: "in_progress" },
    { id: "c", content: "Отменён", status: "pending" },
  ]);
  // Managed-сессия (Claude/ACP): message.part.updated не дублирует teleharness.plan (раннер шлёт его сам)
  hub.markManaged("ses_cl");
  hub.emit({ type: "message.part.updated", properties: { sessionID: "ses_cl", part } }, DIR);
  assert.equal(seen.filter((e) => e.properties.sessionID === "ses_cl").length, 0);
});

test("FEAT-20.37: teleharness.plan от раннера напрямую — planOf заполнен, follow-up НЕ создаётся", () => {
  const hub = new EventHub({});
  const seen = teleharnessPlanEvents(hub);
  hub.emit(
    {
      type: "teleharness.plan",
      properties: {
        sessionID: "ses_p2",
        todos: [{ content: "Шаг", status: "pending", priority: "high", junk: true }],
      },
    },
    DIR,
  );
  assert.deepEqual(hub.planOf("ses_p2"), [{ id: "1", content: "Шаг", status: "pending", priority: "high" }]);
  assert.equal(seen.filter((e) => e.properties.sessionID === "ses_p2").length, 1, "ветка teleharness.plan идемпотентна: один кадр на проводе");
});

test("FEAT-20.37: новый запрос (message.updated role=user, новый id) сбрасывает план", () => {
  const hub = new EventHub({});
  hub.emit({ type: "teleharness.plan", properties: { sessionID: "ses_p3", todos: [{ content: "x", status: "pending" }] } }, DIR);
  assert.ok(hub.planOf("ses_p3"));
  hub.emit({ type: "message.updated", properties: { sessionID: "ses_p3", info: { id: "msg_u1", role: "user" } } }, DIR);
  assert.equal(hub.planOf("ses_p3"), null, "план прошлого хода должен исчезнуть до нового");
});

test("FEAT-20.37: повтор уже отвечённого user-сообщения план не сбрасывает (BUG-016)", () => {
  const hub = new EventHub({});
  hub.emit({ type: "message.updated", properties: { sessionID: "ses_p4", info: { id: "msg_u1", role: "user" } } }, DIR);
  hub.emit({ type: "message.part.updated", properties: { sessionID: "ses_p4", part: { id: "pa1", messageID: "msg_a1", type: "step-start" } } }, DIR);
  // ход ответил → план заполнился уже ПОСЛЕ вопроса
  hub.emit({ type: "teleharness.plan", properties: { sessionID: "ses_p4", todos: [{ content: "y", status: "completed" }] } }, DIR);
  assert.ok(hub.planOf("ses_p4"));
  // opencode перечитывает то же user-сообщение после хода (BUG-016)
  hub.emit({ type: "message.updated", properties: { sessionID: "ses_p4", info: { id: "msg_u1", role: "user" } } }, DIR);
  assert.ok(hub.planOf("ses_p4"), "повтор отвечённого — не новый запрос, план остаётся");
  // а genuinely новый запрос сбрасывает
  hub.emit({ type: "message.updated", properties: { sessionID: "ses_p4", info: { id: "msg_u2", role: "user" } } }, DIR);
  assert.equal(hub.planOf("ses_p4"), null);
});

test("FEAT-20.37: managed-сессия — role=user на dispatch сбрасывает план", () => {
  const hub = new EventHub({});
  hub.markManaged("ses_m1");
  hub.emit({ type: "teleharness.plan", properties: { sessionID: "ses_m1", todos: [{ content: "x", status: "pending" }] } }, DIR);
  assert.ok(hub.planOf("ses_m1"));
  hub.emit({ type: "message.updated", properties: { sessionID: "ses_m1", info: { id: "msg_r1", role: "user" } } }, DIR);
  assert.equal(hub.planOf("ses_m1"), null, "раннер сам эмитит role=user на каждый dispatch");
});

test("FEAT-20.37: session.deleted чистит план", () => {
  const hub = new EventHub({});
  hub.emit({ type: "teleharness.plan", properties: { sessionID: "ses_p5", todos: [{ content: "x", status: "pending" }] } }, DIR);
  assert.ok(hub.planOf("ses_p5"));
  hub.emit({ type: "session.deleted", properties: { sessionID: "ses_p5" } }, DIR);
  assert.equal(hub.planOf("ses_p5"), null);
});

test("FEAT-20.37: planOf неизвестной сессии — null (не массив)", () => {
  const hub = new EventHub({});
  assert.equal(hub.planOf("ses_none"), null);
});

test("FEAT-20.37: todo.updated со статусом cancelled не вызывает ложный teleharness.turn.incomplete (BUG-07.8)", () => {
  const hub = new EventHub({});
  const incomplete = [];
  hub.onEvent((data) => {
    try {
      const e = JSON.parse(data);
      if (e.type === "teleharness.turn.incomplete") incomplete.push(e);
    } catch {}
  });
  hub.emit({ type: "session.status", properties: { sessionID: "ses_cancel", status: { type: "busy" } } }, DIR);
  hub.emit({ type: "todo.updated", properties: { sessionID: "ses_cancel", todos: [{ content: "Отменённый шаг", status: "cancelled" }] } }, DIR);
  hub.emit({ type: "session.status", properties: { sessionID: "ses_cancel", status: { type: "idle" } } }, DIR);
  hub.emit({ type: "session.idle", properties: { sessionID: "ses_cancel" } }, DIR);
  assert.equal(incomplete.length, 0, "cancelled не считается незавершённым шагом для BUG-07.8");
});

// ---- серверная часть: реальный server.js на фейковом opencode ----------------

const ADMIN = "a".repeat(24) + "-hub-plan-" + "5".repeat(24);
let up, srv, tenant;
const api = (p, token = ADMIN) => fetch(srv.base + p, { headers: { authorization: `Bearer ${token}` } });

test("FEAT-20.37: GET /session/:id/plan — admin видит план, тенант 403/200/404 (включая Claude/ACP-сессии)", async () => {
  up = await startFakeOpencode();
  const tmp = makeTmpRoot();
  const preTenantDir = path.join(tmp.tenants, "planb");
  writeFileSync(
    path.join(tmp.data, "claude-sessions.json"),
    JSON.stringify({
      version: 1,
      sessions: {
        ses_acp_own: { directory: preTenantDir, messages: [] },
        ses_acp_foreign: { directory: tmp.home, messages: [] },
      },
    }),
  );
  srv = await spawnPortal({ upstream: up.url, tmp, env: { TELEHARNESS_ADMIN_TOKEN: ADMIN } });
  const r = await fetch(srv.base + "/teleharness/api/admin/users", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "planb" }),
  });
  tenant = await r.json();
  assert.ok(tenant.token);
  // чужая (админская) и своя (тенантская) сессии в индексе upstream
  const tenantDir = path.join(srv.tmp.tenants, "planb");
  up.state.sessions = [
    { id: "ses_foreign", directory: srv.tmp.home },
    { id: "ses_own", directory: tenantDir },
  ];

  await up.waitForSubscription(); // подписка хаба на /event
  const todos = [
    { id: 1, content: "Разобраться", status: "completed" },
    { id: 2, content: "Починить", status: "in_progress" },
    { content: "Проверить", status: "bogus" },
  ];
  up.emit({ type: "todo.updated", properties: { sessionID: "ses_plan1", todos } });
  await new Promise((r2) => setTimeout(r2, 120)); // follow-up дошёл до хаба

  // admin: план из памяти хаба, нормализованный
  const ra = await api("/teleharness/api/session/ses_plan1/plan");
  assert.equal(ra.status, 200, await ra.clone().text());
  const ja = await ra.json();
  assert.equal(ja.sessionID, "ses_plan1");
  assert.deepEqual(ja.todos, [
    { id: "1", content: "Разобраться", status: "completed" },
    { id: "2", content: "Починить", status: "in_progress" },
    { id: "3", content: "Проверить", status: "pending" },
  ]);

  // тенант: чужая сессия — 403 «outside your scope»
  const rf = await api("/teleharness/api/session/ses_foreign/plan", tenant.token);
  assert.equal(rf.status, 403);
  assert.equal((await rf.json()).error, "outside your scope");

  // тенант: своя сессия — 200, пустой массив = плана нет
  const ro = await api("/teleharness/api/session/ses_own/plan", tenant.token);
  assert.equal(ro.status, 200, await ro.clone().text());
  assert.deepEqual(await ro.json(), { sessionID: "ses_own", todos: [] });

  // несуществующая сессия — 404
  const rn = await api("/teleharness/api/session/ses_missing/plan", tenant.token);
  assert.equal(rn.status, 404);
  assert.equal((await rn.json()).error, "session not found");

  // teleharness.plan тенанту тоже виден через маршрут: план своей сессии
  up.emit({ type: "teleharness.plan", properties: { sessionID: "ses_own", todos: [{ content: "Свой шаг", status: "pending" }] } });
  await new Promise((r2) => setTimeout(r2, 120));
  const ro2 = await api("/teleharness/api/session/ses_own/plan", tenant.token);
  assert.equal(ro2.status, 200);
  assert.deepEqual((await ro2.json()).todos, [{ id: "1", content: "Свой шаг", status: "pending" }]);

  // Claude/ACP-сессия (отсутствует в индексе opencode, живёт в claude.dirOf):
  // своя → 200 с планом, чужая → 403.
  up.emit({ type: "teleharness.plan", properties: { sessionID: "ses_acp_own", todos: [{ content: "ACP шаг", status: "in_progress" }] } });
  await new Promise((r2) => setTimeout(r2, 120));
  const racpOwn = await api("/teleharness/api/session/ses_acp_own/plan", tenant.token);
  assert.equal(racpOwn.status, 200, await racpOwn.clone().text());
  assert.deepEqual((await racpOwn.json()).todos, [{ id: "1", content: "ACP шаг", status: "in_progress" }]);
  const racpForeign = await api("/teleharness/api/session/ses_acp_foreign/plan", tenant.token);
  assert.equal(racpForeign.status, 403);
});

after(async () => {
  await srv?.stop();
  await up?.close?.();
});
