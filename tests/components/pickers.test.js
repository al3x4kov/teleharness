// C6 Pickers (L2, TASK-14.7): шит выбора (PickerSheet: Escape/фон/✕,
// фокус), выбор модели (ModelPicker: группы движков, поиск, галочка,
// «Ничего не найдено», ошибка каталога → «Повторить»), выбор агента
// (AgentPicker: «Основные»/«Вспомогательные», поиск, ошибка), агент
// Claude-чата (ClaudeAgentPicker: «Без агента» всегда есть, пустой каталог),
// выбор проекта/папки (ProjectsView + AddProjectModal: проверка пути,
// дубликат, вердикт сервера /dircheck, добавление в список).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    PickerSheet: "src/components/Pickers.jsx#PickerSheet",
    ModelPicker: "src/components/Pickers.jsx#ModelPicker",
    AgentPicker: "src/components/Pickers.jsx#AgentPicker",
    ClaudeAgentPicker: "src/components/Pickers.jsx#ClaudeAgentPicker",
    ProjectsView: "src/components/views/ProjectsView.jsx",
    AddProjectModal: "src/components/views/ProjectsView.jsx#AddProjectModal",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.providerCfg.value = null;
  s.providerError.value = false;
  s.agents.value = [];
  s.agentsError.value = false;
  s.claudeAgents.value = null;
  s.claudeAgentsError.value = false;
  s.sessions.value = [];
  s.userProjects.value = [];
  localStorage.clear();
  installFetch();
});

const CFG = {
  models: [
    { id: "glm-5.3-flash", providerID: "zai-coding-plan", label: "GLM-5.3 Flash (zai-coding-plan)", status: "active" },
    { id: "glm-5.3", providerID: "zai-coding-plan", label: "GLM-5.3 (zai-coding-plan)", status: "active" },
    { id: "glm-5v-turbo", providerID: "zai", label: "GLM-5V-Turbo (zai)", imageInput: true, status: "active" },
    { id: "glm-4.5", providerID: "zai", label: "GLM-4.5 (zai)", status: "active" }, // не в WORKING_MODELS
    { id: "big-pickle", providerID: "opencode", label: "Big Pickle (opencode)", status: "active" }, // не на токене
    { id: "claude-opus-5-5", providerID: "anthropic", label: "Claude Opus 5.5 (anthropic)", status: "active" },
    { id: "claude-sonnet-5", providerID: "anthropic", label: "Claude Sonnet 5 (anthropic)", status: "active" },
  ],
  defaults: { anthropic: "claude-sonnet-5" },
  connected: ["zai-coding-plan", "zai", "opencode", "anthropic"],
};
const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const names = (root) => $$(root, "button.picker-row .picker-row-name").map((n) => n.textContent);
const groupTitles = (root) => $$(root, ".engine-group .eg-name").map((n) => n.textContent);

// ---- PickerSheet ------------------------------------------------------------------

test("PickerSheet: портал в body, role=dialog с заголовком; Escape, клик по фону и ✕ закрывают; прокрутка страницы заперта", () => {
  let closed = 0;
  const opener = document.createElement("button");
  document.body.appendChild(opener);
  opener.focus();
  const h = t$.mount(ui.PickerSheet, { title: "Модель чата", onClose: () => (closed += 1), children: ui.h("p", null, "тело") });
  const sheet = document.querySelector(".sheet");
  assert.ok(sheet, "шит отрисован");
  assert.equal(h.root.contains(sheet), false, "шит — порталом в body, не внутри корня");
  assert.equal(sheet.getAttribute("role"), "dialog");
  assert.equal(sheet.getAttribute("aria-modal"), "true");
  assert.equal(sheet.getAttribute("aria-label"), "Модель чата");
  assert.equal($(sheet, ".sheet-title").textContent, "Модель чата");
  assert.equal(document.activeElement, sheet, "фокус уходит в шит");
  assert.equal(document.body.style.overflow, "hidden");

  t$.key(document, "Escape");
  assert.equal(closed, 1, "Escape");
  t$.fire(document.querySelector(".sheet-backdrop"), "mousedown", {}, MouseEvent);
  assert.equal(closed, 2, "клик по фону");
  t$.fire(sheet, "mousedown", {}, MouseEvent);
  assert.equal(closed, 2, "клик внутри шита не закрывает");
  t$.click(sheet.querySelector('button[aria-label="Закрыть"]'));
  assert.equal(closed, 3, "✕");

  h.unmount();
  assert.equal(document.body.style.overflow, "", "прокрутка возвращена");
  assert.equal(document.activeElement, opener, "фокус вернулся на кнопку, открывшую шит");
});

// ---- ModelPicker ------------------------------------------------------------------

test("ModelPicker: две группы движков (z.ai первой), только рабочие модели, галочка на текущей", () => {
  ui.store.providerCfg.value = CFG;
  const { root } = t$.mount(ui.ModelPicker, { value: GLM, onPick() {} });
  assert.deepEqual(groupTitles(root).length, 2);
  const [zai, claude] = $$(root, "section");
  assert.match(zai.getAttribute("aria-label"), /^opencode/); // TASK-01.84
  assert.equal(!!$(claude, ".engine-dot.is-claude"), true, "вторая группа — Claude");
  assert.deepEqual(names(zai), ["GLM-5.3", "GLM-5.3 Flash", "GLM-5V-Turbo"], "план z.ai, затем vision-модель; без GLM-4.5 и Big Pickle");
  assert.deepEqual(names(claude), ["Claude Sonnet 5", "Claude Opus 5.5"], "дефолт Claude — первым");
  assert.equal(root.textContent.includes("(zai-coding-plan)"), false, "id провайдера в названии не показывается");
  const active = $$(root, "button.picker-row").filter((b) => b.getAttribute("aria-pressed") === "true");
  assert.equal(active.length, 1);
  assert.equal($(active[0], ".picker-row-name").textContent, "GLM-5.3 Flash");
  assert.ok($(active[0], ".picker-check"));
  assert.ok(byText(root, ".glyph-label", "картинки"), "у vision-модели метка «картинки»");
  assert.match($(root, ".picker-foot").textContent, /только модели, которые сейчас отвечают/);
});

test("ModelPicker: выбор строки → onPick({providerID, modelID})", () => {
  ui.store.providerCfg.value = CFG;
  const picked = [];
  const { root } = t$.mount(ui.ModelPicker, { value: GLM, onPick: (v) => picked.push(v) });
  t$.click($$(root, "button.picker-row").find((b) => b.textContent.includes("Claude Opus 5.5")));
  assert.deepEqual(picked, [{ providerID: "anthropic", modelID: "claude-opus-5-5" }]);
});

test("ModelPicker: engine=opencode — только свой движок и пояснение (закреплённый чат)", () => {
  ui.store.providerCfg.value = CFG;
  const { root } = t$.mount(ui.ModelPicker, { value: GLM, engine: "opencode", note: "Движок чата закреплён." });
  assert.equal(groupTitles(root).length, 1);
  assert.equal(root.textContent.includes("Claude"), false);
  assert.equal($(root, ".picker-note").textContent, "Движок чата закреплён.");
});

test("ModelPicker: поиск фильтрует; пусто → «Ничего не найдено по «…»» и «Сбросить» возвращает список", () => {
  ui.store.providerCfg.value = CFG;
  const { root } = t$.mount(ui.ModelPicker, { value: GLM });
  const search = $(root, "input.picker-search");
  assert.equal(search.getAttribute("aria-label"), "Поиск модели");
  t$.typeInto(search, "opus");
  assert.deepEqual(names(root), ["Claude Opus 5.5"]);
  t$.typeInto(search, "  нет-такой ");
  assert.equal(names(root).length, 0);
  assert.match($(root, ".picker-empty").textContent, /Ничего не найдено по «нет-такой»/);
  t$.click(byText(root, "button", "Сбросить"));
  assert.equal(names(root).length, 5);
  assert.equal(search.value, "");
});

test("ModelPicker: каталог грузится — скелетон «Загрузка моделей…»; ошибка /provider → «Повторить» → список", async () => {
  let fail = true;
  const PROVIDER = {
    all: [{ id: "zai-coding-plan", models: { "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM-5.3 Flash", status: "active" } } }],
    default: {},
    connected: ["zai-coding-plan"],
  };
  installFetch([{ method: "GET", path: "/zai/api/provider", reply: () => (fail ? { status: 500, body: { error: "x" } } : PROVIDER) }]);
  const { root } = t$.mount(ui.ModelPicker, { value: null });
  assert.ok($(root, '[role="status"][aria-label="Загрузка моделей…"]'), "сразу скелетон, не пустой шит");
  await t$.waitFor(() => $(root, ".picker-fail"));
  assert.match($(root, ".picker-fail").textContent, /Не удалось получить список моделей/);
  assert.match($(root, ".picker-fail").textContent, /Текущая модель не меняется/);
  fail = false;
  t$.click(byText(root, ".picker-fail button", "Повторить"));
  await t$.waitFor(() => names(root).length === 1);
  assert.deepEqual(names(root), ["GLM-5.3 Flash"]);
  assert.equal(fetchCalls.filter((c) => c.path === "/zai/api/provider").length, 2);
});

// ---- AgentPicker ------------------------------------------------------------------

const AGENTS = [
  { name: "Sisyphus - ultraworker", description: "Основной исполнитель", mode: "primary" },
  { name: "Prometheus", description: "Планировщик", mode: "all" },
  { name: "explore", description: "Поиск по коду", mode: "subagent" },
  { name: "Prometheus", description: "дубль из второго конфига", mode: "primary" },
];

test("AgentPicker: «Основные» над «Вспомогательными», по алфавиту, дубли схлопнуты; галочка и onPick(name)", () => {
  ui.store.agents.value = AGENTS;
  const picked = [];
  const { root } = t$.mount(ui.AgentPicker, { value: "Prometheus", onPick: (n) => picked.push(n) });
  assert.deepEqual($$(root, ".agent-group-label").map((x) => x.textContent), ["Основные", "Вспомогательные"]);
  const [main, aux] = $$(root, "section");
  assert.deepEqual($$(main, ".picker-row-title").map((x) => x.textContent), ["Prometheus", "Sisyphus - ultraworker"]);
  assert.deepEqual($$(aux, ".picker-row-title").map((x) => x.textContent), ["explore"]);
  const prom = $$(main, "button.picker-row")[0];
  assert.equal(prom.getAttribute("aria-pressed"), "true");
  assert.equal($(prom, ".picker-row-desc").textContent, "Планировщик", "описание — первое из дублей");
  t$.click($$(aux, "button.picker-row")[0]);
  assert.deepEqual(picked, ["explore"]);
});

test("AgentPicker: поиск по имени и описанию; ничего не найдено → «Сбросить»", () => {
  ui.store.agents.value = AGENTS;
  const { root } = t$.mount(ui.AgentPicker, { value: null });
  const search = $(root, "input.picker-search");
  t$.typeInto(search, "коду");
  assert.deepEqual($$(root, ".picker-row-title").map((x) => x.textContent), ["explore"]);
  assert.deepEqual($$(root, ".agent-group-label").map((x) => x.textContent), ["Вспомогательные"], "пустая группа скрыта");
  t$.typeInto(search, "zzz");
  assert.match($(root, ".picker-empty").textContent, /Ничего не найдено по «zzz»/);
  t$.click(byText(root, "button", "Сбросить"));
  assert.equal($$(root, "button.picker-row").length, 3);
});

test("AgentPicker: пустой список — скелетон; ошибка /agent → «Повторить» перезапрашивает", async () => {
  installFetch([{ method: "GET", path: "/zai/api/agent", reply: () => AGENTS }]);
  const { root } = t$.mount(ui.AgentPicker, { value: null });
  assert.ok($(root, '[aria-label="Загрузка агентов…"]'));
  ui.store.agentsError.value = true;
  await t$.flush();
  assert.match($(root, ".picker-fail").textContent, /Не удалось получить список агентов/);
  t$.click(byText(root, ".picker-fail button", "Повторить"));
  await t$.waitFor(() => $$(root, "button.picker-row").length === 3);
  assert.equal(ui.store.agentsError.value, false);
  assert.ok(fetchCalls.some((c) => c.path === "/zai/api/agent"));
});

// ---- ClaudeAgentPicker -------------------------------------------------------------

test("ClaudeAgentPicker: каталог не загружен → запрос /claude/agents; «Без агента» доступна до загрузки и выбирается (null)", async () => {
  installFetch([{ method: "GET", path: "/zai/api/claude/agents", reply: () => ({ agents: [{ id: "workflow", name: "Workflow", description: "Полный флоу" }, { bad: 1 }] }) }]);
  const picked = [];
  const { root } = t$.mount(ui.ClaudeAgentPicker, { value: "workflow", onPick: (v) => picked.push(v) });
  const none = $$(root, "button.picker-row")[0];
  assert.equal($(none, ".picker-row-title").textContent, "Без агента");
  assert.equal(none.getAttribute("aria-pressed"), "false");
  await t$.waitFor(() => $$(root, "button.picker-row").length === 2);
  const wf = $$(root, "button.picker-row")[1];
  assert.equal(wf.getAttribute("aria-pressed"), "true", "галочка на текущем агенте");
  assert.equal($(wf, ".picker-row-desc").textContent, "Полный флоу");
  t$.click(none);
  assert.deepEqual(picked, [null]);
  assert.match($(root, ".picker-foot").textContent, /можно сменить в любой момент/);
});

test("ClaudeAgentPicker: пустой каталог → «Агентов пока нет.», «Без агента» с галочкой", () => {
  ui.store.claudeAgents.value = [];
  const { root } = t$.mount(ui.ClaudeAgentPicker, {});
  assert.equal($(root, ".picker-empty").textContent, "Агентов пока нет.");
  assert.equal($$(root, "button.picker-row").length, 1);
  assert.equal($$(root, "button.picker-row")[0].getAttribute("aria-pressed"), "true");
  assert.equal(fetchCalls.some((c) => c.path === "/zai/api/claude/agents"), false, "загруженный каталог не перезапрашивается");
});

// ---- выбор проекта / папки ------------------------------------------------------

const NOW = Date.now();
const ses = (id, directory, extra = {}) => ({ id, title: id, directory, time: { created: NOW, updated: NOW }, ...extra });

test("Проекты: карточки из папок чатов — имя, счётчик, ссылка #/project/<папка>; добавленная вручную помечена", async () => {
  ui.store.sessions.value = [ses("s1", "D:\\Work\\alpha"), ses("s2", "D:\\Work\\alpha"), ses("s3", "D:\\Work\\beta")];
  ui.store.userProjects.value = ["E:\\Manual\\gamma"];
  const { root } = t$.mount(ui.ProjectsView);
  await t$.flush();
  const cards = $$(root, ".project-card");
  const byName = Object.fromEntries(cards.map((c) => [$(c, ".project-name").firstChild.textContent, c]));
  assert.deepEqual(Object.keys(byName).sort(), ["alpha", "beta", "gamma"]);
  assert.match($(byName.alpha, ".set-value").textContent, /^2 чата/);
  assert.equal($(byName.alpha, "a.project-head").getAttribute("href"), "#/project/" + encodeURIComponent("D:\\Work\\alpha"));
  assert.match($(byName.gamma, ".set-value").textContent, /пока нет чатов/);
  assert.ok($(byName.gamma, ".project-tag"), "«добавлен вручную»");
  assert.equal($(byName.alpha, ".project-tag"), null);
});

test("Новый проект: относительный и системный путь отклоняются без запроса к серверу", async () => {
  const created = [];
  const { root } = t$.mount(ui.AddProjectModal, { projects: [], onCreate: (d) => created.push(d), onClose() {} });
  const input = $(root, 'input[aria-label="Папка проекта"]');
  const createBtn = byText(root, ".modal-actions button", "Создать");
  assert.equal(createBtn.disabled, true, "пустой путь — «Создать» выключена");
  t$.typeInto(input, "projects\\app");
  t$.click(createBtn);
  await t$.flush();
  assert.match($(root, ".modal-error").textContent, /Нужен полный путь с диском/);
  assert.equal(input.getAttribute("aria-invalid"), "true");
  t$.typeInto(input, "C:\\Windows\\System32\\x");
  assert.equal($(root, ".modal-error"), null, "ввод снимает ошибку");
  t$.key(input, "Enter");
  await t$.flush();
  assert.match($(root, ".modal-error").textContent, /Системные папки Windows/);
  assert.deepEqual(created, []);
  assert.equal(fetchCalls.some((c) => c.path === "/zai/api/dircheck"), false);
});

test("Новый проект: дубликат (регистр и хвостовой слэш не важны) → «уже есть» + «Открыть его»", async () => {
  let closed = 0;
  const { root } = t$.mount(ui.AddProjectModal, {
    projects: [{ directory: "D:\\Work\\Alpha" }],
    onCreate: () => assert.fail("дубликат не создаётся"),
    onClose: () => (closed += 1),
  });
  t$.typeInto($(root, "input.modal-input"), "d:\\work\\alpha\\");
  t$.click(byText(root, ".modal-actions button", "Создать"));
  await t$.flush();
  assert.match($(root, ".modal-error").textContent, /Эта папка уже есть в списке проектов/);
  t$.click(byText(root, ".modal-error button", "Открыть его"));
  assert.equal(closed, 1);
  assert.equal(location.hash, "#/project/" + encodeURIComponent("D:\\Work\\Alpha"));
});

test("Новый проект: вердикт сервера (/dircheck) показывается до добавления; ok → onCreate(путь)", async () => {
  let verdict = { ok: false, error: "Такого диска нет на сервере." };
  installFetch([{ method: "GET", path: "/zai/api/dircheck", reply: () => verdict }]);
  const created = [];
  const { root } = t$.mount(ui.AddProjectModal, { projects: [], onCreate: (d) => created.push(d), onClose() {} });
  t$.typeInto($(root, "input.modal-input"), "Z:\\nowhere");
  t$.click(byText(root, ".modal-actions button", "Создать"));
  await t$.waitFor(() => $(root, ".modal-error"));
  assert.equal($(root, ".modal-error").textContent, "Такого диска нет на сервере.");
  assert.equal(fetchCalls.find((c) => c.path === "/zai/api/dircheck").query.directory, "Z:\\nowhere");
  assert.deepEqual(created, []);
  verdict = { ok: true };
  t$.typeInto($(root, "input.modal-input"), "  D:\\Projects\\new-app ");
  t$.click(byText(root, ".modal-actions button", "Создать"));
  await t$.waitFor(() => created.length === 1);
  assert.deepEqual(created, ["D:\\Projects\\new-app"], "путь обрезан по краям");
});

test("Проекты: «+» открывает «Новый проект», созданная папка появляется в списке и в localStorage", async () => {
  installFetch([{ method: "GET", path: "/zai/api/dircheck", reply: () => ({ ok: true }) }]);
  ui.store.sessions.value = [ses("s1", "D:\\Work\\alpha")];
  const { root } = t$.mount(ui.ProjectsView);
  await t$.flush();
  t$.click($(root, 'button[aria-label="Добавить проект"]'));
  const dlg = await t$.waitFor(() => $(root, '.modal[aria-label="Новый проект"]'));
  t$.typeInto($(dlg, "input.modal-input"), "D:\\Projects\\delta");
  t$.click(byText(dlg, ".modal-actions button", "Создать"));
  await t$.waitFor(() => !$(root, ".modal"));
  assert.ok($$(root, ".project-name").some((n) => n.textContent.startsWith("delta")));
  assert.deepEqual(ui.store.userProjects.value, ["D:\\Projects\\delta"]);
  const key = Object.keys(localStorage).find((k) => k.startsWith("zai.projects"));
  assert.ok(key, "список проектов сохранён");
  assert.deepEqual(JSON.parse(localStorage.getItem(key)), ["D:\\Projects\\delta"]);
});
