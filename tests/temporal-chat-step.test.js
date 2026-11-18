// FEAT-19.16: model step = chat turn. Positive, limit, error, abort, timeout, refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatStepRunner } from "../lib/temporal/chat-step.js";

function harness({ end, refuse = false, answer = "Готово: файл report.md" } = {}) {
  const calls = { dispatched: [], aborted: [], titled: [] };
  let r;
  r = chatStepRunner({
    createSession: async () => "ses_x",
    setTitle: (sid, t) => calls.titled.push(t),
    dispatchTurn: async ({ res, text, engine, model }) => { calls.dispatched.push({ text, engine, model }); res.writeHead(refuse ? 403 : 204); res.end(refuse ? '{"error":"engine not allowed"}' : undefined); if (end) setTimeout(() => r.onTurnEnd({ sid: "ses_x", ...end }), 5); },
    messagesOf: () => [{ info: { role: "user" }, parts: [{ type: "text", text: "q" }] }, { info: { role: "assistant" }, parts: [{ type: "tool" }, { type: "text", text: answer }] }],
    abort: (sid) => calls.aborted.push(sid),
    isLimit: (err) => /usage limit/.test(err),
  });
  return { r, calls };
}
const job = (over = {}) => ({ user: { id: "u" }, engine: "claude", model: "claude-haiku-4-5", directory: "/p/pipelines/x", runFolder: "runs/1", title: "⇄ P · шаг", instruction: "Сделай отчёт", timeoutMs: 2000, ...over });

test("позитив: ход чата с рабочей папкой, ответ и ID разговора", async () => {
  const { r, calls } = harness({ end: { error: null } });
  assert.deepEqual(await r.run(job()), { text: "Готово: файл report.md", sessionId: "ses_x" });
  assert.match(calls.dispatched[0].text, /Рабочая папка этого запуска: runs\/1/); assert.match(calls.dispatched[0].text, /Сделай отчёт$/);
  assert.deepEqual(calls.titled, ["⇄ P · шаг"]);
});
test("лимит подписки → quota_wait; иная ошибка → исключение", async () => {
  assert.equal((await harness({ end: { error: "Claude usage limit reached" } }).r.run(job())).state, "quota_wait");
  await assert.rejects(harness({ end: { error: "boom" } }).r.run(job()), /model step failed: boom/);
  await assert.rejects(harness({ end: { error: null }, answer: "" }).r.run(job()), /no text/);
  await assert.rejects(harness({ end: { reason: "aborted" } }).r.run(job()), /stopped/);
});
test("отказ портала (403) — без ожидания; таймаут и отмена прерывают ход", async () => {
  await assert.rejects(harness({ refuse: true }).r.run(job()), /refused: 403/);
  const t = harness({}); await assert.rejects(t.r.run(job({ timeoutMs: 50 })), /timeout/); assert.deepEqual(t.calls.aborted, ["ses_x"]);
  const a = harness({}); const ac = new AbortController(); const p = a.r.run(job({ signal: ac.signal })); setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, /aborted/); assert.deepEqual(a.calls.aborted, ["ses_x"]);
});

test("BUG-257: проект передаётся в создание чата и ход (тенант: чат в проекте, работа в папке пайпа)", async () => {
  const seen = []; let r;
  r = chatStepRunner({ createSession: async (o) => { seen.push(["create", o.directory, o.project]); return "s1"; },
    dispatchTurn: async (o) => { seen.push(["turn", o.directory, o.project]); o.res.writeHead(204); o.res.end(); setTimeout(() => r.onTurnEnd({ sid: "s1", error: null }), 5); },
    messagesOf: () => [{ info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] }], abort: () => {}, isLimit: () => false });
  await r.run({ user: { id: "t" }, engine: "claude", model: "m", directory: "/home/t/pipelines/p", project: "/home/t", instruction: "x", timeoutMs: 1000 });
  assert.deepEqual(seen, [["create", "/home/t/pipelines/p", "/home/t"], ["turn", "/home/t/pipelines/p", "/home/t"]]);
});
