// FEAT-20.3 (2.1): Настройки → GitHub (кадры T-3/T-4/T-5) — форма подключения
// с проверкой через PUT, плашки прав по репозиториям, предупреждение об
// истечении за ≤ 7 дней, баннер «токен отклонён», отключение с последствиями.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    GitHubSection: "src/components/git/GitHubSection.jsx",
    repoState: "src/components/git/GitHubSection.jsx#repoState",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  installFetch();
});

const DAY = 86400000;
const FACE = {
  connected: true,
  login: "owner-gh",
  tokenLast4: "7Qx2",
  expiresAt: Date.now() + 5 * DAY,
  status: "ok",
  checkedAt: Date.now() - 3600_000,
  expiringSoon: true,
  repos: [
    { fullName: "acme/app", permissions: { contents: "write", pull_requests: "write", issues: "read", actions: "read", webhooks: "write" } },
    { fullName: "teleharness/dev", permissions: { contents: "write", pull_requests: "write", webhooks: undefined } },
    { fullName: "teleharness/qa", permissions: { contents: "read" } },
  ],
};

function connRoutes(conn, { puts = null, deleted = null } = {}) {
  let cur = conn;
  installFetch([
    { method: "GET", path: "/teleharness/api/github/connection", reply: () => cur },
    { method: "PUT", path: "/teleharness/api/github/connection", reply: (c) => (puts?.push(c.body), (cur = FACE)) },
    { method: "POST", path: "/teleharness/api/github/connection/check", reply: () => (cur = FACE) },
    { method: "DELETE", path: "/teleharness/api/github/connection", reply: () => (deleted?.push(1), (cur = { connected: false }), { ok: true, removed: true }) },
    { method: "GET", path: "/teleharness/api/temporal/triggers", reply: () => [{ id: "t1" }, { id: "t2" }] },
  ]);
}

async function mount(conn = { connected: false }, opts) {
  connRoutes(conn, opts);
  return t$.mount(ui.GitHubSection);
}

test("нет подключения: форма с токеном, права, кнопка активна от 20 символов; PUT подключает", async () => {
  const puts = [];
  const h = await mount({ connected: false }, { puts });
  await t$.waitFor(() => $(h.root, ".gh-token input"));
  const input = $(h.root, ".gh-token input");
  assert.equal(input.type, "password", "токен по умолчанию скрыт");
  const btn = byText(h.root, "button", "Подключить");
  assert.ok(btn.disabled, "короткий токен — кнопка неактивна");
  assert.ok($$(h.root, ".gh-perms li").length === 5, "пять прав в памятке");
  assert.ok(byText(h.root, ".gh-perms", "Webhooks"));

  t$.typeInto(input, "github_pat_" + "11AB00000000000000000000000000007Qx2");
  await t$.waitFor(() => !byText(h.root, "button", "Подключить").disabled);
  t$.click(byText(h.root, "button", "Подключить"));

  await t$.waitFor(() => $(h.root, ".gh-owner"));
  assert.deepEqual(puts, [{ token: "github_pat_" + "11AB00000000000000000000000000007Qx2" }], "токен ушёл один раз в PUT");
  assert.ok(byText(h.root, ".gh-owner", "owner-gh"));
  assert.ok(byText(h.root, ".gh-owner", "•••• 7Qx2"), "видны только последние 4 символа");
  assert.ok(byText(h.root, ".gh-pill", "Готов"));
  assert.ok(byText(h.root, ".gh-pill", "Опрос"), "нет Webhooks: write — будет опрос");
  assert.ok(byText(h.root, ".gh-pill", "Мало прав"), "нет Pull requests: write");
});

test("плашки по правам репозитория (repoState)", () => {
  assert.equal(ui.repoState(FACE.repos[0]).text, "Готов");
  assert.equal(ui.repoState(FACE.repos[1]).text, "Опрос");
  assert.equal(ui.repoState(FACE.repos[2]).text, "Мало прав");
  assert.equal(ui.repoState({ fullName: "x/y", permissions: null }).text, "Мало прав", "права не раскрыты — считаем недостаточными");
  // Реальный формат GitHub REST /user/repos (boolean admin/push/pull)
  assert.equal(ui.repoState({ fullName: "o/a", permissions: { admin: true, push: true, pull: true } }).text, "Готов");
  assert.equal(ui.repoState({ fullName: "o/b", permissions: { admin: false, push: true, pull: true } }).text, "Опрос");
  assert.equal(ui.repoState({ fullName: "o/c", permissions: { admin: false, push: false, pull: true } }).text, "Мало прав");
});

test("истечение за ≤ 7 дней — предупреждение с датой и «Заменить токен»", async () => {
  const h = await mount(FACE);
  await t$.waitFor(() => byText(h.root, ".t-banner-warn", "истекает через 5 дн."));
  assert.ok(byText(h.root, ".t-banner-warn", "Триггеры продолжат работу"));
  t$.click(byText(h.root, "button", "Заменить токен"));
  await t$.waitFor(() => $(h.root, ".gh-token input"));
});

test("токен отклонён: баннер 401 и «Нет подключения», переход к новому токену", async () => {
  const h = await mount({ ...FACE, status: "expired" });
  await t$.waitFor(() => byText(h.root, '[role="alert"]', "GitHub отклонил токен (401)"));
  assert.ok(byText(h.root, ".gh-owner", "Нет подключения"));
  assert.ok(!byText(h.root, ".t-banner-warn", "истекает"), "предупреждение об истечении не показывается");
  t$.click(byText(h.root, "button", "Вставить новый токен"));
  await t$.waitFor(() => $(h.root, ".gh-token input"));
});

test("отключение: лист с последствиями (число триггеров), DELETE возвращает к форме", async () => {
  const deleted = [];
  const h = await mount(FACE, { deleted });
  await t$.waitFor(() => byText(h.root, ".gh-owner", "owner-gh"));
  t$.click(byText(h.root, "button", "Отключить GitHub"));
  await t$.waitFor(() => byText(document.body, ".t-sheet", "Триггеры (2) встанут на паузу"));
  assert.ok(byText(document.body, ".t-sheet", "Webhook, созданные порталом, будут удалены"));
  t$.click(byText(document.body, ".t-sheet button", "Отключить").closest("button"));
  await t$.waitFor(() => $(h.root, ".gh-token input"));
  assert.equal(deleted.length, 1, "DELETE вызван");
});

test("BUG-323 п.5: при reposTruncated=true показывает подсказку о неполном списке репозиториев", async () => {
  const h = await mount({ ...FACE, reposTruncated: true });
  await t$.waitFor(() => byText(h.root, ".gh-owner", "owner-gh"));
  assert.ok(h.root.textContent.includes("полный список ограничен лимитом загрузки"), "подсказка о reposTruncated отображается");
});

