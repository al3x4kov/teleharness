// Subscriptions: the kind label of a provider card follows the UI language. The server sends a
// short Russian word («подписка», «баланс», …); product names such as "Coding Plan" pass through.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadUI } from "./helpers/load.mjs";

let ui;
before(async () => {
  ui = await loadUI({ badgeText: "src/components/views/SettingsView.jsx#badgeText", subscriptionNote: "src/components/views/SettingsView.jsx#subscriptionNote" }, { lang: "en" });
});

test("English UI: card kind labels are translated, product names are kept", () => {
  assert.equal(ui.badgeText("подписка"), "subscription");
  assert.equal(ui.badgeText("ключ API"), "API key");
  assert.equal(ui.badgeText("баланс"), "balance");
  assert.equal(ui.badgeText("провайдер"), "provider");
  assert.equal(ui.badgeText("Coding Plan"), "Coding Plan");
  assert.equal(ui.badgeText("API"), "API");
});

test("English UI: the note of a card without data has no Russian text", () => {
  for (const card of [
    { state: "no-api", hint: "claude-subscription" },
    { state: "no-api", hint: "management-key" },
    { state: "no-api", hint: "console-only" },
    { state: "no-api" },
    { state: "no-key" },
    { state: "need-admin-key" },
    { state: "error", reason: "401" },
    { state: "error", reason: "network" },
    { state: "error", reason: "other" },
  ]) {
    const note = ui.subscriptionNote(card);
    assert.ok(note && !/[А-Яа-яЁё]/.test(note), `${JSON.stringify(card)} → ${note}`);
  }
});
