// FEAT-20.3 (2.3): мастер шаблона и «свой триггер» — готовность с blocking-проблемами,
// создание пайпа+триггера, ключи/секрет один раз, webhook кнопкой (T-6–T-10, D-2, D-3, N-1).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ TriggerForm: "src/components/temporal/TriggerForm.jsx" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  installFetch();
  location.hash = "";
});

const CAPS = { engines: ["claude"], pipelineAvailable: true, schedulesAvailable: true, runListAvailable: true, triggersAvailable: true,
  triggers: { available: true, publicUrl: "https://zai.example/zai", adminStopped: false, claudeLeftToday: 5 },
  subscriptionModels: { claude: ["claude-opus-5-5", "claude-sonnet-4-5"] } };
const KEY = "K".repeat(43);
const SECRET = "S".repeat(43);
const HOOK_URL = `https://zai.example/teleharness/hooks/github/${KEY}`;

// Реальное стеночное время: waitFor крутит setImmediate и не даёт сработать
// дебаунсу «Готовности» (500 мс). Здесь — sleep + act, как в харнессе.
async function settle(h, cond, { seconds = 3 } = {}) {
  for (let i = 0; i < seconds * 10; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    t$.act(() => {});
    let v;
    try {
      v = cond();
    } catch {
      v = null;
    }
    if (v) return v;
  }
  return null;
}

function routes({ readiness = { ready: true, problems: [] }, failWebhook = false } = {}) {
  const calls = { readiness: [], create: [], publish: null, trigger: [], webhook: [] };
  installFetch([
    { method: "GET", path: "/teleharness/api/temporal/projects", reply: () => ({ projects: [{ directory: "/srv/projects/app", name: "app" }], default: "/srv/projects/app" }) },
    { method: "POST", path: /^\/teleharness\/api\/temporal\/templates\/[a-z0-9-]+\/readiness$/, reply: (c) => (calls.readiness.push(c.body), readiness) },
    { method: "GET", path: "/teleharness/api/temporal/definitions", reply: () => [{ id: "pipe-1", name: "Мой пайп", latestVersion: 2 }] },
    { method: "POST", path: "/teleharness/api/temporal/definitions", reply: (c) => (calls.create.push(c.body), { id: "def-1", revision: 1 }) },
    { method: "POST", path: "/teleharness/api/temporal/definitions/def-1/publish", reply: (c) => (calls.publish = c.body, { id: "def-1", versions: [{ version: 1 }] }) },
    { method: "POST", path: "/teleharness/api/temporal/triggers", reply: (c) => (calls.trigger.push(c.body), { status: 201, body: { id: "trig-1", key: KEY, secret: SECRET, hookUrl: HOOK_URL, revision: 1, enabled: true, repo: c.body.repo } }) },
    { method: "POST", path: "/teleharness/api/temporal/triggers/trig-1/webhook", reply: () => (calls.webhook.push(1), failWebhook ? { status: 200, body: { hookId: 77, pinged: false, hookUrl: HOOK_URL } } : { status: 200, body: { hookId: 77, pinged: true, hookUrl: HOOK_URL } }) },
  ]);
  return calls;
}

test("шаблон: поля, готовность зелёная → создать → ключи один раз → webhook", async () => {
  location.hash = "#/temporal/triggers/new?tpl=task-to-pr";
  const calls = routes();
  const h = t$.mount(ui.TriggerForm, { capabilities: CAPS });
  await t$.waitFor(() => byText(h.root, "h2", "Задача → PR"));
  await t$.waitFor(() => $(h.root, "select.t-input")?.value === "/srv/projects/app", { tries: 60 });
  const repo = $(h.root, 'input[placeholder="owner/repo"]');
  t$.typeInto(repo, "acme/app");
  await settle(h, () => byText(h.root, ".t-ready", "Готово к созданию"));
  assert.deepEqual(calls.readiness.at(-1), { repo: "acme/app", directory: "/srv/projects/app", engine: "claude", model: "claude-opus-5-5" });

  t$.click(byText(h.root, "button", "Создать"));
  await t$.waitFor(() => byText(h.root, "h2", "Триггер создан"));
  assert.equal(calls.publish.revision, 1, "пайп опубликован");
  assert.deepEqual(calls.trigger[0], {
    definitionId: "def-1", repo: "acme/app", kinds: ["issue_labeled", "comment_command"],
    filters: { label: "agent", command: "agent" }, delivery: "auto", pollSeconds: 120, limits: { perHour: 6, queue: 20 },
  }, "спецификация триггера из шаблона");
  assert.ok($(h.root, "input[readonly]") && [...$$(h.root, "input[readonly]")].some((i) => i.value === KEY), "ключ виден");
  assert.ok([...$$(h.root, "input[readonly]")].some((i) => i.value === SECRET), "секрет виден");

  t$.click(byText(h.root, "button", "Создать webhook на GitHub"));
  await t$.waitFor(() => byText(h.root, '[role="status"]', "проверочное событие доставлено"));
  assert.equal(calls.webhook.length, 1);
});

test("готовность с blocking-проблемой: «Создать» неактивна, список причин", async () => {
  location.hash = "#/temporal/triggers/new?tpl=task-to-pr";
  routes({ readiness: { ready: false, problems: [{ field: "github", message: "Подключите GitHub в Настройках", blocking: true }] } });
  const h = t$.mount(ui.TriggerForm, { capabilities: CAPS });
  await t$.waitFor(() => byText(h.root, "h2", "Задача → PR"));
  const repo = $(h.root, 'input[placeholder="owner/repo"]');
  t$.typeInto(repo, "acme/app");
  await settle(h, () => byText(h.root, ".t-ready.bad", "есть препятствия"));
  assert.ok(byText(h.root, ".t-ready", "Подключите GitHub в Настройках"));
  assert.ok(byText(h.root, "button", "Создать").disabled, "blocking — создать нельзя");
});

test("нет публичного адреса: webhook недоступен, выбор переключается на опрос (N-1)", async () => {
  location.hash = "#/temporal/triggers/new?tpl=task-to-pr";
  routes();
  const caps = { ...CAPS, triggers: { ...CAPS.triggers, publicUrl: null } };
  const h = t$.mount(ui.TriggerForm, { capabilities: caps });
  await t$.waitFor(() => byText(h.root, "h2", "Задача → PR"));
  const wh = await t$.waitFor(() => byText(h.root, ".t-seg-btn", "Webhook — нет"));
  assert.ok(wh, "кнопка webhook помечена недоступной");
  t$.click(wh);
  await settle(h, () => byText(h.root, ".t-seg-btn.on", "Опрос"));
  assert.ok(byText(h.root, ".t-seg-btn.on", "Опрос"), "переключилось на опрос");
});

test("свой триггер: виды событий и фильтры уходят в POST", async () => {
  location.hash = "#/temporal/triggers/new";
  const calls = routes();
  const h = t$.mount(ui.TriggerForm, { capabilities: CAPS });
  await t$.waitFor(() => byText(h.root, "h2", "Свой триггер для пайпа"));
  const select = await t$.waitFor(() => [...$$(h.root, "select.t-input option")].some((o) => o.value === "pipe-1") && $(h.root, "select.t-input"));
  select.value = "pipe-1";
  t$.fire(select, "change");
  const repo = $(h.root, 'input[placeholder="owner/repo"]');
  t$.typeInto(repo, "octo/hello");
  const boxes = $$(h.root, '.t-kind input[type="checkbox"]');
  assert.equal(boxes.length, 5);
  t$.click(boxes[1]); // issue_opened
  t$.click(byText(h.root, "button", "Создать триггер"));
  await t$.waitFor(() => byText(h.root, "h2", "Триггер создан"));
  assert.deepEqual(calls.trigger[0].kinds, ["issue_labeled", "issue_opened"]);
  assert.deepEqual(calls.trigger[0].definitionId, "pipe-1");
});

test("правила фоновых запусков — лист с последствиями", async () => {
  location.hash = "#/temporal/triggers/new?tpl=fix-ci";
  routes();
  const h = t$.mount(ui.TriggerForm, { capabilities: CAPS });
  await t$.waitFor(() => byText(h.root, "h2", "Починить CI"));
  t$.click(byText(h.root, "button", "Правила фоновых запусков"));
  await t$.waitFor(() => byText(document.body, ".t-sheet", "Правила фоновых запусков"));
  assert.ok(byText(document.body, ".t-sheet", "как данные, а не команды"));
});

test("BUG-317: панель «Готовность» показывает несовпадение origin папки с репозиторием и блокирует «Создать»", async () => {
  location.hash = "#/temporal/triggers/new?tpl=task-to-pr";
  routes({
    readiness: {
      ready: false,
      problems: [{ field: "directory", message: "Папка указывает на other/shop, а выбран репозиторий octo/hello", blocking: true }],
    },
  });
  const h = t$.mount(ui.TriggerForm, { capabilities: CAPS });
  await t$.waitFor(() => byText(h.root, "h2", "Задача → PR"));
  const repo = $(h.root, 'input[placeholder="owner/repo"]');
  t$.typeInto(repo, "octo/hello");
  await settle(h, () => byText(h.root, ".t-ready.bad", "Папка указывает на other/shop"));
  assert.ok(byText(h.root, "button", "Создать").disabled, "при несовпадении origin создать триггер нельзя");
});

