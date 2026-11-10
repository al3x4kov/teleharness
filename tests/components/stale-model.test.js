// BUG-137: модель из Настроек, которой больше нет в рабочем каталоге
// (zai/glm-4.5 из кейса 82), не уходит в новый чат молча: новый чат берёт
// рабочую модель по умолчанию, Настройки и тост говорят «модель недоступна —
// выбрана X», сохранённое значение не стирается.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ SettingsView: "src/components/views/SettingsView.jsx" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.providerCfg.value = null;
  s.me.value = null;
  s.sessions.value = [];
  s.active.value = null;
  s.setNotice(null);
  s.setPrefs({ model: null });
  installFetch();
});

const ADMIN = { id: "admin", name: "Владелец", role: "admin" };
const m = (providerID, id, name) => ({ id, providerID, label: `${name} (${providerID})`, status: "active" });
// Каталог как после normalizeProviders: Coding Plan + платный zai (из него рабочая только vision-модель).
const CATALOG = {
  models: [
    m("zai-coding-plan", "glm-5.3-flash", "GLM-5.3-Flash"),
    m("zai-coding-plan", "glm-5.3", "GLM-5.3"),
    m("zai", "glm-5v-turbo", "GLM-5V-Turbo"),
    m("zai", "glm-4.5", "GLM-4.5"),
  ],
  defaults: {},
  connected: ["zai-coding-plan", "zai"],
};
const STALE = { providerID: "zai", modelID: "glm-4.5" };
const DEFAULT = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };

test("BUG-137: sanitizePrefs — модель вне рабочего каталога → дефолт + staleModel; рабочая и неизвестный каталог — как есть", () => {
  const p = { model: STALE, agent: "build" };
  const out = ui.store.sanitizePrefs(p, { user: ADMIN, catalog: CATALOG });
  assert.deepEqual(out.model, DEFAULT);
  assert.deepEqual(out.staleModel, STALE);
  // тенант — так же
  assert.deepEqual(ui.store.sanitizePrefs(p, { user: { id: "t", role: "user", engines: ["opencode"] }, catalog: CATALOG }).model, DEFAULT);
  // рабочая модель остаётся
  const ok = ui.store.sanitizePrefs({ model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } }, { user: ADMIN, catalog: CATALOG });
  assert.deepEqual(ok.model, { providerID: "zai-coding-plan", modelID: "glm-5.3" });
  assert.equal(ok.staleModel, undefined);
  // каталог ещё не загружен — судить нельзя
  assert.deepEqual(ui.store.sanitizePrefs(p, { user: ADMIN, catalog: null }).model, STALE);
  // Claude-модель при каталоге без Claude-моделей не трогаем
  const claude = { providerID: "anthropic", modelID: "claude-sonnet-4-5" };
  assert.deepEqual(ui.store.sanitizePrefs({ model: claude }, { user: ADMIN, catalog: CATALOG }).model, claude);
});

test("BUG-137: новый чат с устаревшей моделью из Настроек — создаётся на дефолтной, тост «модель недоступна — выбрана …», настройка не стёрта", async () => {
  ui.store.me.value = ADMIN;
  ui.store.providerCfg.value = CATALOG;
  ui.store.setPrefs({ model: STALE });
  installFetch([
    { method: "POST", path: "/zai/api/session", reply: (c) => ({ id: "ses_new", title: "", directory: "C:\\Users\\USER", time: { created: 1, updated: 1 }, zai: { engine: "opencode", model: c.body.model, agent: null, prompted: false } }) },
    { method: "GET", path: "/zai/api/session/ses_new/message", reply: () => [] },
  ]);
  await ui.store.createAndOpen();
  const post = fetchCalls.find((c) => c.method === "POST" && c.path === "/zai/api/session");
  assert.deepEqual(post.body.model, DEFAULT, "в новый чат ушла рабочая модель");
  assert.match(ui.store.notice.value?.text ?? String(ui.store.notice.value ?? ""), /GLM-4\.5.*недоступна.*выбрана GLM-5\.3-Flash/);
  assert.deepEqual(ui.store.prefs.value.model, STALE, "сохранённое значение не потеряно");
});

test("BUG-137: Настройки — у поля модели предупреждение «недоступна — выбрана …»; с рабочей моделью его нет", async () => {
  ui.store.me.value = ADMIN;
  ui.store.providerCfg.value = CATALOG;
  ui.store.setPrefs({ model: STALE });
  // Настройки сами перечитывают /provider — отдаём тот же каталог в сыром виде.
  const raw = {
    all: CATALOG.connected.map((pid) => ({
      id: pid,
      models: Object.fromEntries(CATALOG.models.filter((x) => x.providerID === pid).map((x) => [x.id, { id: x.id, name: x.label.replace(` (${pid})`, ""), providerID: pid, status: "active" }])),
    })),
    default: {},
    connected: CATALOG.connected,
  };
  installFetch([{ method: "GET", path: "/zai/api/provider", reply: () => raw }]);
  const h = t$.mount(ui.SettingsView, { section: "models" });
  await t$.flush(10);
  const warn = await t$.waitFor(() => byText(h.root, ".set-warn", "недоступна"));
  assert.match(warn.textContent, /GLM-4\.5.*недоступна.*выбрана GLM-5\.3-Flash/);
  assert.match(byText(h.root, ".set-row", "Модель для новых чатов")?.textContent ?? $(h.root, ".set-row").textContent, /GLM-5\.3-Flash/);
  h.unmount();
  ui.store.setPrefs({ model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } });
  const h2 = t$.mount(ui.SettingsView, { section: "models" });
  await t$.flush(10);
  assert.equal($(h2.root, ".set-warn"), null);
});

test("BUG-152: «О приложении» переносится по словам (is-wrap) и показывает версию Claude Code целиком", async () => {
  installFetch([{ method: "GET", path: "/zai/api/about", reply: () => ({ version: "1.10.2", opencodeVersion: "1.19.5", omoVersion: "5.1.60", claudeVersion: "2.1.316" }) }]);
  ui.store.about.value = { version: "1.10.2", opencodeVersion: "1.19.5", omoVersion: "5.1.60", claudeVersion: "2.1.316" };
  const h = t$.mount(ui.SettingsView, { section: "about" });
  const row = await t$.waitFor(() => [...h.root.querySelectorAll(".set-value")].find((el) => el.textContent.startsWith("Teleharness ")));
  // BUG-178: версия приложения первой, отстающий сервер — в скобках
  assert.match(row.textContent, /^Teleharness \d+\.\d+\.\d+ \(сервер 1\.10\.2\) · opencode 1\.19\.5 \(OmO 5\.1\.60\) · Claude Code 2\.1\.316$/);
  assert.ok(row.classList.contains("is-wrap"), "строка не обрезается многоточием на узком экране");
});
