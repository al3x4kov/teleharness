// Регрессия BUG-295 (Auto-Relay/лимит ACP), BUG-296 (учёт ACP в расходах),
// BUG-297 («Сначала план» для ACP).
import test from "node:test";
import assert from "node:assert/strict";
import { modelInCatalog, providerForUser } from "../lib/policy.js";
import { planUnsupported } from "../lib/binding.js";
import { resolveAcpMode } from "../lib/claude.js";
import { engineOfAnswer } from "../lib/cost/recorder.js";
import { isSubscriptionProvider, SUBSCRIPTION_PROVIDERS } from "../lib/cost/prices.js";
import { CostLedger } from "../lib/cost/ledger.js";
import { CostReports } from "../lib/cost/report.js";
import { claudeAnswerError, isLimitError, turnErrorKind } from "../shared/turn-error.js";
import { describeTurnError } from "../src/lib/turn.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CATALOG_WITH_ACP = {
  connected: ["zai-coding-plan", "anthropic", "openai-codex", "acp-antigravity"],
  all: [
    { id: "zai-coding-plan", models: { "glm-5.3": { id: "glm-5.3", name: "GLM-5.3" } } },
    { id: "anthropic", models: { "claude-opus-5-5": { id: "claude-opus-5-5", name: "Claude Opus 5.5" } } },
    { id: "openai-codex", models: { "gpt-6.2-astra": { id: "gpt-6.2-astra", name: "GPT-6.2 Astra" } } },
    {
      id: "acp-antigravity",
      models: {
        "gemini-4-neon-medium": { id: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
      },
    },
  ],
  default: { "zai-coding-plan": "glm-5.3", "acp-antigravity": "gemini-4-neon-medium" },
};

test("BUG-295: providerForUser и modelInCatalog уважают acpAllowed (админ видит Gemini, тенант — нет)", () => {
  const gem = { providerID: "acp-antigravity", modelID: "gemini-4-neon-medium" };
  const bad = { providerID: "acp-antigravity", modelID: "no-such-model" };

  // Тенант (по умолчанию acpAllowed=false): провайдер скрыт и модель отклонена
  const tenantView = providerForUser(CATALOG_WITH_ACP, { claudeAllowed: false, codexAllowed: false });
  assert.equal(tenantView.connected.includes("acp-antigravity"), false);
  assert.equal(modelInCatalog(CATALOG_WITH_ACP, gem, { claudeAllowed: true, codexAllowed: false }), false);

  // Админ (acpAllowed=true): провайдер виден, существующая модель проходит, несуществующая — нет
  const adminView = providerForUser(CATALOG_WITH_ACP, { claudeAllowed: true, codexAllowed: true, acpAllowed: true });
  assert.equal(adminView.connected.includes("acp-antigravity"), true);
  assert.equal(modelInCatalog(CATALOG_WITH_ACP, gem, { claudeAllowed: true, codexAllowed: true, acpAllowed: true }), true);
  assert.equal(modelInCatalog(CATALOG_WITH_ACP, bad, { claudeAllowed: true, codexAllowed: true, acpAllowed: true }), false);
});

test("BUG-295: карточка ошибки лимита и запуска для ACP и Codex не подставляет z.ai/Claude", () => {
  const acpLimit = describeTurnError("429 Too Many Requests: quota exceeded", { engine: "acp" });
  assert.equal(acpLimit.kind, "limit");
  assert.match(acpLimit.title, /ACP/i);
  assert.doesNotMatch(acpLimit.title + " " + acpLimit.text, /z\.ai|Coding Plan|Claude/i);

  const codexLimit = describeTurnError("You've hit your limit", { engine: "codex" });
  assert.equal(codexLimit.kind, "limit");
  assert.match(codexLimit.title, /Codex/i);
  assert.doesNotMatch(codexLimit.title, /Claude/i);

  assert.equal(turnErrorKind("Не удалось запустить ACP-агент CLI: ENOENT", { engine: "acp" }), "spawn");
  assert.equal(claudeAnswerError("Агент ACP вернул ошибку"), "Агент ACP вернул ошибку");
  assert.equal(isLimitError("Rate limit exceeded", { engine: "acp" }), true);

  const acpSpawn = describeTurnError("Не удалось запустить ACP-агент CLI: ENOENT", { engine: "acp" });
  assert.equal(acpSpawn.kind, "spawn");
  assert.match(acpSpawn.title, /ACP/i);
  assert.doesNotMatch(acpSpawn.title, /Claude/i);
});

test("BUG-296: CostRecorder, prices и CostReports корректно учитывают движок acp и подписки ACP", () => {
  assert.equal(engineOfAnswer({ id: "msgc_a_1", providerID: "acp-antigravity" }), "acp");
  assert.equal(engineOfAnswer({ id: "msgc_a_2", providerID: "acp-github-copilot-cli" }), "acp");
  assert.equal(engineOfAnswer({ id: "msgc_a_3", providerID: "openai-codex" }), "codex");
  assert.equal(engineOfAnswer({ id: "msgc_a_4", providerID: "anthropic" }), "claude");
  assert.equal(engineOfAnswer({ id: "msg_oc_1", providerID: "zai-coding-plan" }), "opencode");

  assert.equal(isSubscriptionProvider("acp-antigravity"), true);
  assert.equal(isSubscriptionProvider("acp-github-copilot-cli"), true);
  assert.ok(SUBSCRIPTION_PROVIDERS.includes("acp-antigravity"));

  const dir = mkdtempSync(path.join(tmpdir(), "teleharness-cost-acp-"));
  try {
    const ledger = new CostLedger({ file: path.join(dir, "costs.sqlite") });
    ledger.open();
    const subs = ledger.saveSubscriptions(
      [{ title: "Google AI Ultra", providers: ["acp-antigravity"], usdMonth: 250, activeFrom: "2026-11-01" }],
      { ifMatch: 1 },
    );
    assert.equal(subs.items.length, 1);
    assert.deepEqual(subs.items[0].providers, ["acp-antigravity"]);

    ledger.record({
      engine: "acp",
      answerId: "msgc_a_acp1",
      sid: "ses_acp_1",
      userId: "admin",
      userName: "admin",
      providerId: "acp-antigravity",
      modelId: "gemini-4-neon-medium",
      completedAt: Date.UTC(2026, 10, 21, 12, 0),
      norm: { status: "ok", tokens: { in: 1000, out: 500, reason: 0, cacheRead: 0, w5m: 0, w1h: 0, context: 0 }, byModel: [], partial: false, engineCostMicro: null, engineCostBasis: null, speed: null },
      source: "live",
    });

    const reports = new CostReports({ ledger });
    const sum = reports.summary({ period: { kind: "month", from: "2026-11-01", to: "2026-11-30", month: "2026-11" }, withSubs: true });
    const row = sum.byEngine.find((r) => r.engine === "acp");
    assert.ok(row, "в byEngine должна быть строка acp");
    assert.equal(row.title, "ACP");
    assert.equal(row.turns, 1);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BUG-297: planUnsupported и resolveAcpMode поддерживают «Сначала план» (plan / plan-ro) для ACP", () => {
  assert.equal(planUnsupported({ engine: "acp", admin: true }), null);
  assert.match(planUnsupported({ engine: "acp", admin: false }), /администратору/i);
  assert.equal(resolveAcpMode("plan", true), "plan");
  assert.equal(resolveAcpMode("plan-ro", true), "plan-ro");
  assert.equal(resolveAcpMode("plan-ro", false), "plan-ro");
});
