// TASK-13.27 (design §5): the claude store is written DEFERRED - a burst of
// turn events collapses into one async write (tmp+rename, never the event
// loop), the wait is capped from the first unsaved change, and flushNow()
// is the immediate sync path for shutdown and tests.
// Run: node --test --test-timeout=60000 tests/claude-store-flush.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { ClaudeRunner } from "../lib/claude.js";
import { writeJsonAtomicAsync } from "../lib/json-store.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const TMP = mkdtempSync(path.join(tmpdir(), "zai-claude-flush-"));
after(() => rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 5000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}
let storeSeq = 0;
const freshStore = () => {
  const dir = path.join(TMP, `data-${++storeSeq}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "claude-sessions.json");
};

const stubHub = () => {
  const events = [];
  return { events, managed: new Set(), markManaged() {}, emit: (event, dir) => events.push({ event, dir }) };
};
const body = (text) => Buffer.from(JSON.stringify({ model: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, parts: [{ type: "text", text }] }));
const fakeRes = () => {
  const res = { code: 0, ended: false, body: "" };
  res.writeHead = (code) => { res.code = code; };
  res.end = (b) => { res.ended = true; res.body = b ?? ""; };
  return res;
};
async function waitIdle(hub, count = 1, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (hub.events.filter((x) => x.event.type === "session.idle").length >= count) return;
    await sleep(50);
  }
  throw new Error("no session.idle");
}

// Runner with tiny intervals (constructor params per design) and a counting
// write backend (test-only injection allowed by TASK-13.27).
function countingRunner({ flushDelayMs, flushMaxMs } = {}) {
  const storePath = freshStore();
  const hub = stubHub();
  const writes = [];
  let onWrite = null; // probe: () => void at write start
  const countingWrite = (file, data, opts) => {
    if (onWrite) onWrite();
    writes.push(Date.now());
    return writeJsonAtomicAsync(file, data, opts);
  };
  const runner = new ClaudeRunner({
    hub,
    storePath,
    binPath: FIXTURE,
    keepaliveMs: 1000,
    log: () => {},
    flushDelayMs,
    flushMaxMs,
    storeWriteAsync: countingWrite,
  });
  return { runner, hub, storePath, writes, setOnWrite: (fn) => { onWrite = fn; } };
}

// (а) A series of N changes in a short time → fewer than N disk writes,
// and the final file carries every change (nothing lost by the batching).
test("deferred flush: N rapid changes collapse into fewer writes, content stays complete", async () => {
  const { runner, hub, storePath, writes } = countingRunner({ flushDelayMs: 40, flushMaxMs: 200 });
  const N = 12;
  for (let i = 1; i <= N; i++) runner.setTitle("s1", `заголовок ${i}`, "user");
  assert.equal(writes.length, 0, "no write while the burst is under the debounce window");
  assert.ok(await waitFor(() => writes.length > 0, 3000), "the debounced write happens");
  assert.ok(await waitFor(() => writes.length > 0 && Date.now() - writes.at(-1) > 200, 3000), "writes settle");
  assert.ok(writes.length < N, `writes ${writes.length} < changes ${N}`);
  const onDisk = JSON.parse(readFileSync(storePath, "utf8"));
  assert.equal(onDisk.sessions.s1.title, `заголовок ${N}`, "the LAST change is on disk");
  // a turn on top: user + answer reach the disk as one complete final state
  const res = fakeRes();
  await runner.dispatch({ res, sid: "s1", dir: TMP, body: body("ECHO привет") });
  assert.equal(res.code, 204);
  await waitIdle(hub, 1);
  await runner.flushNow();
  const stored = JSON.parse(readFileSync(storePath, "utf8")).sessions.s1;
  assert.equal(stored.messages.length, 2, "user + assistant on disk");
  assert.equal(stored.title, `заголовок ${N}`);
});

// (б) flushNow() right after a change → the change is on the disk at once.
test("flushNow writes the current state immediately (and is repeatable)", async () => {
  const { runner, hub, storePath } = countingRunner({ flushDelayMs: 5000, flushMaxMs: 10_000 });
  runner.setTitle("b1", "живой заголовок", "user");
  assert.ok(!existsSync(storePath), "the 5 s debounce has not fired yet");
  const ok = runner.flushNow();
  assert.equal(ok, true);
  assert.equal(JSON.parse(readFileSync(storePath, "utf8")).sessions.b1.title, "живой заголовок");
  assert.equal(runner.flushNow(), true, "a repeated call is safe");
  // a turn finalizes; flushNow right after puts the answer on the disk
  const res = fakeRes();
  await runner.dispatch({ res, sid: "b1", dir: TMP, body: body("hello") });
  await waitIdle(hub, 1);
  runner.flushNow();
  const msgs = JSON.parse(readFileSync(storePath, "utf8")).sessions.b1.messages;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].info.role, "assistant");
});

// (в) A new runner over the same file after flushNow() sees the history.
test("flushNow + new runner on the same store file → history is there", async () => {
  const { runner, hub, storePath } = countingRunner({ flushDelayMs: 5000, flushMaxMs: 10_000 });
  const res = fakeRes();
  await runner.dispatch({ res, sid: "c1", dir: TMP, body: body("привет") });
  await waitIdle(hub, 1);
  runner.flushNow();
  const runner2 = new ClaudeRunner({ hub: stubHub(), storePath, binPath: FIXTURE, keepaliveMs: 1000, log: () => {} });
  const msgs = runner2.messages("c1");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].info.role, "user");
});

// (г) Changes arriving continuously longer than the max window still reach
// the disk while the churn is ongoing (the cap from the first change).
test("continuous changes: a write happens while the churn is still going", async () => {
  const { runner, storePath, writes, setOnWrite } = countingRunner({ flushDelayMs: 30, flushMaxMs: 150 });
  let churning = true;
  let duringChurn = 0;
  setOnWrite(() => { if (churning) duringChurn++; });
  let n = 0;
  const iv = setInterval(() => runner.setTitle("g1", `волна ${++n}`, "user"), 20);
  setTimeout(() => { churning = false; clearInterval(iv); }, 800);
  assert.ok(await waitFor(() => writes.length > 0, 3000), "a write happened under continuous churn");
  await waitFor(() => writes.length > 0 && Date.now() - writes.at(-1) > 300, 3000); // let the tail write land
  assert.ok(duringChurn > 0, `a write landed DURING the churn (duringChurn=${duringChurn})`);
  const onDisk = JSON.parse(readFileSync(storePath, "utf8"));
  assert.match(onDisk.sessions.g1.title, /волна \d+/, "the disk carries a churn state");
});

// (д) The debounce timer must not hold the process: a child marks the store
// dirty and exits its event loop naturally.
test("unref: a pending debounce timer does not keep the process alive", async () => {
  const storePath = freshStore();
  const script = path.join(TMP, "unref-probe.mjs");
  writeFileSync(
    script,
    `import { ClaudeRunner } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "lib", "claude.js")).href)};\n` +
    `const runner = new ClaudeRunner({ storePath: process.argv[2], log: () => {} });\n` +
    `runner.setTitle("d1", "грязно", "user");\n` +
    `// no flushNow, no stop: the unref'd debounce timer must not hold the loop\n`,
    "utf8",
  );
  const child = spawn(process.execPath, [script, storePath], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += String(d); });
  const code = await Promise.race([
    new Promise((r) => child.once("exit", (c) => r(c ?? "signal"))),
    sleep(10_000).then(() => "timeout"),
  ]);
  assert.equal(code, 0, `child must exit on its own, got ${code}; stderr: ${stderr}`);
});
