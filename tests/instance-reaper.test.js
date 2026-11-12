// BUG-195: экземпляры opencode папок чатов освобождаются после простоя (иначе
// каждая когда-либо открытая папка держит serve-экземпляр + пару MCP-процессов).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInstanceReaper } from "../lib/instance-reaper.js";

function setup({ busy = new Set(), protectedDirs = ["C:\\Users\\USER"], failDispose = false } = {}) {
  const disposed = [];
  const logs = [];
  const r = createInstanceReaper({
    idleMs: 30 * 60_000,
    isProtected: (d) => protectedDirs.some((p) => p.toLowerCase() === String(d).replace(/\//g, "\\").toLowerCase()),
    isBusy: async (d) => busy.has(d),
    dispose: async (d) => {
      if (failDispose) throw new Error("upstream down");
      disposed.push(d);
      return true;
    },
    log: (m) => logs.push(m),
  });
  return { r, disposed, logs };
}

const MIN = 60_000;

test("BUG-195: папка без активности дольше idle освобождается, свежая — нет", async () => {
  const { r, disposed } = setup();
  r.touch("C:\\Users\\USER\\.zai-tenants\\Alice\\chat-1", 0);
  r.touch("C:\\Users\\USER\\.zai-tenants\\Carol", 20 * MIN);
  const out = await r.sweep(35 * MIN);
  assert.deepEqual(disposed, ["C:\\Users\\USER\\.zai-tenants\\Alice\\chat-1"]);
  assert.deepEqual(out, { disposed: 1, busy: 0, kept: 1 });
  assert.equal(r.size(), 1, "освобождённая папка больше не отслеживается");
});

test("BUG-195: touch продлевает жизнь; одна папка в разных формах пути — одна запись", async () => {
  const { r, disposed } = setup();
  r.touch("C:\\Users\\USER\\.zai-tenants\\Alice", 0);
  r.touch("C:/Users/USER/.zai-tenants/Alice/", 25 * MIN);
  assert.equal(r.size(), 1);
  await r.sweep(40 * MIN);
  assert.deepEqual(disposed, [], "последняя активность 25 мин → в 40 мин ещё жива");
  await r.sweep(56 * MIN);
  assert.equal(disposed.length, 1);
});

test("BUG-195: папка с идущим ходом не освобождается и остаётся в учёте", async () => {
  const d = "D:\\work\\proj";
  const { r, disposed } = setup({ busy: new Set([d]) });
  r.touch(d, 0);
  const out = await r.sweep(60 * MIN);
  assert.deepEqual(disposed, []);
  assert.equal(out.busy, 1);
  assert.equal(r.size(), 1);
});

test("BUG-195: папка владельца по умолчанию не освобождается никогда", async () => {
  const { r, disposed } = setup();
  r.touch("C:/Users/USER", 0);
  await r.sweep(999 * MIN);
  assert.deepEqual(disposed, []);
  assert.equal(r.size(), 0, "защищённая папка не учитывается вовсе");
});

test("BUG-195: seed — папки индекса чатов с временем старта; пустые и дубли игнорируются", async () => {
  const { r, disposed } = setup();
  r.seed(["C:/a", "C:\\a", "", null, "C:/b"], 0);
  assert.equal(r.size(), 2);
  await r.sweep(31 * MIN);
  assert.equal(disposed.length, 2);
});

test("BUG-195: ошибка upstream при освобождении — запись остаётся, повтор на следующем проходе", async () => {
  const { r, logs } = setup({ failDispose: true });
  r.touch("C:/x", 0);
  const out = await r.sweep(31 * MIN);
  assert.equal(out.disposed, 0);
  assert.equal(r.size(), 1);
  assert.ok(logs.some((l) => /upstream down/.test(l)));
});

test("BUG-195: параллельный sweep не освобождает дважды", async () => {
  const { r, disposed } = setup();
  r.touch("C:/y", 0);
  await Promise.all([r.sweep(31 * MIN), r.sweep(31 * MIN)]);
  assert.equal(disposed.length, 1);
});
