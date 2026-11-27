// FEAT-20.3 (2.4): карточка триггера, журнал с фильтрами, лист события,
// «Запустить снова» только для повторяемых решений (T-11, T-12, P-9, P-11).
// FEAT-20.3 (2.5): красный CI в журнале — по PR и ветке, «Нужен человек» с хвостом лога (T-17).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    TriggerCard: "src/components/temporal/TriggerCard.jsx",
    decisionPill: "src/components/temporal/TriggerCard.jsx#decisionPill",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  installFetch();
});

const TID = "11111111-1111-1111-1111-111111111111";
const CAPS = { triggers: { available: true, publicUrl: "https://teleharness.example/teleharness", adminStopped: false, claudeLeftToday: 5 } };
const TRIG = { id: TID, repo: "acme/app", definitionId: "pipe-1", version: null, kinds: ["issue_labeled", "comment_command"], filters: { label: "agent" }, delivery: "auto", pollSeconds: 120, enabled: true, limits: { perHour: 6, queue: 20 }, hookConfigured: true, revision: 1, createdAt: 1, lastAt: Date.now(), errors: 0, badSignature: 0, ciAttempts: 0, stormAt: null };
const ROWS = [
  { id: 5, at: Date.now() - 60_000, kind: "issue_labeled", repo: "acme/app", number: 142, actor: "owner-gh", decision: "started", reason: null, workflowId: "wf-2c9f41a8", via: "webhook", eventJson: null },
  { id: 4, at: Date.now() - 600_000, kind: "issue_labeled", repo: "acme/app", number: 151, actor: "owner-gh", decision: "untrusted_author", reason: "Пропущено: автор не доверен", workflowId: null, via: "webhook", eventJson: { kind: "issue_labeled", number: 151, title: "Добавьте тёмную тему", author: "octo-guest", url: "https://github.com/acme/app/issues/151" } },
  { id: 3, at: Date.now() - 3_600_000, kind: "issue_labeled", repo: "acme/app", number: 133, actor: "owner-gh", decision: "rate_limited", reason: "Лимит частоты", workflowId: null, via: "poll", eventJson: { kind: "issue_labeled", number: 133, title: "Перевести настройки", url: "https://github.com/acme/app/issues/133" } },
];

function routes({ trig = TRIG, rows = ROWS, status = 200 } = {}) {
  const calls = { journal: [], replay: [] };
  installFetch([
    { method: "GET", path: new RegExp(`/teleharness/api/temporal/triggers/${TID}$`), reply: () => ({ status, body: status === 200 ? trig : { error: "Триггер не найден" } }) },
    { method: "GET", path: "/teleharness/api/temporal/definitions/pipe-1", reply: () => ({ id: "pipe-1", name: "Задача → PR", versions: [{ version: 3 }] }) },
    { method: "GET", path: new RegExp(`/teleharness/api/temporal/triggers/${TID}/journal`), reply: (c) => (calls.journal.push(c.query), rows) },
    { method: "POST", path: new RegExp(`/teleharness/api/temporal/triggers/${TID}/journal/\\d+/replay$`), reply: (c) => (calls.replay.push(c.path), { ok: true, workflowId: "wf-new" }) },
  ]);
  return calls;
}

async function mount(opts) {
  const calls = routes(opts);
  const h = t$.mount(ui.TriggerCard, { id: TID, capabilities: CAPS });
  return { h, calls };
}

test("каталог решений — значок и слово (не только цвет)", () => {
  assert.equal(ui.decisionPill("started").text, "Запущен");
  assert.equal(ui.decisionPill("rate_limited").text, "Лимит частоты");
  assert.equal(ui.decisionPill("untrusted_author").text, "Автор не доверен");
  assert.equal(ui.decisionPill("started", "Из очереди").text, "Из очереди", "причина — словом в плашке");
  assert.equal(ui.decisionPill("неведомое").text, "неведомое");
});

test("карточка: сводка, версия пайпа, статус; журнал с решениями и ссылкой на запуск", async () => {
  const { h, calls } = await mount();
  await t$.waitFor(() => byText(h.root, ".t-kv", "acme/app"));
  assert.ok(byText(h.root, ".t-kv", "последняя версия (3)"));
  assert.ok(byText(h.root, ".t-pill", "Работает"), "статус триггера включён");
  await t$.waitFor(() => $$(h.root, ".t-jr").length === 3);
  assert.ok(calls.journal[0] && calls.journal[0].filter === undefined, "первый запрос без фильтра");
  assert.ok(byText(h.root, ".t-jr", "#142"), "заголовок события");
  assert.ok(byText(h.root, ".t-jr", "Запущен"));
  assert.ok(byText(h.root, ".t-jr", "Автор не доверен"));
  const runLink = $(h.root, '.t-jr a[href="#/temporal/run/wf-2c9f41a8"]');
  assert.ok(runLink, "ссылка на экран запуска");
  assert.match(runLink.textContent, /запуск wf-2…41a8/);
});

test("фильтр журнала уходит в запрос", async () => {
  const { h, calls } = await mount();
  await t$.waitFor(() => $$(h.root, ".t-jr").length === 3);
  t$.click(byText(h.root, ".t-chip", "Ошибки"));
  await t$.waitFor(() => calls.journal.some((q) => q.filter === "errors"));
  t$.click(byText(h.root, ".t-chip", "Все"));
  await t$.waitFor(() => calls.journal.at(-1).filter === undefined, { tries: 400 });
});

test("лист события: причина словами; повтор только у повторяемых, с подтверждением (P-11)", async () => {
  const { h, calls } = await mount();
  await t$.waitFor(() => $$(h.root, ".t-jr").length === 3);
  t$.click($$(h.root, ".t-jr").find((r) => r.textContent.includes("Автор не доверен")));
  await t$.waitFor(() => byText(document.body, ".t-sheet", "Добавьте тёмную тему"));
  assert.ok(byText(document.body, ".t-sheet", "Пропущено: автор не доверен"), "решение словами");
  assert.ok(byText(document.body, ".t-sheet", "не передан агенту и не сохранён"), "пояснение для недоверенного");
  assert.equal(byText(document.body, ".t-sheet", "Запустить снова"), null, "не повторяемое — без кнопки");
  assert.ok(byText(document.body, ".t-sheet", "Открыть на GitHub"));
  t$.fire(document.querySelector(".t-scrim"), "keydown", { key: "Escape" }, KeyboardEvent);
  await t$.waitFor(() => !document.querySelector(".t-sheet"));

  t$.click($$(h.root, ".t-jr").find((r) => r.textContent.includes("Лимит частоты")));
  await t$.waitFor(() => byText(document.body, ".t-sheet", "Перевести настройки"));
  t$.click(byText(document.body, "button", "Запустить снова"));
  await t$.waitFor(() => byText(document.body, "button", "Повторить запуск?"));
  t$.click(byText(document.body, "button", "Нет"));
  await t$.waitFor(() => !byText(document.body, "button", "Повторить запуск?"));
  assert.equal(calls.replay.length, 0, "отмена — без запроса");
  t$.click(byText(document.body, "button", "Запустить снова"));
  await t$.waitFor(() => byText(document.body, "button", "Повторить запуск?"));
  t$.click(byText(document.body, "button", "Повторить запуск?"));
  await t$.waitFor(() => !document.querySelector(".t-sheet"));
  assert.equal(calls.replay.length, 1, "POST replay отправлен");
  await t$.waitFor(() => byText(h.root, '[role="status"]', "Запущено"));
});

// FEAT-20.3 (2.5, T-17): красный CI в журнале — строка названа по PR и ветке («лицо»
// события без текста, dispatch.js), лист «Нужен человек» объясняет исчерпанные попытки
// и показывает хвост лога. Данные — как их пишет сервер: REPLAYABLE и «Нужен человек»
// хранят тело целиком, остальные решения красного CI — только «лицо» (ciFace).
const CI_FACE = { kind: "ci_failed", repo: "acme/app", prNumber: 320, branch: "feature/upload", workflow: "test", url: "https://github.com/acme/app/actions/runs/555" };
const CI_LOG = "FAIL tests/upload.test.js\n● upload › rejects 0-byte file\nexpected 400, received 500";
const ciRow = (id, over = {}) => ({ id, at: Date.now() - 60_000 * id, kind: "ci_failed", repo: "acme/app", number: null, actor: "owner-gh", decision: "started", reason: null, workflowId: "wf-7777aaaa", via: "webhook", eventJson: CI_FACE, ...over });
const EXHAUSTED_REASON = "Нужен человек: 2 из 2 попыток";
const exhausted = (over = {}) => ciRow(8, { decision: "ci_attempts_exhausted", reason: EXHAUSTED_REASON, workflowId: null,
  eventJson: { ...CI_FACE, url: "https://github.com/acme/app/actions/runs/556", sha: "9c0d51f", title: "Upload: handle empty file", author: "owner-gh", body: "", ciLog: CI_LOG }, ...over });
const sheet = () => document.querySelector(".t-sheet");
const openRow = async (h, text) => {
  await t$.waitFor(() => $$(h.root, ".t-jr").some((r) => r.textContent.includes(text)));
  t$.click($$(h.root, ".t-jr").find((r) => r.textContent.includes(text)));
};

test("T-17: красный CI в журнале назван «PR #320 · ветка feature/upload»; «Нужен человек» — значок и слово, лога в строке нет", async () => {
  const { h } = await mount({ rows: [ciRow(9), exhausted()] });
  await t$.waitFor(() => $$(h.root, ".t-jr").length === 2);
  assert.deepEqual($$(h.root, ".t-jr-tt").map((el) => el.textContent), ["PR #320 · ветка feature/upload", "PR #320 · ветка feature/upload"], "обе строки — по предмету события, не прочерк");
  const human = $$(h.root, ".t-jr").find((r) => r.textContent.includes(EXHAUSTED_REASON));
  assert.ok(human.textContent.includes("красный CI · owner-gh · webhook · Нужен человек: 2 из 2 попыток"), "вид события, автор, канал и решение");
  const pill = $(human, ".t-pill");
  assert.equal(pill.textContent, "!Нужен человек", "статус — значок и слово, не только цвет");
  assert.ok($(pill, "i")?.getAttribute("aria-hidden") === "true", "значок скрыт от скринридера — читается слово");
  assert.ok(!human.textContent.includes("FAIL tests"), "хвост лога — только в листе, не в строке журнала");
});

test("лист «Запущен» для красного CI: workflow, ссылка на PR #320, ссылка на запуск; без баннера, лога и повтора", async () => {
  const { h, calls } = await mount({ rows: [ciRow(9), exhausted()] });
  await openRow(h, "Запущен");
  await t$.waitFor(() => byText(document.body, ".t-sheet", "Workflow"));
  assert.equal($(sheet(), ".t-jr-sheet-title").textContent, "PR #320 · ветка feature/upload");
  assert.match($(sheet(), ".t-kv").textContent, /Репозиторийacme\/app/);
  assert.match($(sheet(), ".t-kv").textContent, /Workflowtest/);
  assert.ok(!$(sheet(), ".t-kv").textContent.includes("Автор текста"), "«лицо» без текста — автора в нём нет");
  const link = $(sheet(), 'a[target="_blank"]');
  assert.deepEqual([link.textContent, link.getAttribute("href"), link.getAttribute("rel"), link.classList.contains("t-primary")],
    ["Открыть PR #320 ↗", "https://github.com/acme/app/pull/320", "noreferrer", false], "на PR, где красный CI; обычная, не главная");
  assert.ok($(sheet(), 'a[href="#/temporal/run/wf-7777aaaa"]'), "ссылка на экран запуска");
  assert.equal($(sheet(), ".t-banner"), null, "запущен — без баннера об исчерпании");
  assert.equal($(sheet(), ".t-code"), null, "в «лице» лога нет");
  assert.ok(!byText(sheet(), "button", "Запустить снова"), "запущен — не повторяется");
  assert.equal(calls.replay.length, 0);
});

test("T-17 / N-23: «Нужен человек» — что случилось, что делать и хвост лога CI; ссылкой на PR, без повтора", async () => {
  const { h, calls } = await mount({ rows: [ciRow(9), exhausted()] });
  await openRow(h, EXHAUSTED_REASON);
  await t$.waitFor(() => byText(document.body, ".t-sheet", "CI всё ещё красный"));
  assert.equal($(sheet(), ".t-jr-sheet-title").textContent, "PR #320 · ветка feature/upload");
  const banner = byText(sheet(), ".t-banner", "CI всё ещё красный");
  assert.match(banner.textContent, /CI всё ещё красный после 2 попыток/);
  assert.match(banner.textContent, /Дальше агент не запускается по этой ветке, пока вы или коллега не запушите свой коммит\./, "что происходит дальше — словами");
  assert.equal($(sheet(), ".t-cilog-h").textContent, "Лог CI · хвост");
  assert.equal($(sheet(), ".t-code").textContent, CI_LOG, "хвост лога — текстом, не разметкой");
  assert.match($(sheet(), ".t-code + .t-help").textContent, /секреты скрыты\. Полный лог — на GitHub\./);
  assert.match($(sheet(), ".t-kv").textContent, /РешениеНужен человек: 2 из 2 попыток/);
  const link = $(sheet(), 'a[target="_blank"]');
  assert.deepEqual([link.textContent, link.getAttribute("href"), link.classList.contains("t-primary")],
    ["Открыть PR #320 ↗", "https://github.com/acme/app/pull/320", true], "что делать — на первый план");
  assert.ok(!byText(sheet(), "button", "Запустить снова"), "исчерпание попыток само не повторяется");
  assert.ok(!$(sheet(), 'a[href^="#/temporal/run/"]'), "запуска не было");
  assert.equal(calls.replay.length, 0);
});

test("T-17: «Нужен человек» без хвоста лога — честно «Хвост лога CI недоступен», ссылка на PR остаётся", async () => {
  const { h } = await mount({ rows: [exhausted({ eventJson: { ...CI_FACE, ciLog: "" } })] });
  await openRow(h, EXHAUSTED_REASON);
  await t$.waitFor(() => byText(document.body, ".t-sheet", "CI всё ещё красный"));
  assert.equal($(sheet(), ".t-code"), null, "пустого блока лога нет");
  assert.ok(byText(sheet(), "p", "Хвост лога CI недоступен — полный лог на GitHub."), "не выдумываем лог");
  assert.equal($(sheet(), 'a[target="_blank"]').getAttribute("href"), "https://github.com/acme/app/pull/320");
});

test("красный CI вне PR (ветка main): строка названа веткой, лист ведёт на запуск Actions, а не на несуществующий PR", async () => {
  const run = "https://github.com/acme/app/actions/runs/560";
  const { h } = await mount({ rows: [ciRow(9, { decision: "ci_logs_unavailable", reason: "Логи CI недоступны", workflowId: null, eventJson: { kind: "ci_failed", repo: "acme/app", branch: "main", workflow: "deploy", url: run } })] });
  await t$.waitFor(() => $$(h.root, ".t-jr").length === 1);
  assert.equal($(h.root, ".t-jr-tt").textContent, "ветка main");
  t$.click($(h.root, ".t-jr"));
  await t$.waitFor(() => byText(document.body, ".t-sheet", "Логи CI недоступны"));
  const link = $(sheet(), 'a[target="_blank"]');
  assert.deepEqual([link.textContent, link.getAttribute("href")], ["Открыть на GitHub ↗", run], "надпись соответствует адресу");
  assert.equal($(sheet(), ".t-banner"), null, "это не исчерпание попыток — баннера нет");
});

test("«лицо» события не сохранилось у старой записи — прочерк, а не «undefined»", async () => {
  const { h } = await mount({ rows: [ciRow(9, { eventJson: null }), ciRow(8, { eventJson: { kind: "ci_failed" } })] });
  await t$.waitFor(() => $$(h.root, ".t-jr").length === 2);
  assert.deepEqual($$(h.root, ".t-jr-tt").map((el) => el.textContent), ["—", "—"]);
  t$.click($$(h.root, ".t-jr")[0]);
  await t$.waitFor(() => sheet());
  assert.equal($(sheet(), ".t-jr-sheet-title").textContent, "—");
  assert.equal($(sheet(), 'a[target="_blank"]'), null, "некуда вести — кнопки нет");
  assert.ok(!sheet().textContent.includes("undefined"), "и без «undefined» в тексте");
});

test("GitHub Enterprise: красный CI в PR ведёт на PR того же хоста, надпись — «Открыть PR #7»", async () => {
  const { h } = await mount({ rows: [ciRow(9, { repo: "corp/tools", eventJson: { kind: "ci_failed", prNumber: 7, branch: "feat/x", workflow: "ci", url: "https://ghe.corp/corp/tools/actions/runs/9" } })] });
  await openRow(h, "Запущен");
  await t$.waitFor(() => sheet());
  assert.equal($(sheet(), ".t-jr-sheet-title").textContent, "PR #7 · ветка feat/x");
  const link = $(sheet(), 'a[target="_blank"]');
  assert.deepEqual([link.textContent, link.getAttribute("href")], ["Открыть PR #7 ↗", "https://ghe.corp/corp/tools/pull/7"], "надпись и адрес — про одно и то же");
});

test("чужой/несуществующий триггер — 404 с объяснением", async () => {
  const { h } = await mount({ status: 404 });
  await t$.waitFor(() => byText(h.root, "h2", "Триггер не найден"));
  assert.ok(byText(h.root, "a", "К триггерам"));
});

test("FEAT-20.3 (2.6, T-18): выключение триггера с идущими запусками спрашивает «Пусть доработают / Отменить идущие» и включает обратно", async () => {
  const actions = [];
  let state = { ...TRIG, enabled: true, activeCount: 2 };
  installFetch([
    { method: "GET", path: new RegExp(`/teleharness/api/temporal/triggers/${TID}$`), reply: () => state },
    { method: "GET", path: "/teleharness/api/temporal/definitions/pipe-1", reply: () => ({ id: "pipe-1", name: "Задача → PR", versions: [{ version: 3 }] }) },
    { method: "GET", path: new RegExp(`/teleharness/api/temporal/triggers/${TID}/journal`), reply: () => ROWS },
    { method: "GET", path: "/teleharness/api/temporal/triggers", reply: () => [state] },
    { method: "POST", path: new RegExp(`/teleharness/api/temporal/triggers/${TID}/disable$`), reply: ({ body }) => { actions.push({ op: "disable", running: body?.running }); state = { ...state, enabled: false, activeCount: body?.running === "cancel" ? 0 : 2 }; return state; } },
    { method: "POST", path: new RegExp(`/teleharness/api/temporal/triggers/${TID}/enable$`), reply: () => { actions.push({ op: "enable" }); state = { ...state, enabled: true }; return state; } },
  ]);

  const h = t$.mount(ui.TriggerCard, { id: TID, capabilities: CAPS });
  const el = h.root;
  await t$.waitFor(() => byText(el, "button", "Выключить триггер"));
  await t$.click(byText(el, "button", "Выключить триггер"));
  await t$.waitFor(() => byText(document.body, "button", "Отменить идущие"));
  assert.ok(document.body.textContent.includes("Сейчас идёт 2 запуска"));
  assert.ok(byText(document.body, "button", "Пусть доработают"));

  await t$.click(byText(document.body, "button", "Отменить идущие"));
  await t$.waitFor(() => byText(el, "button", "Включить триггер"));
  assert.deepEqual(actions[0], { op: "disable", running: "cancel" });

  await t$.click(byText(el, "button", "Включить триггер"));
  await t$.waitFor(() => byText(el, "button", "Выключить триггер"));
  assert.deepEqual(actions[1], { op: "enable" });
});

test("BUG-316 + BUG-319: TriggerCard показывает «Очистить очередь» при queuedCount>0 и плашки queue_cleared / agent_loop", async () => {
  let state = { ...TRIG, enabled: true, activeCount: 1, queuedCount: 2, stormAt: Date.now() - 1000 };
  let rows = [
    { id: 91, at: Date.now() - 2000, kind: "push", repo: "octo/hello", decision: "agent_loop", reason: "Коммит агента — счётчик попыток не сброшен", via: "webhook" },
  ];
  let clearCalls = 0;
  installFetch([
    { method: "GET", path: new RegExp(`/teleharness/api/temporal/triggers/${TID}$`), reply: () => state },
    { method: "GET", path: "/teleharness/api/temporal/definitions/pipe-1", reply: () => ({ id: "pipe-1", name: "Задача → PR", versions: [{ version: 3 }] }) },
    { method: "GET", path: new RegExp(`/teleharness/api/temporal/triggers/${TID}/journal`), reply: () => rows },
    { method: "GET", path: "/teleharness/api/temporal/triggers", reply: () => [state] },
    {
      method: "POST", path: new RegExp(`/teleharness/api/temporal/triggers/${TID}/queue/clear$`),
      reply: () => {
        clearCalls += 1;
        state = { ...state, queuedCount: 0, stormAt: null };
        rows = [{ id: 92, at: Date.now(), kind: "system", repo: "octo/hello", decision: "queue_cleared", reason: "Очередь очищена вручную (удалено: 2)", via: "manual" }, ...rows];
        return { ok: true, cleared: 2 };
      },
    },
  ]);

  const h = t$.mount(ui.TriggerCard, { id: TID, capabilities: CAPS });
  const el = h.root;
  const btn = await t$.waitFor(() => byText(el, "button", "Очистить очередь (2)"));
  assert.ok(el.textContent.includes("Коммит агента"), "плашка agent_loop отображается");
  await t$.click(btn);
  await t$.waitFor(() => clearCalls === 1 && el.textContent.includes("Очередь очищена"));
  assert.equal(byText(el, "button", "Очистить очередь (2)"), null, "кнопка исчезает после очистки очереди");
});

