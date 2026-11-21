// BUG-285..288 (релиз 2.4.4): паритет экранов EPIC-20 с макетами и OpenSpec.
import test from "node:test";
import assert from "node:assert/strict";
import { $, $$, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

test("BUG-285: AcpCatalog и AntigravityLogin оформлены карточками портала, пилюлей и сортируют каталог (установленные → доступные → остальные)", async (t) => {
  const ui = await loadUI({ AcpCatalog: "src/components/views/AcpCatalog.jsx" });
  const h = createHarness(ui);
  t.after(() => h.cleanup());
  installFetch([
    {
      method: "GET",
      path: "/teleharness/api/acp/registry",
      reply: () => ({
        fetchedAt: "2026-11-21T10:00:00.000Z",
        agents: [
          { id: "zeta-cli", name: "Zeta CLI", version: "0.1.0", description: "Unavailable", license: "MIT", installable: false, status: "absent" },
          { id: "github-copilot-cli", name: "GitHub Copilot", version: "1.0.114", description: "Copilot", license: "Proprietary", installable: true, status: "absent" },
          { id: "antigravity", name: "Google Antigravity", version: "1.22.0", description: "Antigravity", license: "Proprietary", installable: true, status: "installed" },
        ],
      }),
    },
    { method: "GET", path: "/teleharness/api/acp/antigravity/login", reply: () => ({ status: "ready" }) },
  ]);
  const { root } = h.mount(ui.AcpCatalog);
  await h.waitFor(() => root.textContent.includes("Вход выполнен"));

  assert.ok($(root, ".acp-card.card"), "установленный агент обёрнут в карточку портала .acp-card.card");
  const pill = $(root, ".acp-pill.is-ok");
  assert.ok(pill, "у статуса входа есть пилюля .acp-pill.is-ok");
  assert.match(pill.textContent, /✓.*Вход выполнен/, "пилюля сочетает значок и слово");

  const toggleBtn = byText(root, "button", "Каталог агентов");
  assert.ok(toggleBtn.classList.contains("btn"), "кнопка «Каталог агентов» оформлена классом .btn");
  h.click(toggleBtn);
  await h.waitFor(() => $(root, ".acp-catalog-list"));

  const refreshBtn = byText(root, "button", "Обновить каталог");
  assert.ok(refreshBtn.classList.contains("btn"), "кнопка «Обновить каталог» оформлена классом .btn");

  const names = $$(root, ".acp-catalog-row .acp-agent-name").map((el) => el.textContent.trim());
  assert.deepEqual(names, ["Google Antigravity", "GitHub Copilot", "Zeta CLI"], "сортировка: установленные → доступные → остальные");

  const search = $(root, "input[type=\"search\"]");
  assert.ok(search, "в каталоге есть поиск");
  h.typeInto(search, "copilot");
  await h.waitFor(() => $$(root, ".acp-catalog-row").length === 1);
  assert.equal($(root, ".acp-catalog-row .acp-agent-name").textContent.trim(), "GitHub Copilot");
});

test("BUG-286: ACP-чат скрывает EditButton, RegenerateButton и TurnMenu; 409 undo is not available даёт честный текст", async (t) => {
  const ui = await loadUI({ ChatView: "src/components/views/ChatView.jsx" });
  const h = createHarness(ui);
  t.after(() => h.cleanup());
  const sid = "ses_acp_286";
  const acpSession = {
    id: sid,
    title: "ACP тест",
    directory: "/tmp",
    teleharness: { engine: "acp", model: { providerID: "acp-antigravity", modelID: "gemini-3.8-flash-high" }, agent: null, prompted: true },
  };
  installFetch([
    { method: "GET", path: "/teleharness/api/session", reply: () => [acpSession] },
    {
      method: "GET",
      path: `/teleharness/api/session/${sid}/message`,
      reply: () => [
        { info: { id: "u1", role: "user", time: { created: 1000 } }, parts: [{ type: "text", text: "Привет" }] },
        { info: { id: "a1", role: "assistant", providerID: "acp-antigravity", modelID: "gemini-3.8-flash-high", time: { created: 1005, completed: 1010 } }, parts: [{ type: "text", text: "Привет! Я Antigravity." }] },
      ],
    },
    { method: "POST", path: `/teleharness/api/session/${sid}/revert`, reply: () => ({ status: 409, body: { error: "undo is not available for ACP turns" } }) },
  ]);
  ui.store.sessions.value = [acpSession];
  const { root } = h.mount(ui.ChatView, { id: sid });
  await h.waitFor(() => $$(root, ".msg").length >= 2);
  assert.equal($$(root, "button[aria-label=\"Изменить сообщение\"]").length, 0, "на ACP-ходе нет EditButton");
  assert.equal($$(root, "button[aria-label=\"Сгенерировать заново\"]").length, 0, "на ACP-ходе нет RegenerateButton");
  assert.equal($$(root, "button[aria-label=\"Действия с ходом\"]").length, 0, "на ACP-ходе нет TurnMenu");

  // Если сервер всё же вернёт 409 undo is not available — уведомление честное, не «Ход уже идёт»
  await ui.store.undoTurn(sid);
  assert.match(String(ui.store.notice.value), /Откат.*недоступн/i);
});

test("BUG-287: modelName fallback для legacy acp-antigravity, динамические группы <Имя> · ACP и нейтральный LOCK_NOTE", async (t) => {
  const ui = await loadUI({
    modelGroups: "src/components/Pickers.jsx#modelGroups",
    ModelBar: "src/components/chat/ModelBar.jsx",
    modelName: "src/lib/engine.js#modelName",
  });
  const h = createHarness(ui);
  t.after(() => h.cleanup());

  const cfg = {
    connected: ["acp-antigravity", "acp-github-copilot-cli"],
    models: [
      { id: "gemini-3.8-flash-high", providerID: "acp-antigravity", label: "Gemini 3.8 Flash (High)" },
      { id: "copilot-gpt-5", providerID: "acp-github-copilot-cli", label: "Copilot GPT-5" },
    ],
    defaults: {},
  };
  assert.equal(ui.modelName(cfg, { providerID: "acp-antigravity", modelID: "acp-antigravity" }), "Google Antigravity");
  assert.equal(ui.modelName(cfg, { providerID: "acp-github-copilot-cli", modelID: "acp-github-copilot-cli" }), "GitHub Copilot CLI");

  const groups = ui.modelGroups(cfg);
  const titles = groups.map((g) => g.title);
  assert.deepEqual(titles, ["Google Antigravity · ACP", "GitHub Copilot CLI · ACP"], "динамические группы по каждому ACP-агенту");

  ui.store.providerCfg.value = cfg;
  ui.store.sessions.value = [{ id: "ses_lock", directory: "/tmp", teleharness: { engine: "acp", model: { providerID: "acp-antigravity", modelID: "gemini-3.8-flash-high" }, prompted: true } }];
  const { root } = h.mount(ui.ModelBar, { sessionId: "ses_lock", hasMessages: true });
  h.click($(root, "button.model-pill"));
  await h.waitFor(() => $(document.body, ".picker-note"));
  const note = $(document.body, ".picker-note").textContent;
  assert.match(note, /Движок чата закреплён/);
  assert.equal(note.includes("история z.ai и Claude"), false, "LOCK_NOTE не ограничивается z.ai и Claude");
});

test("BUG-288: DayChart разделяет заголовок «По дням» и подпись «в среднем …» через .cost-chart-head", async (t) => {
  const ui = await loadUI({ CostsSection: "src/components/views/CostsSection.jsx" });
  const h = createHarness(ui);
  t.after(() => h.cleanup());
  installFetch([
    {
      method: "GET",
      path: "/teleharness/api/costs/summary",
      reply: () => ({
        period: { from: "2026-11-01", to: "2026-11-30" },
        tz: "Europe/Moscow",
        priceVersion: { version: 1, createdAt: "2026-11-20T00:00:00Z" },
        totals: { subscriptionMicro: 100_000_000, subscriptionTurns: 10, apiPaidMicro: 1_000_000, apiTurns: 1, freeTurns: 0, turns: 11 },
        subscriptions: { configured: true, costMicro: 50_000_000, savedMicro: 50_000_000, payback: 2, prorated: false, items: [{ id: "s1" }] },
        noData: { count: 0, byReason: {} },
        byDay: [{ day: "2026-11-20", micro: 100_000_000, turns: 10, noData: 0 }],
        byModel: [],
        byProject: [],
        topChats: [],
        runs: [],
        byEngine: [],
        backfill: [],
        noPriceModels: 0,
      }),
    },
  ]);
  ui.store.me.value = { id: "admin", role: "admin", engines: ["opencode", "claude", "codex"] };
  const { root } = h.mount(ui.CostsSection, { admin: true });
  await h.waitFor(() => $(root, ".cost-tiles"));
  const head = $(root, ".cost-chart-head");
  assert.ok(head, "у графика по дням есть раздельная шапка .cost-chart-head");
  assert.equal($(head, "h3").textContent.trim(), "По дням");
  assert.match(head.textContent, /в среднем.*по ценам API/);
});
