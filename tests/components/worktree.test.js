// FEAT-20.7: рабочие копии — компонентные тесты состояний макета
// (design/mockups-v2/epic20-worktrees.html): чип «Отдельная копия» и не-git
// (T-1, T-5), лист настроек с незакоммиченным и detached (T-2), пилюля ветки
// (T-3), полоса создания и ошибки создания (T-12), полосы пересечений и лист
// пересечения (T-6, T-7), лист «Рабочая копия» (T-4: «Дождитесь конца хода»,
// офлайн), слияние: без тестов нужна причина, шаги и итоги (T-9…T-11, T-13),
// удаление копии и чата (T-14), список копий проекта (T-15), экран запуска,
// предупреждение отката хода; чистые помощники.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    WorktreeChip: "src/components/chat/Worktree.jsx#WorktreeChip",
    WorktreeHeaderPill: "src/components/chat/Worktree.jsx#WorktreeHeaderPill",
    WorktreeBand: "src/components/chat/Worktree.jsx#WorktreeBand",
    WorktreeSheet: "src/components/chat/Worktree.jsx#WorktreeSheet",
    WorktreeDeleteModal: "src/components/chat/Worktree.jsx#WorktreeDeleteModal",
    RunWorktree: "src/components/chat/Worktree.jsx#RunWorktree",
    WorktreesView: "src/components/views/WorktreesView.jsx",
    UndoSheet: "src/components/chat/TurnActions.jsx#UndoSheet",
    wtByChat: "src/lib/worktree-client.js#wtByChat",
    wtCreateError: "src/lib/worktree-client.js#wtCreateError",
    noteWorktreeError: "src/lib/worktree-client.js#noteWorktreeError",
    overlapBars: "src/lib/worktree-client.js#overlapBars",
    mergeSteps: "src/lib/worktree-client.js#mergeSteps",
    opOutcome: "src/lib/worktree-client.js#opOutcome",
    shortBranch: "src/lib/worktree-client.js#shortBranch",
    unsavedText: "src/lib/worktree-client.js#unsavedText",
    planBlocked: "src/lib/worktree-client.js#planBlocked",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.wtByChat.value = {};
  ui.wtCreateError.value = {};
  ui.store.busyMap.value = {};
  installFetch();
});

const SID = "ses_wt1";
const WT = "wt_aaaaaaaaaaaa";
const plan = (over = {}) => ({
  repo: true, admin: true, name: "teleharness-portal", base: "main", detached: false, branches: ["main", "dev"], dirty: [], dirtyCount: 0,
  estimateBytes: 186 * 1024 ** 2, freeBytes: 412 * 1024 ** 3, reserveBytes: 1024 ** 3, limits: { max: 20, used: 1 }, submodules: 0, lfs: 0,
  deps: { node_modules: true }, envFiles: [".env"], testCmd: "npm test", testSource: "package.json", settings: { deps: "link", copyEnv: true, mergeMethod: "squash" }, remember: null, ...over,
});
const item = (over = {}) => ({
  id: WT, kind: "chat", sid: SID, branch: "teleharness/dobav-indeks-po-customer-e4db", base: "main", state: "ready", port: 43120, branchOk: true, onBranch: "teleharness/dobav-indeks-po-customer-e4db",
  ahead: 2, behind: 0, files: [{ path: "src/api/orders.ts", additions: 20, deletions: 4 }, { path: "migrations/007.sql", additions: 4, deletions: 2, uncommitted: true }],
  filesCount: 2, uncommitted: 1, additions: 24, deletions: 6, testCmd: "npm test", testSource: "package.json", overlaps: [], op: null, queue: null, canUndoMerge: false, tenant: false, ...over,
});

test("T-1: чип «Отдельная копия» в пустом чате — тап включает (заявка), подпись «создастся при отправке»", async () => {
  installFetch([
    { method: "GET", path: "/teleharness/api/worktrees/plan", reply: () => plan() },
    { method: "GET", path: "/teleharness/api/worktrees", reply: () => ({ item: null, pending: null }) },
    { method: "POST", path: "/teleharness/api/worktrees/pending", reply: () => ({ pending: { base: "main" } }) },
  ]);
  const { root } = t$.mount(ui.WorktreeChip, { sessionId: SID });
  const chip = await t$.waitFor(() => $(root, ".wt-chip"));
  assert.equal(chip.getAttribute("aria-pressed"), "false");
  t$.click(chip);
  await t$.waitFor(() => $(root, ".wt-chip.is-on"));
  assert.match(root.textContent, /Ветка от main создастся при отправке/);
  const post = fetchCalls.find((c) => c.method === "POST" && c.path === "/teleharness/api/worktrees/pending");
  assert.equal(post.body.on, true);
  assert.equal(post.body.remember, true, "выбор запоминается на проект");
});

test("T-5: не-git папка — чип недоступен «Папка не под git» + «Создать репозиторий»; без коммитов — без кнопки", async () => {
  installFetch([
    { method: "GET", path: "/teleharness/api/worktrees/plan", reply: () => ({ repo: false, reason: "not-git" }) },
    { method: "GET", path: "/teleharness/api/worktrees", reply: () => ({ item: null, pending: null }) },
  ]);
  const { root } = t$.mount(ui.WorktreeChip, { sessionId: SID });
  const chip = await t$.waitFor(() => $(root, ".wt-chip"));
  assert.equal(chip.disabled, true);
  assert.match(root.textContent, /Папка не под git/);
  assert.ok($$(root, ".wt-link").some((b) => b.textContent === "Создать репозиторий"));
  assert.deepEqual(ui.planBlocked({ repo: false, reason: "no-commits" }).init, false);
});

test("T-2: лист настроек — незакоммиченное (по умолчанию «Создать без них»), detached требует базу, тенанту нет «Установить заново»", async () => {
  installFetch([
    { method: "GET", path: "/teleharness/api/worktrees/plan", reply: () => plan({ admin: false, detached: true, base: null, dirty: ["a.ts", "b.ts", "c.ts"], dirtyCount: 3, testsAvailable: true }) },
    { method: "GET", path: "/teleharness/api/worktrees", reply: () => ({ item: null, pending: null }) },
    { method: "POST", path: "/teleharness/api/worktrees/pending", reply: (c) => ({ pending: { base: c.body.base, carryDirty: c.body.carryDirty } }) },
  ]);
  const { root } = t$.mount(ui.WorktreeChip, { sessionId: SID });
  t$.click(await t$.waitFor(() => $(root, ".wt-chip")));
  const sheet = await t$.waitFor(() => document.querySelector(".sheet"));
  assert.match(sheet.textContent, /3 файла не закоммичены в основной копии/);
  const radios = [...sheet.querySelectorAll('input[name="wt-carry"]')];
  assert.equal(radios.length, 2);
  assert.equal(radios[1].checked, false, "по умолчанию «Создать без них» (перенос не выбран)");
  assert.equal([...sheet.querySelectorAll("option")].some((o) => o.textContent === "Установить заново"), false);
  assert.match(sheet.textContent, /в песочнице: без сети, 512 МБ/);
  const ok = [...sheet.querySelectorAll(".wt-actions button")].at(-1);
  assert.equal(ok.disabled, true);
  assert.match(ok.textContent, /Выберите базовую ветку/);
});

test("T-3: пилюля ветки в шапке — имя режется с начала, «от main», знак «!» при пересечении", async () => {
  ui.wtByChat.value = { [SID]: { item: item({ overlaps: [{ kind: "main", files: [{ path: "x" }] }] }) } };
  let opened = 0;
  const { root } = t$.mount(ui.WorktreeHeaderPill, { sessionId: SID, onOpen: () => opened++ });
  const pill = $(root, ".wt-pill");
  assert.match(pill.textContent, /от main/);
  // dogfood 2026-11-20: имя режется только с начала — концовка с id видна, второго «…» нет
  const name = $(root, ".wt-pill-name").textContent;
  assert.ok(name.startsWith("…") && name.endsWith("-e4db") && name.length <= 18, name);
  assert.match(pill.getAttribute("aria-label"), /teleharness\/dobav-indeks-po-customer-e4db/);
  assert.ok(pill.classList.contains("is-warn"));
  assert.equal(ui.shortBranch("teleharness/" + "x".repeat(40) + "-e4db", 20).endsWith("-e4db"), true);
  t$.click(pill);
  assert.equal(opened, 1);
});

test("T-12, кр. 2: «Создаю рабочую копию…» во время первого хода; ошибка места — текст, сообщение в композере, выходы", async () => {
  ui.wtByChat.value = { [SID]: { item: null, pending: { base: "main" } } };
  installFetch([{ method: "GET", path: "/teleharness/api/worktrees", reply: () => ({ item: null, pending: { base: "main" } }) }]);
  const h = t$.mount(ui.WorktreeBand, { sessionId: SID, busy: true });
  assert.match(h.root.textContent, /Создаю рабочую копию…/);
  t$.cleanup();
  ui.noteWorktreeError(SID, { worktree: true, kind: "space", error: "Не хватает места", estimateBytes: 1.8 * 1024 ** 3, reserveBytes: 1024 ** 3, freeBytes: 2.1 * 1024 ** 3 });
  const { root } = t$.mount(ui.WorktreeBand, { sessionId: SID, busy: false });
  assert.match(root.textContent, /Не хватает места/);
  assert.match(root.textContent, /Нужно 2,8 ГБ, свободно 2,1 ГБ/);
  assert.match(root.textContent, /Сообщение осталось в композере/);
  const labels = $$(root, "button").map((b) => b.textContent);
  assert.ok(labels.includes("Повторить") && labels.includes("Работать в основной копии"));
});

test("T-6/T-7, кр. 7: полосы пересечения (≤ 2, конфликт первым), лист с «будет конфликт» и «Попросить агента разрешить»", async () => {
  const overlaps = [
    { kind: "main", otherId: "main", files: [{ path: "b.ts", conflict: null }], conflict: false },
    { kind: "chat", otherId: "wt_b", sid: "ses_b", title: "Индекс заказов", files: [{ path: "src/api/orders.ts", conflict: true }], conflict: true },
    { kind: "base", otherId: "base", title: "main", files: [{ path: "c.ts", conflict: false }], conflict: false },
  ];
  const bars = ui.overlapBars(overlaps);
  assert.equal(bars.shown.length, 2);
  assert.equal(bars.more, 1);
  assert.equal(bars.shown[0].kind, "chat");
  ui.wtByChat.value = { [SID]: { item: item({ overlaps }) } };
  installFetch([{ method: "GET", path: "/teleharness/api/worktrees", reply: () => ({ item: item({ overlaps }), pending: null }) }]);
  const { root } = t$.mount(ui.WorktreeBand, { sessionId: SID, busy: false });
  const shown = $$(root, ".wt-overlap");
  assert.equal(shown.length, 2);
  assert.match(shown[0].textContent, /Чат «Индекс заказов» тоже правит 1 файл/);
  assert.match(shown[0].textContent, /будет конфликт/);
  assert.match(shown[0].textContent, /и ещё 1/);
  t$.click(shown[0]);
  const sheet = await t$.waitFor(() => document.querySelector(".sheet"));
  assert.match(sheet.textContent, /✕ будет конфликт/);
  const btns = [...sheet.querySelectorAll("button")].map((b) => b.textContent);
  assert.ok(btns.includes("Попросить агента разрешить"));
  assert.ok(btns.includes("Скрыть для этих файлов"));
});

test("T-4, кр. 6: лист «Рабочая копия» — ветка, впереди/позади, файлы, тесты, порты; идёт ход → «Дождитесь конца хода»", async () => {
  installFetch([{ method: "GET", path: "/teleharness/api/worktrees", reply: () => ({ item: item(), pending: null }) }]);
  ui.store.busyMap.value = { [SID]: Date.now() };
  ui.wtByChat.value = { [SID]: { item: item() } };
  t$.mount(ui.WorktreeSheet, { sessionId: SID, onClose: () => {} });
  const sheet = await t$.waitFor(() => document.querySelector(".sheet"));
  assert.match(sheet.textContent, /впереди на 2 · main ушла на 0/);
  assert.match(sheet.textContent, /Изменено: 2 файла/);
  assert.match(sheet.textContent, /Порты dev-сервера этой копии: 43120–43129/);
  assert.match(sheet.textContent, /npm test/);
  const merge = [...sheet.querySelectorAll("button")].find((b) => /Дождитесь конца хода/.test(b.textContent));
  assert.ok(merge && merge.disabled);
  const names = [...sheet.querySelectorAll("button")].map((b) => b.textContent);
  for (const n of ["Подтянуть main", "Git", "На ревью", "Удалить копию"]) assert.ok(names.includes(n), n);
});

test("T-9/T-13: слияние — без команды тестов нужна причина; шаги и итог «Тесты не прошли — main не изменена» с действиями", async () => {
  const op = { opId: "op_aaaaaaaaaaaa", wtId: WT, phase: "failed", kind: "tests-failed", error: "Тесты не прошли — main не изменена", steps: { precheck: "ok", update: "ok", test: "fail", advance: "wait" }, test: { cmd: "npm test", passed: false, tail: "✖ orders total\n3 failing", summary: { pass: 209, fail: 3 } } };
  installFetch([
    { method: "GET", path: "/teleharness/api/worktrees", reply: () => ({ item: item({ testCmd: null, testSource: "not-found" }), pending: null }) },
    { method: "GET", path: "/teleharness/api/me/worktrees", reply: () => ({ mergeMethod: "squash" }) },
    { method: "POST", path: `/teleharness/api/worktrees/${WT}/merge`, reply: (c) => ({ status: 202, body: { ...op, phase: "queued", steps: { precheck: "wait", update: "wait", test: "wait", advance: "wait" } } }) },
    { method: "GET", path: `/teleharness/api/worktrees/ops/${op.opId}`, reply: () => op },
  ]);
  ui.wtByChat.value = { [SID]: { item: item({ testCmd: null, testSource: "not-found" }) } };
  t$.mount(ui.WorktreeSheet, { sessionId: SID, onClose: () => {}, initial: "merge" });
  const sheet = await t$.waitFor(() => document.querySelector(".sheet"));
  assert.match(sheet.textContent, /Команда тестов не найдена/);
  assert.match(sheet.textContent, /1 файл в копии не закоммичен — закоммичу его в ветку/); // BUG-277: согласование числа
  const go = [...sheet.querySelectorAll(".wt-actions button")].at(-1);
  assert.match(go.textContent, /Слить без тестов…/);
  t$.click(go);
  await t$.waitFor(() => document.querySelector(".wt-bad"));
  assert.match(document.querySelector(".wt-bad").textContent, /Укажите причину/);
  const reason = [...document.querySelectorAll(".sheet input[type=text]")].at(-1);
  t$.typeInto(reason, "проверю руками");
  t$.click([...document.querySelectorAll(".sheet .wt-actions button")].at(-1));
  await t$.waitFor(() => /Тесты не прошли/.test(document.querySelector(".sheet")?.textContent ?? ""));
  const body = fetchCalls.find((c) => c.method === "POST" && c.path.endsWith("/merge")).body;
  assert.equal(body.skipTests, true);
  assert.equal(body.reason, "проверю руками");
  assert.equal(body.commitDirty, true);
  assert.match(body.idemKey, /^m_/);
  const s = document.querySelector(".sheet").textContent;
  assert.equal((s.match(/main не изменена/g) ?? []).length, 2, "заголовок листа и итог — без третьего повтора");
  assert.match(s, /✖ orders total/);
  for (const n of ["Попросить агента починить", "Вернуть ветку как до слияния", "Слить без тестов…", "Полный журнал"]) assert.ok(s.includes(n), n);
});

test("кр. 8–12: шаги слияния и итоги — чистые функции (успех, конфликт, перезапуск)", () => {
  const steps = ui.mergeSteps({ steps: { precheck: "ok", update: "ok", test: "run", advance: "wait" }, test: { cmd: "npm test" } });
  assert.deepEqual(steps.map((s) => s.state), ["ok", "ok", "run", "wait"]);
  assert.equal(steps[1].label, "Подтягиваю main в ветку");
  assert.deepEqual(ui.opOutcome({ phase: "done", files: 3, test: { passed: true, summary: { pass: 212 } } }), { tone: "ok", title: "Слито в main", text: "3 файла · тесты 212 ✓" });
  assert.equal(ui.opOutcome({ phase: "failed", kind: "conflict" }).title, "Конфликт — слияние не выполнено");
  // dogfood 2026-11-20: текст, повторяющий заголовок, не дублируется
  const tf = ui.opOutcome({ phase: "failed", kind: "tests-failed", error: "Тесты не прошли — main не изменена" });
  assert.equal(tf.text, "");
  assert.equal(tf.baseUnchanged, true);
  assert.equal(ui.opOutcome({ phase: "interrupted" }).title, "Слияние прервано перезапуском сервера");
  assert.equal(ui.unsavedText({ uncommitted: 2, commits: 3 }), "В копии 2 незакоммиченных файла и 3 коммита не в main");
});

test("T-14, кр. 14: удаление чата с несохранённой работой — по умолчанию «сохранить ветку», «Удалить всё» только с галочкой", async () => {
  installFetch([
    { method: "GET", path: `/teleharness/api/worktrees/${WT}/unsaved`, reply: () => ({ uncommitted: 2, commits: 1, merged: false }) },
    { method: "DELETE", path: `/teleharness/api/worktrees/${WT}`, reply: () => ({ ok: true, branchKept: true }) },
  ]);
  let deleted = 0;
  t$.mount(ui.WorktreeDeleteModal, { sessionId: SID, item: item(), title: "Индекс", onClose: () => {}, onDelete: async () => deleted++ });
  const dlg = await t$.waitFor(() => (/несохранённая работа/.test(document.querySelector(".modal")?.textContent ?? "") ? document.querySelector(".modal") : null));
  assert.match(dlg.textContent, /2 незакоммиченных файла и 1 коммит не в main/);
  const radios = [...dlg.querySelectorAll('input[name="wt-del"]')];
  assert.equal(radios[1].checked, true, "по умолчанию «Удалить чат, сохранить ветку»");
  t$.click(radios[2]);
  const del = await t$.waitFor(() => [...document.querySelectorAll(".modal .btn-danger")][0]);
  assert.equal(del.disabled, true, "без галочки «Понимаю…» нельзя");
  t$.click(radios[1]);
  t$.click([...document.querySelectorAll(".modal .btn-danger")][0]);
  await t$.waitFor(() => deleted === 1);
  const call = fetchCalls.find((c) => c.method === "DELETE");
  assert.equal(call.query.mode, "keep-branch");
});

test("T-15, кр. 15: «Рабочие копии» проекта — копии, состояние словом, ветки без чата", async () => {
  location.hash = "#/worktrees?directory=" + encodeURIComponent("/p/teleharness");
  installFetch([
    { method: "GET", path: "/teleharness/api/worktrees", reply: () => ({ repo: true, name: "teleharness", items: [item({ title: "Индекс", size: 1024 ** 2 }), item({ id: "wt_bbbbbbbbbbbb", title: "Платежи", overlaps: [{ kind: "chat", title: "Индекс", files: [{ path: "a" }], conflict: true }] })], branches: [{ name: "teleharness/old-1a2b", subject: "WIP: сохранено при удалении чата" }], limits: { max: 20 } }) },
    { method: "GET", path: "/teleharness/api/me/worktrees", reply: () => ({ mergeMethod: "squash", testTimeoutMin: 10 }) },
  ]);
  const { root } = t$.mount(ui.WorktreesView, {});
  await t$.waitFor(() => $$(root, ".wt-card").length >= 3);
  assert.match(root.textContent, /2 из 20/);
  assert.match(root.textContent, /✕ будет конфликт/);
  assert.match(root.textContent, /Ветки без чата/);
  assert.ok($$(root, "button").some((b) => b.textContent === "Удалить ветку"));
  location.hash = "";
});

test("кр. 22: экран запуска — ветка копии запуска и «Слить в main»; кр. 19: откат хода предупреждает о коммите", async () => {
  installFetch([{ method: "GET", path: "/teleharness/api/worktrees", reply: (c) => (c.query.run === "wf-1" ? { item: item({ kind: "run", sid: null, runId: "wf-1", branch: "teleharness/run-nochnoe-obnovlenie-7f2a" }), pending: null } : { item: null }) }]);
  const { root } = t$.mount(ui.RunWorktree, { workflowId: "wf-1" });
  await t$.waitFor(() => $(root, ".wt-branch"));
  assert.match(root.textContent, /teleharness\/run-nochnoe-obnovlenie-7f2a/);
  assert.ok($$(root, "button").some((b) => b.textContent === "Слить в main"));
  t$.cleanup();
  installFetch([
    { method: "GET", path: "/teleharness/api/worktrees", reply: () => ({ item: item({ turnCommit: { before: "a".repeat(40), after: "abc1234".padEnd(40, "0") } }), pending: null }) },
    { method: "GET", path: /\/revert$/, reply: () => ({ files: [] }) },
  ]);
  t$.mount(ui.UndoSheet, { sid: SID, onClose: () => {} });
  await t$.waitFor(() => /Ход сделал коммит abc1234/.test(document.querySelector(".sheet")?.textContent ?? ""));
  assert.match(document.querySelector(".sheet").textContent, /коммит останется в ветке teleharness\/dobav-indeks-po-customer-e4db/);
});

// BUG-277: тап-цели EPIC-20 — не меньше 44 px (ссылки листа копии, чипы и ссылки «Расходов», вход в «Расход чата»)
test("BUG-277: тап-цели листов копии и «Расходов» ≥ 44 px; «●» не липнет к числам", () => {
  const wt = readFileSync(new URL("../../src/components/worktree.css", import.meta.url), "utf8");
  const cost = readFileSync(new URL("../../src/components/costs.css", import.meta.url), "utf8");
  assert.match(wt, /\.wt-link \{[^}]*min-height: 44px/);
  assert.match(wt, /\.wt-file-num \.wt-tag \{ margin-left: 6px; \}/);
  for (const sel of ["cost-chip", "cost-link", "ctx-meter\\.is-button"]) assert.match(cost, new RegExp(`\\.${sel} \\{[^}]*min-height: 44px`), sel);
  assert.match(cost, /\.cost-more summary \{ min-height: 44px/);
  assert.match(wt, /\.wt-warn \{[^}]*display: block;/, "«!» и текст предупреждения — одной строкой");
});
