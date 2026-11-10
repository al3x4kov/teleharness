// BUG-177: device keyboard trace store (lib/kb-trace.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeKbTrace, MAX_PER_DAY } from "../lib/kb-trace.js";

test("BUG-177: storeKbTrace — jsonl per day, shape check, size and daily caps", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kbtrace-"));
  try {
    const now = new Date("2026-11-05T20:40:00Z");
    assert.equal(storeKbTrace(dir, null, { now }).status, 400);
    assert.equal(storeKbTrace(dir, { frames: "x" }, { now }).status, 400);
    assert.equal(storeKbTrace(dir, { kind: "focus", frames: [{ t: 0, vvH: 956 }] }, { now }).status, 204);
    const lines = readFileSync(path.join(dir, "kb-trace-20261105.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).frames[0].vvH, 956);
    assert.equal(storeKbTrace(dir, { frames: Array.from({ length: 5000 }, (_, i) => ({ t: i, pad: "x".repeat(40) })) }, { now }).status, 413);
    for (let i = 1; i < MAX_PER_DAY; i++) storeKbTrace(dir, { frames: [] }, { now });
    assert.equal(storeKbTrace(dir, { frames: [] }, { now }).status, 429);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
