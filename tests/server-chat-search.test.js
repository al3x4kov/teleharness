// @suite: server
// FEAT-01.60: контрактный серверный тест GET /teleharness/api/session/search —
// поиск по вопросам и ответам (opencode + Claude), исключение [obsidian-cache] и tool,
// изоляция тенантов (admin vs non-admin), удаление чата из индекса.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnPortal } from "./helpers/spawn-server.mjs";

const TMP = mkdtempSync(path.join(tmpdir(), "teleharness-search-srv-"));
const HOME_DIR = path.join(TMP, "home");
const DATA_DIR = path.join(TMP, "data");
const TENANT_DIR = path.join(TMP, "tenant-alice");
mkdirSync(HOME_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(TENANT_DIR, { recursive: true });

const ADMIN_TOKEN = "a".repeat(20) + "-search-admin-" + "9".repeat(24);

// Seed claude-sessions.json до старта портала (проверка Claude-источника)
writeFileSync(path.join(DATA_DIR, "claude-sessions.json"), JSON.stringify({
  version: 1,
  sessions: {
    ses_claude_admin: {
      directory: HOME_DIR,
      messages: [
        {
          info: { id: "msg_c1", role: "user", time: { created: 1700000010000 } },
          parts: [{ type: "text", text: "[obsidian-cache] скрытый_кэш_клауда\n---\nСобери релизный план по деплою" }],
        },
        {
          info: { id: "msg_c2", role: "assistant", time: { created: 1700000020000, completed: 1700000021000 } },
          parts: [
            { type: "tool", tool: "bash", state: { output: "секретный_вывод_инструмента" } },
            { type: "text", text: "Миграция кластера прошла успешно без простоев" },
          ],
        },
      ],
    },
  },
}));

const ocSessions = [
  { id: "ses_oc_admin", title: "Утренний план", directory: HOME_DIR, time: { created: 1700000001000, updated: 1700000005000 } },
  { id: "ses_claude_admin", title: "Релиз Claude", directory: HOME_DIR, time: { created: 1700000010000, updated: 1700000021000 } },
  { id: "ses_oc_alice", title: "Чат Алисы", directory: TENANT_DIR, time: { created: 1700000030000, updated: 1700000035000 } },
];

const ocMessages = {
  ses_oc_admin: [
    {
      info: { id: "msg_u1", role: "user", time: { created: 1700000002000 } },
      parts: [{ type: "text", text: "[obsidian-cache] секрет_кэша_oc\n---\nПроверь счёт за электричество в квартире" }],
    },
    {
      info: { id: "msg_a1", role: "assistant", time: { created: 1700000005000 } },
      parts: [
        { type: "reasoning", text: "скрытое_размышление_модели" },
        { type: "text", text: "Проверил квитанцию: сумма к оплате 2450 рублей" },
      ],
    },
  ],
  ses_claude_admin: [],
  ses_oc_alice: [
    {
      info: { id: "msg_al1", role: "user", time: { created: 1700000031000 } },
      parts: [{ type: "text", text: "Подбери рецепт яблочного пирога" }],
    },
    {
      info: { id: "msg_al2", role: "assistant", time: { created: 1700000035000 } },
      parts: [{ type: "text", text: "Вот проверенный рецепт шарлотки с корицей" }],
    },
  ],
};

const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (req.method === "GET" && u.pathname === "/session") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(ocSessions));
    return;
  }
  const mm = /^\/session\/([^/]+)\/message$/.exec(u.pathname);
  if (req.method === "GET" && mm) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(ocMessages[decodeURIComponent(mm[1])] ?? []));
    return;
  }
  const dm = /^\/session\/([^/]+)$/.exec(u.pathname);
  if (req.method === "DELETE" && dm) {
    const sid = decodeURIComponent(dm[1]);
    const idx = ocSessions.findIndex((s) => s.id === sid);
    if (idx >= 0) ocSessions.splice(idx, 1);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (u.pathname === "/event") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify([]));
});

await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upUrl = `http://127.0.0.1:${upstream.address().port}`;

const portal = await spawnPortal({
  upstream: upUrl,
  env: {
    TELEHARNESS_HOME: HOME_DIR,
    TELEHARNESS_CHAT_DIR: HOME_DIR,
    TELEHARNESS_DATA_DIR: DATA_DIR,
    TELEHARNESS_ADMIN_TOKEN: ADMIN_TOKEN,
    TELEHARNESS_FILE_ROOTS: TMP,
    TELEHARNESS_SEARCH_NO_BG: "1",
    TELEHARNESS_COST_NO_BACKFILL: "1",
  },
});

after(async () => {
  await portal.stop();
  await new Promise((r) => upstream.close(r));
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

async function login(token) {
  const r = await fetch(`${portal.base}/teleharness/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  return cookie;
}

const adminCookie = await login(ADMIN_TOKEN);

// Создадим тенанта Alice с доступом только к TENANT_DIR
const createAlice = await fetch(`${portal.base}/teleharness/api/admin/users`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: adminCookie },
  body: JSON.stringify({ name: "Alice", directories: [TENANT_DIR], role: "user" }),
});
assert.equal(createAlice.status, 201);
const { token: aliceToken } = await createAlice.json();
const aliceCookie = await login(aliceToken);

async function search(cookie, q) {
  const r = await fetch(`${portal.base}/teleharness/api/session/search?q=${encodeURIComponent(q)}`, {
    headers: { cookie },
  });
  assert.equal(r.status, 200);
  return r.json();
}

test("GET /teleharness/api/session/search: находит вопросы и ответы на opencode и Claude, чистит кэш и tool", async () => {
  // 1. Вопрос в opencode (кириллица, другой регистр)
  const r1 = await search(adminCookie, "ЭЛЕКТРИЧЕСТВО");
  assert.equal(r1.hits.length, 1);
  assert.equal(r1.hits[0].sessionId, "ses_oc_admin");
  assert.equal(r1.hits[0].messageId, "msg_u1");
  assert.equal(r1.hits[0].role, "user");
  assert.ok(r1.hits[0].snippet.toLowerCase().includes("электричество"));

  // 2. Ответ в opencode
  const r2 = await search(adminCookie, "2450 рублей");
  assert.equal(r2.hits.length, 1);
  assert.equal(r2.hits[0].sessionId, "ses_oc_admin");
  assert.equal(r2.hits[0].messageId, "msg_a1");
  assert.equal(r2.hits[0].role, "assistant");

  // 3. Ответ в Claude
  const r3 = await search(adminCookie, "кластера");
  assert.equal(r3.hits.length, 1);
  assert.equal(r3.hits[0].sessionId, "ses_claude_admin");
  assert.equal(r3.hits[0].messageId, "msg_c2");
  assert.equal(r3.hits[0].role, "assistant");

  // 4. Скрытые [obsidian-cache], reasoning и tool output не находятся
  for (const noise of ["секрет_кэша_oc", "скрытый_кэш_клауда", "скрытое_размышление", "секретный_вывод_инструмента"]) {
    const rn = await search(adminCookie, noise);
    assert.equal(rn.hits.length, 0, `noise must not match: ${noise}`);
  }
});

test("GET /teleharness/api/session/search: изоляция тенантов — Alice видит свои чаты и не видит чаты admin", async () => {
  const own = await search(aliceCookie, "шарлотки");
  assert.equal(own.hits.length, 1);
  assert.equal(own.hits[0].sessionId, "ses_oc_alice");
  assert.equal(own.hits[0].messageId, "msg_al2");

  const foreign1 = await search(aliceCookie, "электричество");
  assert.equal(foreign1.hits.length, 0);

  const foreign2 = await search(aliceCookie, "кластера");
  assert.equal(foreign2.hits.length, 0);
});

test("GET /teleharness/api/session/search: удаление чата вычищает его из индекса", async () => {
  const del = await fetch(`${portal.base}/teleharness/api/session/ses_oc_admin`, {
    method: "DELETE",
    headers: { cookie: adminCookie },
  });
  assert.equal(del.status, 200);
  const afterDel = await search(adminCookie, "электричество");
  assert.equal(afterDel.hits.length, 0);
});
