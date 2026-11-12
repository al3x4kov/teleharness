// BUG-215 (BUG-13.26): молчаливые потери Claude-хода.
// (а) buildTurn: отказ записи вложения (пустой catch) — ни промпт, ни история
//     не узнают об этом; ждём видимую пометку в обоих.
// (б) dispatch: обрезанное JSON-тело превращалось в пустой ход (204) — ждём
//     400 {error:"bad json body"} до любых записей в стор и запуска CLI.
// (в) валидное тело работает как раньше (регресс).
// Run: node --test --test-timeout=60000 tests/claude-bad-input.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const TMP = mkdtempSync(path.join(tmpdir(), "zai-claude-bad-input-"));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let storeSeq = 0;
const freshStore = () => {
  const dir = path.join(TMP, `data-${++storeSeq}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "claude-sessions.json");
};

// --- (а) buildTurn: сессия-каталог — существующий ФАЙЛ → mkdirSync падает ---

test("BUG-215: buildTurn при отказе записи вложения оставляет пометку в промпте и в stored", async () => {
  const { buildTurn } = await import("../lib/claude.js");
  const notADir = path.join(TMP, "session-dir-is-a-file");
  writeFileSync(notADir, "занято");
  const png = "data:image/png;base64," + Buffer.from("pngbytes").toString("base64");
  const parts = [
    { type: "text", text: "вопрос" },
    { type: "file", mime: "image/png", filename: "shot (1).png", url: png },
  ];
  const { prompt, stored } = buildTurn(parts, notADir);
  assert.ok(prompt.includes("[вложение не сохранено: shot (1).png]"), prompt);
  assert.ok(stored.some((p) => p.type === "text" && p.text.includes("[вложение не сохранено: shot (1).png]")), JSON.stringify(stored));
  // base64 наружу не утекает, ссылок на несуществующий файл нет
  assert.equal(JSON.stringify(stored).includes("data:"), false);
  assert.equal(JSON.stringify(stored).includes(".zai-uploads/"), false);
});

// --- (б/в) dispatch: фейковый CLI + заглушка хаба, как в tests/claude.test.js ---

function stubHub() {
  const events = [];
  return {
    events,
    markManaged: () => {},
    emit: (event, dir) => events.push({ event, dir }),
  };
}

const body = (text) => Buffer.from(JSON.stringify({ model: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, parts: [{ type: "text", text }] }));

const fakeRes = () => {
  const res = { code: 0, ended: false, body: "" };
  res.writeHead = (code) => {
    res.code = code;
  };
  res.end = (b) => {
    res.ended = true;
    res.body = b ?? "";
  };
  return res;
};

async function waitIdle(hub, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hub.events.some((x) => x.event.type === "session.idle")) return;
    await sleep(50);
  }
  throw new Error("no session.idle within timeout; events: " + hub.events.map((x) => x.event.type).join(","));
}

test("BUG-215: dispatch с обрезанным JSON-телом — 400 bad json body, стор чист, CLI не запускался", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 50 });
  for (const bad of ['{"parts":[', "", "null", '{"model":{"modelID":"claude-haiku-4-5"}}']) {
    const res = fakeRes();
    await runner.dispatch({ res, sid: "bad1", dir: TMP, body: Buffer.from(bad, "utf8") });
    assert.equal(res.code, 400, `body=${JSON.stringify(bad)}`);
    assert.deepEqual(JSON.parse(res.body), { error: "bad json body" });
  }
  assert.equal(runner.has("bad1"), false, "в сторе ничего не появилось");
  assert.equal(hub.events.length, 0, "ход не стартовал: ни одного события хаба");
});

test("BUG-215: валидное тело работает как раньше (204, ответ в истории)", async () => {
  const { ClaudeRunner } = await import("../lib/claude.js");
  const hub = stubHub();
  const runner = new ClaudeRunner({ hub, storePath: freshStore(), binPath: FIXTURE, keepaliveMs: 50 });
  const res = fakeRes();
  await runner.dispatch({ res, sid: "ok1", dir: TMP, body: body("hello") });
  assert.equal(res.code, 204);
  await waitIdle(hub);
  const msgs = runner.messages("ok1");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].info.role, "user");
  const textOf = (m) => (m?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n\n");
  assert.equal(textOf(msgs[1]), "Привет, мир!");
});
