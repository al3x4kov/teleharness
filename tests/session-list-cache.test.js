// BUG-260 п.5 / TASK-261 п.3: список чатов — одновременные одинаковые запросы
// склеиваются в один поход к opencode; при сбое движка — последний удачный
// список не старше staleMs (2 мин), иначе ошибка как раньше (→ 502).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createListCache } from "../lib/list-cache.js";

test("BUG-260: одновременные запросы с одним ключом — один вызов загрузчика", async () => {
  const c = createListCache();
  let calls = 0;
  const load = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return [{ id: "a" }];
  };
  const out = await Promise.all([c.get("", load), c.get("", load), c.get("", load)]);
  assert.equal(calls, 1);
  for (const r of out) assert.deepEqual(r, { value: [{ id: "a" }], stale: false });
  await c.get("", load); // после завершения — новый поход, не вечный кэш
  assert.equal(calls, 2);
});

test("BUG-260: разные ключи (папка админа) не склеиваются", async () => {
  const c = createListCache();
  let calls = 0;
  const load = async () => [calls++];
  await Promise.all([c.get("", load), c.get("/a", load)]);
  assert.equal(calls, 2);
});

test("BUG-260: сбой движка ≤ staleMs — последний удачный список с пометкой stale", async () => {
  let t = 1_000;
  const c = createListCache({ staleMs: 120_000, now: () => t });
  await c.get("", async () => [{ id: "a" }]);
  t += 119_000;
  const r = await c.get("", async () => {
    throw new Error("fetch failed");
  });
  assert.deepEqual(r.value, [{ id: "a" }]);
  assert.equal(r.stale, true);
});

test("BUG-260: сбой движка дольше staleMs или без удачного списка — ошибка как раньше", async () => {
  let t = 1_000;
  const c = createListCache({ staleMs: 120_000, now: () => t });
  await assert.rejects(c.get("", async () => { throw new Error("down"); }), /down/);
  await c.get("", async () => [1]);
  t += 121_000;
  await assert.rejects(c.get("", async () => { throw new Error("down2"); }), /down2/);
});

test("BUG-260: после изменения (bump) новый запрос не присоединяется к старому походу", async () => {
  const c = createListCache();
  let calls = 0;
  let release;
  const slow = () => new Promise((r) => { calls++; release = r; });
  const first = c.get("", slow);
  c.bump(); // например, создан чат
  const second = c.get("", async () => { calls++; return ["new"]; });
  assert.deepEqual((await second).value, ["new"]);
  release(["old"]);
  assert.deepEqual((await first).value, ["old"]);
  assert.equal(calls, 2);
});
