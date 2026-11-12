// TASK-16.7 волна 2 (ядро чата на opencode 2.2.6): адаптер приводит формы v2 к языку 1.x.
// BUG-202 стоп/отказ как ошибка; BUG-203 вопросы-формы; BUG-204 ответ на вопрос;
// BUG-205 разрешения; BUG-206 «Вернуть» после отката; BUG-207 файлы в истории;
// BUG-208 чип вложения.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeOpencodeV2 } from "./helpers/fake-opencode-v2.mjs";
import { createOcClient } from "../lib/oc-client.js";

const PWD = "pw-wave2";
const DIR = "C:\\Users\\USER\\.zai-tenants\\alice";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FORM = {
  id: "frm_1", sessionID: "ses_1", title: "Questions",
  metadata: { kind: "question", tool: { messageID: "msg_a", id: "call_q" } },
  fields: [
    { key: "q0", title: "Цвет", description: "Какой цвет вы выбираете?", type: "string",
      options: [{ value: "красный", label: "красный", description: "Красный цвет" }, { value: "синий", label: "синий" }], custom: true },
    { key: "q1", title: "Размеры", description: "Какие размеры?", type: "string[]", options: [{ value: "S", label: "S" }, { value: "M", label: "M" }] },
  ],
};
const PERM = { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["rm -rf build"], save: ["rm *"], source: { type: "tool", messageID: "msg_a", id: "call_s" } };

async function withUp(opts, fn) {
  const up = await startFakeOpencodeV2({ password: PWD, ...opts });
  try {
    await fn(up, createOcClient({ api: "v2", base: up.url, password: PWD }));
  } finally {
    await up.close();
  }
}

test("BUG-202: SSE — прерванный ход ({type:'aborted'}) приходит как MessageAbortedError, не как ошибка хода", async () => {
  await withUp({}, async (up, c) => {
    const got = [];
    const stop = c.events({ onEvent: (e) => got.push(e), backoffMs: [10, 20] });
    await up.waitForSubscription();
    up.emit({ type: "session.execution.failed", location: { directory: DIR }, data: { sessionID: "ses_1", error: { type: "aborted", message: "Aborted" } } });
    up.emit({ type: "session.execution.failed", location: { directory: DIR }, data: { sessionID: "ses_2", error: { type: "provider.no-route", message: "нет модели" } } });
    await sleep(60);
    const a = got.find((e) => e.properties?.sessionID === "ses_1");
    assert.equal(a.type, "session.idle", "стоп — конец хода, не ошибка");
    const b = got.find((e) => e.properties?.sessionID === "ses_2");
    assert.equal(b.type, "session.error");
    assert.equal(b.properties.error.name, "provider.no-route", "у ошибки появилось имя для клиента");
    assert.equal(b.properties.error.data.message, "нет модели");
    stop.close();
  });
});

test("BUG-202: история — ответ с ошибкой aborted → error.name MessageAbortedError", async () => {
  await withUp({ messages: { ses_1: [
    { id: "m2", type: "assistant", content: [{ type: "text", text: "част" }], error: { type: "aborted", message: "Aborted" }, time: { created: 2 } },
    { id: "m1", type: "user", text: "q", time: { created: 1 } },
  ] } }, async (up, c) => {
    const { messages } = await c.listMessages("ses_1", { directory: DIR });
    assert.equal(messages[1].info.error.name, "MessageAbortedError");
  });
});

test("BUG-203: форма v2 → вопрос 1.x (SSE form.created {form} и список /api/form)", async () => {
  await withUp({ forms: [FORM] }, async (up, c) => {
    const got = [];
    const stop = c.events({ onEvent: (e) => got.push(e), backoffMs: [10, 20] });
    await up.waitForSubscription();
    up.emit({ type: "form.created", location: { directory: DIR }, data: { form: FORM } });
    await sleep(60);
    const q = got.find((e) => e.type === "question.asked");
    assert.equal(q.properties.id, "frm_1");
    assert.equal(q.properties.sessionID, "ses_1");
    assert.deepEqual(q.properties.questions.map((x) => [x.key, x.header, x.question, x.multiple, x.custom]), [
      ["q0", "Цвет", "Какой цвет вы выбираете?", false, true],
      ["q1", "Размеры", "Какие размеры?", true, false],
    ]);
    assert.deepEqual(q.properties.questions[0].options, [{ label: "красный", description: "Красный цвет" }, { label: "синий" }]);
    assert.deepEqual(q.properties.tool, { messageID: "msg_a", callID: "call_q" });
    stop.close();
    const list = await c.listQuestions({ directory: DIR });
    assert.equal(list[0].id, "frm_1");
    assert.equal(list[0].questions.length, 2);
  });
});

test("BUG-204: ответ клиента массивом (1.x answers string[][]) → {answer:{ключ: значение}} по полям формы", async () => {
  await withUp({ forms: [FORM] }, async (up, c) => {
    await c.replyQuestion({ directory: DIR, sessionID: "ses_1", formID: "frm_1", answers: [["синий"], ["S", "M"]] });
    const req = up.requests.find((r) => r.method === "POST" && r.path === "/api/session/ses_1/form/frm_1/reply");
    assert.deepEqual(req.body, { answer: { q0: "синий", q1: ["S", "M"] } });
    // объект — как раньше
    await c.replyQuestion({ directory: DIR, sessionID: "ses_1", formID: "frm_1", answer: { q0: "красный" } });
    const req2 = up.requests.filter((r) => r.method === "POST" && r.path === "/api/session/ses_1/form/frm_1/reply").at(-1);
    assert.deepEqual(req2.body, { answer: { q0: "красный" } });
  });
});

test("BUG-205: запрос разрешения v2 → поля 1.x (permission/patterns/always/command), исходные поля сохранены", async () => {
  await withUp({ permissions: [PERM] }, async (up, c) => {
    const got = [];
    const stop = c.events({ onEvent: (e) => got.push(e), backoffMs: [10, 20] });
    await up.waitForSubscription();
    up.emit({ type: "permission.asked", location: { directory: DIR }, data: PERM });
    await sleep(60);
    const p = got.find((e) => e.type === "permission.asked").properties;
    assert.equal(p.permission, "bash", "shell → bash (язык 1.x)");
    assert.deepEqual(p.patterns, ["rm -rf build"]);
    assert.deepEqual(p.always, ["rm *"]);
    assert.equal(p.metadata.command, "rm -rf build");
    assert.equal(p.action, "shell", "исходное поле на месте (tenantMustReject)");
    stop.close();
    const list = await c.listPermissions({ directory: DIR });
    assert.equal(list[0].permission, "bash");
  });
});

test("BUG-206: revert v2 — только stage (откат можно вернуть); commit — перед следующим ходом", async () => {
  await withUp({ sessions: [{ id: "ses_1", location: { directory: DIR }, revert: { messageID: "m1" } }] }, async (up, c) => {
    await c.revert("ses_1", { directory: DIR, messageID: "m1" });
    const paths = up.requests.map((r) => `${r.method} ${r.path}`);
    assert.ok(paths.includes("POST /api/session/ses_1/revert/stage"));
    assert.ok(!paths.includes("POST /api/session/ses_1/revert/commit"), "без commit — «Вернуть» работает");
    up.requests.length = 0;
    await c.prompt({ directory: DIR, sessionID: "ses_1", parts: [{ type: "text", text: "дальше" }] });
    const order = up.requests.map((r) => `${r.method} ${r.path}`);
    const ci = order.indexOf("POST /api/session/ses_1/revert/commit");
    const pi = order.indexOf("POST /api/session/ses_1/prompt");
    assert.ok(ci >= 0 && pi > ci, `commit перед ходом: ${order.join(", ")}`);
  });
});

test("BUG-207: история — файлы user-сообщения v2 возвращаются file-частями (картинка в пузыре после перезагрузки)", async () => {
  await withUp({ messages: { ses_1: [
    { id: "m1", type: "user", text: "что на фото?", files: [{ data: "iVBORw0KGgo=", mime: "image/png", name: "a.png", source: { type: "inline" } }, { uri: "file:///C:/x/b.pdf", name: "b.pdf" }], time: { created: 1 } },
  ] } }, async (up, c) => {
    const { messages } = await c.listMessages("ses_1", { directory: DIR });
    const files = messages[0].parts.filter((p) => p.type === "file");
    assert.deepEqual(files, [
      { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,iVBORw0KGgo=" },
      { type: "file", filename: "b.pdf", url: "file:///C:/x/b.pdf" },
    ]);
  });
});

test("BUG-208: история — ссылки на вложения (.zai-uploads) отдельными text-частями, как их шлёт композер", async () => {
  const ref = "[Пользователь приложил файл: .zai-uploads/отчёт.xlsx (2048 байт, application/vnd.ms-excel). Файл лежит в папке сессии.]";
  await withUp({ messages: { ses_1: [
    { id: "m1", type: "user", text: `посмотри\n\n${ref}`, time: { created: 1 } },
  ] } }, async (up, c) => {
    const { messages } = await c.listMessages("ses_1", { directory: DIR });
    const texts = messages[0].parts.filter((p) => p.type === "text").map((p) => p.text);
    assert.deepEqual(texts, ["посмотри", ref]);
  });
});
