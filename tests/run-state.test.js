// TASK-12.29 (wave2): unit — lib/run-state.js: run-state.json remembers
// whether the previous run ended cleanly. markStarted → clean:false;
// markClean → clean:true; a killed run reads back as crashed; no file = no
// crash. Run: node --test tests/run-state.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { markClean, markStarted, readPrevious } from "../lib/run-state.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "zai-run-state-"));

test("readPrevious: no file means no crash (first boot)", () => {
  const dir = tmp();
  try {
    assert.deepEqual(readPrevious(dir), { crashed: false, startedAt: null, pid: null });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("markStarted writes {pid, startedAt, clean:false} atomically; readPrevious reports a crash", () => {
  const dir = tmp();
  try {
    markStarted(dir);
    const f = path.join(dir, "run-state.json");
    assert.ok(existsSync(f));
    const raw = JSON.parse(readFileSync(f, "utf8"));
    assert.equal(raw.pid, process.pid);
    assert.equal(raw.clean, false);
    assert.ok(typeof raw.startedAt === "string" && !Number.isNaN(Date.parse(raw.startedAt)), "startedAt is an ISO string");
    const prev = readPrevious(dir);
    assert.equal(prev.crashed, true);
    assert.equal(prev.pid, process.pid);
    assert.equal(prev.startedAt, raw.startedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("markClean flips clean to true, keeps startedAt; readPrevious then sees no crash", () => {
  const dir = tmp();
  try {
    markStarted(dir);
    markClean(dir);
    const raw = JSON.parse(readFileSync(path.join(dir, "run-state.json"), "utf8"));
    assert.equal(raw.clean, true);
    assert.equal(raw.pid, process.pid);
    const prev = readPrevious(dir);
    assert.equal(prev.crashed, false);
    assert.equal(prev.startedAt, raw.startedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a corrupt run-state.json is not evidence of a crash (half-writes are impossible via writeJsonAtomic)", () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, "run-state.json"), "{not json", "utf8");
    assert.equal(readPrevious(dir).crashed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// TASK-12.29: плановый рестарт (выкат) убивает процесс без сигнала — деплой-скрипт
// заранее ставит отметку чистого завершения, чтобы старт не сообщал о «сбое».
test("плановый рестарт: ops/deploy/mark-planned-restart.mjs снимает признак сбоя", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const cp = await import("node:child_process");
  const { markStarted, readPrevious } = await import("../lib/run-state.js");
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), "zai-runstate-planned-"));
  try {
    markStarted(dir);
    assert.equal(readPrevious(dir).crashed, true, "идущий запуск без отметки выглядел бы сбоем");
    const script = nodePath.resolve(import.meta.dirname, "..", "ops", "deploy", "mark-planned-restart.mjs");
    const run = cp["spawn" + "Sync"](process.execPath, [script, dir], { encoding: "utf8", timeout: 15000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout.trim()).ok, true);
    assert.equal(readPrevious(dir).crashed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
