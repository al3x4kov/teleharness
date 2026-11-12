// BUG-218 (SRV-06, design §1): PATCH привязки читает запись, ждёт несколько
// await (проверка модели по каталогу) и пишет устаревшее — параллельный первый
// ход теряет prompted:true. Теперь чтение, проверки и запись PATCH — под
// блокировкой чата (lib/session-lock.js), пометка prompted — тоже, запись
// читается заново под локом. Фейк каталога замедлен, чтобы окно гонки было
// широким. Образец — tests/tenant-gates-server.test.js.
// Run: node --test --test-timeout=60000 tests/binding-race.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ADMIN = "a".repeat(24) + "-binding-race-" + "3".repeat(24);
const CATALOG = {
  all: [
    { id: "zai-coding-plan", name: "Z.AI", models: { "glm-5.3": { id: "glm-5.3", name: "GLM 5.3" }, "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM 5.3 Flash" } } },
  ],
  connected: ["zai-coding-plan"],
  default: { "zai-coding-plan": "glm-5.3" },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(20);
  }
  return false;
};

let up, srv, tenant;
const api = (p, { method = "GET", body, token = ADMIN } = {}) =>
  fetch(srv.base + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

before(async () => {
  up = await startFakeOpencode();
  // Замедленный каталог: PATCH держит окно гонки внутри проверки модели.
  up.route("GET", "/provider", async () => {
    await sleep(400);
    return { json: CATALOG };
  });
  up.route("GET", "/config", () => ({ json: { model: "zai-coding-plan/glm-5.3" } }));
  up.route("GET", "/agent", () => ({ json: [{ name: "Sandbox", mode: "primary", permission: [] }] }));
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_TENANT_AGENT: "Sandbox" } });
  tenant = await (await api("/zai/api/admin/users", { method: "POST", body: { name: "racer" } })).json();
  assert.ok(tenant.token);
  // Чат без сообщений и без модели апстрима: привязки ещё нет. Добавляем в фейк
  // ПОСЛЕ первой выборки индекса портала — тогда PATCH форсирует свежий GET /session.
  up.state.sessions.push({ id: "ses_race", directory: tenant.user.directories[0], title: "race" });
});

after(async () => {
  await srv?.stop();
  await up?.close?.();
});

test("PATCH привязки и первый ход одновременно: prompted не теряется, модель PATCH сохраняется", async () => {
  const patch = api("/zai/api/session/ses_race/binding", {
    method: "PATCH",
    token: tenant.token,
    body: { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } },
  });
  // PATCH внутри блокировки дошёл до проверки модели (медленный каталог) —
  // только теперь стартуем ход: раньше он успевал вклиниться между await-ами.
  assert.ok(await waitFor(() => up.requests.some((r) => r.path === "/provider")), "PATCH дошёл до проверки модели");
  const prompt = api("/zai/api/session/ses_race/prompt", {
    method: "POST",
    body: { model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" }, parts: [{ type: "text", text: "первый ход" }] },
  });
  const [pr, ps] = await Promise.all([patch, prompt]);
  assert.equal(pr.status, 200, await pr.text());
  assert.equal(ps.status, 204, await ps.text());
  assert.ok(up.requests.some((r) => r.path === "/session/ses_race/prompt_async"), "ход ушёл в upstream");

  const list = await (await api("/zai/api/session")).json();
  const zai = list.find((s) => s.id === "ses_race")?.zai;
  assert.ok(zai, JSON.stringify(list));
  assert.equal(zai.prompted, true, "потерян флаг первого хода");
  assert.equal(zai.model?.modelID, "glm-5.3", "потеряна модель PATCH");
});
