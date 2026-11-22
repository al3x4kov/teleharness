// FEAT-11.23: автоподгрузка моделей opencode для портала.
// Проверяет:
// - lib/oc-client.js v2 listProviders: санитайзинг (без settings/apiKey/baseURL),
//   фильтрация enabled:false, исключение провайдеров без активных моделей.
// - lib/claude.js handleProvider: 60s кеш, { force: true } обходит кеш/ETag,
//   502 при ошибке upstream на forced refresh (без затирания stale кеша).
// - lib/policy.js isPaidOpencodeModel / providerForUser / modelInCatalog:
//   тенанту доступны zai-coding-plan и бесплатные модели opencode (cost=0),
//   платные pay-per-token модели скрыты и отвергаются; админу доступны все.
// - lib/attach.js modelAcceptsImages: поддержка v2 массива capabilities.input.
// - routes/catalog.js /teleharness/api/provider?refresh=1: проброс force и фильтрация.
// - src/lib/normalize.js + src/lib/engine.js: произвольные провайдеры и имена.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOcClient } from "../lib/oc-client.js";
import { ClaudeRunner } from "../lib/claude.js";
import { isPaidOpencodeModel, providerForUser, modelInCatalog } from "../lib/policy.js";
import { modelAcceptsImages } from "../lib/attach.js";
import { catalogRoutes } from "../routes/catalog.js";
import { normalizeProviders } from "../src/lib/normalize.js";
import { workingModels, opencodeProviderName } from "../src/lib/engine.js";
import { startFakeOpencodeV2 } from "./helpers/fake-opencode-v2.mjs";

const PWD = "oc2-test-secret";
const FAKE_API_KEY = "sk-" + "SUPER-SECRET";

test("FEAT-11.23: oc-client v2 listProviders убирает settings/секреты, скрывает enabled:false и пустых провайдеров", async () => {
  const up = await startFakeOpencodeV2({
    password: PWD,
    providers: [
      { id: "zai-coding-plan", name: "Z.AI Coding Plan", status: "connected" },
      { id: "opencode", name: "OpenCode", status: "connected" },
      { id: "empty-connected", name: "Empty Connected", status: "connected" },
      { id: "openrouter", name: "OpenRouter", status: "connected", settings: { apiKey: "prov-top-secret", baseURL: "https://provider.internal" } },
    ],
    models: [
      {
        id: "glm-5.3-flash",
        providerID: "zai-coding-plan",
        name: "GLM-5.3 Flash",
        status: "active",
        enabled: true,
        cost: { input: 0, output: 0 },
        limit: { context: 204800, output: 131072 },
        capabilities: { input: ["text"], output: ["text"] },
        settings: { apiKey: FAKE_API_KEY, baseURL: "https://internal.example", headers: { Authorization: "Bearer secret" } },
      },
      {
        id: "glm-5.3-highspeed",
        providerID: "zai-coding-plan",
        name: "GLM-5.3 Highspeed",
        status: "active",
        enabled: false,
      },
      {
        id: "glm-5.3-flash-free",
        providerID: "opencode",
        name: "GLM-5.3 Flash Free",
        status: "active",
        enabled: true,
        cost: { input: 0, output: 0 },
        capabilities: { input: ["text", "image"], output: ["text"] },
        settings: { apiKey: "public" },
      },
      {
        id: "only-disabled",
        providerID: "empty-connected",
        name: "Disabled Model",
        status: "active",
        enabled: false,
      },
      {
        id: "deepseek-r1",
        providerID: "openrouter",
        name: "DeepSeek R1",
        status: "active",
        enabled: true,
        cost: { input: 0.55, output: 2.19 },
        settings: { apiKey: "or-secret-key" },
      },
    ],
  });
  try {
    const oc = createOcClient({ api: "v2", base: up.url, password: PWD });
    const res = await oc.listProviders();

    assert.deepEqual(res.connected, ["zai-coding-plan", "opencode", "openrouter"]);
    assert.equal(res.connected.includes("empty-connected"), false, "провайдер без активных моделей исключён из connected");
    assert.equal(res.default, null, "в v2 default на уровне каталога null");

    const zai = res.all.find((p) => p.id === "zai-coding-plan");
    assert.ok(zai?.models["glm-5.3-flash"]);
    assert.equal("glm-5.3-highspeed" in zai.models, false, "disabled-модель исключена");

    const dumped = JSON.stringify(res);
    assert.equal(dumped.includes(FAKE_API_KEY), false, "apiKey не утекает в ответ");
    assert.equal(dumped.includes("or-secret-key"), false, "apiKey стороннего провайдера не утекает");
    assert.equal(dumped.includes("internal.example"), false, "baseURL не утекает");
    assert.equal("settings" in zai.models["glm-5.3-flash"], false, "поле settings модели удалено");
    assert.equal(dumped.includes("prov-top-secret"), false, "provider.settings.apiKey не утекает");
    assert.equal(dumped.includes("provider.internal"), false, "provider.settings.baseURL не утекает");
    assert.equal(res.all.some((p) => "settings" in p), false, "поле settings провайдера удалено");
    assert.deepEqual(zai.models["glm-5.3-flash"].cost, { input: 0, output: 0 });
    assert.deepEqual(res.all.find((p) => p.id === "opencode").models["glm-5.3-flash-free"].capabilities, { input: ["text", "image"], output: ["text"] });
  } finally {
    await up.close();
  }
});

test("FEAT-11.23: ClaudeRunner.handleProvider — 60с кеш, force=true обходит кеш/ETag, 502 при ошибке без потери stale", async () => {
  const runner = new ClaudeRunner({ enabled: false, codexEnabled: false });
  let calls = 0;
  let mode = "v1";
  const catalog = async () => {
    calls += 1;
    if (mode === "fail") throw new Error("opencode down");
    const models = { "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM-5.3 Flash", status: "active" } };
    if (mode === "v2") models["big-pickle"] = { id: "big-pickle", name: "Big Pickle", status: "active" };
    return {
      all: [{ id: "zai-coding-plan", name: "Z.AI Coding Plan", models }],
      default: { "zai-coding-plan": "glm-5.3-flash" },
      connected: ["zai-coding-plan"],
    };
  };
  const call = async (headers = {}, opts = {}) => {
    let status = 0, outHeaders = {}, body = "";
    const res = {
      writeHead: (s, h = {}) => { status = s; outHeaders = h; },
      end: (b = "") => { body = String(b); },
    };
    await runner.handleProvider({ headers }, res, "http://127.0.0.1:1", { catalog, ...opts });
    return { status, headers: outHeaders, body: body ? JSON.parse(body) : null };
  };

  // 1. Первый запрос прогревает кеш
  const r1 = await call();
  assert.equal(r1.status, 200);
  assert.equal(calls, 1);
  assert.ok(r1.headers.etag);

  // 2. Повторный в пределах 60с — из кеша (catalog не вызывается), с ETag → 304
  const r2 = await call({ "if-none-match": r1.headers.etag });
  assert.equal(r2.status, 304);
  assert.equal(calls, 1);

  // 3. force: true — обходит и кеш, и If-None-Match, подтягивает новую модель
  mode = "v2";
  const r3 = await call({ "if-none-match": r1.headers.etag }, { force: true });
  assert.equal(r3.status, 200);
  assert.equal(calls, 2);
  assert.ok(r3.body.all[0].models["big-pickle"], "новая модель появилась после force refresh");

  // 4. Падение upstream при force: true → 502 (а не старый 200)
  mode = "fail";
  const r4 = await call({}, { force: true });
  assert.equal(r4.status, 502);
  assert.equal(calls, 3);

  // 5. Обычный запрос без force всё ещё получает валидный stale кеш
  const r5 = await call();
  assert.equal(r5.status, 200);
  assert.ok(r5.body.all[0].models["big-pickle"]);
});

test("FEAT-11.23: isPaidOpencodeModel и providerForUser — тенант видит zai-coding-plan и бесплатные, платные скрыты и запрещены", () => {
  assert.equal(isPaidOpencodeModel("zai-coding-plan", { cost: { input: 5, output: 10 } }), false, "zai-coding-plan — подписка");
  assert.equal(isPaidOpencodeModel("opencode", { cost: { input: 0, output: 0 } }), false, "бесплатная opencode");
  assert.equal(isPaidOpencodeModel("openrouter", { cost: { input: 0, output: 0 } }), false, "бесплатная сторонняя");
  assert.equal(isPaidOpencodeModel("zai", { id: "glm-5v-turbo" }), false, "legacy модель без cost не блокируется");
  assert.equal(isPaidOpencodeModel("openrouter", { cost: { input: 0.5, output: 1.5 } }), true);
  assert.equal(isPaidOpencodeModel("openai", { cost: { input: 0, output: 0.1 } }), true);

  const fullCatalog = {
    all: [
      {
        id: "zai-coding-plan",
        name: "Z.AI Coding Plan",
        models: { "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM-5.3 Flash", cost: { input: 0, output: 0 } } },
      },
      {
        id: "opencode",
        name: "OpenCode",
        models: {
          "big-pickle": { id: "big-pickle", name: "Big Pickle", cost: { input: 0, output: 0 } },
          "zen-paid": { id: "zen-paid", name: "Zen Paid", cost: { input: 1.2, output: 3.4 } },
        },
      },
      {
        id: "openrouter",
        name: "OpenRouter",
        models: {
          "qwen-free": { id: "qwen-free", name: "Qwen Free", cost: { input: 0, output: 0 } },
          "deepseek-paid": { id: "deepseek-paid", name: "DeepSeek Paid", cost: { input: 0.55, output: 2.19 } },
        },
      },
      {
        id: "openai",
        name: "OpenAI",
        models: { "gpt-5": { id: "gpt-5", name: "GPT-5", cost: { input: 2.5, output: 10 } } },
      },
      {
        id: "anthropic",
        name: "Claude · подписка",
        models: { "claude-opus-5-5": { id: "claude-opus-5-5", name: "Claude Opus 5.5" } },
      },
    ],
    default: { "zai-coding-plan": "glm-5.3-flash", opencode: "zen-paid", openrouter: "deepseek-paid", openai: "gpt-5", anthropic: "claude-opus-5-5" },
    connected: ["zai-coding-plan", "opencode", "openrouter", "openai", "anthropic"],
  };

  const tenantCat = providerForUser(fullCatalog, { claudeAllowed: false, codexAllowed: false, acpAllowed: false });
  assert.deepEqual(tenantCat.connected, ["zai-coding-plan", "opencode", "openrouter"]);
  assert.equal(tenantCat.all.some((p) => p.id === "openai"), false, "чисто платный провайдер скрыт");
  assert.equal("openai" in tenantCat.default, false);

  const oc = tenantCat.all.find((p) => p.id === "opencode");
  assert.deepEqual(Object.keys(oc.models), ["big-pickle"]);
  assert.equal("opencode" in tenantCat.default, false, "платный дефолт не утекает тенанту");

  const or = tenantCat.all.find((p) => p.id === "openrouter");
  assert.deepEqual(Object.keys(or.models), ["qwen-free"]);
  assert.equal("openrouter" in tenantCat.default, false, "платный дефолт openrouter не утекает тенанту");

  assert.equal(modelInCatalog(tenantCat, { providerID: "opencode", modelID: "big-pickle" }), true);
  assert.equal(modelInCatalog(tenantCat, { providerID: "openrouter", modelID: "qwen-free" }), true);
  assert.equal(modelInCatalog(tenantCat, { providerID: "openrouter", modelID: "deepseek-paid" }), false, "платная модель отвергается для тенанта");
  assert.equal(modelInCatalog(tenantCat, { providerID: "openai", modelID: "gpt-5" }), false);

  // Админ (с полным каталогом без фильтра) видит и может выбрать платную модель подключённого провайдера
  assert.equal(modelInCatalog(fullCatalog, { providerID: "openrouter", modelID: "deepseek-paid" }, { claudeAllowed: true, paidOpencodeAllowed: true }), true);
  assert.equal(modelInCatalog(fullCatalog, { providerID: "openai", modelID: "gpt-5" }, { claudeAllowed: true, paidOpencodeAllowed: true }), true);
});

test("FEAT-11.23: modelAcceptsImages поддерживает массив capabilities.input из opencode v2", () => {
  const catalog = {
    all: [
      {
        id: "opencode",
        models: {
          "nemotron-vl-free": { id: "nemotron-vl-free", capabilities: { input: ["text", "image"], output: ["text"] } },
          "big-pickle": { id: "big-pickle", capabilities: { input: ["text"], output: ["text"] } },
        },
      },
      {
        id: "zai",
        models: {
          "glm-5v-turbo": { id: "glm-5v-turbo", capabilities: { input: { text: true, image: true } } },
        },
      },
    ],
    connected: ["opencode", "zai"],
  };
  assert.equal(modelAcceptsImages(catalog, { providerID: "opencode", modelID: "nemotron-vl-free" }), true);
  assert.equal(modelAcceptsImages(catalog, { providerID: "opencode", modelID: "big-pickle" }), false);
  assert.equal(modelAcceptsImages(catalog, { providerID: "zai", modelID: "glm-5v-turbo" }), true);
});

test("FEAT-11.23: маршрут GET /teleharness/api/provider?refresh=1 передаёт force=true и фильтрует платные для тенанта", async () => {
  const seenForce = [];
  const rawCatalog = {
    all: [
      { id: "zai-coding-plan", name: "Z.AI Coding Plan", models: { "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM-5.3 Flash", cost: { input: 0, output: 0 } } } },
      { id: "opencode", name: "OpenCode", models: { "big-pickle": { id: "big-pickle", name: "Big Pickle", cost: { input: 0, output: 0 } } } },
      { id: "openrouter", name: "OpenRouter", models: { "paid-1": { id: "paid-1", name: "Paid 1", cost: { input: 1, output: 2 } } } },
    ],
    default: { "zai-coding-plan": "glm-5.3-flash", opencode: "big-pickle", openrouter: "paid-1" },
    connected: ["zai-coding-plan", "opencode", "openrouter"],
  };
  const routes = catalogRoutes({
    sendJson: (res, status, data) => { res.status = status; res.data = data; },
    errLog: () => {},
    claude: {
      handleProvider: (_req, shim, _up, opts = {}) => {
        seenForce.push(Boolean(opts.force));
        shim.writeHead(200, { "content-type": "application/json" });
        shim.end(JSON.stringify(rawCatalog));
      },
    },
    upstream: "http://127.0.0.1:1",
    captureResponse: async (fn) => {
      let status = 200, body = "";
      await fn({ writeHead: (s) => { status = s; }, end: (b) => { body = String(b ?? ""); } });
      return { status, body };
    },
    providerForUser,
    acpReady: () => [],
    engineAllowed: () => false,
  });
  const provRoute = routes.find((r) => r.path === "/teleharness/api/provider");

  // Админ с ?refresh=1
  const resAdmin = { writeHead(s) { this.status = s; }, end(b) { this.data = JSON.parse(String(b)); } };
  await provRoute.handler({
    req: { url: "/teleharness/api/provider?refresh=1", headers: {} },
    res: resAdmin,
    url: new URL("http://localhost/teleharness/api/provider?refresh=1"),
    user: { id: "admin", role: "admin" },
    admin: true,
  });
  assert.equal(seenForce.at(-1), true);
  assert.equal(resAdmin.status, 200);
  assert.equal(resAdmin.data.connected.includes("openrouter"), true);

  // Тенант без refresh — force=false, openrouter/paid-1 отфильтрован
  const resTenant = {};
  await provRoute.handler({
    req: { url: "/teleharness/api/provider", headers: {} },
    res: resTenant,
    url: new URL("http://localhost/teleharness/api/provider"),
    user: { id: "u1", role: "user", engines: ["opencode"] },
    admin: false,
  });
  assert.equal(seenForce.at(-1), false);
  assert.equal(resTenant.status, 200);
  assert.deepEqual(resTenant.data.connected, ["zai-coding-plan", "opencode"]);
});

test("FEAT-11.23: normalizeProviders и workingModels динамически подхватывают произвольного провайдера и имена", () => {
  const cfg = normalizeProviders({
    all: [
      {
        id: "openrouter",
        name: "OpenRouter",
        models: {
          "qwen-free": { id: "qwen-free", name: "Qwen Free", status: "active", enabled: true, capabilities: { input: ["text", "image"] } },
          "disabled-one": { id: "disabled-one", name: "Disabled", status: "active", enabled: false },
          "old-one": { id: "old-one", name: "Old", status: "deprecated", enabled: true },
        },
      },
      {
        id: "zai-coding-plan",
        name: "Z.AI Coding Plan",
        models: { "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM-5.3 Flash", status: "active" } },
      },
    ],
    default: {},
    connected: ["openrouter", "zai-coding-plan"],
  });

  assert.equal(cfg.providers.openrouter, "OpenRouter");
  assert.equal(opencodeProviderName("openrouter", cfg.providers), "OpenRouter");
  assert.equal(opencodeProviderName("zai-coding-plan", cfg.providers), "Z.AI Coding Plan");
  assert.equal(cfg.models.some((m) => m.id === "disabled-one"), false, "enabled:false отброшена в normalizeProviders");
  const qwen = cfg.models.find((m) => m.id === "qwen-free");
  assert.equal(qwen.imageInput, true, "v2 array capabilities.input:['text','image'] → imageInput:true");

  const wm = workingModels(cfg);
  assert.deepEqual(wm.map((m) => `${m.providerID}/${m.id}`).sort(), ["openrouter/qwen-free", "zai-coding-plan/glm-5.3-flash"]);
});
