// FEAT-18.7: каталог Codex — кэш при старте, ответ посредника в фоне, вход
// потерян → выключен, сбой посредника не выключает работающий движок, TELEHARNESS_CODEX=off.
// Run: node --test tests/codex-catalog.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodexCatalog, parseCatalogLine } from "../lib/codex-catalog.js";

const TMP = mkdtempSync(path.join(tmpdir(), "teleharness-codex-cat-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const RAW = [{ id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true }, { id: "gpt-6-astra", displayName: "GPT-6-Astra" }];

// spawn-заглушка: печатает заданную строку и закрывается
function fakeSpawn(line, calls = []) {
  return (cmd, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (line != null) child.stdout.emit("data", Buffer.from(line + "\n"));
      child.emit("close", 0);
    });
    return child;
  };
}
const dirFor = (n) => {
  const d = path.join(TMP, n);
  rmSync(d, { recursive: true, force: true });
  return (writeFileSync(path.join(TMP, ".keep"), ""), d);
};
import { mkdirSync } from "node:fs";

test("parseCatalogLine: вошёл → on с моделями; не вошёл → off; мусор и ok:false → error", () => {
  const on = parseCatalogLine(JSON.stringify({ ok: true, loggedIn: true, plan: "pro", models: RAW }));
  assert.equal(on.state, "on");
  assert.deepEqual(on.models.map((m) => m.id), ["gpt-6.1-sol", "gpt-6-astra"]);
  assert.equal(on.plan, "pro");
  assert.equal(parseCatalogLine(JSON.stringify({ ok: true, loggedIn: false })).state, "off");
  assert.equal(parseCatalogLine("garbage").state, "error");
  const err = parseCatalogLine(JSON.stringify({ ok: false, error: "codex not found" }));
  assert.equal(err.state, "error");
  assert.equal(err.error, "codex not found");
  assert.equal(parseCatalogLine("log line\n" + JSON.stringify({ ok: true, loggedIn: true, models: RAW })).state, "on", "берётся последняя строка");
});

test("старт: кэш сразу, затем ответ посредника обновляет каталог и кэш", async () => {
  const dir = dirFor("start");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "codex-models.json"), JSON.stringify({ models: [{ id: "gpt-old", displayName: "Old" }] }));
  const seen = [];
  const calls = [];
  const cat = createCodexCatalog({ dataDir: dir, env: {}, log: () => {}, onChange: (m) => seen.push(m.map((x) => x.id)), spawnImpl: fakeSpawn(JSON.stringify({ ok: true, loggedIn: true, models: RAW }), calls) });
  cat.load();
  assert.deepEqual(seen[0], ["gpt-old"]);
  await cat.refresh();
  assert.deepEqual(seen.at(-1), ["gpt-6.1-sol", "gpt-6-astra"]);
  assert.ok(calls[0].includes("--teleharness-catalog"));
  const cache = JSON.parse(readFileSync(path.join(dir, "codex-models.json"), "utf8"));
  assert.deepEqual(cache.models.map((m) => m.id), ["gpt-6.1-sol", "gpt-6-astra"]);
});

test("вход потерян → Codex выключен и кэш удалён", async () => {
  const dir = dirFor("logout");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "codex-models.json"), JSON.stringify({ models: RAW }));
  const cat = createCodexCatalog({ dataDir: dir, env: {}, log: () => {}, spawnImpl: fakeSpawn(JSON.stringify({ ok: true, loggedIn: false })) });
  cat.load();
  assert.equal(cat.models().length, 2);
  await cat.refresh();
  assert.equal(cat.models().length, 0);
  assert.equal(existsSync(path.join(dir, "codex-models.json")), false);
});

test("сбой посредника не выключает работающий движок", async () => {
  const dir = dirFor("fail");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "codex-models.json"), JSON.stringify({ models: RAW }));
  const cat = createCodexCatalog({ dataDir: dir, env: {}, log: () => {}, spawnImpl: fakeSpawn(JSON.stringify({ ok: false, error: "timeout" })) });
  cat.load();
  const r = await cat.refresh();
  assert.equal(r.state, "error");
  assert.equal(cat.models().length, 2);
});

test("без кэша и без codex — Codex выключен; TELEHARNESS_CODEX=off — посредник не запускается", async () => {
  const dir = dirFor("none");
  const cat = createCodexCatalog({ dataDir: dir, env: {}, log: () => {}, spawnImpl: fakeSpawn(null) });
  cat.load();
  await cat.refresh();
  assert.equal(cat.models().length, 0);
  const calls = [];
  const off = createCodexCatalog({ dataDir: dir, env: { TELEHARNESS_CODEX: "off" }, log: () => {}, spawnImpl: fakeSpawn("x", calls) });
  off.start();
  await off.refresh();
  off.stop();
  assert.equal(calls.length, 0);
  assert.equal(off.models().length, 0);
});
