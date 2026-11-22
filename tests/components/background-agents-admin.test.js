// FEAT-20.3 (2.6, D-6, кр. 20): Настройки → «Фоновые агенты» (admin) —
// общий выключатель триггеров, суточный лимит Claude в фоне, подключения GitHub без токенов.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    BackgroundAgentsSection: "src/components/views/BackgroundAgentsSection.jsx",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  installFetch();
});

const INITIAL = {
  adminStopped: false,
  claudePerDay: 10,
  claudeUsedToday: 3,
  claudeLeftToday: 7,
  triggersTotal: 4,
  triggersEnabled: 3,
  activeRuns: 1,
  connections: [
    { owner: "admin", login: "owner-gh", tokenLast4: "7Qx2", status: "ok", expiresAt: Date.now() + 86400_000 * 20 },
    { owner: "alice", login: "alice-dev", tokenLast4: "9Ab1", status: "invalid", expiresAt: null },
  ],
};

test("D-6: показывает сводку, подключения без токенов, переключает общий выключатель и сохраняет лимит Claude", async () => {
  let state = { ...INITIAL };
  const puts = [];
  installFetch([
    { method: "GET", path: "/teleharness/api/admin/background", reply: () => state },
    {
      method: "PUT", path: "/teleharness/api/admin/background",
      reply: ({ body }) => {
        puts.push(body);
        if (typeof body.adminStopped === "boolean") state = { ...state, adminStopped: body.adminStopped };
        if (typeof body.claudePerDay === "number") state = { ...state, claudePerDay: body.claudePerDay, claudeLeftToday: Math.max(0, body.claudePerDay - state.claudeUsedToday) };
        return state;
      },
    },
  ]);

  const h = t$.mount(ui.BackgroundAgentsSection, {});
  const el = h.root;
  await t$.waitFor(() => byText(el, "button", "Остановить все триггеры"));
  assert.ok(el.textContent.includes("Использовано сегодня: 3 из 10 (осталось 7)"));
  assert.ok(el.textContent.includes("Всего: 4 · Включено: 3 · Активных запусков: 1"));
  assert.ok(el.textContent.includes("@owner-gh") && el.textContent.includes("•••• 7Qx2"));
  assert.ok(el.textContent.includes("@alice-dev") && el.textContent.includes("Токен отклонён"));

  // Остановить все триггеры
  await t$.click(byText(el, "button", "Остановить все триггеры"));
  await t$.waitFor(() => byText(el, "button", "Возобновить триггеры"));
  assert.deepEqual(puts[0], { adminStopped: true });
  assert.ok(el.textContent.includes("Остановлены администратором"));

  // Обновить суточный лимит Claude
  const inp = $(el, "#bg-claude-limit");
  await t$.typeInto(inp, "25");
  await t$.click(byText(el, "button", "Сохранить"));
  await t$.waitFor(() => el.textContent.includes("Использовано сегодня: 3 из 25 (осталось 22)"));
  assert.deepEqual(puts[1], { claudePerDay: 25 });
});

test("D-6: ошибка загрузки показывает сообщение и кнопку «Повторить»", async () => {
  installFetch([
    { method: "GET", path: "/teleharness/api/admin/background", reply: () => ({ status: 500, body: { error: "Внутренняя ошибка" } }) },
  ]);
  const h = t$.mount(ui.BackgroundAgentsSection, {});
  const el = h.root;
  await t$.waitFor(() => byText(el, "button", "Повторить"));
  assert.ok($(el, "[role=alert]")?.textContent?.trim().length > 0);
});
