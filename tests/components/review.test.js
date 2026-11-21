// FEAT-20.1: ревью с телефона — компонентные тесты состояний макета
// (design/mockups-v2/epic20-phone-review.html): очередь «Ждёт ревью» на доске
// (T-10, T-11, фильтры, «Ещё 30»), экран ревью (T-2 файлы и «Просмотрено»,
// T-3/T-4 выбор строки и диапазона, 200 строк, граница свёрнутого, T-5 черновик
// на сервере, T-6 «Вернуть агенту» один запрос с ключом, T-9 «Принять» и
// «Уже принято», T-13 «Агент работает», T-14 «Файлы изменились», T-16 огромный,
// T-17 двоичный, T-24 чужое), плашка и пузырь ревью в чате, карточка плана
// (одно одобрение), выбор строк — чистые функции.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    ReviewView: "src/components/views/ReviewView.jsx",
    ReviewQueue: "src/components/views/ReviewQueue.jsx",
    ReviewPlaque: "src/components/chat/ChatReview.jsx#ReviewPlaque",
    ReviewBubble: "src/components/chat/ChatReview.jsx#ReviewBubble",
    PlanCards: "src/components/chat/ChatReview.jsx#PlanCards",
    chatReviews: "src/components/chat/ChatReview.jsx#chatReviews",
    lineRows: "src/lib/review-client.js#lineRows",
    selectLines: "src/lib/review-client.js#selectLines",
    selectionComment: "src/lib/review-client.js#selectionComment",
    anchorRow: "src/lib/review-client.js#anchorRow",
    hunksOfPatch: "src/lib/review-client.js#hunksOfPatch",
    filterQueue: "src/components/views/ReviewQueue.jsx#filterQueue",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.me.value = null;
  ui.chatReviews.value = {};
  try { sessionStorage.clear(); localStorage.clear(); } catch {}
  installFetch();
});

const ID = "rv_AAAAAAAAAAAA";
const PATCH = "diff --git a/auth.js b/auth.js\n--- a/auth.js\n+++ b/auth.js\n@@ -40,6 +40,8 @@\n ctx40\n ctx41\n-old42\n+new42\n+new43\n+new44\n ctx43\n ctx44\n@@ -180,3 +182,3 @@\n c180\n-o181\n+n183\n";
const detail = (over = {}) => ({
  id: ID, key: `review:${ID}`, sid: "ses_1", title: "Токен обновления", status: "waiting", needsYou: true, state: "pending", revision: 2, turns: 2, files: 3,
  additions: 5, deletions: 2, drafts: 0, mode: "snapshot", modeReason: null, busy: false, stale: null, model: "claude-opus-5-5", engine: "claude",
  fileList: [
    { path: "src/auth.js", status: "M", additions: 3, deletions: 1, reviewed: true },
    { path: "assets/logo.png", status: "M", additions: 0, deletions: 0, binary: true, reviewed: false },
    { path: "dist/bundle.js", status: "M", additions: 24000, deletions: 10, reviewed: false },
  ],
  comments: [], sends: [], sinceRevision: null, sinceFiles: null, accept: null, revisions: [], ...over,
});
function routes(d, extra = []) {
  installFetch([
    ...extra,
    { method: "GET", path: `/teleharness/api/review/${ID}`, reply: () => d },
    { method: "GET", path: `/teleharness/api/review/${ID}/diff`, reply: (c) => (c.query.file === "assets/logo.png" ? { file: c.query.file, binary: true, patch: "", huge: false } : c.query.file === "dist/bundle.js" ? { file: c.query.file, huge: true, patch: "", additions: 24000, deletions: 10 } : { file: c.query.file, patch: PATCH, additions: 4, deletions: 2, mode: "snapshot" }) },
    { method: "POST", path: `/teleharness/api/review/${ID}/viewed`, reply: () => ({ ok: true }) },
    { method: "PUT", path: /\/comments\//, reply: (c) => ({ comment: { ...c.body, id: c.path.split("/").pop(), state: "draft", version: (c.body.version ?? 0) + 1, updatedAt: Date.now() }, drafts: 1 }) },
  ]);
}
async function mountReview(d = detail(), extra = []) {
  routes(d, extra);
  ui.store.me.value = { id: "u1", role: "admin" };
  const h = t$.mount(ui.ReviewView, { id: ID });
  await t$.waitFor(() => $(h.root, ".rv-file-list"));
  return h;
}
const openFile = async (root, name) => {
  const b = $$(root, ".rv-file").find((x) => x.textContent.includes(name));
  t$.click(b);
  await t$.waitFor(() => $(root, ".rv-diff") || $(root, ".rv-note"));
};
const lineBtn = (root, no, t = null) => $$(root, ".rv-line").find((b) => $(b, ".rv-no").textContent === String(no) && (!t || b.classList.contains("is-" + t)));

test("T-2, кр. 2: файлы — буква и слово статуса, +/−, «просмотрено» галочкой, «Просмотрено 1 из 3»", async () => {
  const { root } = await mountReview();
  assert.match($(root, ".rv-summary").textContent, /Просмотрено 1 из 3/);
  const rows = $$(root, ".rv-file");
  assert.equal(rows.length, 3);
  assert.equal($(rows[0], ".rv-letter").textContent, "M");
  assert.match($(rows[0], ".rv-file-dir").textContent, /src\s· изменён/);
  assert.equal($(rows[0], ".rv-check").getAttribute("aria-label"), "просмотрено");
  assert.equal($(rows[1], ".rv-check").getAttribute("aria-label"), "не просмотрено");
  // BUG-277: ревизия/ходы/файлы — в сводке, подзаголовок шапки — название чата
  assert.match($(root, ".rv-facts").textContent, /ревизия 2 · 2 хода · 3 файла/);
  assert.doesNotMatch($(root, ".rv-sub").textContent, /ревизия/);
  assert.equal($(root, ".rv-bar .bd-btn").textContent, "Вернуть агенту · 0");
});

test("кр. 2: файл открывается одним тапом и отмечается просмотренным; «Следующий файл ›»", async () => {
  const { root } = await mountReview();
  await openFile(root, "logo.png");
  await t$.waitFor(() => fetchCalls.some((c) => c.method === "POST" && c.path.endsWith("/viewed") && c.body.file === "assets/logo.png"));
  assert.ok($(root, ".rv-next"));
});

test("T-3/T-4, кр. 3, P-3/P-4: тап по строке — выбор, тап по второй — диапазон; кнопки строк для VoiceOver", async () => {
  const { root } = await mountReview();
  await openFile(root, "auth.js");
  const l42 = lineBtn(root, 42, "add");
  assert.equal(l42.getAttribute("aria-label"), "Строка 42, добавлена");
  t$.click(l42);
  assert.match($(root, ".rv-pill-label").textContent, /Строка 42 · 1 строка · добавлена/);
  t$.click(lineBtn(root, 44, "add"));
  assert.match($(root, ".rv-pill-label").textContent, /Строки 42–44 · 3 строки/);
  assert.equal($$(root, ".rv-line.is-on").length, 3);
  // ▼ — продлить на строку
  t$.click($$(root, ".rv-pill-btn").find((b) => b.getAttribute("aria-label") === "Расширить вниз"));
  assert.match($(root, ".rv-pill-label").textContent, /Строки 42–45/);
});

test("N-13: выделение не идёт через свёрнутый участок — «Разверните, чтобы выделить»", async () => {
  const { root } = await mountReview();
  await openFile(root, "auth.js");
  t$.click(lineBtn(root, 44, "add"));
  t$.click(lineBtn(root, 183, "add"));
  assert.equal($(root, ".rv-pill-label").textContent, "Разверните, чтобы выделить");
  assert.ok($$(root, ".rv-line.is-on").every((b) => Number($(b, ".rv-no").textContent) < 100));
});

// BUG-271 (BUG-20.9): сброс выбора строк при новом диффе шёл отложенным эффектом
// (useEffect → кадр/таймер preact); под нагрузкой он срабатывал ПОСЛЕ первого тапа
// и стирал выбор — второй тап давал «Строка 183» вместо диапазона/подсказки.
test("BUG-271: выбор строки, сделанный сразу после загрузки диффа, не стирается отложенным сбросом", async () => {
  for (let round = 0; round < 3; round += 1) {
    const { root } = await mountReview();
    await openFile(root, "auth.js");
    t$.click(lineBtn(root, 44, "add")); // сразу, до кадра/таймера отложенных эффектов
    await new Promise((r) => setTimeout(r, 150)); // кадр (rAF) и запасной таймер эффектов прошли
    await t$.flush();
    assert.match($(root, ".rv-pill-label")?.textContent ?? "(нет выбора)", /Строка 44 · 1 строка/, `раунд ${round}: выбор цел`);
    t$.click(lineBtn(root, 183, "add"));
    assert.equal($(root, ".rv-pill-label").textContent, "Разверните, чтобы выделить");
    t$.cleanup();
  }
});

test("N-15: удалённая строка — сторона «было», подпись «Удалённая строка»", async () => {
  const { root } = await mountReview();
  await openFile(root, "auth.js");
  t$.click(lineBtn(root, 42, "del"));
  assert.match($(root, ".rv-pill-label").textContent, /^Удалённая строка 42/);
});

test("T-4/T-5, кр. 5: комментарий — лист с цитатой, черновик на сервере, карточка под строкой", async () => {
  const { root } = await mountReview();
  await openFile(root, "auth.js");
  t$.click(lineBtn(root, 42, "add"));
  t$.click(lineBtn(root, 43, "add"));
  t$.click($(root, ".rv-pill-go"));
  await t$.flush();
  assert.match(document.querySelector(".rv-sheet h2").textContent, /строки 42–43/);
  assert.equal(document.querySelector(".rv-quote").textContent, "new42\nnew43");
  t$.typeInto(document.querySelector(".rv-textarea"), "Проверь срок");
  assert.ok(Object.keys(JSON.parse(localStorage.getItem(`teleharness.review.u1.${ID}`))).length === 1, "локально сразу");
  t$.click([...document.querySelectorAll(".rv-sheet .bd-btn")].find((b) => b.textContent === "Добавить"));
  await t$.waitFor(() => fetchCalls.some((c) => c.method === "PUT"));
  const put = fetchCalls.find((c) => c.method === "PUT");
  assert.deepEqual([put.body.side, put.body.from, put.body.to, put.body.file, put.body.text], ["new", 42, 43, "src/auth.js", "Проверь срок"]);
  await t$.waitFor(() => $(root, ".rv-comment"));
  assert.match($(root, ".rv-comment").textContent, /Строки 42–43.*Черновик.*Проверь срок/);
});

test("T-16/T-17, кр. 15, N-12/N-14: двоичный — без строк; огромный — «Скачать патч»; у обоих «＋ Комментарий к файлу»", async () => {
  const { root } = await mountReview();
  await openFile(root, "logo.png");
  await t$.waitFor(() => $(root, ".rv-note"));
  assert.match($(root, ".rv-note").textContent, /Двоичный файл/);
  assert.equal($$(root, ".rv-line").length, 0);
  assert.ok($$(root, ".bd-btn").some((b) => b.textContent === "＋ Комментарий к файлу"));
  t$.cleanup();
  const r2 = (await mountReview()).root;
  await openFile(r2, "bundle.js");
  await t$.waitFor(() => $(r2, ".rv-note a"));
  assert.equal($(r2, ".rv-note a").textContent, "Скачать патч");
  assert.match($(r2, ".rv-note a").getAttribute("href"), /raw=1/);
});

test("T-13, кр. 10: агент работает — «Принять» недоступна с причиной, комментарии можно", async () => {
  const { root } = await mountReview(detail({ busy: true }));
  assert.equal($(root, ".rv-bar .bd-primary").getAttribute("aria-disabled"), "true");
  assert.equal($(root, ".rv-bar-why").textContent, "Агент работает — дождитесь конца хода");
  assert.ok($$(root, ".bd-btn").some((b) => b.textContent === "＋ Общий комментарий"));
});

test("T-14, кр. 9: файлы изменились — баннер «Обновить до ревизии 3», принять нельзя", async () => {
  const { root } = await mountReview(detail({ stale: { revision: 3, files: 1, changedFiles: ["src/auth.js"] } }));
  assert.ok($$(root, ".bd-banner button").some((b) => b.textContent === "Обновить до ревизии 3"));
  assert.match($(root, ".rv-bar-why").textContent, /обновите до ревизии 3/);
});

test("T-6, кр. 6, N-5: «Вернуть агенту» — превью, один запрос с ключом; повтор после обрыва — тот же ключ", async () => {
  const d = detail({ comments: [{ id: "c_x1", side: "new", file: "src/auth.js", from: 42, to: 42, quote: ["new42"], text: "Почему?", state: "draft", version: 1, revision: 2 }], drafts: 1 });
  let fail = true;
  const { root } = await mountReview(d, [
    { method: "POST", path: `/teleharness/api/review/${ID}/preview`, reply: () => ({ text: "## Ревью · 1 комментарий к 1 файлу (ревизия 2)\n\nтекст\n<!-- teleharness-review:rv_AAAAAAAAAAAA:r2 -->", count: 1, busy: true, shortened: false }) },
    { method: "POST", path: `/teleharness/api/review/${ID}/send`, reply: () => (fail ? "network" : { already: false, count: 1, at: Date.now() }) },
  ]);
  installFetch([
    { method: "POST", path: `/teleharness/api/review/${ID}/preview`, reply: () => ({ text: "## Ревью · 1 комментарий к 1 файлу (ревизия 2)\n\nтекст\n<!-- teleharness-review:rv_AAAAAAAAAAAA:r2 -->", count: 1, busy: true, shortened: false }) },
    { method: "POST", path: `/teleharness/api/review/${ID}/send`, reply: "network" },
    { method: "GET", path: `/teleharness/api/review/${ID}`, reply: () => d },
  ]);
  const back = $(root, ".rv-bar .bd-btn");
  assert.equal(back.textContent, "Вернуть агенту · 1");
  t$.click(back);
  await t$.waitFor(() => document.querySelector(".rv-preview"));
  assert.ok(!document.querySelector(".rv-preview").textContent.includes("teleharness-review"), "служебный маркер не показан");
  assert.match(document.querySelector(".rv-sheet").textContent, /встанет в очередь и уйдёт после текущего хода/);
  const go = () => [...document.querySelectorAll(".rv-sheet .bd-primary")][0];
  t$.click(go());
  await t$.waitFor(() => document.querySelector(".rv-sheet .rv-error"));
  assert.match(document.querySelector(".rv-sheet .rv-error").textContent, /Не отправлено — нет связи/);
  const k1 = fetchCalls.find((c) => c.path.endsWith("/send")).body.key;
  installFetch([
    { method: "POST", path: `/teleharness/api/review/${ID}/send`, reply: () => ({ already: false, count: 1, at: Date.now() }) },
    { method: "GET", path: `/teleharness/api/review/${ID}`, reply: () => d },
  ]);
  assert.equal(go().textContent, "Повторить отправку");
  t$.click(go());
  await t$.waitFor(() => fetchCalls.some((c) => c.path.endsWith("/send")));
  assert.equal(fetchCalls.find((c) => c.path.endsWith("/send")).body.key, k1, "тот же ключ — сервер не задвоит");
  void fail;
});

test("T-9, кр. 8, N-3: «Принять» — предупреждение о непросмотренных; 409 already — «Уже принято на другом устройстве в …»", async () => {
  const at = new Date(2026, 10, 20, 14, 32).getTime();
  const { root } = await mountReview(detail(), [{ method: "POST", path: `/teleharness/api/review/${ID}/accept`, reply: () => ({ status: 409, body: { error: "Уже принято", code: "already", state: "accepted", at } }) }]);
  t$.click($(root, ".rv-bar .bd-primary"));
  await t$.flush();
  assert.match(document.querySelector(".rv-sheet").textContent, /2 файла вы не открывали/);
  const btns = [...document.querySelectorAll(".rv-sheet .bd-btn")].map((b) => b.textContent);
  assert.deepEqual(btns, ["Принять и закоммитить", "Принять", "Отмена"]);
  t$.click([...document.querySelectorAll(".rv-sheet .bd-btn")].find((b) => b.textContent === "Принять"));
  await t$.waitFor(() => document.querySelector(".rv-sheet .rv-error"));
  assert.equal(document.querySelector(".rv-sheet .rv-error").textContent, "Уже принято на другом устройстве в 14:32");
});

test("кр. 8: «Принять и закоммитить» передаёт Git ровно файлы пункта", async () => {
  const { root } = await mountReview(detail(), [{ method: "POST", path: `/teleharness/api/review/${ID}/accept`, reply: () => ({ ok: true, at: 1, files: ["src/auth.js", "assets/logo.png"] }) }]);
  t$.click($(root, ".rv-bar .bd-primary"));
  await t$.flush();
  t$.click([...document.querySelectorAll(".rv-sheet .bd-btn")].find((b) => b.textContent === "Принять и закоммитить"));
  await t$.waitFor(() => sessionStorage.getItem("teleharness.git.review-select.ses_1"));
  assert.deepEqual(JSON.parse(sessionStorage.getItem("teleharness.git.review-select.ses_1")), ["src/auth.js", "assets/logo.png"]);
  assert.equal(location.hash, "#/git/ses_1");
});

test("T-24, кр. 16, N-20: чужое или несуществующее — «Ревью недоступно» без названия", async () => {
  installFetch([{ method: "GET", path: `/teleharness/api/review/${ID}`, reply: () => ({ status: 404, body: { error: "Ревью недоступно" } }) }]);
  const { root } = t$.mount(ui.ReviewView, { id: ID });
  await t$.waitFor(() => $(root, ".bd-gone h2"));
  assert.equal($(root, ".bd-gone h2").textContent, "Ревью недоступно");
});

test("T-8, кр. 7: ревизия 2 — «С прошлого ревью · N / Всё», комментарий с отметкой «строки изменились»", async () => {
  const d = detail({ sinceRevision: 1, sinceFiles: ["src/auth.js"], comments: [{ id: "c_s1", side: "new", file: "src/auth.js", from: 42, to: 42, quote: [], text: "x", state: "sent", sentIn: 1, outcome: "changed", revision: 1, version: 1 }] });
  const { root } = await mountReview(d);
  const seg = $$(root, ".rv-seg button").map((b) => b.textContent);
  assert.deepEqual(seg, ["С прошлого ревью · 1", "Всё · 3"]);
  t$.click($$(root, ".rv-seg button")[0]);
  assert.equal($$(root, ".rv-file").length, 1);
  await openFile(root, "auth.js");
  await t$.waitFor(() => fetchCalls.some((c) => c.path.endsWith("/diff") && c.query.since === "1"));
  await t$.waitFor(() => $(root, ".rv-comment.is-sent"));
  assert.match($(root, ".rv-comment.is-sent").textContent, /строки изменились/);
});

const S = (id, over = {}) => ({ id, key: `review:${id}`, source: "chat", title: "Чат " + id, project: { name: "zai" }, status: "waiting", needsYou: true, revision: 1, turns: 1, files: 2, additions: 3, deletions: 1, drafts: 0, since: 1000, href: `#/review/${id}`, ...over });

test("T-10, кр. 11, P-10: «Ждёт ревью» — самые давние первыми, фильтры «Все / Чаты / Пайпы / Агент правит», «Ещё 30»", async () => {
  const list = [S("rv_b", { since: 2000 }), S("rv_a", { since: 1000, drafts: 3 }), S("rv_p", { source: "run", since: 3000 }), S("rv_r", { status: "returned", needsYou: false, since: 500 })];
  const { root } = t$.mount(ui.ReviewQueue, { reviews: list, now: 10_000 });
  assert.deepEqual($$(root, ".rq-item").map((a) => a.getAttribute("href")), ["#/review/rv_r", "#/review/rv_a", "#/review/rv_b", "#/review/rv_p"]);
  assert.deepEqual($$(root, ".rq-filters button").map((b) => b.textContent), ["Все · 4", "Чаты · 3", "Пайпы · 1", "Агент правит · 1"]);
  assert.match($(root, '[data-key="review:rv_a"]').textContent, /3 комментария в черновике/);
  assert.match($(root, '[data-key="review:rv_r"] .rv-chip').textContent, /Агент правит/);
  t$.click($$(root, ".rq-filters button")[2]);
  assert.equal($$(root, ".rq-item").length, 1);
  t$.cleanup();
  const many = Array.from({ length: 45 }, (_, i) => S("rv_" + i, { since: i }));
  const r2 = t$.mount(ui.ReviewQueue, { reviews: many }).root;
  assert.equal($$(r2, ".rq-item").length, 30);
  const more = $$(r2, ".bd-btn").find((b) => b.textContent.startsWith("Ещё"));
  assert.equal(more.textContent, "Ещё 15");
  t$.click(more);
  assert.equal($$(r2, ".rq-item").length, 45);
});

test("BUG-277: карточка «Ждёт ревью» — модель человеческим именем, проект копии — репозиторий, статус компактной пилюлей", () => {
  const list = [
    S("rv_m", { model: "claude-sonnet-5-5", project: { name: "v-fayle-src-orders-js-dobav-meis", dir: "/p/.teleharness-worktrees/shop/v-fayle-src-orders-js-dobav-meis" } }),
    S("rv_g", { model: "gpt-6.1-sol", since: 2000 }),
  ];
  const { root } = t$.mount(ui.ReviewQueue, { reviews: list, now: 10_000 });
  const m = $(root, '[data-key="review:rv_m"]').textContent;
  assert.match(m, /Claude Sonnet 5\.5/);
  assert.match(m, /Чат · shop/);
  assert.doesNotMatch(m, /v-fayle|Claude sonnet/);
  assert.match($(root, '[data-key="review:rv_g"]').textContent, /GPT-6\.1-Sol/);
  const css = readFileSync(new URL("../../src/components/review.css", import.meta.url), "utf8");
  assert.match(css, /\.rq-item \.rv-chip \{ align-self: flex-start;/);
});

test("T-11, N-31: пусто — «Нечего проверять» с пояснением; T-12 нет связи — данные на время", () => {
  const { root } = t$.mount(ui.ReviewQueue, { reviews: [], offline: true, at: new Date(2026, 10, 20, 14, 32).getTime() });
  assert.equal($(root, ".bd-empty h2").textContent, "Нечего проверять");
  assert.match($(root, ".bd-banner").textContent, /данные на 14:32/);
});

test("T-1, кр. 1: плашка «Ждёт ревью · Проверить» под ответом ведёт на экран ревью", async () => {
  installFetch([{ method: "GET", path: "/teleharness/api/review/chat/ses_1", reply: () => ({ review: S(ID, { files: 4 }), plans: [], sends: [] }) }]);
  const { root } = t$.mount(ui.ReviewPlaque, { sid: "ses_1" });
  await t$.waitFor(() => $(root, ".rv-plaque"));
  assert.match($(root, ".rv-plaque").textContent, /Ждёт ревью · 4 файла/);
  assert.equal($(root, ".rv-plaque a").getAttribute("href"), `#/review/${ID}`);
  assert.equal($(root, ".rv-plaque a").textContent, "Проверить");
});

test("T-7, кр. 6: сообщение ревью в ленте — свёрнуто «Ревью · 3 комментария к 2 файлам»", () => {
  const text = "## Ревью · 3 комментария к 2 файлам (ревизия 2)\n\n### a.js\nтекст\n\n<!-- teleharness-review:rv_AAAAAAAAAAAA:r2 -->";
  const { root } = t$.mount(ui.ReviewBubble, { text });
  assert.equal($(root, "summary").textContent, "💬 Ревью · 3 комментария к 2 файлам · ревизия 2");
  assert.ok(!$(root, ".rv-bubble-body").textContent.includes("teleharness-review"));
});

test("T-20, кр. 13, N-25: карточка плана — «Одобрить и выполнить» двойным тапом — один ключ; 409 — «Решение уже принято»", async () => {
  const plan = { id: "pl_AAAAAAAAAAAA", sid: "ses_1", n: 1, turn: "m9", engine: "claude", model: "claude-opus-5-5", text: "1. Сделать X\n2. Тест", state: "waiting", createdAt: 1 };
  let calls = 0;
  installFetch([
    { method: "GET", path: "/teleharness/api/review/chat/ses_1", reply: () => ({ review: null, plans: [plan], sends: [] }) },
    { method: "POST", path: /\/plan\/pl_AAAAAAAAAAAA\/approve$/, reply: () => { calls += 1; return { status: 409, body: { error: "Решение уже принято", state: "approved", decidedAt: new Date(2026, 10, 20, 14, 40).getTime() } }; } },
  ]);
  const { root } = t$.mount(ui.PlanCards, { sid: "ses_1", turnLast: "m9", isLastTurn: true, feedIds: new Set(["m9"]), chatModel: "gpt-6.1-sol" });
  await t$.waitFor(() => $(root, ".pl-card"));
  assert.match($(root, ".pl-card h3").textContent, /План 1.*Ждёт одобрения · только чтение/);
  assert.match($(root, ".pl-card").textContent, /План составил Claude opus 5.5|План составил Claude/);
  assert.deepEqual($$(root, ".pl-actions .bd-btn").map((b) => b.textContent), ["Одобрить и выполнить", "Править", "Переделать", "Отклонить"]);
  const ok = $$(root, ".pl-actions .bd-btn")[0];
  t$.click(ok);
  t$.click(ok);
  await t$.waitFor(() => $(root, ".rv-error"));
  assert.equal(calls, 1, "двойной тап — один запрос");
  assert.equal($(root, ".rv-error").textContent, "Решение уже принято: Одобрено в 14:40");
});

test("выбор строк — чистые правила: одна сторона, ≤ 200 строк, якорь карточки без номеров по тексту (N-17, N-18)", () => {
  const big = { oldStart: 1, oldLines: 0, newStart: 1, newLines: 300, lines: Array.from({ length: 300 }, (_, i) => ({ t: "+", text: "l" + i, o: null, n: i + 1 })) };
  const rows = ui.lineRows([big]);
  const r = ui.selectLines(rows, 0, 259);
  assert.equal(r.error, "Не больше 200 строк в одном комментарии");
  assert.equal(r.to - r.from + 1, 200);
  const sc = ui.selectionComment(rows, { anchor: 0, from: 0, to: 4 });
  assert.deepEqual([sc.side, sc.from, sc.to, sc.count], ["new", 1, 5, 5]);
  const frag = ui.lineRows([{ oldStart: null, newStart: null, lines: [{ t: "-", text: "a = 1", o: null, n: null }, { t: "+", text: "a = 2", o: null, n: null }] }]);
  assert.equal(ui.anchorRow(frag, { side: "new", from: null, quote: ["a = 2"] }), 1);
});

test("BUG (dogfood 20.1): автосохранение черновика и «Добавить» не дают ложного «изменён на другом устройстве»", async () => {
  let ver = 0;
  const puts = [];
  const { root } = await mountReview(detail(), [
    { method: "PUT", path: /\/comments\//, reply: async (c) => {
      puts.push(c.body.version);
      await new Promise((r) => setTimeout(r, 300)); // медленная сеть: автосохранение ещё в пути
      if ((c.body.version ?? 0) !== ver) return { status: 409, body: { error: "Комментарий изменён на другом устройстве", code: "version", current: { id: "c", text: "другое", version: ver } } };
      ver += 1;
      return { comment: { ...c.body, id: c.path.split("/").pop(), state: "draft", version: ver }, drafts: 1 };
    } },
  ]);
  await openFile(root, "logo.png");
  const fileBtn = () => [...root.querySelectorAll(".bd-btn")].find((b) => b.textContent === "＋ Комментарий к файлу");
  await t$.waitFor(() => fileBtn());
  t$.click(fileBtn());
  await t$.flush();
  t$.typeInto(document.querySelector(".rv-textarea"), "первый");
  await new Promise((r) => setTimeout(r, 1250)); // автосохранение ушло и ещё не вернулось
  t$.typeInto(document.querySelector(".rv-textarea"), "первый и второй");
  t$.click([...document.querySelectorAll(".rv-sheet .bd-btn")].find((b) => b.textContent === "Добавить"));
  for (let i = 0; i < 100 && (puts.length < 2 || document.querySelector(".rv-sheet")); i++) await t$.waitFor(() => true).then(() => new Promise((r) => setTimeout(r, 20)));
  assert.deepEqual(puts, [0, 1], "второе сохранение — с версией после первого");
  assert.equal(document.querySelector(".rv-sheet"), null, "листа конфликта нет");
});
