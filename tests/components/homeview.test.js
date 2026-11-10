// C3 HomeView (L2, TASK-14.7): строка чата со свайпом (пороги, тап-закрытие),
// действия по фокусу клавиатуры (BUG-014), rename без «New session - ISO»
// (BUG-015), подтверждение удаления без сырого заголовка (BUG-01.41),
// «Ничего не найдено».
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    HomeView: "src/components/views/HomeView.jsx",
    SessionRow: "src/components/views/HomeView.jsx#SessionRow",
    RenameModal: "src/components/views/HomeView.jsx#RenameModal",
    DeleteModal: "src/components/views/HomeView.jsx#DeleteModal",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.sessions.value = [];
  installFetch();
});

const NOW = Date.now();
const ses = (id, title, extra = {}) => ({ id, title, directory: "C:\\Users\\USER", time: { created: NOW, updated: NOW }, ...extra });

// Ряд с управляемым open (как в HomeView: open = id открытой строки).
function mountRow(session, { open = false } = {}) {
  const log = { open: [], rename: [], del: [] };
  const props = {
    session,
    open,
    onOpen: (id) => log.open.push(id),
    onRename: (s) => log.rename.push(s.id),
    onDelete: (s) => log.del.push(s.id),
  };
  const h = t$.mount(ui.SessionRow, props);
  return { ...h, log, content: () => $(h.root, ".swipe-content") };
}

// Свайп: touchstart → touchmove(ы) → touchend; Date.now управляется mock.timers,
// чтобы «быстрый» флик (< 250 мс) и обычный жест различались детерминированно.
function swipe(t, el, dxs, { ms = 400 } = {}) {
  t$.touch(el, "touchstart", 300, 100);
  for (const dx of dxs) t$.touch(el, "touchmove", 300 + dx, 100);
  t.mock.timers.tick(ms);
  t$.touch(el, "touchend", 300 + dxs.at(-1), 100);
}

test("медленный свайп меньше половины ширины действий — строка не открывается", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const r = mountRow(ses("ses_a", "Отчёт"));
  swipe(t, r.content(), [-10, -30, -50]);
  assert.deepEqual(r.log.open, [null]);
});

test("свайп дальше порога — строка открывается", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const r = mountRow(ses("ses_a", "Отчёт"));
  swipe(t, r.content(), [-20, -120, -160]);
  assert.deepEqual(r.log.open, ["ses_a"]);
});

test("быстрый короткий флик (< 250 мс, > 24 px) — открывает", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const r = mountRow(ses("ses_a", "Отчёт"));
  swipe(t, r.content(), [-12, -30], { ms: 100 });
  assert.deepEqual(r.log.open, ["ses_a"]);
});

test("вертикальный жест — это прокрутка, строка не трогается", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const r = mountRow(ses("ses_a", "Отчёт"));
  t$.touch(r.content(), "touchstart", 300, 100);
  t$.touch(r.content(), "touchmove", 295, 160);
  t$.touch(r.content(), "touchend", 295, 160);
  assert.deepEqual(r.log.open, []);
});

test("тап по открытой строке закрывает её и не уводит в чат", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  t.mock.timers.tick(10_000); // клик не «сразу после жеста»
  const r = mountRow(ses("ses_a", "Отчёт"), { open: true });
  assert.equal(r.root.querySelector(".swipe").classList.contains("is-open"), true);
  const notPrevented = t$.click(r.content());
  assert.equal(notPrevented, false, "переход по ссылке отменён");
  assert.deepEqual(r.log.open, [null]);
});

test("клик сразу после жеста проглатывается (не открывает чат)", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const r = mountRow(ses("ses_a", "Отчёт"));
  swipe(t, r.content(), [-20, -120, -160]);
  const notPrevented = t$.click(r.content());
  assert.equal(notPrevented, false);
});

test("действия строки — кнопки с понятными aria-label, доступны с клавиатуры (BUG-014)", () => {
  const r = mountRow(ses("ses_a", "Отчёт"));
  const btns = $$(r.root, ".swipe-actions button.swipe-action");
  assert.deepEqual(btns.map((b) => b.getAttribute("aria-label")), ["Переименовать чат «Отчёт»", "Удалить чат «Отчёт»"]);
  assert.equal(btns.every((b) => b.tabIndex !== -1), true, "не выключены из Tab-порядка");
  t$.click(btns[0]);
  t$.click(btns[1]);
  assert.deepEqual(r.log.rename, ["ses_a"]);
  assert.deepEqual(r.log.del, ["ses_a"]);
});

test("rename: «New session - ISO» не подставляется в поле (BUG-015); обычный заголовок — подставляется", () => {
  const saved = [];
  const a = t$.mount(ui.RenameModal, { session: ses("s1", "New session - 2026-11-02T10:00:00.000Z"), onSave: (x) => saved.push(x), onClose() {} });
  assert.equal($(a.root, ".modal-input").value, "");
  assert.equal($(a.root, ".btn-primary").disabled, true, "пустое имя не сохранить");
  a.unmount();
  const b = t$.mount(ui.RenameModal, { session: ses("s2", "Отчёт за квартал"), onSave: (x) => saved.push(x), onClose() {} });
  assert.equal($(b.root, ".modal-input").value, "Отчёт за квартал");
  t$.typeInto($(b.root, ".modal-input"), "  Новый  ");
  t$.click($(b.root, ".btn-primary"));
  assert.deepEqual(saved, ["Новый"]);
});

test("delete-модалка: нет сырого «New session - ISO», текст про историю", () => {
  const d = t$.mount(ui.DeleteModal, { session: ses("s1", "New session - 2026-11-02T10:00:00.000Z"), onConfirm() {}, onClose() {} });
  const text = $(d.root, ".modal-text").textContent;
  assert.equal(text.includes("New session"), false, text);
  assert.match(text, /будет удалён вместе с историей/);
});

test("HomeView: поиск без совпадений → «Ничего не найдено по «…»»", async () => {
  installFetch([{ method: "GET", path: "/zai/api/session", reply: () => [ses("ses_a", "Отчёт"), ses("ses_b", "Задача")] }]);
  ui.store.sessions.value = [ses("ses_a", "Отчёт"), ses("ses_b", "Задача")];
  const { root } = t$.mount(ui.HomeView);
  await t$.waitFor(() => $$(root, ".swipe").length >= 2);
  t$.typeInto($(root, ".home-search"), "zzz-нет-такого");
  const empty = await t$.waitFor(() => [...root.querySelectorAll("*")].find((el) => /^Ничего не найдено по «zzz-нет-такого»/.test(el.textContent.trim()) && el.children.length <= 2));
  assert.equal(!!empty, true);
  assert.equal($$(root, ".swipe").length, 0);
});

test("rename: сбой сохранения — модалка остаётся открытой, введённое имя и ошибка внутри (ISSUE-007)", async () => {
  let closed = 0;
  const calls = [];
  const m = t$.mount(ui.RenameModal, {
    session: ses("s3", "Старое"),
    onSave: async (x) => {
      calls.push(x);
      return calls.length === 1 ? "Не удалось переименовать чат — сервер недоступен." : null;
    },
    onClose: () => closed++,
  });
  t$.typeInto($(m.root, ".modal-input"), "Новое имя");
  t$.click($(m.root, ".btn-primary"));
  const err = await t$.waitFor(() => $(m.root, ".modal-error"));
  assert.match(err.textContent, /Не удалось переименовать чат/);
  assert.equal(err.getAttribute("role"), "alert");
  assert.equal($(m.root, ".modal-input").value, "Новое имя", "введённое имя не потеряно");
  assert.equal($(m.root, ".modal-input").getAttribute("aria-invalid"), "true");
  assert.equal(closed, 0, "модалка не закрылась");
  t$.click($(m.root, ".btn-primary"));
  await t$.waitFor(() => !$(m.root, ".modal-error"));
  assert.deepEqual(calls, ["Новое имя", "Новое имя"]);
});

test("HomeView: сбой переименования — ошибка в модалке, глобальный notice не появляется (ISSUE-007)", async () => {
  installFetch([
    { method: "GET", path: "/zai/api/session", reply: () => [ses("ses_a", "Отчёт")] },
    { method: "PATCH", path: "/zai/api/session/ses_a", reply: () => ({ status: 502, body: { error: "upstream" } }) },
  ]);
  ui.store.sessions.value = [ses("ses_a", "Отчёт")];
  ui.store.notice.value = null;
  const { root } = t$.mount(ui.HomeView);
  await t$.waitFor(() => $$(root, ".swipe").length >= 1);
  const renameBtn = await t$.waitFor(() => $$(root, "button").find((b) => /^Переименовать чат/.test(b.getAttribute("aria-label") ?? "")));
  t$.click(renameBtn);
  const input = await t$.waitFor(() => $(root, ".modal-input"));
  t$.typeInto(input, "Квартальный отчёт");
  t$.click($(root, ".modal .btn-primary") ?? $$(root, ".btn-primary").find((b) => /Сохранить/.test(b.textContent)));
  const err = await t$.waitFor(() => $(root, ".modal-error"));
  assert.match(err.textContent, /переименовать/i);
  assert.equal($(root, ".modal-input").value, "Квартальный отчёт");
  assert.equal(ui.store.notice.value, null, "notice не дублирует ошибку поверх «Чаты»");
  assert.equal(ui.store.sessions.value.find((s) => s.id === "ses_a").title, "Отчёт", "откат имени в списке");
});

test("BUG-154: «работает» и «⏸ разрешение» — в строке под заголовком, справа остаётся только бейдж движка", () => {
  const s = ses("ses_busy154", "Проверка задач и деплой на прод", { zai: { engine: "claude", model: { providerID: "anthropic", modelID: "claude-opus-5-5" } } });
  ui.store.busyMap.value = { ses_busy154: { type: "busy" } };
  try {
    const { root } = mountRow(s);
    const badge = $(root, ".badge-busy");
    assert.ok(badge, "пометка «работает» есть");
    assert.ok(badge.closest(".session-main"), "пометка внутри колонки заголовка, не отдельной колонкой справа");
    assert.ok($(root, ".badge-engine"), "бейдж движка на месте");
    assert.equal($(root, ".badge-engine").closest(".session-main"), null, "бейдж движка — справа");
  } finally {
    ui.store.busyMap.value = {};
  }
});
