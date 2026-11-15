// FEAT-18.6: авто-передача при лимите — настройка, выбор модели, оркестратор (не чаще раза на ход).
// Run: node --test tests/auto-relay.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_RELAY_ORDER_MAX, cleanAutoRelay, createAutoRelay, pickAutoRelayModel, readAutoRelay } from "../lib/auto-relay.js";

const GLM = { providerID: "zai-coding-plan", modelID: "glm-5.3" };
const FLASH = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const HAIKU = { providerID: "anthropic", modelID: "claude-haiku-4-5" };

test("FEAT-18.6: cleanAutoRelay — форма, повторы схлопываются, не больше 3, плохое — 400", () => {
  assert.deepEqual(cleanAutoRelay({ on: true, order: [GLM, { ...GLM }, HAIKU] }), { on: true, order: [GLM, HAIKU] });
  assert.deepEqual(cleanAutoRelay({ on: false }), { on: false, order: [] });
  assert.equal(AUTO_RELAY_ORDER_MAX, 3);
  for (const bad of [null, [], { on: "yes" }, { on: true, order: "x" }, { on: true, order: [{ providerID: "a" }] }, { on: true, order: [GLM, FLASH, HAIKU, { providerID: "p", modelID: "m" }] }]) {
    assert.throws(() => cleanAutoRelay(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test("FEAT-18.6: readAutoRelay — по умолчанию выключено, мусор в хранилище — выключено", () => {
  assert.deepEqual(readAutoRelay(null), { on: false, order: [] });
  assert.deepEqual(readAutoRelay({ on: 1, order: 5 }), { on: false, order: [] });
  assert.deepEqual(readAutoRelay({ on: true, order: [FLASH] }), { on: true, order: [FLASH] });
});

test("FEAT-18.6: pickAutoRelayModel — первая доступная, не текущая", async () => {
  const all = async () => true;
  assert.deepEqual(await pickAutoRelayModel([HAIKU, GLM], HAIKU, all), GLM, "текущая пропускается");
  assert.deepEqual(await pickAutoRelayModel([HAIKU, FLASH, GLM], GLM, async (m) => m.providerID !== "anthropic"), FLASH, "недоступная пропускается");
  assert.equal(await pickAutoRelayModel([HAIKU], GLM, async () => false), null, "нет доступных → null");
  assert.equal(await pickAutoRelayModel([], GLM, all), null);
  assert.equal(await pickAutoRelayModel([FLASH], GLM, async () => { throw new Error("catalog"); }), null, "ошибка проверки = недоступна");
});

function harness({ setting = { on: true, order: [GLM] }, current = { engine: "claude", model: HAIKU }, available = async () => true, relayOk = true } = {}) {
  const calls = { relay: [], resume: [] };
  const ar = createAutoRelay({
    ownerOf: async () => ({ id: "u1", role: "user" }),
    settingOf: async () => setting,
    bindingOf: async () => current,
    available: async (_u, m) => available(m),
    relay: async (x) => {
      calls.relay.push(x);
      return relayOk ? { ok: true, status: 200 } : { ok: false, status: 409, error: "turn is running" };
    },
    resume: async (x) => {
      calls.resume.push(x);
      return { ok: true, status: 204 };
    },
  });
  return { ar, calls };
}

test("FEAT-18.6: включено — передача первой запасной и ход «продолжи»", async () => {
  const { ar, calls } = harness();
  const r = await ar.onLimit({ sid: "s1", dir: "D:/p" });
  assert.equal(r.done, true);
  assert.deepEqual(r.model, GLM);
  assert.equal(calls.relay.length, 1);
  assert.deepEqual(calls.relay[0].model, GLM);
  assert.equal(calls.resume.length, 1);
});

test("FEAT-18.6: выключено (по умолчанию) — ничего не делает", async () => {
  const { ar, calls } = harness({ setting: null });
  assert.equal((await ar.onLimit({ sid: "s1" })).why, "off");
  assert.equal(calls.relay.length, 0);
});

test("FEAT-18.6: нет доступной запасной — без передачи (клиент покажет плашку)", async () => {
  const { ar, calls } = harness({ available: async () => false });
  assert.equal((await ar.onLimit({ sid: "s1" })).why, "no-target");
  assert.equal(calls.relay.length, 0);
  assert.equal(ar.isArmed("s1"), false, "без передачи цикл не взводится");
});

test("FEAT-18.6: не чаще раза на ход — лимит на запасной в том же цикле останавливает; ход пользователя открывает новый цикл", async () => {
  const { ar, calls } = harness({ setting: { on: true, order: [GLM, FLASH] } });
  assert.equal((await ar.onLimit({ sid: "s1" })).done, true);
  assert.equal((await ar.onLimit({ sid: "s1" })).why, "cycle");
  assert.equal(calls.relay.length, 1);
  ar.userTurn("s1");
  assert.equal((await ar.onLimit({ sid: "s1" })).done, true);
  assert.equal(calls.relay.length, 2);
  assert.equal((await ar.onLimit({ sid: "s2" })).done, true, "другой чат — свой цикл");
});

test("FEAT-18.6: отказ передачи (ход идёт) — без хода «продолжи» и без взвода", async () => {
  const { ar, calls } = harness({ relayOk: false });
  const r = await ar.onLimit({ sid: "s1" });
  assert.equal(r.why, "relay-failed");
  assert.equal(calls.resume.length, 0);
  assert.equal(ar.isArmed("s1"), false);
});

test("FEAT-18.6: два лимита одного чата одновременно — одна передача", async () => {
  const { ar, calls } = harness();
  await Promise.all([ar.onLimit({ sid: "s1" }), ar.onLimit({ sid: "s1" })]);
  assert.equal(calls.relay.length, 1);
});
