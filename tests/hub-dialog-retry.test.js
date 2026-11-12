// BUG-213 (SRV-08/SRV-09): хаб не теряет диалог и занятость при неудачном
// автоответе/abort. Фейковый oc-клиент (интерфейс lib/oc-client.js): события —
// заглушка, replyPermission/rejectQuestion/abort бросают по сценарию; сценарий
// диалога идёт через hub.emit() (тот же конвейер #emitEvent, что и live SSE).
// Run: node --test --test-timeout=60000 tests/hub-dialog-retry.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventHub } from "../lib/hub.js";
import { OcError } from "../lib/oc-client.js";

const cleanups = [];
after(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Condition polling instead of fixed windows (robust under a loaded machine).
async function waitUntil(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) return false;
    await sleep(20);
  }
  return true;
}

// Фейковый oc-клиент: считает вызовы; replyErr/abortErr — функции, выдающие
// ошибку текущего прохода (или null — успех). base хабу нужен только для
// гейтов watchdog: весь I/O уходит в фейк.
function fakeOc() {
  const calls = { replies: 0, rejects: 0, aborts: 0 };
  let replyErr = null;
  let abortErr = null;
  const oc = {
    api: "v1",
    events: () => ({ close() {} }),
    async replyPermission() {
      calls.replies += 1;
      if (replyErr) throw replyErr();
    },
    async rejectQuestion() {
      calls.rejects += 1;
      if (replyErr) throw replyErr();
    },
    async abort() {
      calls.aborts += 1;
      if (abortErr) throw abortErr();
    },
  };
  return { oc, calls, setReplyErr: (f) => { replyErr = f; }, setAbortErr: (f) => { abortErr = f; } };
}

function hubWith(oc, opts = {}) {
  const hub = new EventHub({ oc: oc.oc, unstickSettleMs: 0, ...opts });
  hub.start("http://127.0.0.1:9");
  cleanups.push(() => hub.stop());
  return hub;
}

const busyOn = (sid) => ({ type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } });

// ---- #expireDialogs: запись удаляется только по исходу автоответа ------------

test("BUG-213: автоответ упал — диалог остаётся и повторяется на следующем проходе; успех — запись уходит", async () => {
  const oc = fakeOc();
  oc.setReplyErr(() => new OcError("network down", { status: 0, code: "network" }));
  const hub = hubWith(oc, { dialogTimeoutMs: 40, stallTickMs: 20 });
  const S = "ses_retry";
  hub.emit({ type: "permission.asked", properties: { sessionID: S, id: "per_1", permission: "bash" } });
  assert.ok(hub.dialogsSnapshot().some((d) => d.id === "per_1"), "диалог в учёте");
  await waitUntil(() => oc.calls.replies >= 2, 3000);
  assert.ok(hub.dialogsSnapshot().some((d) => d.id === "per_1"), "после неудачи запись на месте — повтор будет");
  oc.setReplyErr(null);
  assert.ok(await waitUntil(() => hub.dialogsSnapshot().length === 0, 3000), "успешный автоответ удаляет запись");
  const done = oc.calls.replies;
  await sleep(100);
  assert.equal(oc.calls.replies, done, "после удаления попыток больше нет");
});

test("BUG-213: движок отвечает 404 — диалог считается решённым и удаляется сразу", async () => {
  const oc = fakeOc();
  oc.setReplyErr(() => new OcError("already gone", { status: 404 }));
  const hub = hubWith(oc, { dialogTimeoutMs: 40, stallTickMs: 20 });
  hub.emit({ type: "question.asked", properties: { sessionID: "ses_404", id: "q_1" } });
  assert.ok(await waitUntil(() => hub.dialogsSnapshot().length === 0, 3000), "404 — удаляем без повторов");
  assert.ok(oc.calls.rejects >= 1, "попытка была");
  const n = oc.calls.rejects;
  await sleep(100);
  assert.equal(oc.calls.rejects, n, "повторов нет");
});

test("BUG-213: 5 неудач подряд — запись удаляется с записью в лог, шторм прекращается", async () => {
  const oc = fakeOc();
  oc.setReplyErr(() => new OcError("network down", { status: 0, code: "network" }));
  const hub = hubWith(oc, { dialogTimeoutMs: 40, stallTickMs: 20 });
  hub.emit({ type: "permission.asked", properties: { sessionID: "ses_giveup", id: "per_9" } });
  assert.ok(await waitUntil(() => oc.calls.replies >= 5, 5000), "пять попыток");
  assert.ok(await waitUntil(() => hub.dialogsSnapshot().length === 0, 3000), "после пятой неудачи сдались");
  const n = oc.calls.replies;
  await sleep(120);
  assert.equal(oc.calls.replies, n, "бесконечного долбления нет");
});

// ---- #abortStalled / prepareForPrompt: занятость снимается после подтверждения

test("BUG-213: abort упал — busy остаётся, часы тишины заводятся заново; успех — снимается", async () => {
  const oc = fakeOc();
  oc.setAbortErr(() => new OcError("upstream 503", { status: 503 }));
  const hub = hubWith(oc, { stallAbortMs: 40, stallTickMs: 20 });
  const S = "ses_stuck";
  hub.emit(busyOn(S));
  await waitUntil(() => oc.calls.aborts >= 1, 3000);
  assert.ok(hub.busySnapshot()[S], "abort не прошёл — чат не считался свободным");
  const t1 = oc.calls.aborts;
  await sleep(30); // меньше порога тишины
  assert.equal(oc.calls.aborts, t1, "без шторма: следующая попытка — через тот же порог тишины");
  oc.setAbortErr(null);
  assert.ok(await waitUntil(() => hub.busySnapshot()[S] === undefined, 3000), "успешный abort снимает запись");
});

test("BUG-213: prepareForPrompt — abort не прошёл, занятость возвращена (BUG-07.10 жив)", async () => {
  const oc = fakeOc();
  oc.setAbortErr(() => new OcError("boom", { status: 0, code: "network" }));
  const hub = hubWith(oc, { promptUnstickMs: 40 });
  const S = "ses_pp";
  hub.emit(busyOn(S));
  await sleep(60); // тишина за порогом
  let res = await hub.prepareForPrompt(S);
  assert.deepEqual(res, { aborted: false, reason: "abort-failed" });
  assert.ok(hub.busySnapshot()[S], "abort не прошёл — запись занятости возвращена");
  oc.setAbortErr(null);
  res = await hub.prepareForPrompt(S);
  assert.deepEqual(res, { aborted: true, reason: "silent" });
  assert.equal(hub.busySnapshot()[S], undefined, "успешный unstick снимает запись, как раньше");
});
