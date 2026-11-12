// FEAT-11.18 (шаг В): клиентские помощники передачи.
// Run: node --test tests/relay-client.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { lowQuota, placeRelayMarks, suggestRelay, windowWords } from "../src/lib/relay.js";

const GROUPS = [
  { engine: "opencode", title: "opencode", models: [{ providerID: "zai-coding-plan", id: "glm-5.3", name: "GLM-5.3" }, { providerID: "zai-coding-plan", id: "glm-5.3-flash", name: "GLM-5.3 Flash" }] },
  { engine: "claude", title: "Claude · подписка", models: [{ providerID: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" }, { providerID: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }] },
];
const CLAUDE = { engine: "claude", model: { providerID: "anthropic", modelID: "claude-opus-5-5" } };
const GLM = { engine: "opencode", model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } };

test("suggestRelay: предлагается другой движок; модель по умолчанию пользователя — если она на нём", () => {
  assert.deepEqual(suggestRelay(GROUPS, CLAUDE), { engine: "opencode", providerID: "zai-coding-plan", modelID: "glm-5.3", name: "GLM-5.3" });
  assert.equal(suggestRelay(GROUPS, CLAUDE, { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" }).modelID, "glm-5.3-flash");
  assert.equal(suggestRelay(GROUPS, GLM).modelID, "claude-opus-5-5");
  assert.equal(suggestRelay(GROUPS, GLM, { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" }).engine, "claude", "своя модель по умолчанию на том же движке не подходит");
});

test("suggestRelay: другого движка нет (пользователь без Claude) — другая модель того же; совсем нечего — null", () => {
  assert.equal(suggestRelay([GROUPS[0]], GLM).modelID, "glm-5.3-flash");
  assert.equal(suggestRelay([{ engine: "opencode", models: [GROUPS[0].models[0]] }], GLM), null);
  assert.equal(suggestRelay([], GLM), null);
  assert.equal(suggestRelay(null, null), null);
});

test("placeRelayMarks: отметка встаёт перед первым сообщением после неё; последняя — в хвост", () => {
  const m = (id, at) => ({ info: { id, time: { created: at } } });
  const msgs = [m("u1", 10), m("a1", 20), m("u2", 50), m("a2", 60)];
  const { before, tail } = placeRelayMarks(msgs, [{ at: 70, n: 3 }, { at: 30, n: 1 }, { at: 35, n: 2 }]);
  assert.deepEqual([...before.keys()], ["u2"]);
  assert.deepEqual(before.get("u2").map((x) => x.n), [1, 2], "по порядку времени");
  assert.deepEqual(tail.map((x) => x.n), [3], "после последнего сообщения — ход нового движка ещё не начался");
  assert.deepEqual(placeRelayMarks([], [{ at: 1 }]).tail.length, 1);
  assert.equal(placeRelayMarks(msgs, null).before.size, 0);
});

test("lowQuota: только чат на z.ai и только при использовании ≥ 85 %; берётся самое занятое окно", () => {
  const cards = [{ id: "zai", state: "ok", windows: [{ kind: "hours", number: 5, percent: 91, resetAt: 5 }, { kind: "week", number: 1, percent: 40 }] }, { id: "claude", state: "no-api" }];
  assert.deepEqual(lowQuota(cards, GLM), { left: 9, kind: "hours", number: 5, resetAt: 5 });
  assert.equal(lowQuota(cards, CLAUDE), null, "у Claude остаток неизвестен");
  assert.equal(lowQuota([{ id: "zai", state: "ok", windows: [{ kind: "hours", percent: 84 }] }], GLM), null);
  assert.equal(lowQuota([{ id: "zai", state: "error" }], GLM), null);
  assert.equal(lowQuota(null, GLM), null);
  assert.equal(lowQuota(cards, { engine: "opencode", model: { providerID: "openrouter", modelID: "x" } }), null, "модель другого провайдера — лимит z.ai её не касается");
  assert.equal(windowWords("hours", 5), "на 5 ч");
  assert.equal(windowWords("week"), "на неделю");
});
