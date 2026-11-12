// FEAT-01.77: карточка субагента по BRIEF-14 и макету
// design/mockups-v2/subagents.html (кадры 1, 2, 3, 6). Компонент чисто
// презентационный: run приходит готовым пропом (модель design §2),
// подписи — функциями-пропами stepLabel/fmtDuration (заглушки в тесте).
// Отдельно — совместимость со старым вызовом { part } из ToolCard
// (opencode 1.x: subagent_type/run_in_background/metadata.sessionId).
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { stepLabel as realStepLabel } from "../../src/lib/subagents.js";

const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/v2-subagent-sync.json", import.meta.url), "utf8"));

let ui, t$;
before(async () => {
  ui = await loadUI({ AgentCard: "src/components/chat/AgentCard.jsx" });
  t$ = createHarness(ui);
});
afterEach(() => t$.cleanup());

// ---- заглушки подписей (реальные придут из src/lib/subagents.js) -----------
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const stepLabel = (s) => ({ verb: s.verb ?? s.tool ?? "Делает", object: s.object ?? "" });

const NOW = 1_800_000_000_000;
const step = (id, verb, object, status = "done") => ({ id, kind: "tool", tool: verb, object, status });
const run = (over = {}) => ({
  id: "run1",
  agent: "explorer",
  description: "Структура каталогов и точки входа",
  background: false,
  state: "running",
  startedAt: NOW - 42_000,
  endedAt: null,
  childId: "ses_child",
  steps: [step("s1", "list", "**/*"), step("s2", "read", "package.json"), step("s3", "read", "server.js", "running")],
  now: { verb: "Читает", object: "server.js" },
  output: null,
  error: null,
  tokens: null,
  depth: 0,
  ...over,
});

const mount = (props) => t$.mount(ui.AgentCard, props);

// ---- состояния карточки -----------------------------------------------------

test("running: класс is-run, «фоном» нет, строка «сейчас» с пульсом и объектом моноширинным, время и шаги справа", () => {
  const { root } = mount({ run: run({ background: false }), now: NOW, stepLabel, fmtDuration: fmtDur });
  const card = $(root, ".sa");
  assert.ok(card, "корень .sa");
  assert.ok(card.classList.contains("is-run"));
  assert.equal(card.getAttribute("data-run-id"), "run1");
  const head = $(root, ".sa-head");
  assert.equal(head.tagName, "BUTTON", "вся шапка — одна кнопка");
  assert.equal(head.getAttribute("aria-expanded"), "false", "по умолчанию свёрнута");
  assert.equal(head.getAttribute("aria-label"), "Агент explorer, работает, Структура каталогов и точки входа, 0:42");
  assert.ok($(root, ".sa-i-bot"), "значок работающего — значок агента");
  const nowRow = $(root, ".sa-now");
  assert.ok(nowRow, "строка «сейчас» у работающего свёрнутого");
  assert.ok($(nowRow, ".sa-pulse"), "пульсирующая точка");
  assert.match(nowRow.textContent, /Читает/);
  assert.equal($(nowRow, "code").textContent, "server.js", "объект моноширинным");
  const meta = $(root, ".sa-meta").textContent;
  assert.match(meta, /0:42/);
  assert.match(meta, /3 шага/);
  assert.equal($(root, ".sa-body"), null, "тело скрыто");
  assert.equal($(root, ".sa-name em"), null, "без «фоном»");
});

test("queued: слово «в очереди» вместо времени, часы, строки «сейчас» нет", () => {
  const { root } = mount({ run: run({ state: "queued", startedAt: null, now: null, steps: [] }), now: NOW, stepLabel, fmtDuration: fmtDur });
  assert.ok($(root, ".sa.is-queued"));
  assert.ok($(root, ".sa-i-clock"), "в очереди — часы");
  assert.match($(root, ".sa-meta").textContent, /в очереди/);
  assert.equal($(root, ".sa-now"), null);
  assert.equal($(root, ".sa-pulse"), null);
});

test("done: «1:08 · 6 шагов», вторая строка «12,4k токенов», галочка; по умолчанию свёрнута", () => {
  const { root } = mount({
    run: run({ state: "done", startedAt: NOW - 68_000, endedAt: NOW, now: null, steps: Array.from({ length: 6 }, (_, i) => step(`s${i}`, "read", `f${i}`)), tokens: 12_400 }),
    stepLabel,
    fmtDuration: fmtDur,
  });
  assert.ok($(root, ".sa.is-ok"));
  assert.ok($(root, ".sa-i-check"), "готов — галочка");
  const meta = $(root, ".sa-meta");
  assert.match($$(meta, ".sa-meta-line")[0].textContent, /^1:08 · 6 шагов$/);
  assert.match($$(meta, ".sa-meta-line")[1].textContent, /^12,4k токенов$/, "формат числа fmtNum");
  assert.equal($(root, ".sa-body"), null, "завершённая карточка свёрнута");
  assert.equal($(root, ".sa-pulse"), null);
});

test("done без токенов — второй строки метрики нет", () => {
  const { root } = mount({ run: run({ state: "done", startedAt: NOW - 68_000, endedAt: NOW, now: null, tokens: null, steps: [] }), fmtDuration: fmtDur });
  assert.equal($$(root, ".sa-meta-line").length, 1, "только «время · шагов»");
  assert.equal($(root, ".sa-meta").textContent.includes("токен"), false);
});

test("error: крест, слово «ошибка» и строка «Не выполнено: <причина>»", () => {
  const { root } = mount({
    run: run({ state: "error", startedAt: NOW - 9_000, endedAt: NOW, now: null, error: "команда npm test запрещена в этом чате", steps: [] }),
    now: NOW,
    fmtDuration: fmtDur,
  });
  assert.ok($(root, ".sa.is-err"));
  assert.ok($(root, ".sa-i-x"), "ошибка — крест");
  assert.match($(root, ".sa-meta").textContent, /ошибка/, "состояние словом, не только цветом");
  const err = $(root, ".sa-err");
  assert.ok(err, "строка причины");
  assert.equal(err.textContent, "Не выполнено: команда npm test запрещена в этом чате");
});

test("stopped: квадрат и слово «остановлен»", () => {
  const { root } = mount({ run: run({ state: "stopped", startedAt: NOW - 30_000, endedAt: NOW - 5_000, now: null, steps: [] }), fmtDuration: fmtDur });
  assert.ok($(root, ".sa.is-stop"));
  assert.ok($(root, ".sa-i-stop"), "остановлен — квадрат");
  assert.match($(root, ".sa-meta").textContent, /остановлен/);
  assert.equal($(root, ".sa-pulse"), null);
});

// ---- раскрытие ---------------------------------------------------------------

test("тап по шапке раскрывает: шаги с значками и подписями stepLabel, объект моноширинным; aria-expanded", () => {
  const { root } = mount({ run: run(), stepLabel, fmtDuration: fmtDur });
  const head = $(root, ".sa-head");
  t$.click(head);
  assert.equal(head.getAttribute("aria-expanded"), "true");
  const body = $(root, ".sa-body");
  assert.ok(body, "тело раскрылось");
  const items = $$(root, ".sa-steps li");
  assert.equal(items.length, 3);
  assert.match(items[0].textContent, /list/);
  assert.equal($(items[0], "code").textContent, "**/*");
  assert.ok(items[0].className.includes("done") === false, "готовый шаг без класса run");
  assert.ok(items[2].className.includes("run"), "текущий шаг — с точкой");
  assert.ok($(items[2], ".sa-i-run-mark") || items[2].textContent.includes("●"), "текущий шаг — ●");
  assert.equal($(root, ".sa-now"), null, "у раскрытого строки «сейчас» нет — текущий шаг виден в списке");
  t$.click(head);
  assert.equal(head.getAttribute("aria-expanded"), "false", "сворачивается обратно");
  assert.equal($(root, ".sa-body"), null);
});

test("управляемое раскрытие: expanded/onToggle — клик зовёт onToggle(run), состояние не переключается само", () => {
  const calls = [];
  const r = run();
  const { root } = mount({ run: r, expanded: false, onToggle: (x) => calls.push(x), stepLabel, fmtDuration: fmtDur });
  t$.click($(root, ".sa-head"));
  assert.deepEqual(calls, [r], "onToggle получил run");
  assert.equal($(root, ".sa-body"), null, "при expanded=false карточка не раскрылась сама");
  const { root: root2 } = mount({ run: r, expanded: true, onToggle: () => {}, stepLabel, fmtDuration: fmtDur });
  assert.ok($(root2, ".sa-body"), "expanded=true — тело сразу");
  assert.equal($(root2, ".sa-head").getAttribute("aria-expanded"), "true");
});

test("12 шагов: видно 8 и «Показать все шаги», по тапу — все 12", () => {
  // TASK-01.79: лимит 8 строк считается по строкам после группировки — шаги
  // делаем неоднотипными (read/glob вперемешку), чтобы групп не было
  const steps = Array.from({ length: 12 }, (_, i) => step(`s${i}`, i % 2 ? "glob" : "read", `f${i}.js`));
  const { root } = mount({ run: run({ state: "done", startedAt: NOW - 60_000, endedAt: NOW, now: null, steps }), stepLabel, fmtDuration: fmtDur });
  t$.click($(root, ".sa-head"));
  assert.equal($$(root, ".sa-steps li").length, 8, "не больше 8 строк");
  const more = $(root, ".sa-more");
  assert.equal(more.textContent, "Показать все шаги");
  t$.click(more);
  assert.equal($$(root, ".sa-steps li").length, 12);
  assert.equal($(root, ".sa-more"), null);
});

test("TASK-01.79: однотипные подряд сворачиваются — 12 чтений одной строкой, без «Показать все шаги»", () => {
  const steps = Array.from({ length: 12 }, (_, i) => step(`s${i}`, "read", `f${i}.js`));
  const { root } = mount({ run: run({ state: "done", startedAt: NOW - 60_000, endedAt: NOW, now: null, steps }), stepLabel: realStepLabel, fmtDuration: fmtDur });
  t$.click($(root, ".sa-head"));
  assert.equal($$(root, ".sa-steps li").length, 1, "все 12 чтений — одна строка");
  assert.equal($(root, ".sa-more"), null, "лимит считается по строкам после группировки");
  assert.match($(root, ".sa-meta").textContent, /12 шагов/, "число шагов в шапке — по исходным шагам");
});

test("TASK-01.79: группа чтения — «Прочитал a, b · ещё 3», в группе имена файлов, полный хвост у одиночной строки", () => {
  const paths = ["D:\\w\\package.json", "D:\\w\\server.js", "D:\\w\\lib\\a.js", "D:\\w\\lib\\b.js", "D:\\w\\lib\\c.js"];
  const steps = paths.map((p, i) => ({ id: `s${i}`, kind: "tool", tool: "read", object: p, status: "done" }));
  const { root } = mount({ run: run({ state: "done", startedAt: NOW - 60_000, endedAt: NOW, now: null, steps }), stepLabel: realStepLabel, fmtDuration: fmtDur });
  t$.click($(root, ".sa-head"));
  const items = $$(root, ".sa-steps li");
  assert.equal(items.length, 1, "пять чтений — одна строка");
  assert.match(items[0].textContent, /Прочитал/);
  const codes = $$(items[0], "code");
  assert.deepEqual(codes.map((c) => c.textContent), ["package.json", "server.js"], "первые два объекта — имена файлов");
  assert.match($(items[0], "small").textContent, /· ещё 3/);
  const single = [{ id: "x1", kind: "tool", tool: "read", object: "…\\dir\\a.js", status: "done" }];
  const m2 = mount({ run: run({ state: "done", startedAt: NOW - 60_000, endedAt: NOW, now: null, steps: single }), stepLabel: realStepLabel, fmtDuration: fmtDur });
  t$.click($(m2.root, ".sa-head"));
  assert.equal($$(m2.root, ".sa-steps li code")[0].textContent, "…\\dir\\a.js", "у одиночной строки полный хвост");
});

test("TASK-01.79: note шага — мелким текстом после объекта («· 214 файлов»)", () => {
  const steps = [{ id: "g1", kind: "tool", tool: "glob", object: "**/*", status: "done", note: "214 файлов" }];
  const { root } = mount({ run: run({ state: "done", startedAt: NOW - 60_000, endedAt: NOW, now: null, steps }), stepLabel: realStepLabel, fmtDuration: fmtDur });
  t$.click($(root, ".sa-head"));
  const li = $(root, ".sa-steps li");
  assert.match(li.textContent, /Список файлов/);
  assert.match($(li, "small").textContent, /· 214 файлов/);
});

test("TASK-01.79: работающий шаг не группируется с завершёнными — отдельной строкой с точкой", () => {
  const steps = [
    { id: "s1", kind: "tool", tool: "read", object: "a.js", status: "done" },
    { id: "s2", kind: "tool", tool: "read", object: "b.js", status: "done" },
    { id: "s3", kind: "tool", tool: "read", object: "c.js", status: "running" },
  ];
  const { root } = mount({ run: run({ state: "running", startedAt: NOW - 60_000, now: null, steps }), stepLabel: realStepLabel, fmtDuration: fmtDur });
  t$.click($(root, ".sa-head"));
  const items = $$(root, ".sa-steps li");
  assert.equal(items.length, 2, "группа чтений + работающий шаг");
  assert.ok(items[1].className.includes("run"), "работающий шаг с классом run");
  assert.match(items[0].textContent, /Прочитал/);
  assert.match(items[1].textContent, /Читает/);
});

test("ответ: длинный — до 6 строк и «Показать полностью», по тапу раскрывается целиком", () => {
  const output = Array.from({ length: 9 }, (_, i) => `строка ${i + 1}`).join("\n");
  const { root } = mount({ run: run({ state: "done", startedAt: NOW - 60_000, endedAt: NOW, now: null, output, steps: [] }), stepLabel, fmtDuration: fmtDur });
  t$.click($(root, ".sa-head"));
  const out = $(root, ".sa-out");
  assert.ok(out, "блок ответа");
  assert.ok(out.classList.contains("is-clamped"), "зажат до 6 строк");
  const more = $(root, ".sa-out-more");
  assert.equal(more.textContent, "Показать полностью");
  t$.click(more);
  assert.equal($(root, ".sa-out").classList.contains("is-clamped"), false);
  assert.equal($(root, ".sa-out-more"), null);
});

test("короткий ответ — без «Показать полностью»", () => {
  const { root } = mount({ run: run({ state: "done", startedAt: NOW - 60_000, endedAt: NOW, now: null, output: "каталог пуст", steps: [] }), stepLabel, fmtDuration: fmtDur });
  t$.click($(root, ".sa-head"));
  assert.ok($(root, ".sa-out"));
  assert.equal($(root, ".sa-out-more"), null);
});

test("TASK-01.79: ответ агента — markdown разметкой (strong, список), без тегов обёртки, «Показать полностью»", () => {
  const output = "<answer>\n**Жирный** и список:\n\n- один\n- два\n- три\n- четыре\n- пять\n- шесть\n- семь\n</answer>";
  const { root } = mount({ run: run({ state: "done", startedAt: NOW - 60_000, endedAt: NOW, now: null, output, steps: [] }), stepLabel, fmtDuration: fmtDur });
  t$.click($(root, ".sa-head"));
  const out = $(root, ".sa-out");
  assert.ok(out, "блок ответа");
  assert.ok($(out, ".md"), "внутри — markdown-компонент (.md)");
  assert.ok($(out, "strong"), "markdown отрендерен (<strong>)");
  assert.ok($(out, "ul li"), "список отрендерен");
  assert.equal(out.textContent.includes("<answer>"), false, "тегов обёртки на экране нет");
  assert.ok($(root, ".sa-out-more"), "длинный ответ — «Показать полностью»");
  assert.ok($(root, ".sa-out").classList.contains("is-clamped"), "зажат до 6 строк");
  t$.click($(root, ".sa-out-more"));
  assert.equal($(root, ".sa-out").classList.contains("is-clamped"), false, "кнопка раскрывает");
  assert.equal($(root, ".sa-out-more"), null);
});

test("TASK-01.79: обёртки results/files в ответе убраны, содержимое осталось", () => {
  const output = "<results>\n<files>\n- a.txt\n- b.txt\n</files>\n</results>";
  const { root } = mount({ run: run({ state: "done", startedAt: NOW - 60_000, endedAt: NOW, now: null, output, steps: [] }), stepLabel, fmtDuration: fmtDur });
  t$.click($(root, ".sa-head"));
  const out = $(root, ".sa-out");
  assert.equal(out.textContent.includes("<results>"), false, "тегов нет");
  assert.equal(out.textContent.includes("<files>"), false, "тегов нет");
  assert.match(out.textContent, /a\.txt/);
  assert.match(out.textContent, /b\.txt/);
});

// ---- «Открыть чат агента» ------------------------------------------------------

test("«Открыть чат агента»: есть при childId и onOpenChild, клик зовёт onOpenChild(run)", () => {
  const calls = [];
  const r = run();
  const { root } = mount({ run: r, onOpenChild: (x) => calls.push(x), stepLabel, fmtDuration: fmtDur });
  t$.click($(root, ".sa-head")); // ссылка живёт в раскрытом теле (кадры 2, 3)
  const link = $(root, ".sa-link");
  assert.ok(link, "кнопка в теле раскрытой карточки");
  assert.equal(link.textContent.trim(), "Открыть чат агента");
  t$.click(link);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "run1", "onOpenChild получил run");
  assert.ok(link.className.includes("sa-link"));
});

test("«Открыть чат агента» нет без childId и без onOpenChild", () => {
  const a = mount({ run: run({ childId: null }), onOpenChild: () => {}, stepLabel, fmtDuration: fmtDur });
  assert.equal($(a.root, ".sa-link"), null, "нет childId — нет кнопки");
  const b = mount({ run: run(), stepLabel, fmtDuration: fmtDur });
  assert.equal($(b.root, ".sa-link"), null, "нет onOpenChild — нет кнопки");
});

// ---- вложенность и длинные строки ---------------------------------------------

test("depth > 0 — отступ одним уровнем (is-deep), глубже не растёт", () => {
  const a = mount({ run: run({ depth: 1 }), stepLabel, fmtDuration: fmtDur });
  assert.ok($(a.root, ".sa.is-deep"), "первый уровень — отступ");
  const b = mount({ run: run({ depth: 3 }), stepLabel, fmtDuration: fmtDur });
  assert.ok($(b.root, ".sa.is-deep"));
  assert.ok(!/is-deep-2|is-deep-3/.test($(b.root, ".sa").className), "глубже одного уровня классов отступа нет");
});

test("длинные имя и задача не ломают разметку: классы обрезки на месте", () => {
  const { root } = mount({
    run: run({ agent: "agent-skills:security-auditor-с-очень-длинным-именем-агента", description: "Проверка обработчиков входа и хранения токенов на утечки и прочие длинные дела" }),
    stepLabel,
    fmtDuration: fmtDur,
  });
  assert.ok($(root, ".sa-name"), "имя — в элементе с обрезкой");
  assert.ok($(root, ".sa-task"), "задача — в элементе с многоточием");
  assert.match($(root, ".sa-head").getAttribute("aria-label"), /agent-skills:security-auditor/);
});

test("без имени и описания — «Фоновая задача»; с описанием, но без имени — «агент»", () => {
  const a = mount({ run: run({ agent: null, description: "" }), stepLabel, fmtDuration: fmtDur });
  assert.match($(a.root, ".sa-name").textContent, /Фоновая задача/);
  const b = mount({ run: run({ agent: null }), stepLabel, fmtDuration: fmtDur });
  assert.match($(b.root, ".sa-name").textContent, /^агент/);
});

// ---- совместимость со старым вызовом { part } ----------------------------------

test("старый вызов { part } (фикстура v2, opencode 2.2.6): новая вёрстка, имя/задача/итог из части", () => {
  const msg = FIXTURE.history.messages.find((m) => m.parts.some((p) => p.type === "tool" && p.tool === "subagent"));
  const part = msg.parts.find((p) => p.type === "tool" && p.tool === "subagent");
  const { root } = mount({ part });
  const card = $(root, ".sa");
  assert.ok(card, "новая вёрстка .sa");
  assert.ok(card.classList.contains("is-ok"), "completed → готов");
  assert.match($(root, ".sa-name").textContent, /explorer/);
  assert.match($(root, ".sa-task").textContent, /Список файлов в текущей папке/);
  assert.equal($(root, ".sa-head").getAttribute("aria-expanded"), "false");
  // длительность из part.time (ran→completed ≈ 15,5 с) дефолтным fmtElapsed
  assert.match($(root, ".sa-meta").textContent, /15с/);
  assert.equal($(root, ".sa-now"), null);
  t$.click($(root, ".sa-head"));
  assert.equal($(root, ".sa-head").getAttribute("aria-expanded"), "true", "раскрытие работает");
});

test("opencode 1.x: subagent_type + run_in_background — «фоном», имя из subagent_type", () => {
  const part = {
    type: "tool",
    tool: "task",
    callID: "call_legacy",
    state: { status: "running", input: { subagent_type: "librarian", run_in_background: true, description: "Устаревшие зависимости", prompt: "…" }, time: { start: NOW - 5_000, end: null } },
  };
  const { root } = mount({ part, now: NOW, fmtDuration: fmtDur });
  assert.ok($(root, ".sa.is-run"));
  assert.match($(root, ".sa-name").textContent, /librarian/);
  assert.equal($(root, ".sa-name em").textContent, "фоном", "пилюля «фоном»");
  assert.match($(root, ".sa-meta").textContent, /0:05/, "время от now пропа");
  assert.equal($(root, ".sa-link"), null, "без onOpenChild ссылки нет");
});

test("часть без агента и описания → «Фоновая задача» (как было), ошибка части → is-err и «ошибка»", () => {
  const blank = { type: "tool", tool: "task", state: { status: "completed", input: { prompt: "x" }, time: { start: NOW - 1000, end: NOW } } };
  const a = mount({ part: blank });
  assert.match($(a.root, ".sa-name").textContent, /Фоновая задача/);
  const failed = { type: "tool", tool: "task", state: { status: "error", input: { subagent_type: "fixer", description: "Тесты" }, time: { start: NOW - 9000, end: NOW } } };
  const b = mount({ part: failed });
  assert.ok($(b.root, ".sa.is-err"));
  assert.match($(b.root, ".sa-meta").textContent, /ошибка/);
});

test("repeat > 1 — значок ×N сохранён", () => {
  const part = { type: "tool", tool: "task", state: { status: "completed", input: { subagent_type: "fixer", description: "x" }, time: { start: NOW - 1000, end: NOW } } };
  const { root } = mount({ part, repeat: 3 });
  assert.match($(root, ".sa-name").textContent, /×3/);
});
