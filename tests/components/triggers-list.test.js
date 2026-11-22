// FEAT-20.3 (2.2): Temporal → «Триггеры» — статусы словами, баннеры (токен,
// admin, лимит Claude, шторм, неверные подписи), пустой экран с шаблонами,
// счётчик ошибок в общем сигнале (T-1, T-2, T-13, T-19–T-21).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    TriggersList: "src/components/temporal/TriggersList.jsx",
    TemporalView: "src/components/views/TemporalView.jsx",
    triggerPill: "src/components/temporal/TriggersList.jsx#triggerPill",
    triggerSub: "src/components/temporal/TriggersList.jsx#triggerSub",
    githubTriggers: "src/lib/github-conn.js#githubTriggers",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  installFetch();
});

const DAY = 86400000;
const CONN_OK = { connected: true, login: "owner-gh", tokenLast4: "7Qx2", expiresAt: Date.now() + 90 * DAY, status: "ok", checkedAt: Date.now(), expiringSoon: false, repos: [] };
const CONN_SOON = { ...CONN_OK, expiresAt: Date.now() + 5 * DAY, expiringSoon: true };
const DEF = [{ id: "def-1", name: "Задача → PR", latestVersion: 1 }];

function routes({ conn = CONN_OK, triggers, defs = DEF, templates = [] } = {}) {
  installFetch([
    { method: "GET", path: "/teleharness/api/github/connection", reply: () => conn },
    { method: "GET", path: "/teleharness/api/temporal/triggers", reply: () => triggers },
    { method: "GET", path: "/teleharness/api/temporal/definitions", reply: () => defs },
    { method: "GET", path: "/teleharness/api/temporal/templates", reply: () => ({ templates, readiness: {} }) },
  ]);
}
const CAPS = { triggers: { available: true, publicUrl: "https://zai.example", adminStopped: false, claudeLeftToday: 5 } };
const trig = (over = {}) => ({ id: "t-1", definitionId: "def-1", repo: "acme/app", kinds: ["issue_labeled"], filters: { label: "agent" }, delivery: "auto", pollSeconds: 120, enabled: true, hookConfigured: true, limits: {}, revision: 1, createdAt: 1, lastAt: Date.now() - 120_000, errors: 0, badSignature: 0, ciAttempts: 0, stormAt: null, ...over });

test("статусы триггеров словом (triggerPill)", () => {
  const conn = CONN_OK;
  assert.match(ui.triggerPill(trig(), conn).text, /Работает · webhook/);
  assert.match(ui.triggerPill(trig({ hookConfigured: false }), conn).text, /Опрос · каждые 2 мин/);
  assert.equal(ui.triggerPill(trig({ enabled: false }), conn).text, "Выключен");
  assert.match(ui.triggerPill(trig({ ciAttempts: 2 }), conn).text, /Нужен человек: 2/);
  assert.equal(ui.triggerPill(trig(), { connected: true, status: "expired" }).text, "Нет подключения");
  assert.match(ui.triggerSub(trig()), /acme\/app · метка agent/);
});

async function mount(opts) {
  routes(opts);
  return t$.mount(ui.TriggersList, { capabilities: CAPS });
}

test("список: строки со статусом, последним срабатыванием, без лишних баннеров", async () => {
  const h = await mount({ triggers: [trig(), trig({ id: "t-2", hookConfigured: false, enabled: false })] });
  await t$.waitFor(() => $$(h.root, ".t-trig").length === 2);
  assert.ok(byText(h.root, ".t-trig", "Задача → PR"), "имя пайпа из определений");
  assert.ok(byText(h.root, ".t-trig", "Работает · webhook"));
  assert.ok(byText(h.root, ".t-trig", "Выключен"));
  assert.ok(byText(h.root, ".t-trig", "2 мин назад"), "последнее срабатывание");
  assert.equal(byText(h.root, ".t-banner", "GitHub"), null, "подключено — баннеров про токен нет");
  assert.ok(byText(h.root, "p", "Журнал срабатываний хранится 14 дней."));
});

test("баннеры: истечение, admin, лимит Claude, шторм, подписи; 401 отдельно", async () => {
  const conn = { ...CONN_OK, expiresAt: Date.now() + 5 * DAY, expiringSoon: true };
  const triggers = [trig({ stormAt: Date.now(), badSignature: 3 })];
  const h = await mount({ conn, triggers });
  await t$.waitFor(() => byText(h.root, ".t-banner-warn", "истекает через 5 дн."));
  assert.equal(byText(h.root, ".t-banner-err", "GitHub отклонил токен (401)"), null, "токен ещё жив");
  assert.equal(byText(h.root, ".t-banner-err", "Остановлено администратором"), null, "admin не остановлен");
  h.rerender({ capabilities: { triggers: { ...CAPS.triggers, adminStopped: true, claudeLeftToday: 0 } } });
  await t$.waitFor(() => byText(h.root, ".t-banner-err", "Остановлено администратором"));
  await t$.waitFor(() => byText(h.root, ".t-banner-warn", "Лимит Claude в фоне исчерпан"));
  assert.ok(byText(h.root, ".t-banner-warn", "Шторм событий"));
  assert.ok(byText(h.root, ".t-banner-warn", "Неверные подписи webhook: 3"));
});

test("токен отклонён — баннер 401 вместо обычных статусов", async () => {
  const h = await mount({ conn: { ...CONN_OK, status: "expired" }, triggers: [trig()] });
  await t$.waitFor(() => byText(h.root, ".t-banner-err", "GitHub отклонил токен (401)"));
  assert.ok(byText(h.root, ".t-trig", "Нет подключения"), "плашка строки тоже про подключение");
});

test("пусто: заголовок, шаблоны со ссылками на мастер, «Свой триггер»", async () => {
  const templates = [
    { id: "task-to-pr", name: "Задача → PR", description: "Метка «agent»…", needs: ["github", "claude"], trigger: {}, schedule: null },
    { id: "nightly-deps", name: "Ночное обновление", description: "…", needs: ["github", "claude"], trigger: null, schedule: { cron: "0 3 * * 1-5" } },
  ];
  const h = await mount({ conn: { connected: false }, triggers: [], templates });
  await t$.waitFor(() => byText(h.root, ".t-empty", "Фоновые агенты"));
  assert.ok(byText(h.root, ".t-banner", "GitHub не подключён"), "без подключения — баннер-подсказка");
  const hrefs = $$(h.root, "a").map((a) => a.getAttribute("href"));
  assert.ok(hrefs.includes("#/temporal/triggers/new?tpl=task-to-pr"));
  assert.ok(hrefs.includes("#/temporal/triggers/new?tpl=nightly-deps"));
  assert.ok(hrefs.includes("#/temporal/triggers/new"), "свой триггер");
  assert.equal(byText(h.root, ".t-tpl", "Починить CI"), null, "только переданные шаблоны");
});

test("счётчик ошибок триггеров — в общем сигнале для вкладки", async () => {
  await mount({ triggers: [trig({ errors: 4 })] });
  await t$.waitFor(() => ui.githubTriggers.value.loaded && ui.githubTriggers.value.errors === 4);
});

test("TemporalView: #/temporal/triggers (без id) рендерит список TriggersList, а не TriggerCard", async () => {
  installFetch([
    { method: "GET", path: "/teleharness/api/temporal/capabilities", reply: () => ({ runListAvailable: true, pipelineAvailable: true, schedulesAvailable: true, engines: ["opencode", "claude"], triggers: CAPS.triggers }) },
    { method: "GET", path: "/teleharness/api/github/connection", reply: () => CONN_OK },
    { method: "GET", path: "/teleharness/api/temporal/triggers", reply: () => [trig()] },
    { method: "GET", path: "/teleharness/api/temporal/definitions", reply: () => DEF },
    { method: "GET", path: "/teleharness/api/temporal/templates", reply: () => ({ templates: [], readiness: {} }) },
  ]);
  const h = t$.mount(ui.TemporalView, { section: "triggers" });
  await t$.waitFor(() => byText(h.root, ".t-trig", "Задача → PR"));
  assert.equal(byText(h.root, ".t-empty", "Триггер не найден"), null);
});
