// TASK-16.31: контракт «защита от зависшего хода» на opencode 2.x.
// Живой поток 2.2.6 (tests/fixtures/v2-turn-events.json, записан со стенда v2) не содержит
// message.updated — хаб взводит и снимает ожидание ответа по служебным событиям, которые
// порождает переписыватель адаптера (properties.zaiInternal). Клиентам они не уходят.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { EventHub } from "../lib/hub.js";
import { createOcClient, createV2Rewriter } from "../lib/oc-client.js";
import { startFakeOpencodeV2 } from "./helpers/fake-opencode-v2.mjs";

const PWD = "oc2-secret";
const DIR = "C:\\Users\\USER\\.zai-tenants\\alice";
const FIX = JSON.parse(readFileSync(new URL("./fixtures/v2-turn-events.json", import.meta.url), "utf8"));
const SID = FIX.sessionID;
// события записи: папка заменена на папку теста, рукопожатие отдаёт сам фейк
const EVENTS = FIX.events
  .filter((e) => e.type !== "server.connected")
  .map(({ dtMs, ...e }) => JSON.parse(JSON.stringify(e), (k, v) => (k === "directory" && typeof v === "string" ? DIR : v)));
const idx = (type) => EVENTS.findIndex((e) => e.type === type);
const INBOX = EVENTS[idx("session.inbox.enqueued")].data.inboxID;

const cleanups = [];
after(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`не дождались: ${label}`);
    await sleep(20);
  }
}
async function setup({ hubOpts = {}, messages = [] } = {}) {
  const now = Date.now();
  const up = await startFakeOpencodeV2({
    password: PWD,
    sessions: [{ id: SID, title: "", time: { created: now, updated: now }, location: { directory: DIR } }],
    messages: { [SID]: messages },
  });
  const oc = createOcClient({ api: "v2", base: up.url, password: PWD });
  const hub = new EventHub({ directoryPollMs: 100, stallReplayMs: 600_000, ...hubOpts, oc });
  hub.start(up.url, { directories: [DIR] });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await up.waitForSubscription();
  const res = new EventEmitter();
  res.chunks = [];
  res.writableLength = 0;
  res.writeHead = () => {};
  res.write = (c) => { res.chunks.push(c); return true; };
  res.destroy = () => {};
  hub.handleClient({ url: "/zai/api/event", headers: {} }, res, { visible: null });
  const seen = () =>
    res.chunks.join("").split("\n\n").map((f) => f.split("\n").find((l) => l.startsWith("data: "))).filter(Boolean)
      .map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
  return { up, hub, seen, raw: () => res.chunks.join("") };
}
// История с неотвеченным сообщением появляется ПОСЛЕ стартового сканирования хаба (иначе ожидание взвёл бы
// сам boot seed, а не событие): проверяется именно путь событий.
async function lateHistory(up, text) {
  await until(() => up.requests.some((r) => r.method === "GET" && r.path === `/api/session/${SID}/message`), "стартовое сканирование истории прошло");
  await sleep(150);
  up.state.messages[SID] = [{ id: INBOX, type: "user", text, time: { created: Date.now() } }];
}
const feed = async (up, events) => { for (const e of events) { up.emit(e); await sleep(3); } };

test("запись живого потока 2.2.6: message.updated в ней нет — контракт держит переписыватель", () => {
  assert.equal(FIX.events.some((e) => e.type === "message.updated"), false);
  for (const t of ["session.inbox.enqueued", "session.inbox.delivered", "session.execution.started", "session.step.started", "session.execution.succeeded"]) {
    assert.ok(idx(t) >= 0, `в записи есть ${t}`);
  }
});

test("переписыватель: служебные message.updated — пользователь по inbox.enqueued, ответ с parentID по step.started; исходные события идут как раньше", () => {
  const out = [];
  const rw = createV2Rewriter({ emit: (e) => out.push(e), throttleMs: 0 });
  const returned = [];
  for (const e of EVENTS) { const r = rw(e); if (r) returned.push(r); }
  const internal = out.filter((e) => e.properties?.zaiInternal === true);
  assert.deepEqual(internal.map((e) => `${e.type}:${e.properties.info.role}`), ["message.updated:user", "message.updated:assistant"]);
  assert.equal(internal[0].properties.info.id, INBOX);
  assert.equal(internal[1].properties.info.parentID, INBOX);
  assert.equal(internal[1].properties.info.time.completed, undefined, "успешный ход не помечается завершённым служебно — детектор пустого хода не затронут");
  assert.equal(internal.every((e) => e.directory === DIR), true);
  // исходные inbox/step события по-прежнему проходят насквозь, служебного флага на них нет
  assert.ok(returned.some((e) => e.type === "session.inbox.enqueued"));
  assert.ok(returned.some((e) => e.type === "session.step.started"));
  assert.equal(returned.some((e) => e.properties?.zaiInternal), false);
  assert.equal(returned.at(-1).type, "session.idle");
  rw({ type: "session.deleted", data: { id: SID } });
  assert.equal(rw._sizes().turnUser, 0, "карта сообщений хода чистится по удалению сессии");
});

test("хаб: сообщение пользователя взводит ожидание, ответ его снимает; служебные события клиентам не уходят", async () => {
  const { up, hub, seen, raw } = await setup();
  const cut = idx("session.inbox.enqueued");
  await feed(up, EVENTS.slice(0, cut + 1));
  await until(() => hub.pendingSnapshot()[SID], "ожидание взведено по inbox.enqueued");
  await feed(up, EVENTS.slice(cut + 1));
  await until(() => seen().some((e) => e.type === "session.idle"), "клиент получил конец хода");
  await until(() => !hub.pendingSnapshot()[SID], "ожидание снято ответом");
  assert.equal(Object.keys(hub.busySnapshot()).length, 0);
  assert.equal(raw().includes("zaiInternal"), false, "служебный флаг не утёк клиенту");
  assert.equal(seen().some((e) => e.type === "message.updated"), false, "клиент не получил служебных message.updated");
  const text = seen().filter((e) => e.type === "message.part.updated" && e.properties?.part?.type === "text").at(-1);
  assert.equal(text?.properties?.part?.text, "готово", "текст ответа дошёл клиенту как раньше");
  assert.ok(seen().some((e) => e.type === "session.inbox.enqueued"), "исходное событие очереди проходит клиенту как раньше");
});

test("хаб: «Стоп» до первого шага — ожидание снято, повторной отправки нет", async () => {
  const { up, hub } = await setup({ hubOpts: { stallReplayMs: 150, stallTickMs: 40, maxPromptReplays: 1, unstickSettleMs: 0 } });
  await lateHistory(up, "вопрос");
  const head = EVENTS.slice(0, idx("session.inbox.delivered") + 1);
  await feed(up, head);
  await until(() => hub.pendingSnapshot()[SID], "ожидание взведено");
  up.emit({ type: "session.execution.interrupted", data: { sessionID: SID } });
  await until(() => !hub.pendingSnapshot()[SID], "ожидание снято прерыванием");
  await sleep(600); // пауза по смыслу: окно повторной отправки (150 мс) прошло несколько раз
  assert.equal(up.requests.some((r) => r.method === "POST" && r.path === `/api/session/${SID}/prompt`), false, "остановленный пользователем промпт не отправлен повторно");
});

test("хаб: ход упал с ошибкой — клиент получил ошибку, ожидание снято, повтора нет", async () => {
  const { up, hub, seen } = await setup({ hubOpts: { stallReplayMs: 150, stallTickMs: 40, maxPromptReplays: 1, unstickSettleMs: 0 } });
  await lateHistory(up, "вопрос");
  await feed(up, EVENTS.slice(0, idx("session.inbox.delivered") + 1));
  await until(() => hub.pendingSnapshot()[SID], "ожидание взведено");
  up.emit({ type: "session.execution.failed", data: { sessionID: SID, error: { type: "ProviderError", message: "boom" } } });
  await until(() => seen().some((e) => e.type === "session.error"), "клиент получил ошибку хода");
  await until(() => !hub.pendingSnapshot()[SID], "ожидание снято ошибкой");
  await sleep(600); // пауза по смыслу: окно повторной отправки прошло
  assert.equal(up.requests.some((r) => r.method === "POST" && r.path === `/api/session/${SID}/prompt`), false);
});

test("хаб: сообщение принято, но ход не запустился — после окна тишины промпт отправлен повторно", async () => {
  const { up, hub } = await setup({ hubOpts: { stallReplayMs: 150, stallTickMs: 40, maxPromptReplays: 1, unstickSettleMs: 0 }, messages: [{ id: INBOX, type: "user", text: "почему молчишь", time: { created: Date.now() } }] });
  await feed(up, EVENTS.slice(0, idx("session.inbox.enqueued") + 1)); // execution.started так и не пришёл
  await until(() => hub.pendingSnapshot()[SID], "ожидание взведено");
  await until(() => up.requests.some((r) => r.method === "POST" && r.path === `/api/session/${SID}/prompt`), "повторная отправка ушла", 6000);
  const post = up.requests.find((r) => r.method === "POST" && r.path === `/api/session/${SID}/prompt`);
  assert.equal(post.body.text, "почему молчишь");
});

test("SRV-35: форму вопроса прочитать не удалось — ответ движку не уходит, наружу ошибка 502", async () => {
  const up = await startFakeOpencodeV2({ password: PWD });
  cleanups.push(() => up.close());
  const oc = createOcClient({ api: "v2", base: up.url, password: PWD });
  up.route("GET", "/api/form", () => ({ status: 500, json: { _tag: "InternalError", message: "boom" } }));
  await assert.rejects(
    () => oc.replyQuestion({ directory: DIR, sessionID: "ses_q", formID: "frm_1", answers: [["синий"]] }),
    (err) => err?.status === 502 && /форма вопроса недоступна/.test(String(err.message)),
  );
  assert.equal(up.requests.some((r) => r.method === "POST" && r.path === "/api/session/ses_q/form/frm_1/reply"), false, "ответ с выдуманными ключами не отправлен");
});
