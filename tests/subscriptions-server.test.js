// FEAT-11.18 (шаг А): GET /zai/api/subscriptions доступен всем пользователям, ключей в ответе нет.
// Run: node --test tests/subscriptions-server.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ADMIN = "u".repeat(20) + "-admin-token-" + "5".repeat(24);
const TMP = mkdtempSync(path.join(tmpdir(), "zai-subs-"));
const AUTH = path.join(TMP, "auth.json");
writeFileSync(AUTH, JSON.stringify({ xai: { type: "api", key: "sk-SECRET-VALUE" } }) /* ключ провайдера без API расхода: наружу тест не ходит */);
let up, srv;
const api = (p, { token = ADMIN, method = "GET", body } = {}) => fetch(srv.base + p, { method, headers: { authorization: `Bearer ${token}`, origin: srv.base, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });

before(async () => {
  up = await startFakeOpencode();
  up.route("GET", "/provider", () => ({ status: 200, json: { all: [{ id: "zai-coding-plan", models: { "glm-5.3": { id: "glm-5.3", name: "GLM-5.3" } } }, { id: "openrouter", models: { "x/y": { id: "x/y", name: "Y" } } }], connected: ["zai-coding-plan", "openrouter"], default: {} } }));
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_AUTH_FILE: AUTH, ZAI_QUOTA_BASE: "http://127.0.0.1:9" } });
});
after(async () => {
  await srv?.stop?.();
  await up?.close?.();
  rmSync(TMP, { recursive: true, force: true });
});

test("FEAT-11.18: администратор и обычный пользователь получают карточки; ключей в ответе нет; без входа — 401", async () => {
  const a = await api("/zai/api/subscriptions");
  assert.equal(a.status, 200, await a.clone().text());
  const body = await a.json();
  assert.ok(Array.isArray(body.providers));
  for (const c of body.providers) {
    assert.equal(typeof c.id, "string");
    assert.ok(["ok", "error", "no-key", "need-admin-key", "no-api"].includes(c.state), c.state);
  }
  assert.equal(JSON.stringify(body).includes("SECRET"), false);
  assert.deepEqual(body.providers.map((c) => c.id), ["zai", "openrouter", "claude"]);
  assert.equal(body.providers[1].state, "no-key");
  assert.equal(body.providers[0].state, "no-key", "ключа z.ai в тестовом auth.json нет");
  const created = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "subs-user" } })).json();
  const t = await api("/zai/api/subscriptions", { token: created.token });
  assert.equal(t.status, 200, "обычный пользователь видит расход");
  assert.ok(Array.isArray((await t.json()).providers));
  assert.equal((await api("/zai/api/usage", { token: created.token })).status, 403, "старый admin-маршрут остался закрытым");
  assert.equal((await fetch(srv.base + "/zai/api/subscriptions")).status, 401);
});
