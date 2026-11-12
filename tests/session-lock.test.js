// BUG-218 (BUG-12.27, design §1): блокировка на чат — цепочка промисов на id.
// Контракт: задачи одного id идут строго по очереди; ошибка задачи доходит до
// её вызывающего и НЕ ломает очередь; запись очереди удаляется из карты, когда
// очередь пуста (нет утечки на длинных сессиях). Отдельно — флаг «идёт откат»,
// который проверяет старт хода (409 revert in progress).
// Run: node --test tests/session-lock.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearReverting, isReverting, lockQueueSize, markReverting, withSessionLock } from "../lib/session-lock.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("withSessionLock сериализует задачи одного id в порядке вызова", async () => {
  const events = [];
  const p1 = withSessionLock("a", async () => {
    events.push("s1");
    await sleep(50);
    events.push("e1");
  });
  const p2 = withSessionLock("a", async () => {
    events.push("s2");
  });
  await Promise.all([p1, p2]);
  assert.deepEqual(events, ["s1", "e1", "s2"], "вторая задача ждёт конца первой");
});

test("ошибка задачи доходит до вызывающего и не ломает очередь", async () => {
  await assert.rejects(
    withSessionLock("b", async () => {
      throw new Error("first failed");
    }),
    /first failed/,
  );
  const events = [];
  await withSessionLock("b", () => events.push("next-runs"));
  assert.deepEqual(events, ["next-runs"], "очередь пережила отказ");
});

test("разные id не блокируют друг друга", async () => {
  const order = [];
  const slow = withSessionLock("c1", async () => {
    await sleep(50);
    order.push("c1");
  });
  const fast = withSessionLock("c2", () => order.push("c2"));
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["c2", "c1"], "чужой лок не ждёт");
});

test("после завершения всех задач внутренняя карта пуста", async () => {
  await withSessionLock("d", async () => {
    await sleep(10);
  });
  await withSessionLock("e", () => {});
  // последний хвост мог осесть на микро-задаче — даём циклу обороты
  await sleep(10);
  assert.equal(lockQueueSize(), 0, "нет утечки записей очереди");
});

test("markReverting / clearReverting / isReverting", () => {
  assert.equal(isReverting("s"), false);
  markReverting("s");
  assert.equal(isReverting("s"), true);
  clearReverting("s");
  assert.equal(isReverting("s"), false);
});
