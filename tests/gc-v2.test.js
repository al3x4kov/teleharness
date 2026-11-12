// BUG-212 (BUG-16.29): сборщик пустых чатов считает сообщения через адаптер
// lib/oc-client.js — работает и на v2 (Basic-авторизация, /api/session/:id/message),
// а не прямым fetch по пути 1.x (на v2 → 404 → «unknown» → чат никогда не удаляется).
// Сценарий BUG-078 на фейке opencode v2: пустой чат старше порога попадает в
// dry-run отчёт и удаляется APPLY-проходом, чат с сообщением остаётся (has-messages).
// Run: node --test --test-timeout=60000 tests/gc-v2.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencodeV2 } from "./helpers/fake-opencode-v2.mjs";

const ADMIN = "c".repeat(24) + "-gcv2-" + "3".repeat(24);
const PW = "oc2-password-gc-НЕ-ПОПАДЕТ-В-ОТВЕТЫ-4k8z";
const DIR = "C:\\w\\gcv2";
const DEF_TITLE = "New session - 2026-11-10T00:00:00.000Z";
const OLD = Date.now() - 5 * 60_000; // старше порога ZAI_GC_EMPTY_MIN = 1 мин

let up, srv;
const api = (p, { method = "GET" } = {}) =>
  fetch(srv.base + p, { method, headers: { authorization: `Bearer ${ADMIN}` } });
const sessionDeletes = () => up.requests.filter((x) => x.method === "DELETE" && x.path.startsWith("/api/session/")).map((x) => x.path);

after(async () => {
  await srv?.stop();
  await up?.close?.();
});

test("BUG-212: на v2 пустой чат старше порога — к удалению и удаляется, чат с сообщением остаётся (has-messages)", async () => {
  const S = (id, extra = {}) => ({ id, title: DEF_TITLE, location: { directory: DIR }, time: { created: OLD, updated: OLD }, ...extra });
  up = await startFakeOpencodeV2({
    password: PW,
    sessions: [S("ses_gc_empty"), S("ses_gc_msgs")],
    messages: { ses_gc_msgs: [{ id: "msg_1", type: "user", text: "вопрос", time: { created: OLD } }] },
  });
  srv = await spawnPortal({
    upstream: up.url,
    env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_OC_API: "v2", ZAI_OC_PASSWORD: PW, ZAI_GC_EMPTY_MIN: "1" },
  });

  // dry-run: пустой — в список к удалению, с сообщением — kept has-messages
  const dry = await api("/zai/api/admin/gc");
  assert.equal(dry.status, 200);
  const rep = await dry.json();
  assert.deepEqual(rep.emptyChats.map((c) => c.id), ["ses_gc_empty"]);
  assert.deepEqual(rep.emptyChatsKept.map((k) => `${k.id}:${k.reason}`), ["ses_gc_msgs:has-messages"]);
  assert.deepEqual(sessionDeletes(), [], "dry-run ничего не удаляет");

  // APPLY: пустой удалён через адаптер (DELETE /api/session/:id), второй жив
  const r = await api("/zai/api/admin/gc", { method: "POST" });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.deepEqual(out.empty.deleted, ["ses_gc_empty"]);
  assert.deepEqual(sessionDeletes(), ["/api/session/ses_gc_empty"]);
  assert.deepEqual(up.state.sessions.map((s) => s.id), ["ses_gc_msgs"]);
});
