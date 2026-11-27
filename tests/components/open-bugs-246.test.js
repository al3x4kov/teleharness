// TDD regression tests for 2.4.6 open bugs batch:
// BUG-270 (Codex plan-ro approvalPolicy), BUG-236 (Windows inspectProcess fallback),
// BUG-233 (relay message dot), BUG-238 (quota reset date),
// BUG-239 (quota phone wrap), BUG-240 (Windows dir 400).
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { $, byText, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let ui, t$;
before(async () => {
  ui = await loadUI({
    ChatView: "src/components/views/ChatView.jsx",
    MessageList: "src/components/chat/MessageList.jsx",
    QuotaStrip: "src/components/chat/Relay.jsx#QuotaStrip",
    formatQuotaReset: "src/components/chat/Relay.jsx#formatQuotaReset",
  });
  t$ = createHarness(ui);
});
after(() => { ui?.store?.dispose?.(); });
afterEach(() => {
  t$.cleanup();
  delete globalThis.__teleharnessActiveId;
  ui.store.sessions.value = [];
  ui.store.active.value = null;
  ui.store.subscriptions.value = [];
  installFetch();
});

test("BUG-270: codexPolicy plan-ro uses approvalPolicy=never in read-only sandbox (no read declines)", async () => {
  const { parseArgs, codexPolicy } = await import("../../lib/codex-shim.mjs");
  const { permissionArgs } = await import("../../lib/claude.js");
  const pol = codexPolicy(parseArgs(["--input-format", "text", ...permissionArgs("admin", { addDirs: [], mode: "plan-ro" })]));
  assert.equal(pol.mode, "plan");
  assert.equal(pol.sandbox, "read-only");
  assert.equal(pol.approvalPolicy, "never");
});

test("BUG-236: parseTasklistCsv extracts image name for Windows fallback", async () => {
  const { parseTasklistCsv } = await import("../../lib/claude.js");
  assert.equal(typeof parseTasklistCsv, "function");
  assert.equal(parseTasklistCsv('"node.exe","1234","Console","1","25,000 K"\r\n'), "node");
  assert.equal(parseTasklistCsv("INFO: No tasks are running which match the specified criteria.\r\n"), null);
});

test("BUG-233: Claude -> GLM -> Claude feed keeps per-message engine dot even with nested model.providerID", async () => {
  const SID = "ses_bug233";
  ui.store.providerCfg.value = {
    models: [
      { id: "claude-opus-5-5", providerID: "anthropic", label: "Claude Opus 5.5" },
      { id: "glm-5.3", providerID: "zai-coding-plan", label: "GLM-5.3" },
    ],
  };
  ui.store.sessions.value = [
    {
      id: SID,
      title: "Relay dot test",
      directory: "/srv/proj",
      teleharness: { engine: "claude", model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, agent: null, prompted: true },
    },
  ];
  const msgs = [
    { info: { id: "u1", role: "user", sessionID: SID, time: { created: 1000 } }, parts: [{ id: "p1", type: "text", text: "hi" }] },
    { info: { id: "a1", role: "assistant", sessionID: SID, providerID: "anthropic", modelID: "claude-opus-5-5", time: { created: 1100, completed: 1200 } }, parts: [{ id: "p2", type: "text", text: "from claude 1" }] },
    { info: { id: "u2", role: "user", sessionID: SID, time: { created: 2000 } }, parts: [{ id: "p3", type: "text", text: "glm turn" }] },
    { info: { id: "a2", role: "assistant", sessionID: SID, providerID: "zai-coding-plan", modelID: "glm-5.3", agent: "Orchestrator", time: { created: 2100, completed: 2200 } }, parts: [{ id: "p4", type: "text", text: "from glm with providerID" }] },
    { info: { id: "u3", role: "user", sessionID: SID, time: { created: 2500 } }, parts: [{ id: "p5", type: "text", text: "glm nested" }] },
    { info: { id: "a3", role: "assistant", sessionID: SID, model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, modelID: "glm-5.3", agent: "Orchestrator", time: { created: 2600, completed: 2700 } }, parts: [{ id: "p6", type: "text", text: "from glm nested providerID" }] },
    { info: { id: "u4", role: "user", sessionID: SID, time: { created: 3000 } }, parts: [{ id: "p7", type: "text", text: "back to claude" }] },
    { info: { id: "a4", role: "assistant", sessionID: SID, providerID: "anthropic", modelID: "claude-opus-5-5", time: { created: 3100, completed: 3200 } }, parts: [{ id: "p8", type: "text", text: "from claude 2" }] },
  ];
  ui.store.active.value = { id: SID, title: "Relay dot test", status: "idle", lastEventAt: 4000, messages: msgs, loading: false, loadError: false };
  globalThis.__teleharnessActiveId = SID;
  const { root } = t$.mount(ui.MessageList, { messages: msgs, busy: false, sessionId: SID });
  const dotOf = (mid) => $(root, `[data-mid="${mid}"] .msg-avatar`);
  assert.ok(dotOf("a1")?.classList.contains("is-claude"), "Claude answer 1 has .is-claude");
  assert.equal(dotOf("a2")?.classList.contains("is-claude"), false, "GLM answer with providerID must NOT have .is-claude");
  assert.equal(dotOf("a3")?.classList.contains("is-claude"), false, "GLM answer with nested model.providerID must NOT have .is-claude");
  assert.ok(dotOf("a4")?.classList.contains("is-claude"), "Claude answer 2 has .is-claude");
});

test("BUG-238: QuotaStrip renders date (DD.MM) for weekly or next-day reset", async () => {
  const SID = "ses_quota_238";
  const futureReset = Date.now() + 3 * 24 * 3600 * 1000;
  const expectedDate = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit" }).format(new Date(futureReset));
  const expectedTime = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" }).format(new Date(futureReset));
  const subPayload = { providers: [{ id: "zai", state: "ok", windows: [{ kind: "week", number: 1, percent: 100, resetAt: futureReset }] }] };
  installFetch([
    {
      method: "GET",
      path: "/teleharness/api/subscriptions",
      reply: () => subPayload,
    },
  ]);
  ui.store.sessions.value = [
    {
      id: SID,
      title: "Quota test",
      directory: "/srv/proj",
      teleharness: { engine: "opencode", model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: null, prompted: true },
    },
  ];
  ui.store.subscriptions.value = subPayload.providers;
  const { root } = t$.mount(ui.QuotaStrip, { sessionId: SID, hidden: false, onPickOther: () => {} });
  await new Promise((r) => setTimeout(r, 20));
  const txt = $(root, ".stall-text")?.textContent ?? "";
  assert.ok(txt.includes(`Сброс ${expectedDate} в ${expectedTime} МСК`), `expected date+time in quota strip, got: ${txt}`);
  const now = Date.parse("2026-11-17T10:00:00+03:00");
  assert.equal(ui.formatQuotaReset(Date.parse("2026-11-17T15:30:00+03:00"), { now, kind: "tokens" }), "Сброс в 15:30 МСК.");
  assert.equal(ui.formatQuotaReset(Date.parse("2026-11-20T21:20:00+03:00"), { now, kind: "week" }), "Сброс 20.11 в 21:20 МСК.");
  assert.equal(ui.formatQuotaReset(Date.parse("2026-11-18T02:20:00+03:00"), { now, kind: "tokens" }), "Сброс 18.11 в 02:20 МСК.");
});

test("BUG-239: relay.css wraps quota-strip text >= 220px so phone viewports do not crush text", () => {
  const css = readFileSync(path.join(ROOT, "src/components/relay.css"), "utf8");
  assert.match(css, /\.quota-strip\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.quota-strip\s+\.stall-text\s*\{[^}]*flex:\s*1\s+1\s+220px/);
});

test("BUG-240: 400 not-absolute on Linux shows clear foreign-directory reason without Retry button", async () => {
  const SID = "ses_win_dir";
  const winDir = "C:/Users/USER/project";
  installFetch([
    { method: "GET", path: "/teleharness/api/session", reply: () => [{ id: SID, title: "Win chat", directory: winDir, time: { created: 1, updated: 2 } }] },
    {
      method: "GET",
      path: `/teleharness/api/session/${SID}/message`,
      reply: () => ({ status: 400, body: { error: "каталог должен быть абсолютным путём", code: "not-absolute" } }),
    },
  ]);
  ui.store.sessions.value = [{ id: SID, title: "Win chat", directory: winDir, time: { created: 1, updated: 2 } }];
  const { root } = t$.mount(ui.ChatView, { id: SID });
  await t$.waitFor(() => {
    const h = $(root, "p.hint")?.textContent ?? "";
    return h.includes(winDir) || h.includes("другого компьютера") || h.includes("сбой сети");
  });
  const hint = $(root, "p.hint")?.textContent ?? "";
  assert.match(hint, /другого компьютера|на сервере её нет/i, `expected clear dir reason, got: ${hint}`);
  assert.ok(hint.includes(winDir), `expected path in hint, got: ${hint}`);
  assert.equal(byText(root, "button", "Повторить"), null, "non-retryable dir error must not show Повторить");
});
