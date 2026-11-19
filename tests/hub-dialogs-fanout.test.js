// BUG-260 (BUG-12.34): GET /teleharness/api/dialogs → hub.collectDialogs() на v2 опрашивал
// вопросы/разрешения КАЖДОЙ известной папки с location[directory]; opencode 2.2.6
// поднимал на каждую экземпляр с MCP-процессами → OOM службы (прод 2026-11-19,
// 36 папок, лимит 3 ГБ) → «Не удалось загрузить чаты». Теперь — только папки
// занятых сессий и папки вопросов, уже известных хабу; одновременные вызовы — один поход.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventHub } from "../lib/hub.js";
import { createOcClient } from "../lib/oc-client.js";
import { startFakeOpencodeV2 } from "./helpers/fake-opencode-v2.mjs";

const PWD = "oc2-secret";
const DIRS = Array.from({ length: 12 }, (_, i) => `/work/tenants/t${i}`);
const cleanups = [];
after(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await sleep(20);
  }
}
const dialogReqs = (up) => up.requests.filter((r) => r.path === "/api/form" || r.path === "/api/permission/request");
const locOf = (r) => r.queryEntries.find(([k]) => k === "location[directory]")?.[1] ?? null;

async function setup({ active = {}, forms = [] } = {}) {
  const up = await startFakeOpencodeV2({
    password: PWD,
    sessions: DIRS.map((d, i) => ({ id: `ses_${i}`, location: { directory: d } })),
    active,
    forms,
  });
  const oc = createOcClient({ api: "v2", base: up.url, password: PWD });
  // большой directoryPollMs: в тесте работает только стартовый syncDirectories
  const hub = new EventHub({ directoryPollMs: 3_600_000, oc });
  hub.start(up.url, { directories: [DIRS[0]] });
  cleanups.push(async () => {
    hub.stop();
    await up.close();
  });
  await hub.syncDirectories(); // как server.js после hub.start
  assert.equal(hub.directories().length, DIRS.length);
  return { hub, up };
}

test("BUG-260: v2 collectDialogs без занятых сессий не обращается ни к одной папке", async () => {
  const { hub, up } = await setup();
  up.requests.length = 0;
  const out = await hub.collectDialogs();
  assert.deepEqual(out, []);
  assert.equal(dialogReqs(up).length, 0, `запросы с location: ${dialogReqs(up).map(locOf).join(", ")}`);
});

test("BUG-260: v2 collectDialogs — вопрос занятой сессии виден, опрошена только её папка", async () => {
  const { hub, up } = await setup({
    active: { ses_5: { type: "running" } },
    forms: [{ id: "form_5", sessionID: "ses_5", title: "Продолжить?", fields: [] }],
  });
  up.requests.length = 0;
  const out = await hub.collectDialogs();
  assert.ok(out.some((e) => e.id === "form_5" && e.directory === DIRS[5]), JSON.stringify(out));
  assert.deepEqual([...new Set(dialogReqs(up).map(locOf))], [DIRS[5]]);
});

test("BUG-260: одновременные collectDialogs — один поход в opencode", async () => {
  const { hub, up } = await setup({ active: { ses_3: { type: "running" } } });
  up.requests.length = 0;
  const [a, b, c] = await Promise.all([hub.collectDialogs(), hub.collectDialogs(), hub.collectDialogs()]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(dialogReqs(up).length, 2, "одна папка × (форма + разрешение)");
  assert.equal(up.requests.filter((r) => r.path === "/api/session/active").length, 1, "одна карта занятости");
});
