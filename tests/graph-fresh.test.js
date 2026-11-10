// scripts/graph-fresh.mjs — проверка свежести графа graphify (TASK-15.5, REQ-X4006).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkGraph, exitCode, formatReport, newestSource } from "../scripts/graph-fresh.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "graph-fresh.mjs");
const T0 = new Date("2026-11-04T08:00:00Z");
const at = (min) => new Date(T0.getTime() + min * 60_000);

function repo(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "zai-graph-fresh-"));
  for (const [rel, min] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "x");
    utimesSync(abs, at(min), at(min));
  }
  return root;
}

test("fresh: граф новее всех исходников → exit 0", (t) => {
  const root = repo({ "server.js": 1, "lib/hub.js": 2, "src/components/chat/Composer.jsx": 3, "graphify-out/graph.json": 10 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = checkGraph(root);
  assert.equal(r.status, "fresh");
  assert.equal(r.newest.file, "src/components/chat/Composer.jsx");
  assert.equal(exitCode(r), 0);
  assert.match(formatReport(r), /^graph-fresh: OK/);
});

test("stale: правка в lib/ после графа → exit 1, назван файл и отставание", (t) => {
  const root = repo({ "server.js": 1, "graphify-out/graph.json": 5, "lib/claude.js": 12 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = checkGraph(root);
  assert.equal(r.status, "stale");
  assert.equal(r.newest.file, "lib/claude.js");
  assert.equal(r.lagMs, 7 * 60_000);
  assert.equal(exitCode(r), 1);
  assert.match(formatReport(r), /STALE .*lib\/claude\.js.*7 мин.*graphify update \./);
});

test("missing: графа нет → exit 2", (t) => {
  const root = repo({ "server.js": 1 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = checkGraph(root);
  assert.equal(r.status, "missing");
  assert.equal(exitCode(r), 2);
});

test("не исходники не считаются: md, css, node_modules, ops/certs, public, data", (t) => {
  const root = repo({
    "lib/a.js": 1,
    "graphify-out/graph.json": 5,
    "docs/architecture.md": 20,
    "src/app.css": 20,
    "lib/node_modules/x/index.js": 20,
    "ops/certs/key.ps1": 20,
    "public/app.js": 20,
    "data/users.js": 20,
    "tests/new.test.js": 20,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(newestSource(root).file, "lib/a.js");
  assert.equal(checkGraph(root).status, "fresh");
});

test("CLI: --root/--json, код выхода совпадает с вердиктом", (t) => {
  const root = repo({ "shared/engine.js": 9, "graphify-out/graph.json": 4 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [SCRIPT, `--root=${root}`, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "stale");
  assert.equal(out.newest.file, "shared/engine.js");
});
