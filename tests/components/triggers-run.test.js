// FEAT-20.3 (2.5): экран запуска от GitHub — источник, шаг «Открыть PR» и его
// итоги, ожидание GitHub, решение по файлам CI, отказы, попытки «Починить CI»,
// хвост лога; строка списка со ссылками наружу. Каждое состояние макета
// epic20-background-agents.html (T-14–T-17, D-4) — тест (задача 3.5).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch, fetchCalls } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    RunDetail: "src/components/temporal/RunDetail.jsx",
    RunsList: "src/components/temporal/RunsList.jsx",
    prOutcome: "src/components/temporal/ui.jsx#prOutcome",
    ghWait: "src/components/temporal/ui.jsx#ghWait",
    sourceText: "src/components/temporal/ui.jsx#sourceText",
    stepErrorTitle: "src/components/temporal/ui.jsx#stepErrorTitle",
    eventTarget: "src/components/temporal/ui.jsx#eventTarget",
    CI_ATTEMPTS_MAX: "shared/temporal-templates.js#CI_ATTEMPTS_MAX",
  });
  t$ = createHarness(ui);
  ui.store.me.value = { id: "admin", role: "admin" };
});
afterEach(() => {
  t$.cleanup();
  installFetch();
  ui.store.me.value = { id: "admin", role: "admin" };
  if (typeof location !== "undefined") location.hash = "";
});

const TID = "11111111-1111-1111-1111-111111111111";
const ISSUE = "https://github.com/acme/app/issues/142";
const PR = "https://github.com/acme/app/pull/318";
const PR320 = "https://github.com/acme/app/pull/320";
const MODEL = { type: "model", engine: "claude", model: "claude-opus-5-5" };
const STEPS = [
  { id: "plan", name: "План", ...MODEL },
  { id: "gate", name: "Одобрить план", type: "approval" },
  { id: "work", name: "Правки в отдельной рабочей копии", ...MODEL },
  { id: "pr", name: "Открыть PR", type: "pull_request" },
];
const DONE = { plan: "completed", gate: "completed", work: "completed", pr: "completed" };
const WAIT_STEPS = [{ id: "work", name: "Правки в отдельной рабочей копии", ...MODEL }, { id: "pr", name: "Открыть PR", type: "pull_request" }];
const CI_STEPS = [{ id: "fix", name: "Найти причину и исправить", type: "model", engine: "opencode", model: "glm-5.3" }, { id: "pr", name: "Открыть PR", type: "pull_request", mode: "same-branch" }];
const CI_REF = "acme/app · PR #320 · feature/upload · CI «test»";
const CI_LOG = "FAIL tests/upload.test.js\n● upload › rejects 0-byte file\nexpected 400, received 500\nat handleUpload (routes/files.js:212)";
const REFUSED = "GitHub отклонил отправку: правило репозитория «Require signed commits». Коммит 5be01d3 остался в рабочей копии — отправьте вручную или ослабьте правило для веток teleharness/*.";
const MOVED = "Ветка обновлена человеком — правки агента не отправлены, перезапись не выполняется. Коммит остался в рабочей копии запуска.";

// Запуск «Задача → PR» от метки agent на задаче #142 — как в кадре T-14.
const ghRun = (over = {}) => ({
  workflowId: "w", runId: "run-1", status: "COMPLETED", name: "Задача → PR", version: 3, definitionId: "a", directory: "/srv/project",
  source: "github", triggerId: TID, eventRef: "acme/app#142 · метка agent", eventUrl: ISSUE,
  startTime: "2026-11-21T11:32:00Z", closeTime: "2026-11-21T11:47:00Z",
  // allowedActions сервер не отдаёт (значит разрешено всё) — в фикстуре его нет, как в реальном ответе.
  steps: STEPS, resultSteps: ["plan", "work"], chats: {}, files: [], runFolder: null,
  state: { generation: "g", paused: false, pending: [], steps: DONE },
  summary: { kind: "ok", status: "COMPLETED", stepsTotal: 4, current: null, waiting: false },
  inputs: { repo: "acme/app", number: 142, title: "Пустой список проектов на телефоне", body: "На телефоне список проектов пуст.", url: ISSUE, actor: "owner-gh" },
  ...over,
});
// Шаг «Открыть PR» ждёт GitHub (токен, сеть) — запуск идёт, T-15.
const waiting = (reason) => ghRun({ status: "RUNNING", closeTime: undefined, steps: WAIT_STEPS, resultSteps: ["work"],
  state: { generation: "g", paused: false, pending: [], steps: { work: "completed", pr: "github_wait" }, waitReasons: { pr: reason } },
  summary: { kind: "github", status: "RUNNING", stepsTotal: 2, current: { id: "pr", name: "Открыть PR", index: 2 }, waiting: false } });
// Шаг PR отказал неповторяемо: воркер упал, текст отказа сохранён в запуск — T-16.
const failed = (stepError, extra = {}) => ghRun({ status: "FAILED", stepError,
  state: { generation: "g", paused: false, pending: [], steps: { ...DONE, pr: "running" } },
  summary: { kind: "err", status: "FAILED", stepsTotal: 4, current: null, waiting: false }, ...extra });
const pushRefused = () => failed({ stepId: "pr", code: "push_rejected", sha: "5be01d3", at: 1, message: REFUSED });

async function mountRun(run, extra = []) {
  installFetch([
    { path: "/teleharness/api/temporal/runs/w", reply: () => run },
    { path: "/teleharness/api/temporal/runs/w/results/work", reply: () => ({ text: "Правки готовы" }) },
    { path: "/teleharness/api/temporal/runs/w/results/fix", reply: () => ({ text: "Исправлено" }) },
    ...extra,
  ]);
  const { root } = t$.mount(ui.RunDetail, { workflowId: "w" });
  await t$.waitFor(() => $(root, ".t-rundetail"));
  return root;
}
const prStep = (root) => $$(root, ".t-tl").find((li) => li.querySelector("b")?.textContent === "Открыть PR");
const pill = (root) => $(root, ".t-head .t-pill").textContent;

test("ui: prOutcome / ghWait / sourceText / stepErrorTitle / eventTarget — итог шага и причины словами", () => {
  const out = (pr, mode = "new") => ui.prOutcome(pr, mode);
  assert.equal(ui.CI_ATTEMPTS_MAX, 2, "предел попыток — из shared, тот же, что на сервере");
  assert.equal(out(null), null);
  assert.deepEqual(out({ state: "no_changes", url: null }), { tone: "off", title: "Изменений нет — PR не открыт", text: "Агент ничего не поменял, отправлять нечего." });
  assert.equal(out({ state: "done", url: PR, outcome: "created", branch: "teleharness/142-fix", base: "main" }).title, "Draft PR #318 открыт");
  assert.equal(out({ state: "done", url: PR, outcome: "updated" }).title, "PR #318 обновлён");
  assert.equal(out({ state: "done", url: PR320, outcome: "pushed", branch: "feature/upload", sha: "7c21e0a" }).title, "Коммит 7c21e0a отправлен в feature/upload");
  assert.equal(out({ state: "done", url: PR }).title, "PR #318 готов к ревью", "старый портал без outcome");
  assert.equal(out({ state: "done", url: PR320 }, "same-branch").title, "Коммит отправлен в ветку PR");
  assert.equal(out({ state: "done" }), null, "сделан, но ссылки нет — пустой ящик не рисуем");
  assert.equal(out({ state: "github_wait" }), null, "не итог");
  assert.equal(out({ state: "needs_approval", url: PR }), null, "шаг не завершён — ящик не рисуется, даже если адрес остался в состоянии");
  assert.equal(out({ state: "done", url: "https://github.com/o/r/pull/318" }).link, "Открыть PR #318 ↗");
  assert.equal(out({ state: "done", url: "https://ghe.local/o/r/pulls/318" }).link, "Открыть PR ↗", "нестандартный адрес — без номера");

  assert.equal(ui.ghWait("github_auth").needToken, true);
  assert.equal(ui.ghWait("github_auth").title, "Ждёт GitHub: токен истёк");
  assert.equal(ui.ghWait("push_auth").needToken, true, "push с тем же отказом — та же помощь");
  assert.deepEqual(
    ["push_network", "github_rate_limited", "github_server", "github_forbidden", "", undefined].map((r) => ui.ghWait(r).title),
    ["Ждёт GitHub: нет связи", "Ждёт GitHub: лимит запросов", "Ждёт GitHub: сервер не отвечает", "Ждёт GitHub", "Ждёт GitHub", "Ждёт GitHub"],
  );

  assert.equal(ui.sourceText({ source: "github", eventRef: CI_REF, attempt: 2 }), `GitHub · ${CI_REF} · попытка 2 из 2`);
  assert.equal(ui.sourceText({ source: "github", eventRef: "o/r#1", attempt: null }), "GitHub · o/r#1");
  assert.equal(ui.sourceText({ source: "schedule" }), "по расписанию");
  assert.equal(ui.sourceText({}), "вручную");

  assert.equal(ui.stepErrorTitle("branch_moved"), "Ветка обновлена человеком");
  assert.equal(ui.stepErrorTitle("nope"), "Шаг PR не выполнен");

  // Куда ведёт запись журнала красного CI: в PR (адрес — от origin события) или на само событие; toPr — из адреса.
  const CI_RUN = "https://github.com/o/r/actions/runs/5";
  assert.deepEqual(ui.eventTarget({ repo: "o/r", eventJson: { kind: "ci_failed", prNumber: 320, url: CI_RUN } }), { href: "https://github.com/o/r/pull/320", toPr: true });
  assert.deepEqual(ui.eventTarget({ repo: "o/r", eventJson: { kind: "ci_failed", prNumber: 3, url: "https://ghe.local/o/r/actions/runs/1" } }), { href: "https://ghe.local/o/r/pull/3", toPr: true }, "GitHub Enterprise — PR на том же хосте");
  assert.deepEqual(ui.eventTarget({ repo: "o/r", eventJson: { kind: "ci_failed", prNumber: null, url: CI_RUN } }), { href: CI_RUN, toPr: false }, "CI упал вне PR — на запуск");
  assert.deepEqual(ui.eventTarget({ repo: "o/r", eventJson: { kind: "ci_failed", prNumber: 320, url: "run-555" } }), { href: "run-555", toPr: false }, "адрес события не разбирается — ведём на него, надпись не врёт");
  assert.deepEqual(ui.eventTarget({ eventJson: { kind: "ci_failed", prNumber: 320, url: CI_RUN } }), { href: CI_RUN, toPr: false }, "без репозитория записи адрес PR не построить");
  assert.deepEqual(ui.eventTarget({ repo: "o/r", eventJson: { url: ISSUE } }), { href: ISSUE, toPr: false });
  assert.deepEqual(ui.eventTarget({ eventJson: { kind: "issue_labeled" } }), { href: null, toPr: false });
  assert.deepEqual(ui.eventTarget({}), { href: null, toPr: false });
  assert.deepEqual(ui.eventTarget(null), { href: null, toPr: false });
});

test("T-14: запуск от GitHub — источник ссылкой на задачу, шаг PR «Draft PR #318 открыт» со ссылкой, триггер в «О запуске»", async () => {
  const root = await mountRun(ghRun({ state: { generation: "g", paused: false, pending: [], steps: DONE,
    pr: { pr: { state: "done", url: PR, outcome: "created", branch: "teleharness/142-empty-projects-list", base: "main", sha: "a41f9c2" } } } }));
  await t$.waitFor(() => root.textContent.includes("Draft PR #318 открыт"));
  const source = $(root, `.t-facts a[href="${ISSUE}"]`);
  assert.ok(source, "источник — ссылкой в шапке");
  assert.equal(source.textContent, "GitHub · acme/app#142 · метка agent ↗");
  assert.match(pill(root), /Завершён/);
  const step = prStep(root);
  assert.ok(step.classList.contains("t-tl-done"));
  assert.match($(step, ".t-meta").textContent, /Шаг портала · готово/);
  const box = $(step, ".t-prbox");
  assert.ok(box.textContent.includes("teleharness/142-empty-projects-list → main"));
  const link = $(box, "a");
  assert.equal(link.getAttribute("href"), PR);
  assert.equal(link.textContent, "Открыть PR #318 ↗");
  assert.equal(link.getAttribute("rel"), "noreferrer");
  // «О запуске»: источник и триггер — ссылками
  const fact = $$(root, "dl.t-kv a").find((a) => a.getAttribute("href") === ISSUE);
  assert.ok(fact, "источник — ссылкой и в «О запуске»");
  assert.match(fact.textContent, /GitHub · acme\/app#142 · метка agent/);
  assert.ok($(root, `a[href="#/temporal/triggers/${TID}"]`), "карточка триггера — из запуска");
  assert.ok(!root.textContent.includes("Запуск завершился ошибкой"));
});

test("N-7 / T-16: PR по ветке уже был — «PR #318 обновлён» комментарием, второй PR не создан", async () => {
  const root = await mountRun(ghRun({ state: { generation: "g", paused: false, pending: [], steps: DONE,
    pr: { pr: { state: "done", url: PR, outcome: "updated", branch: "teleharness/142-empty-projects-list", sha: "165993f" } } } }));
  await t$.waitFor(() => root.textContent.includes("PR #318 обновлён"));
  const box = $(prStep(root), ".t-prbox");
  assert.ok(box.textContent.includes("новый коммит 165993f добавлен туда"));
  assert.ok(box.textContent.includes("Агент обновил PR"));
  assert.ok(box.textContent.includes("Второй PR не создан"));
  assert.equal($(box, "a").getAttribute("href"), PR);
});

test("D-4 / P-6: «Починить красный CI» — коммит в ветку PR, «попытка 1 из 2», хвост лога CI; лог не в списке входов", async () => {
  const root = await mountRun(ghRun({ name: "Починить красный CI", eventRef: CI_REF, eventUrl: PR320, attempt: 1, steps: CI_STEPS, resultSteps: ["fix"],
    state: { generation: "g", paused: false, pending: [], steps: { fix: "completed", pr: "completed" }, pr: { pr: { state: "done", url: PR320, outcome: "pushed", branch: "feature/upload", sha: "7c21e0a" } } },
    summary: { kind: "ok", status: "COMPLETED", stepsTotal: 2, current: null, waiting: false },
    inputs: { repo: "acme/app", branch: "feature/upload", ci_log: CI_LOG } }));
  await t$.waitFor(() => root.textContent.includes("Коммит 7c21e0a отправлен в feature/upload"));
  assert.match($(prStep(root), ".t-prbox").textContent, /PR #320 · CI перезапустится сам/);
  assert.match($(prStep(root), ".t-meta").textContent, /режим «в ветку PR»/);
  assert.equal($(root, `.t-facts a[href="${PR320}"]`).textContent, `GitHub · ${CI_REF} · попытка 1 из 2 ↗`);
  assert.match($(root, "#t-cilog-h").textContent, /Лог CI · хвост/);
  assert.equal($(root, ".t-code").textContent, CI_LOG, "хвост лога — текстом, не html");
  assert.match($(root, ".t-code + .t-help").textContent, /секреты скрыты/);
  const keys = $$(root, "dl.t-kv .t-mono").map((el) => el.textContent);
  assert.ok(keys.includes("repo") && keys.includes("branch"), "короткие входы — на месте");
  assert.ok(!keys.includes("ci_log"), "лог — своей карточкой, не строкой входов");
  assert.ok(!root.textContent.includes("Последняя попытка"), "1 из 2 — без предупреждения");
});

test("N-20: агент ничего не изменил — «Изменений нет — PR не открыт», запуск завершён без ошибки", async () => {
  const root = await mountRun(ghRun({ state: { generation: "g", paused: false, pending: [], steps: DONE, pr: { pr: { state: "no_changes", url: null } } } }));
  await t$.waitFor(() => root.textContent.includes("Изменений нет — PR не открыт"));
  const box = $(prStep(root), ".t-prbox.t-prbox-off");
  assert.ok(box, "итог без PR — приглушённым блоком");
  assert.equal($(box, "a"), null, "ссылки на PR нет");
  assert.match(pill(root), /Завершён/);
  assert.ok(!root.textContent.includes("Запуск завершился ошибкой"));
});

test("T-15 / N-14: токен истёк на шаге — «Ждёт GitHub: токен истёк», коммит сохранён, «Обновить токен»; запуск не упал", async () => {
  const root = await mountRun(waiting("github_auth"));
  await t$.waitFor(() => root.textContent.includes("Ждёт GitHub: токен истёк"));
  assert.match(pill(root), /Ждёт GitHub/, "статус словами, не «выполняется»");
  const token = $(root, 'a[href="#/settings/github"]');
  assert.ok(token, "кнопка ведёт в Настройки → GitHub");
  assert.equal(token.textContent, "Обновить токен");
  assert.match($(prStep(root), ".t-banner").textContent, /Коммит сохранён в рабочей копии: после обновления токена шаг продолжится сам/);
  assert.match($(prStep(root), ".t-meta").textContent, /ждёт GitHub · проверка каждые 5 мин · до 24 ч/);
  assert.ok(!root.textContent.includes("Запуск завершился ошибкой"));
  assert.ok($(root, '[data-action="cancel"]'), "запуск идёт — его можно отменить");
});

test("T-15 (иные причины): нет связи — ожидание без кнопки токена; лимит запросов назван", async () => {
  const offline = await mountRun(waiting("github_network"));
  await t$.waitFor(() => offline.textContent.includes("Ждёт GitHub: нет связи"));
  assert.equal($(offline, 'a[href="#/settings/github"]'), null, "сеть чинится не токеном");
  t$.cleanup();
  const limited = await mountRun(waiting("github_rate_limited"));
  await t$.waitFor(() => limited.textContent.includes("Ждёт GitHub: лимит запросов"));
  assert.match($(prStep(limited), ".t-banner").textContent, /когда лимит обновится/);
});

test("N-10: агент изменил файлы CI — решение у шага PR без копии ответа модели; одобрение уходит с шагом и поколением", async () => {
  const sent = [];
  const root = await mountRun(ghRun({ status: "RUNNING", closeTime: undefined,
    state: { generation: "g", paused: false, pending: ["pr"], steps: { ...DONE, pr: "running" } },
    summary: { kind: "wait", status: "RUNNING", stepsTotal: 4, current: { id: "pr", name: "Открыть PR", index: 4 }, waiting: true } }),
  [{ method: "POST", path: "/teleharness/api/temporal/runs/w/actions", reply: (req) => { sent.push(req.body); return { accepted: true }; } }]);
  await t$.waitFor(() => $(root, ".t-decide"));
  const decide = $(root, ".t-decide");
  assert.match($(decide, "h2").textContent, /Шаг «Открыть PR» ждёт вашего решения/);
  assert.match(decide.textContent, /Агент изменил файлы CI \(\.github\/workflows\)/);
  assert.ok(!decide.textContent.includes("Результат шага"), "решение о файлах CI, а не об ответе модели");
  assert.equal(fetchCalls.filter((c) => c.path.endsWith("/results/work")).length, 0, "ответ модели за решением не подгружается");
  t$.click($(decide, '[data-action="approve"]'));
  await t$.waitFor(() => sent.length === 1);
  assert.deepEqual([sent[0].action, sent[0].stepId, sent[0].generation, sent[0].runId], ["approve", "pr", "g", "run-1"]);
});

test("T-16 / N-17: правило репозитория отклонило отправку — статус «Отправка отклонена», текст правила у шага, без общего «Ошибка»", async () => {
  const root = await mountRun(pushRefused());
  await t$.waitFor(() => root.textContent.includes("Отправка отклонена"));
  assert.match(pill(root), /Отправка отклонена/, "статус запуска назван причиной");
  const step = prStep(root);
  assert.ok(step.classList.contains("t-tl-fail"), "шаг — невыполнен, а не «прерван»");
  assert.match($(step, ".t-meta").textContent, /не выполнен/);
  const box = $(step, ".t-prbox-err");
  assert.equal(box.getAttribute("role"), "alert");
  assert.match($(box, "b").textContent, /Отправка отклонена/);
  assert.equal($(box, "p").textContent, REFUSED, "текст GitHub — с сервера, без правок");
  assert.ok($(box, '[data-action="to-worktree"]'), "путь к рабочей копии, где остался коммит");
  assert.ok(!root.textContent.includes("Запуск завершился ошибкой"), "общий баннер не дублирует частный");
  assert.ok($(root, 'a[href^="#/temporal/start/"]'), "запустить заново можно");
});

test("T-16: человек обновил ветку PR — «Ветка обновлена человеком», перезапись не выполняется", async () => {
  const root = await mountRun(failed({ stepId: "pr", code: "branch_moved", sha: "9c0d51f", at: 1, message: MOVED }));
  await t$.waitFor(() => root.textContent.includes("Ветка обновлена человеком"));
  assert.match(pill(root), /Ветка обновлена человеком/);
  const box = $(prStep(root), ".t-prbox-err");
  assert.equal($(box, "p").textContent, MOVED);
  assert.ok($(box, '[data-action="to-worktree"]'));
});

test("«Открыть рабочую копию» ведёт к карточке копии; без карточки — честное пояснение тостом", async () => {
  const wt = { id: "wt_aaaaaaaaaaaa", kind: "run", branch: "teleharness/142-empty-projects-list", base: "main", state: "ready", ahead: 1, behind: 0, files: [], filesCount: 1, uncommitted: 0, overlaps: [], op: null, queue: null, canUndoMerge: false, tenant: false };
  const scrolled = [];
  const proto = globalThis.HTMLElement?.prototype;
  const original = proto?.scrollIntoView;
  if (proto) proto.scrollIntoView = function (opts) { scrolled.push({ el: this, opts }); };
  try {
    const root = await mountRun(pushRefused(), [{ method: "GET", path: "/teleharness/api/worktrees", reply: () => ({ item: wt, pending: null }) }]);
    await t$.waitFor(() => $(root, '[data-req="FEAT-20.7"]'));
    t$.click($($(root, ".t-prbox-err"), '[data-action="to-worktree"]'));
    assert.deepEqual(scrolled.map((s) => [s.el.getAttribute("data-req"), s.el.querySelector("h2")?.textContent, s.opts.block]), [["FEAT-20.7", "Рабочая копия запуска", "start"]]);
    assert.equal($(root, ".t-toast"), null, "нашёл карточку — без тоста");
  } finally {
    if (proto) proto.scrollIntoView = original;
  }
  t$.cleanup();
  const bare = await mountRun(pushRefused(), [{ method: "GET", path: "/teleharness/api/worktrees", reply: () => ({ item: null, pending: null }) }]);
  await t$.waitFor(() => $(bare, ".t-prbox-err") && !$(bare, '[data-req="FEAT-20.7"]'));
  t$.click($($(bare, ".t-prbox-err"), '[data-action="to-worktree"]'));
  await t$.waitFor(() => $(bare, ".t-toast"));
  assert.match($(bare, ".t-toast").textContent, /Коммит не потерян — он в ветке рабочей копии/);
});

test("N-14: «Ждёт GitHub» дольше 24 ч — шаг прерван, запуск не упал молча; путь к рабочей копии", async () => {
  const root = await mountRun(ghRun({ status: "FAILED", steps: WAIT_STEPS, resultSteps: ["work"],
    state: { generation: "g", paused: false, pending: [], steps: { work: "completed", pr: "github_wait" }, waitReasons: { pr: "github_auth" } },
    summary: { kind: "err", status: "FAILED", stepsTotal: 2, current: { id: "pr", name: "Открыть PR", index: 2 }, waiting: false } }));
  await t$.waitFor(() => root.textContent.includes("Ждёт GitHub дольше 24 ч — шаг прерван"));
  assert.match(pill(root), /Ошибка/);
  assert.match($(prStep(root), ".t-meta").textContent, /прерван/);
  assert.ok(prStep(root).classList.contains("t-tl-stop"));
  assert.ok(!root.textContent.includes("Запуск завершился ошибкой"), "общий баннер не дублирует частный");
  assert.ok(byText(root, ".t-banner", "шаг прерван").textContent.includes("коммит сохранён в рабочей копии"));
  assert.ok($(byText(root, ".t-banner", "шаг прерван"), '[data-action="to-worktree"]'), "из баннера — путь к рабочей копии");
  assert.ok(!$(prStep(root), ".t-prbox-err"), "отказа GitHub не было — блока отказа нет");
});

test("T-17 / N-23: последняя попытка (2 из 2) названа баннером со ссылкой на событие; попытка 1 из 2 — без него", async () => {
  const first = await mountRun(ghRun({ eventRef: CI_REF, eventUrl: PR320, attempt: 1, steps: CI_STEPS, resultSteps: ["fix"],
    state: { generation: "g", paused: false, pending: [], steps: { fix: "completed", pr: "completed" }, pr: { pr: { state: "done", url: PR320, outcome: "pushed", branch: "feature/upload", sha: "7c21e0a" } } },
    summary: { kind: "ok", status: "COMPLETED", stepsTotal: 2, current: null, waiting: false }, inputs: { repo: "acme/app", branch: "feature/upload" } }));
  await t$.waitFor(() => $(first, ".t-prbox"));
  assert.ok(!first.textContent.includes("Последняя попытка"));
  t$.cleanup();
  const last = await mountRun(ghRun({ eventRef: CI_REF, eventUrl: PR320, attempt: 2 }));
  await t$.waitFor(() => last.textContent.includes("Последняя попытка — 2 из 2"));
  const banner = byText(last, ".t-banner", "Последняя попытка");
  assert.match(banner.textContent, /агент по ней больше не запустится — до вашего или коллегиного коммита/);
  assert.equal($(banner, "a").getAttribute("href"), PR320, "из баннера — на PR, где красный CI");
});

test("запуск старой версии портала: у шага есть ссылка, но без outcome — «PR #318 готов к ревью»", async () => {
  const root = await mountRun(ghRun({ state: { generation: "g", paused: false, pending: [], steps: DONE, pr: { pr: { state: "done", url: PR } } } }));
  await t$.waitFor(() => root.textContent.includes("PR #318 готов к ревью"));
  const box = $(prStep(root), ".t-prbox");
  assert.equal($(box, "a").getAttribute("href"), PR);
  assert.match($(box, "a").textContent, /Открыть PR #318 ↗/);
});

test("длинный вход (тело задачи с GitHub) свёрнут до 240 знаков; полный текст — за «показать целиком»", async () => {
  // Текст непериодический (у каждой части свой номер) — проверка «дальше 240 не показано» не спутает одинаковые куски.
  const body = Array.from({ length: 40 }, (_, i) => `шаг-${i + 1}: открыть список проектов;`).join(" ");
  const root = await mountRun(ghRun({ inputs: { repo: "acme/app", number: 142, body, url: ISSUE } }));
  await t$.waitFor(() => $(root, ".t-more"));
  const more = $(root, ".t-more");
  assert.match($(more, "summary").textContent, /показать целиком/);
  assert.equal($(more, ".t-prewrap").textContent, body, "полный текст — внутри, без правок");
  // Строка входа body: вне <details> — ровно имя, 240 знаков и многоточие; остальное только внутри <details>.
  const entry = more.parentElement;
  const visible = [...entry.childNodes].filter((n) => n.nodeName !== "DETAILS").map((n) => n.textContent).join("");
  assert.equal(visible.trim(), `body: ${body.slice(0, 240).trim()}…`);
  assert.equal(more.getAttribute("open"), null, "свёрнут по умолчанию");
  const other = $$(root, "dl.t-kv dd > div").find((d) => d !== entry && d.querySelector(".t-mono")?.textContent === "number");
  assert.equal(other?.textContent, "number: 142", "короткие входы — как были, без сворачивания");
});

// ——— Список запусков ———
const row = (id, kind, extra = {}) => ({ workflowId: id, definitionId: "a", name: "Пайп " + id, version: 1, accepted: true, source: "github",
  eventRef: "acme/app#142 · метка agent", steps: [{ id: "pr", name: "Открыть PR", type: "pull_request" }],
  summary: { kind, status: kind === "ok" ? "COMPLETED" : "RUNNING", startTime: null, stepsTotal: 1, current: null, waiting: false }, ...extra });
const CREATED = { state: "done", url: PR, outcome: "created", branch: "teleharness/142-fix", sha: "a41f9c2" };
const rowById = (root, id) => $$(root, ".t-runrow").find((el) => el.textContent.includes("Пайп " + id));

test("список (кр. 19): запуск от GitHub — итог PR словами, ссылки на событие и PR; строка role=link: чипы её не открывают, клик и Enter — открывают", async () => {
  installFetch([{ path: "/teleharness/api/temporal/runs", reply: () => [
    row("w1", "ok", { eventUrl: ISSUE, pr: CREATED }),
    row("w2", "ok", { source: "manual", eventRef: undefined }),
    row("w3", "github", { eventUrl: PR320, eventRef: CI_REF, attempt: 2, pr: { state: "done", url: PR320, outcome: "pushed", branch: "feature/upload", sha: "7c21e0a" } }),
    row("w4", "err", { eventUrl: ISSUE, stepError: { stepId: "pr", code: "push_rejected", message: REFUSED, at: 1 } }),
    row("w5", "ok", { eventUrl: ISSUE, pr: { state: "no_changes", url: null } }),
  ] }]);
  const { root } = t$.mount(ui.RunsList);
  await t$.waitFor(() => rowById(root, "w5"));

  const r1 = rowById(root, "w1");
  assert.equal(r1.tagName, "DIV", "внутри ссылки — строка не <a>");
  assert.equal(r1.getAttribute("role"), "link");
  assert.equal(r1.getAttribute("tabindex"), "0");
  assert.ok(r1.textContent.includes("GitHub · acme/app#142 · метка agent"));
  assert.ok(r1.textContent.includes("Draft PR #318 открыт"), "итог шага — словами в строке");
  const chips = $$(r1, ".t-runlink");
  assert.deepEqual(chips.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("rel")]), [["Открыть на GitHub ↗", ISSUE, "noreferrer"], ["PR #318 ↗", PR, "noreferrer"]]);
  for (const c of chips) assert.ok(c.classList.contains("t-btn"), "ссылки — чипы кнопочного размера (≥ 44 px)");
  t$.click(chips[0]);
  await t$.flush();
  assert.notEqual(location.hash, "#/temporal/run/w1", "клик по чипу не открывает запуск");
  t$.click($(r1, "b"));
  await t$.flush();
  assert.equal(location.hash, "#/temporal/run/w1", "клик по строке открывает запуск");
  location.hash = "";
  t$.key(r1, "Enter");
  assert.equal(location.hash, "#/temporal/run/w1", "Enter по строке — открывает");
  location.hash = "";
  t$.key(chips[1], "Enter");
  assert.equal(location.hash, "", "Enter по чипу — не запуск");

  const r2 = rowById(root, "w2");
  assert.equal(r2.tagName, "A", "ручной запуск без внешних ссылок — прежняя <a>");
  assert.equal(r2.getAttribute("href"), "#/temporal/run/w2");
  assert.equal($(r2, ".t-runlinks"), null);
  assert.ok(r2.textContent.includes("вручную"));

  // «Починить CI»: событие и PR — один адрес, чип один; «Ждёт GitHub» — идёт и попадает в фильтр
  const r3 = rowById(root, "w3");
  assert.deepEqual($$(r3, ".t-runlink").map((a) => a.textContent), ["PR #320 ↗"]);
  assert.ok(r3.textContent.includes("Ждёт GitHub") && r3.textContent.includes("Коммит 7c21e0a отправлен в feature/upload"));
  assert.ok(r3.textContent.includes("попытка 2 из 2"));
  assert.ok(byText(root, ".t-chip", "Идут · 1"), "«Ждёт GitHub» считается идущим");

  assert.match($(rowById(root, "w4"), ".t-pill").textContent, /Отправка отклонена/, "отказ назван в статусе строки");
  assert.ok(byText(root, ".t-chip", "Ошибки · 1"));
  const r5 = rowById(root, "w5");
  assert.ok(r5.textContent.includes("Изменений нет — PR не открыт"));
  assert.deepEqual($$(r5, ".t-runlink").map((a) => a.textContent), ["Открыть на GitHub ↗"], "без PR — только событие");
});
