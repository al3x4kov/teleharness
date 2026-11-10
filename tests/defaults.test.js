// L1 (FEAT-03.1, остаток; TASK-14.9): дефолты нового чата в «чистом браузере»
// и после миграции старых prefs. Источник — src/lib/store.js (loadPrefs при
// импорте модуля, ключ localStorage `zai.prefs`): модель
// zai-coding-plan/glm-5.3-flash + агент «orchestrator» (до FEAT-16.2 — «Sisyphus - ultraworker»); точная
// старая пара (glm-5.3 + build, 2026-10-31) считается устаревшей и
// пере-сеется. Каждый кейс импортирует store.js заново (?case=N), потому что
// prefs вычисляются один раз при загрузке модуля; localStorage — заглушка.
// Run: node --test tests/defaults.test.js
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { defaultBinding } from "../src/lib/engine.js";

const DEFAULT_MODEL = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
// FEAT-16.2 (2026-11-07): OmO → oh-my-opencode-slim, the default agent is «orchestrator».
const DEFAULT_AGENT = "orchestrator";
const KEY = "zai.prefs";

// Минимальная заглушка Web Storage.
function makeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    _map: m,
  };
}

function setStorage(v) {
  Object.defineProperty(globalThis, "localStorage", { value: v, configurable: true, writable: true });
}

// store.js разнесён на подмодули (src/lib/store/*.js, prefs — в state.js):
// `import("store.js?case=N")` даёт новый store, но КЕШИРОВАННЫЙ state.js — и
// prefs не перечитываются. Поэтому store собирается esbuild-ом в один бандл
// (весь граф внутри), а каждый кейс импортирует свою копию файла → свежий граф
// модулей независимо от того, как store разрежут дальше.
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_DIR = mkdtempSync(path.join(os.tmpdir(), "zai-defaults-"));
after(() => rmSync(BUNDLE_DIR, { recursive: true, force: true }));
const STORE_BUNDLE = (
  await build({
    entryPoints: [path.join(ROOT, "src", "lib", "store.js")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    loader: { ".css": "empty" },
    logLevel: "silent",
  })
).outputFiles[0].text;

let n = 0;
async function freshStore(storage) {
  setStorage(storage);
  const file = path.join(BUNDLE_DIR, `store-case-${++n}.mjs`);
  writeFileSync(file, STORE_BUNDLE);
  return import(pathToFileURL(file).href);
}

const realFetch = globalThis.fetch;
afterEach(() => {
  delete globalThis.localStorage;
  globalThis.fetch = realFetch;
});

// ---- чистый браузер ---------------------------------------------------------------

test("чистый браузер без localStorage вообще (node / приватный режим) → glm-5.3-flash + orchestrator", async () => {
  const { prefs } = await freshStore(undefined);
  assert.deepEqual(prefs.value, { model: DEFAULT_MODEL, agent: DEFAULT_AGENT, claudeAgent: null });
});

test("чистый браузер: пустой localStorage → glm-5.3-flash + orchestrator", async () => {
  const { prefs } = await freshStore(makeStorage());
  assert.deepEqual(prefs.value, { model: DEFAULT_MODEL, agent: DEFAULT_AGENT, claudeAgent: null });
});

test("дефолт никогда не glm-5.3-highspeed (зависал у провайдера 2026-10-31)", async () => {
  const { prefs } = await freshStore(makeStorage());
  assert.notEqual(prefs.value.model.modelID, "glm-5.3-highspeed");
});

test("битый JSON / getItem бросает → дефолты, без падения импорта", async () => {
  let s = await freshStore(makeStorage({ [KEY]: "{not json" }));
  assert.deepEqual(s.prefs.value, { model: DEFAULT_MODEL, agent: DEFAULT_AGENT, claudeAgent: null });
  s = await freshStore({
    getItem() {
      throw new Error("SecurityError");
    },
  });
  assert.deepEqual(s.prefs.value, { model: DEFAULT_MODEL, agent: DEFAULT_AGENT, claudeAgent: null });
});

test("prefs = JSON null / не-объект → дефолты", async () => {
  for (const raw of ["null", "42", '"str"', "[]"]) {
    const { prefs } = await freshStore(makeStorage({ [KEY]: raw }));
    assert.deepEqual(prefs.value, { model: DEFAULT_MODEL, agent: DEFAULT_AGENT, claudeAgent: null }, raw);
  }
});

// ---- миграция ---------------------------------------------------------------------

test("миграция: точная старая пара glm-5.3 + build → новые дефолты", async () => {
  const legacy = { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: "build" };
  const { prefs } = await freshStore(makeStorage({ [KEY]: JSON.stringify(legacy) }));
  assert.deepEqual(prefs.value, { model: DEFAULT_MODEL, agent: DEFAULT_AGENT, claudeAgent: null });
});

test("миграция: частичное совпадение со старой парой — это явный выбор, остаётся", async () => {
  const cases = [
    { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: "plan" },
    { model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" }, agent: "build" },
    { model: { providerID: "other", modelID: "glm-5.3" }, agent: "build" },
  ];
  for (const saved of cases) {
    const { prefs } = await freshStore(makeStorage({ [KEY]: JSON.stringify(saved) }));
    assert.deepEqual(prefs.value, { ...saved, claudeAgent: null }, JSON.stringify(saved));
  }
});

test("явный выбор пользователя (Claude) сохраняется", async () => {
  const saved = { model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, agent: "build" };
  const { prefs } = await freshStore(makeStorage({ [KEY]: JSON.stringify(saved) }));
  assert.deepEqual(prefs.value, { ...saved, claudeAgent: null });
});

test("частичные prefs: нет model.modelID → модель по умолчанию; нет agent → orchestrator", async () => {
  let s = await freshStore(makeStorage({ [KEY]: JSON.stringify({ agent: "plan" }) }));
  assert.deepEqual(s.prefs.value, { model: DEFAULT_MODEL, agent: "plan", claudeAgent: null });
  s = await freshStore(makeStorage({ [KEY]: JSON.stringify({ model: { providerID: "zai-coding-plan" }, agent: null }) }));
  assert.deepEqual(s.prefs.value, { model: DEFAULT_MODEL, agent: DEFAULT_AGENT, claudeAgent: null });
  s = await freshStore(makeStorage({ [KEY]: JSON.stringify({ model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } }) }));
  assert.deepEqual(s.prefs.value, { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: DEFAULT_AGENT, claudeAgent: null });
});

test("setPrefs пишет в zai.prefs, следующая загрузка читает сохранённое", async () => {
  const storage = makeStorage();
  const s1 = await freshStore(storage);
  s1.setPrefs({ agent: "plan" });
  assert.deepEqual(JSON.parse(storage.getItem(KEY)), { model: DEFAULT_MODEL, agent: "plan", claudeAgent: null });
  const s2 = await freshStore(storage);
  assert.deepEqual(s2.prefs.value, { model: DEFAULT_MODEL, agent: "plan", claudeAgent: null });
});

test("setPrefs без localStorage / с бросающим setItem — prefs обновляются в памяти", async () => {
  const s = await freshStore({
    getItem: () => null,
    setItem() {
      throw new Error("QuotaExceeded");
    },
  });
  s.setPrefs({ agent: "x" });
  assert.equal(s.prefs.value.agent, "x");
});

// ---- дефолт доходит до нового чата (FEAT-03.1 мгновенное создание) ----------

test("defaultBinding(дефолтные prefs) → opencode + glm-5.3-flash + orchestrator", async () => {
  const { prefs } = await freshStore(makeStorage());
  assert.deepEqual(defaultBinding(prefs.value), { engine: "opencode", model: DEFAULT_MODEL, agent: DEFAULT_AGENT, prompted: false });
});

test("createAndOpen в чистом браузере: POST /session несёт glm-5.3-flash + orchestrator, чат открыт с привязкой", async () => {
  const s = await freshStore(makeStorage());
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    const body = u.startsWith("/zai/api/session?") || u === "/zai/api/session"
      ? { id: "ses_new", title: "" }
      : u.includes("/status")
        ? {}
        : [];
    return { ok: true, status: 200, json: async () => body };
  };
  let navigated = null;
  s.setNavigate((to) => (navigated = to));
  const created = await s.createAndOpen({ directory: "D:\\Portal\\zai" });

  const post = calls.find((c) => c.init.method === "POST");
  assert.equal(post.url, `/zai/api/session?${new URLSearchParams({ directory: "D:\\Portal\\zai" })}`);
  assert.deepEqual(JSON.parse(post.init.body), { model: DEFAULT_MODEL, agent: DEFAULT_AGENT });
  assert.equal(created.directory, "D:\\Portal\\zai", "directory подставлен, если сервер его не вернул");
  assert.deepEqual(created.zai, { engine: "opencode", model: DEFAULT_MODEL, agent: DEFAULT_AGENT, prompted: false });
  assert.equal(s.active.value.id, "ses_new");
  assert.equal(navigated, "#/chat/ses_new");
});

test("createAndOpen после миграции старой пары → тоже новые дефолты в теле", async () => {
  const legacy = { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: "build" };
  const s = await freshStore(makeStorage({ [KEY]: JSON.stringify(legacy) }));
  let postBody = null;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "POST") postBody = JSON.parse(init.body);
    const u = String(url);
    const body = u === "/zai/api/session" ? { id: "ses_m", zai: { model: DEFAULT_MODEL, agent: DEFAULT_AGENT } } : u.includes("/status") ? {} : [];
    return { ok: true, status: 200, json: async () => body };
  };
  const created = await s.createAndOpen();
  assert.deepEqual(postBody, { model: DEFAULT_MODEL, agent: DEFAULT_AGENT });
  assert.deepEqual(created.zai, { model: DEFAULT_MODEL, agent: DEFAULT_AGENT }, "zai сервера не перезаписывается");
});

test("createAndOpen с Claude в prefs: агент в тело не уходит", async () => {
  const saved = { model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, agent: DEFAULT_AGENT };
  const s = await freshStore(makeStorage({ [KEY]: JSON.stringify(saved) }));
  let postBody = null;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "POST") postBody = JSON.parse(init.body);
    const body = String(url) === "/zai/api/session" ? { id: "ses_c" } : String(url).includes("/status") ? {} : [];
    return { ok: true, status: 200, json: async () => body };
  };
  await s.createAndOpen();
  assert.deepEqual(postBody, { model: saved.model });
});

// FEAT-03.1 (бывший test.todo, TASK-14.9): выбор модели/агента в пилюлях
// пустого чата и его отображение — проверяется рендером (L2):
// tests/components/modelbar.test.js «пустой чат без привязки: пилюли =
// дефолты Настроек…», «смена модели до первого сообщения → PATCH /binding»;
// выбор в шитах — tests/components/pickers.test.js (C6).

// BUG-01.27 / BUG-018 (verified в 1.7.2; бывший todo-маркер, TASK-14.9).
// Ожидавшийся normalize.autoTitle не появился: автозаголовок реализован в
// shared/title.js (сервер: heuristicTitle/typedText, замена upstream-заголовка
// по snapshotDerivedTitle) и в normalize.displayTitle (клиент: список и шапка).
// Контракт тот же: заголовок — из набранного текста, не из снапшота.
test("BUG-01.27 / BUG-018: автозаголовок чата берётся из текста пользователя, а не из внедрённого снапшота", async () => {
  const norm = await import("../src/lib/normalize.js");
  const title = await import("../shared/title.js");
  const injected =
    "[obsidian-cache] Активный кэша проекта «user» (C:\\Users\\USER), собран 2026-11-02 07:02.\n\n" +
    "zai.home.example.net HTTPS IPv6\n\nПравила кэша: _index.md.\n\n---\n\nОтветь одним словом: столица Италии?";
  assert.equal(norm.splitInjected(injected).text, "Ответь одним словом: столица Италии?");
  // Сервер: эвристический заголовок нового чата — из набранного вопроса.
  assert.equal(title.heuristicTitle(injected), "Ответь одним словом: столица Италии?");
  assert.equal(/obsidian|example.net|кэш/i.test(title.heuristicTitle(injected)), false);
  // Сервер: upstream-заголовок, пересказывающий снапшот, подлежит замене.
  assert.equal(title.snapshotDerivedTitle("zai.home.example.net HTTPS IPv6", injected), true);
  // Клиент: без заголовка / с пересказом снапшота / с маркером — набранный текст.
  for (const t of ["", "New session - 2026-11-02T07:02:00.000Z", "zai.home.example.net HTTPS IPv6", "[obsidian-cache] Активный кэш"]) {
    assert.equal(norm.displayTitle(t, injected), "Ответь одним словом: столица Италии?", `displayTitle(«${t}»)`);
  }
  assert.equal(norm.displayTitle("Столица Италии", injected), "Столица Италии", "осмысленный заголовок сохраняется");
});

// ---- FEAT-03.19: «Детализация выполнения» ------------------------------------------

test("FEAT-03.19: «Детализация выполнения» выключена по умолчанию (новый и существующий пользователь)", async () => {
  let s = await freshStore(makeStorage());
  assert.equal(s.execDetailOn(s.prefs.value), false, "чистый браузер");
  const existing = { model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, agent: "build" };
  s = await freshStore(makeStorage({ [KEY]: JSON.stringify(existing) }));
  assert.equal(s.execDetailOn(s.prefs.value), false, "сохранённые prefs без ключа");
  s = await freshStore(makeStorage({ [KEY]: JSON.stringify({ ...existing, execDetail: "yes" }) }));
  assert.equal(s.execDetailOn(s.prefs.value), false, "мусор вместо true — выключено");
});

test("FEAT-03.19: включённая детализация переживает перезагрузку и миграцию старой пары", async () => {
  const storage = makeStorage();
  let s = await freshStore(storage);
  s.setPrefs({ execDetail: true });
  s = await freshStore(storage); // «перезагрузка»: модуль читает localStorage заново
  assert.equal(s.execDetailOn(s.prefs.value), true);
  const legacy = { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: "build", execDetail: true };
  s = await freshStore(makeStorage({ [KEY]: JSON.stringify(legacy) }));
  assert.equal(s.execDetailOn(s.prefs.value), true, "миграция модели не сбрасывает выбор");
});

test("FEAT-03.19: выбор хранится отдельно для каждого пользователя", async () => {
  const storage = makeStorage();
  const s = await freshStore(storage);
  s.bindUserStorage({ id: "u_anna", role: "user" });
  s.setPrefs({ execDetail: true });
  assert.equal(s.execDetailOn(s.prefs.value), true);
  s.bindUserStorage({ id: "u_boris", role: "user" });
  assert.equal(s.execDetailOn(s.prefs.value), false, "другой пользователь на том же устройстве — выключено");
  s.bindUserStorage({ id: "u_anna", role: "user" });
  assert.equal(s.execDetailOn(s.prefs.value), true);
});
