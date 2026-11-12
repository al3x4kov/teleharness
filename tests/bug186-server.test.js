// BUG-186 / BUG-07.23: чат, удалённый через портал во время хода, обязан сразу
// перестать быть «занятым» в хабе. Прод-сценарий 2026-11-07: DELETE вернул 200,
// но SSE-поток папки пробы хаб не слушал — session.deleted от opencode не дошёл,
// и /zai/api/status с healthz.hub.busy врали 4 часа, блокируя тихое окно выката.
// Фейк ниже при удалении НЕ шлёт session.deleted по /event (не шлёт вообще
// ничего) — только настоящий DELETE upstream-а, как в проде. Правка: маршрут
// DELETE сам сообщает хабу (hub.emit session.deleted) — та же очистка, что по
// событию. Run: node --test --test-concurrency=1 tests/bug186-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import { waitFor } from "./helpers/wait.mjs"; // BUG-222/QA-07: ждать условие, а не паузу

const ADMIN = "a".repeat(24) + "-bug186-" + "6".repeat(24);
const FLASH = { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" };
const CATALOG = {
  all: [{ id: "zai-coding-plan", name: "Z.AI", models: { "glm-5.3-flash": { id: "glm-5.3-flash", name: "GLM 5.3 Flash", capabilities: { input: { text: true, image: true } } } } }],
  connected: ["zai-coding-plan"],
  default: { "zai-coding-plan": "glm-5.3-flash" },
};

let up, srv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, { method = "GET", body } = {}) =>
  fetch(srv.base + p, { method, headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });

before(async () => {
  up = await startFakeOpencode();
  let n = 0;
  up.route("GET", "/provider", () => ({ json: CATALOG }));
  up.route("GET", "/config", () => ({ json: { model: "zai-coding-plan/glm-5.3-flash", default_agent: "orchestrator" } }));
  up.route("GET", "/agent", () => ({ json: [{ name: "orchestrator", mode: "primary", permission: [] }] }));
  up.route("POST", "/session", (req, body, url) => {
    const s = { id: `ses_b186_${++n}`, directory: url.searchParams.get("directory"), title: "t", time: { created: Date.now(), updated: Date.now() } };
    up.state.sessions.push(s);
    return { json: s };
  });
  // Настоящее удаление upstream-ом — БЕЗ события session.deleted в /event
  // (у фейка нет исходящих SSE-кадров вовсе): хаб узнаёт, только если портал
  // скажет ему сам.
  up.fallback((req, body, url) => {
    if (req.method !== "DELETE" || !/^\/session\/ses_b186_\d+$/.test(url.pathname)) return undefined;
    const id = decodeURIComponent(url.pathname.split("/")[2]);
    up.state.sessions = up.state.sessions.filter((s) => s.id !== id);
    delete up.state.status[id];
    return { json: true };
  });
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN } });
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
});

async function create() {
  const s = await (await api("/zai/api/session", { method: "POST", body: { model: FLASH, agent: "orchestrator" } })).json();
  assert.ok(s.id, JSON.stringify(s));
  return s.id;
}
const healthz = async () => (await api("/zai/api/healthz")).json();

// healthz — без кэша: hub.busy считает ровно hub.busySnapshot() (server.js).
// Ждём 1, пока хаб сам не увидит busy по /session/status (syncDirectories
// дёргается после каждого POST /session) — этим доказываем, что busy-запись
// живёт именно в хабе, а не только в кэше /status.
async function waitHubBusy(n, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const h = await healthz();
    if (h.hub?.busy === n) return h;
    await sleep(100);
  }
  return healthz();
}

test("BUG-186: DELETE через портал снимает busy сразу — без session.deleted по SSE", async () => {
  const busyId = await create();
  const dir = up.state.sessions.find((s) => s.id === busyId)?.directory ?? null;
  const otherId = await create(); // его POST дёргает hub.syncDirectories: посев busy

  // Чат становится busy: upstream отвечает /session/status {busy} — так хаб
  // и сеет busy-знание (lib/hub.js #seedBusy). Никаких реальных ходов.
  up.state.status = { [busyId]: { type: "busy" } };
  const h = await waitHubBusy(1);
  assert.equal(h.hub?.busy, 1, `хаб держит busy-запись удалённого чата: ${JSON.stringify(h.hub)}`);
  const statusBefore = (await (await api("/zai/api/status")).json())[busyId];
  assert.equal(statusBefore?.type, "busy");

  // Админский SSE-клиент: увидит session.deleted, который маршрут испускает сам.
  const sse = fetch(`${srv.base}/zai/api/event`, { headers: { authorization: `Bearer ${ADMIN}` } });
  const reader = (await sse).body.getReader();
  const frames = [];
  const pump = (async () => {
    try {
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (line) frames.push(JSON.parse(line.slice(6)));
        }
      }
    } catch {}
  })();

  const del = await api(`/zai/api/session/${busyId}`, { method: "DELETE" });
  assert.equal(del.status, 200, await del.text());
  assert.ok(up.requests.some((rq) => rq.method === "DELETE" && rq.path === `/session/${busyId}` && rq.directory === dir), "upstream получил DELETE с папкой чата");

  // «Сразу»: healthz без кэша — busy должен уйти, не дожидаясь ничего.
  let after = null;
  for (let i = 0; i < 50; i++) {
    after = await healthz();
    if (after.hub?.busy === 0) break;
    await sleep(100);
  }
  assert.equal(after.hub?.busy, 0, `healthz.hub.busy после DELETE: ${JSON.stringify(after.hub)}`);

  // /zai/api/status: кэш на 3 с — ждём перестройку и absence.
  let gone = false;
  for (let i = 0; i < 60 && !gone; i++) {
    const st = (await (await api("/zai/api/status")).json());
    gone = !(busyId in st);
    if (!gone) await sleep(200);
  }
  assert.ok(gone, "удалённого чата больше нет в /zai/api/status");

  // Событие, испущенное маршрутом, дошло до клиента с папкой чата (QA-07:
  // ждём сам кадр, а не фиксированные 300 мс).
  await waitFor(
    () => frames.some((f) => f.type === "session.deleted" && f.properties?.sessionID === busyId),
    { label: "session.deleted в SSE-потоке" },
  );
  reader.cancel().catch(() => {});
  await pump.catch(() => {});
  const deleted = frames.filter((f) => f.type === "session.deleted" && f.properties?.sessionID === busyId);
  assert.equal(deleted.length, 1, `клиент получил один session.deleted: ${JSON.stringify(frames.map((f) => f.type))}`);
  assert.equal(deleted[0].properties?.info?.directory, dir, "событие несёт папку чата");

  // Фейк не слал session.deleted: выживший чат по-прежнему на месте и жив.
  assert.ok(up.state.sessions.some((s) => s.id === otherId));
});
