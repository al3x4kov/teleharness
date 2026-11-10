// BUG-177: keyboard layout prediction — replay of the DEVICE trace (iPhone 17 Pro Max,
// iOS 18.7, standalone): tall 894, keyboard-up 481; Safari reports the new height
// ~130 ms after focus and ~150 ms after blur; offsetTop/scrollY stay 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shellFrame, predictFor, learnKbH } from "../src/lib/kb-predict.js";

const TALL = 894, UP = 481;

test("BUG-177: открытие — с выученной высотой клавиатуры шелл сразу «с клавиатурой», без ожидания Safari", () => {
  const kbH = learnKbH(TALL, UP);
  assert.equal(kbH, 413);
  const pred = predictFor("open", { vvH: TALL, tall: TALL, kbH, now: 0 });
  // устройство: 0–129 мс vv.height ещё 894, со 130 мс — 481
  for (const t of [0, 16, 64, 120]) assert.deepEqual(shellFrame({ vvH: TALL, innerH: TALL, tall: TALL, typing: true, pred, now: t }), { h: UP, kb: true }, `t=${t}`);
  for (const t of [130, 300, 900]) assert.deepEqual(shellFrame({ vvH: UP, innerH: TALL, tall: TALL, typing: true, pred, now: t }), { h: UP, kb: true }, `t=${t}`);
});

test("BUG-177: закрытие — шелл сразу во всю высоту, «режим клавиатуры» снят; поле не висит посередине", () => {
  const pred = predictFor("close", { vvH: UP, tall: TALL, kbH: 413, now: 0 });
  // устройство: 0–152 мс vv.height ещё 481, со 153 мс — 894
  for (const t of [0, 9, 100, 150]) assert.deepEqual(shellFrame({ vvH: UP, innerH: TALL, tall: TALL, typing: false, pred, now: t }), { h: TALL, kb: false }, `t=${t}`);
  assert.deepEqual(shellFrame({ vvH: TALL, innerH: TALL, tall: TALL, typing: false, pred, now: 160 }), { h: TALL, kb: false });
  // без предсказания было бы: 481 и kb=false — поле посреди экрана (кадры #66–#70 видео)
  assert.deepEqual(shellFrame({ vvH: UP, innerH: TALL, tall: TALL, typing: false, now: 9 }), { h: UP, kb: false });
});

test("BUG-177: предсказание не держит экран, если Safari так и не изменил высоту (клавиатура не появилась — внешняя клавиатура)", () => {
  const pred = predictFor("open", { vvH: TALL, tall: TALL, kbH: 413, now: 0 });
  assert.deepEqual(shellFrame({ vvH: TALL, innerH: TALL, tall: TALL, typing: true, pred, now: 800 }), { h: TALL, kb: false });
});

test("BUG-177: нечего предсказывать — первая клавиатура (высота неизвестна), клавиатура уже открыта/закрыта", () => {
  assert.equal(predictFor("open", { vvH: TALL, tall: TALL, kbH: null, now: 0 }), null);
  assert.equal(predictFor("open", { vvH: UP, tall: TALL, kbH: 413, now: 0 }), null);
  assert.equal(predictFor("close", { vvH: TALL, tall: TALL, kbH: 413, now: 0 }), null);
  assert.equal(learnKbH(TALL, TALL - 20), null, "не клавиатура");
  assert.equal(learnKbH(TALL, 50), null, "неправдоподобно");
});

test("BUG-177: innerHeight мигает (на устройстве 481↔894 при поднятой клавиатуре) — высота шелла не прыгает", () => {
  for (const ih of [481, TALL, 481]) assert.equal(shellFrame({ vvH: UP, innerH: ih, tall: TALL, typing: true, now: 1000 }).h, UP);
});
