// BUG-218 (SRV-07, design §1): откат проверял «ход не идёт» один раз, затем
// долго готовился (история, план) — новый ход стартовал в этом окне, и откат
// менял файлы под живым ходом. Теперь «ход не идёт» и флаг «идёт откат»
// ставятся под блокировкой чата; старт хода во время отката отвечает
// 409 revert in progress ДО любых побочных эффектов. Медленный фейк держит
// откат в середине — ход обязан получить 409, «не оба 2xx». Образец —
// tests/rewind-server.test.js (медленный фейк апстрима).
// Run: node --test --test-timeout=60000 tests/revert-race.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ADMIN = "a".repeat(24) + "-revert-race-" + "4".repeat(24);
const MODEL = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const MESSAGES = [
  { info: { id: "msg_u1", sessionID: "ses_rv", role: "user", time: { created: 1000 } }, parts: [{ type: "text", text: "вопрос раз" }] },
  { info: { id: "msg_a1", sessionID: "ses_rv", role: "assistant", time: { created: 1100, completed: 1200 } }, parts: [{ type: "text", text: "ответ раз" }] },
  { info: { id: "msg_u2", sessionID: "ses_rv", role: "user", time: { created: 2000 } }, parts: [{ type: "text", text: "вопрос два" }] },
  { info: { id: "msg_a2", sessionID: "ses_rv", role: "assistant", time: { created: 2100, completed: 2200 } }, parts: [{ type: "text", text: "ответ два" }] },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(20);
  }
  return false;
};

let up, srv;
const api = (p, { method = "GET", body } = {}) =>
  fetch(srv.base + p, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const post = (p, obj) => api(p, { method: "POST", body: obj });

before(async () => {
  up = await startFakeOpencode();
  // Откат задерживается на истории — окно «флаг поставлен, файлы ещё не тронуты».
  up.route("GET", "/session/ses_rv/message", async () => {
    await sleep(500);
    return { json: MESSAGES };
  });
  up.route("POST", "/session/ses_rv/revert", (req, body) => ({ json: { id: "ses_rv", revert: { messageID: body?.messageID } } }));
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN } });
  // Сессия с моделью апстрима: привязка opencode известна порталу без стора.
  // Пуш после первой выборки индекса — PATCH-подобные маршруты форсируют свежий GET /session.
  up.state.sessions.push({ id: "ses_rv", directory: srv.tmp.home, title: "revert race", model: { providerID: MODEL.providerID, id: MODEL.modelID } });
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

test("откат и новый ход одновременно: ход получает 409 revert in progress — не оба 2xx", async () => {
  const revert = post("/zai/api/session/ses_rv/revert", { messageID: "msg_u2" });
  // Откат вошёл в критический участок (флаг под локом уже поставлен) —
  // дошёл до медленной истории. Раньше ход в этом окне стартовал свободно.
  assert.ok(await waitFor(() => up.requests.some((r) => r.method === "GET" && r.path === "/session/ses_rv/message")), "откат дошёл до истории");
  const prompt = await post("/zai/api/session/ses_rv/prompt", { parts: [{ type: "text", text: "новый ход во время отката" }] });
  assert.equal(prompt.status, 409, `ход должен получить 409, получил ${prompt.status}`);
  assert.equal((await prompt.json()).error, "revert in progress");

  const rv = await revert;
  assert.equal(rv.status, 200, await rv.clone().text());
  const done = (await rv.json());
  assert.equal(done.revert.messageID, "msg_u2");
  // ход не ушёл в upstream и привязку не тронул
  assert.equal(up.requests.some((r) => r.path === "/session/ses_rv/prompt_async"), false, "отклонённый ход не должен был стартовать");
});
