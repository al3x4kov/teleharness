// FEAT-03.22 «Системный промпт» + BUG-03.20 / FEAT-03.21 (TC-SET-005): the
// Settings card set for admin vs tenant. 2026-11-05: hide admin-only hints
// from tenants, show them their MCP list again, add a system-prompt setting for
// tenants and admin.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    SettingsView: "src/components/views/SettingsView.jsx",
    SystemPromptRow: "src/components/views/SystemPromptRow.jsx",
    promptPreview: "src/components/views/SystemPromptRow.jsx#promptPreview",
  });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  const s = ui.store;
  s.me.value = null;
  s.about.value = null;
  s.mcp.value = null;
  s.host.value = null;
  installFetch();
});

const titles = (root) => $$(root, ".row-title").map((el) => el.textContent.replace(/\s+/g, " ").trim());
const sheet = () => document.querySelector('.sheet[aria-label="Системный промпт"]');

test("promptPreview: first non-empty line or «Не задан»", () => {
  assert.equal(ui.promptPreview(""), "Не задан");
  assert.equal(ui.promptPreview("  \n\n  Отвечай кратко\nвторая"), "Отвечай кратко");
  assert.equal(ui.promptPreview(null), "Не задан");
});

test("TC-SET-005: тенант — нет admin-разделов и «Доступно администратору»; есть «Системный промпт» и свои MCP", async () => {
  installFetch([{ method: "GET", path: "/zai/api/mcp", reply: () => ({ marketplace: { status: "connected" } }) }]);
  ui.store.me.value = { id: "u_t", name: "julia", role: "user" };
  const { root } = t$.mount(ui.SettingsView);
  await t$.waitFor(() => ui.store.mcp.value?.length === 1 && /Не задан/.test(root.textContent));
  const t = titles(root);
  for (const hidden of ["Компьютер", "Подписка z.ai", "Агент для новых чатов · Claude"]) assert.equal(t.some((x) => x.startsWith(hidden)), false, `тенант не видит «${hidden}»`);
  assert.ok(t.includes("Системный промпт") && t.includes("MCP-серверы"));
  assert.equal(root.textContent.includes("Доступно администратору"), false);
  assert.equal(root.querySelector(".access-section, [data-section='access']"), null);
});

test("TC-SET-005: admin — «Компьютер», «Подписка z.ai», MCP и «Системный промпт» на месте", async () => {
  installFetch();
  ui.store.me.value = { id: "admin", name: "owner", role: "admin" };
  const { root } = t$.mount(ui.SettingsView);
  await t$.waitFor(() => /Не задан/.test(root.textContent));
  const t = titles(root);
  for (const shown of ["Компьютер", "MCP-серверы", "Системный промпт"]) assert.ok(t.includes(shown), `admin видит «${shown}»`);
  assert.ok(t.some((x) => x.startsWith("Подписка z.ai")));
});

test("FEAT-03.22: шит — счётчик, лимит 4000 блокирует «Сохранить», сохранение уходит PUT и обновляет строку", async () => {
  let saved = "";
  installFetch([
    { method: "GET", path: "/zai/api/me/system-prompt", reply: () => ({ text: saved, max: 4000 }) },
    { method: "PUT", path: "/zai/api/me/system-prompt", reply: (c) => ((saved = c.body.text.trim()), { text: saved, max: 4000 }) },
  ]);
  const { root } = t$.mount(ui.SystemPromptRow);
  await t$.waitFor(() => /Не задан/.test(root.textContent));
  assert.match(root.textContent, /Добавляется к инструкциям агента во всех ваших чатах/);
  t$.click($(root, "button.set-row"));
  const sh = sheet();
  assert.ok(sh, "шит открыт");
  const save = () => byText(sh, "button", "Сохранить");
  assert.equal(save().disabled, true, "без изменений сохранять нечего");
  assert.equal(byText(sh, "button", "Очистить"), null, "очищать нечего");
  const ta = $(sh, "textarea");
  assert.equal(ta.getAttribute("aria-label"), "Системный промпт");

  t$.typeInto(ta, "я".repeat(4001));
  assert.match($(sh, ".sysprompt-count").textContent, /4001 \/ 4000/);
  assert.ok($(sh, ".sysprompt-count").classList.contains("is-over"));
  assert.match(sh.textContent, /Слишком длинно/);
  assert.equal(save().disabled, true);

  t$.typeInto(ta, "Отвечай кратко\nи по-русски");
  assert.equal(save().disabled, false);
  t$.click(save());
  await t$.waitFor(() => !sheet() && /Отвечай кратко/.test(root.textContent));
  const put = fetchCalls.find((c) => c.method === "PUT" && c.path === "/zai/api/me/system-prompt");
  assert.deepEqual(put.body, { text: "Отвечай кратко\nи по-русски" });
  assert.equal($(root, ".set-value").textContent, "Отвечай кратко", "строка — первая строка промпта");
});

test("FEAT-03.22: «Очистить» отправляет пустой текст; ошибка сервера — словами, шит остаётся открытым", async () => {
  let fail = true;
  installFetch([
    { method: "GET", path: "/zai/api/me/system-prompt", reply: () => ({ text: "Старый промпт", max: 4000 }) },
    {
      method: "PUT",
      path: "/zai/api/me/system-prompt",
      reply: () => (fail ? { status: 400, body: { error: "Системный промпт длиннее 4000 символов — сократите его" } } : { text: "", max: 4000 }),
    },
  ]);
  const { root } = t$.mount(ui.SystemPromptRow);
  await t$.waitFor(() => /Старый промпт/.test(root.textContent));
  t$.click($(root, "button.set-row"));
  t$.click(byText(sheet(), "button", "Очистить"));
  await t$.waitFor(() => /Не удалось сохранить/.test(sheet()?.textContent ?? ""));
  assert.match(sheet().textContent, /4000 символов/);
  fail = false;
  t$.click(byText(sheet(), "button", "Очистить"));
  await t$.waitFor(() => !sheet() && /Не задан/.test(root.textContent));
  assert.deepEqual(fetchCalls.filter((c) => c.method === "PUT").at(-1).body, { text: "" });
});

test("FEAT-03.22: сбой загрузки — «Не удалось загрузить · Повторить», повтор загружает", async () => {
  let down = true;
  installFetch([{ method: "GET", path: "/zai/api/me/system-prompt", reply: () => (down ? { status: 502, body: { error: "x" } } : { text: "P", max: 4000 }) }]);
  const { root } = t$.mount(ui.SystemPromptRow);
  await t$.waitFor(() => /Не удалось загрузить/.test(root.textContent));
  down = false;
  t$.click(byText(root, "button", "Повторить"));
  await t$.waitFor(() => $(root, ".set-value")?.textContent === "P");
});
