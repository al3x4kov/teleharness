// lib/json-store.js: the crash-safe base of every portal store (TASK-14.17,
// SRV-27). Missing/corrupt files fall back without wiping data; a validate
// REJECTION keeps the file in place (only unparseable JSON moves aside);
// writes report success/failure to the caller; the async twin writes without
// blocking the event loop.
// Run: node --test --test-timeout=60000 tests/json-store.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonStore, writeJsonAtomic, writeJsonAtomicAsync } from "../lib/json-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(path.join(tmpdir(), "zai-json-store-"));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

const freshDir = (name) => {
  const dir = path.join(TMP, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const fallback = () => ({ version: 1, sessions: {} });
const asideOf = (dir, file) => readdirSync(dir).filter((n) => n.startsWith(`${file}.corrupt-`));

// --- readJsonStore -------------------------------------------------------------

test("readJsonStore: missing file → fallback, nothing written", () => {
  const file = path.join(freshDir("missing"), "store.json");
  const logs = [];
  assert.deepEqual(readJsonStore(file, { fallback, log: (m) => logs.push(m) }), { version: 1, sessions: {} });
  assert.equal(existsSync(file), false);
  assert.equal(logs.length, 0, "no file is not an error");
  assert.deepEqual(readJsonStore(null, { fallback }), { version: 1, sessions: {} }, "no path → fallback");
});

test("readJsonStore: corrupt JSON → fallback, moved aside to .corrupt-<ts>, source content preserved", () => {
  const dir = freshDir("corrupt");
  const file = path.join(dir, "store.json");
  writeFileSync(file, '{"version":1,"sessions":{"s":{"messages":[', "utf8");
  const logs = [];
  assert.deepEqual(readJsonStore(file, { fallback, log: (m) => logs.push(m) }), fallback());
  const aside = asideOf(dir, "store.json");
  assert.equal(aside.length, 1, `exactly one .corrupt-<ts> copy: ${aside.join(",")}`);
  assert.equal(readFileSync(path.join(dir, aside[0]), "utf8"), '{"version":1,"sessions":{"s":{"messages":[');
  assert.ok(!existsSync(file), "the corrupt file itself is moved, not left in place");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /corrupt/);
});

test("readJsonStore: leftover tmp file is never read as data (atomicity)", () => {
  const dir = freshDir("tmp-leftover");
  const file = path.join(dir, "store.json");
  writeFileSync(`${file}.4242.tmp`, '{"junk":"from a crashed write"}', "utf8");
  const logs = [];
  assert.deepEqual(readJsonStore(file, { fallback, log: (m) => logs.push(m) }), fallback(), "tmp alone is not data");
  assert.equal(logs.length, 0, "a stray tmp file is not reported as corruption");
  writeFileSync(file, '{"version":1,"sessions":{"real":{}}}', "utf8");
  const raw = readJsonStore(file, { fallback, log: (m) => logs.push(m) });
  assert.deepEqual(Object.keys(raw.sessions), ["real"], "the real file wins over the tmp leftover");
});

test("SRV-27: validate rejects VALID JSON → fallback, file stays in place, no .corrupt copy", () => {
  const dir = freshDir("validate-reject");
  const file = path.join(dir, "store.json");
  const good = JSON.stringify({ version: 1, sessions: { a: {} } });
  writeFileSync(file, good, "utf8");
  const logs = [];
  const raw = readJsonStore(file, {
    fallback,
    validate: () => false, // e.g. a schema change after an upgrade
    log: (m) => logs.push(m),
  });
  assert.deepEqual(raw, fallback(), "fallback is served");
  assert.equal(readFileSync(file, "utf8"), good, "the file is kept on disk untouched");
  assert.equal(asideOf(dir, "store.json").length, 0, "valid JSON is never quarantined");
  assert.equal(logs.length, 1, "the rejection is logged, not silent");
});

test("SRV-27: validate throwing → fallback, file stays in place, no .corrupt copy", () => {
  const dir = freshDir("validate-throw");
  const file = path.join(dir, "store.json");
  writeFileSync(file, '{"anything":true}', "utf8");
  const logs = [];
  const raw = readJsonStore(file, {
    fallback,
    validate: () => {
      throw new Error("boom");
    },
    log: (m) => logs.push(m),
  });
  assert.deepEqual(raw, fallback());
  assert.ok(existsSync(file), "the file survives a throwing validate");
  assert.equal(asideOf(dir, "store.json").length, 0);
  assert.equal(logs.length, 1);
});

test("readJsonStore: valid JSON passing validate → the parsed value", () => {
  const dir = freshDir("valid");
  const file = path.join(dir, "store.json");
  writeFileSync(file, '{"version":1,"sessions":{"a":{"messages":[]}}}', "utf8");
  const raw = readJsonStore(file, {
    fallback,
    validate: (r) => Boolean(r && typeof r === "object" && r.sessions),
  });
  assert.deepEqual(raw, { version: 1, sessions: { a: { messages: [] } } });
});

// --- writeJsonAtomic -----------------------------------------------------------

test("writeJsonAtomic: true on success, exact content on disk, no tmp leftovers", () => {
  const dir = freshDir("write-ok");
  const file = path.join(dir, "store.json");
  assert.equal(writeJsonAtomic(file, { a: 1 }), true);
  assert.equal(readFileSync(file, "utf8"), '{"a":1}');
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
});

test("writeJsonAtomic: false when a parent path component is a file", () => {
  const dir = freshDir("write-fail-nodir");
  const blocker = path.join(dir, "blocker"); // a FILE where a directory is needed
  writeFileSync(blocker, "занято", "utf8");
  const logs = [];
  const file = path.join(blocker, "store.json");
  assert.equal(writeJsonAtomic(file, { a: 1 }, { log: (m) => logs.push(m) }), false, "failure is visible to the caller");
  assert.equal(logs.length, 1);
});

test("writeJsonAtomic: false when the target path is a directory", () => {
  const dir = freshDir("write-fail-isdir");
  const target = path.join(dir, "occupied");
  mkdirSync(target, { recursive: true });
  const logs = [];
  assert.equal(writeJsonAtomic(target, { a: 1 }, { log: (m) => logs.push(m) }), false);
  assert.equal(logs.length, 1);
});

// --- writeJsonAtomicAsync (TASK-13.27) ------------------------------------------

test("writeJsonAtomicAsync: resolves true, content on disk, tmp+rename leaves no leftovers", async () => {
  const dir = freshDir("async-ok");
  const file = path.join(dir, "store.json");
  assert.equal(await writeJsonAtomicAsync(file, { a: "раз" }), true);
  assert.equal(readFileSync(file, "utf8"), '{"a":"раз"}');
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
  await writeJsonAtomicAsync(file, { a: "два" });
  assert.equal(readFileSync(file, "utf8"), '{"a":"два"}', "second write replaces atomically");
});

test("writeJsonAtomicAsync: resolves false when a parent path component is a file", async () => {
  const dir = freshDir("async-fail-nodir");
  const blocker = path.join(dir, "blocker");
  writeFileSync(blocker, "занято", "utf8");
  const logs = [];
  const file = path.join(blocker, "store.json");
  assert.equal(await writeJsonAtomicAsync(file, { a: 1 }, { log: (m) => logs.push(m) }), false);
  assert.equal(logs.length, 1);
});

test("writeJsonAtomicAsync: resolves false when the target path is a directory", async () => {
  const dir = freshDir("async-fail-isdir");
  const target = path.join(dir, "occupied");
  mkdirSync(target, { recursive: true });
  const logs = [];
  assert.equal(await writeJsonAtomicAsync(target, { a: 1 }, { log: (m) => logs.push(m) }), false);
  assert.equal(logs.length, 1);
});
