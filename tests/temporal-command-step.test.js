// Unit & integration tests for command-step.js and model-bridge command routing.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CommandCatalog } from "../lib/temporal/command-catalog.js";
import { pipelineArtifacts } from "../lib/temporal/artifacts.js";
import { buildCleanEnv, createCommandStepRunner } from "../lib/temporal/command-step.js";
import { modelBridge } from "../lib/temporal/model-bridge.js";
import { summarizeRun } from "../lib/temporal/run-summary.js";

const NODE_BIN = realpathSync(process.execPath);
const NODE_DIR = path.dirname(NODE_BIN);

async function makeFixture(t, { slotsLimit = 2, commands = [], platform = process.platform, jailBin = "/nonexistent-jail-bin" } = {}) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "teleharness-cmd-step-")));
  const catalogPath = path.join(dir, "temporal-commands.json");
  const artifactDir = path.join(dir, "artifacts");
  const db = new DatabaseSync(path.join(dir, "test.db"));
  t.after(async () => {
    try { db.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  });

  const scriptsDir = path.join(dir, "scripts");
  await mkdir(scriptsDir, { recursive: true });

  await writeFile(catalogPath, JSON.stringify({ schema: 1, items: commands }, null, 2), "utf8");
  const catalog = new CommandCatalog({ file: catalogPath, allowedRoots: [scriptsDir, NODE_DIR] });
  const results = pipelineArtifacts(db, artifactDir);
  const audits = [];
  const runner = createCommandStepRunner({
    db,
    catalog,
    results,
    artifactDirectory: artifactDir,
    dirAllowed: (_user, d) => d.startsWith(dir),
    slotsLimit,
    tenantHome: path.join(dir, "tenants"),
    auditCommand: (ev) => audits.push(ev),
    platform,
    jailBin,
  });
  return { dir, scriptsDir, catalogPath, artifactDir, db, catalog, results, runner, audits };
}

async function makeNodeScript(scriptsDir, name, jsBody) {
  const p = path.join(scriptsDir, name);
  await writeFile(p, jsBody + "\n", "utf8");
  return p;
}

test("buildCleanEnv strips portal/provider secrets and preserves allowlist + entry.exec.env", () => {
  const fakeEnv = {
    PATH: "/usr/bin:/bin",
    HOME: "/tmp/home",
    LANG: "C.UTF-8",
    TELEHARNESS_SECRET: "secret-2",
    CLAUDE_API_KEY: "secret-3",
    OPENCODE_SERVER_PASSWORD: "secret-4",
    GITHUB_TOKEN: "secret-5",
    PGPASSWORD: "secret-6",
    ANTHROPIC_API_KEY: "secret-7",
    OPENAI_API_KEY: "secret-8",
    RANDOM_UNLISTED: "not-allowed",
  };
  const clean = buildCleanEnv({ REPORT_MODE: "weekly", CUSTOM_FLAG: "1" }, fakeEnv);
  assert.equal(clean.PATH, "/usr/bin:/bin");
  assert.equal(clean.HOME, "/tmp/home");
  assert.equal(clean.REPORT_MODE, "weekly");
  assert.equal(clean.CUSTOM_FLAG, "1");
  for (const k of [
    "TELEHARNESS_SECRET",
    "CLAUDE_API_KEY",
    "OPENCODE_SERVER_PASSWORD",
    "GITHUB_TOKEN",
    "PGPASSWORD",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "RANDOM_UNLISTED",
  ]) {
    assert.equal(clean[k], undefined, `expected ${k} to be stripped`);
  }
});

test("exec command runs without shell (metacharacters stay literal), reads prior step output, and writes artifact", async (t) => {
  const fx = await makeFixture(t);
  const script = await makeNodeScript(
    fx.scriptsDir,
    "echo-args.mjs",
    'const [, , a1 = "", a2 = ""] = process.argv;\nprocess.stdout.write(`ARG1=${a1}|ARG2=${a2}|SEC=${process.env.TELEHARNESS_TEST_SECRET || ""}|CUSTOM=${process.env.MY_ENV || ""}\\n`);',
  );
  fx.catalog.create({
    id: "echo-args",
    name: "Echo args",
    kind: "exec",
    tenantSafe: true,
    allow: { roles: ["admin", "user"] },
    params: [
      { name: "first", required: true },
      { name: "second", required: false },
    ],
    exec: {
      file: NODE_BIN,
      argv: [script, "{{param.first}}", "{{param.second}}"],
      env: { MY_ENV: "ok" },
    },
  });

  await mkdir(fx.artifactDir, { recursive: true });
  await writeFile(path.join(fx.artifactDir, "prev-receipt"), "prev-value", "utf8");
  fx.results.remember("wf-1", "s0", "prev-receipt");

  const prevSecret = process.env.TELEHARNESS_TEST_SECRET;
  process.env.TELEHARNESS_TEST_SECRET = "must-not-leak";
  t.after(() => {
    if (prevSecret === undefined) delete process.env.TELEHARNESS_TEST_SECRET;
    else process.env.TELEHARNESS_TEST_SECRET = prevSecret;
  });

  const res = await fx.runner.runStep({
    user: { id: "admin", role: "admin" },
    workflowId: "wf-1",
    stepId: "s1",
    definition: { directory: fx.dir },
    step: {
      id: "s1",
      type: "command",
      command: "echo-args",
      args: {
        first: "; echo INJECTED $(whoami)",
        second: "{{steps.s0}}",
      },
    },
    inputs: {},
  });

  assert.equal(res.state, "done");
  assert.equal(res.exitCode, 0);
  const saved = await fx.results.read("wf-1", "s1");
  assert.equal(saved.trim(), "ARG1=; echo INJECTED $(whoami)|ARG2=prev-value|SEC=|CUSTOM=ok");

  const meta = fx.runner.commandMeta("wf-1");
  assert.equal(meta.s1.commandId, "echo-args");
  assert.equal(meta.s1.state, "done");
  assert.equal(meta.s1.exitCode, 0);
  assert.ok(meta.s1.durationMs >= 0);

  assert.equal(fx.audits.length, 2);
  assert.equal(fx.audits[0].action, "start");
  assert.equal(fx.audits[1].action, "finish");
  assert.ok(!JSON.stringify(fx.audits).includes("must-not-leak"));
});

test("regex pattern mismatch & missing required param fail non-retryably without spawning", async (t) => {
  const fx = await makeFixture(t);
  const marker = path.join(fx.dir, "spawned.txt");
  const script = await makeNodeScript(
    fx.scriptsDir,
    "mark.mjs",
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "x");`,
  );
  fx.catalog.create({
    id: "strict-param",
    name: "Strict",
    kind: "exec",
    allow: { roles: ["admin"] },
    params: [{ name: "week", required: true, pattern: "^[0-9]{4}-W[0-9]{2}$" }],
    exec: { file: NODE_BIN, argv: [script, "{{param.week}}"] },
  });

  const badPattern = await fx.runner.runStep({
    user: { id: "admin", role: "admin" },
    workflowId: "wf-pat",
    stepId: "s1",
    definition: { directory: fx.dir },
    step: { id: "s1", type: "command", command: "strict-param", args: { week: "2026-BAD" } },
  });
  assert.equal(badPattern.state, "failed");
  assert.equal(badPattern.nonRetryable, true);

  const missing = await fx.runner.runStep({
    user: { id: "admin", role: "admin" },
    workflowId: "wf-miss",
    stepId: "s1",
    definition: { directory: fx.dir },
    step: { id: "s1", type: "command", command: "strict-param", args: {} },
  });
  assert.equal(missing.state, "failed");
  assert.equal(missing.nonRetryable, true);

  assert.equal(existsSync(marker), false);
});

test("tenant isolation fails closed when tenantSafe is false and jail binary is missing", async (t) => {
  const fx = await makeFixture(t, { jailBin: "/does/not/exist/teleharness-tenant-run" });
  const script = await makeNodeScript(fx.scriptsDir, "ok.mjs", 'process.stdout.write("ok\\n");');
  fx.catalog.create({
    id: "unsafe-cmd",
    name: "Unsafe",
    kind: "exec",
    tenantSafe: false,
    allow: { roles: ["admin", "user"] },
    exec: { file: NODE_BIN, argv: [script] },
  });
  fx.catalog.create({
    id: "safe-cmd",
    name: "Safe",
    kind: "exec",
    tenantSafe: true,
    allow: { roles: ["admin", "user"] },
    exec: { file: NODE_BIN, argv: [script] },
  });

  const tenant = { id: "t1", role: "user" };
  const denied = await fx.runner.runStep({
    user: tenant,
    workflowId: "wf-t1",
    stepId: "s1",
    definition: { directory: path.join(fx.dir, "tenants", "t1") },
    step: { id: "s1", type: "command", command: "unsafe-cmd" },
  });
  assert.equal(denied.state, "failed");
  assert.equal(denied.nonRetryable, true);
  assert.match(denied.error, /tenantSafe=false/);

  const allowed = await fx.runner.runStep({
    user: tenant,
    workflowId: "wf-t2",
    stepId: "s1",
    definition: { directory: fx.dir },
    step: { id: "s1", type: "command", command: "safe-cmd" },
  });
  assert.equal(allowed.state, "done");
});

test("abort signal kills process group and records cancelled", async (t) => {
  const fx = await makeFixture(t);
  const script = await makeNodeScript(fx.scriptsDir, "sleep.mjs", "setTimeout(() => {}, 30000);");
  fx.catalog.create({
    id: "sleeper",
    name: "Sleeper",
    kind: "exec",
    allow: { roles: ["admin"] },
    exec: { file: NODE_BIN, argv: [script] },
  });

  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 150);
  const res = await fx.runner.runStep({
    user: { id: "admin", role: "admin" },
    workflowId: "wf-abort",
    stepId: "s1",
    definition: { directory: fx.dir },
    step: { id: "s1", type: "command", command: "sleeper" },
    signal: ac.signal,
  });
  const elapsed = Date.now() - started;
  assert.equal(res.state, "failed");
  assert.equal(res.nonRetryable, true);
  assert.ok(elapsed < 5000, `expected quick cancellation, took ${elapsed}ms`);
  assert.equal(fx.runner.commandMeta("wf-abort").s1.state, "cancelled");
});

test("stdout exceeding 1 MiB is truncated to tail with marker and stays readable via results.read", async (t) => {
  const fx = await makeFixture(t);
  const script = await makeNodeScript(
    fx.scriptsDir,
    "big.mjs",
    'process.stdout.write("A".repeat(1200000) + "TAIL-END-MARKER\\n");',
  );
  fx.catalog.create({
    id: "big-out",
    name: "Big output",
    kind: "exec",
    allow: { roles: ["admin"] },
    exec: { file: NODE_BIN, argv: [script] },
  });

  const res = await fx.runner.runStep({
    user: { id: "admin", role: "admin" },
    workflowId: "wf-big",
    stepId: "s1",
    definition: { directory: fx.dir },
    step: { id: "s1", type: "command", command: "big-out" },
  });
  assert.equal(res.state, "done");
  const text = await fx.results.read("wf-big", "s1");
  assert.ok(Buffer.byteLength(text, "utf8") <= 1024 * 1024);
  assert.ok(text.startsWith("[… усечено до последних 1 МБ …]\n"));
  assert.ok(text.endsWith("TAIL-END-MARKER\n"));
});

test("non-zero exit obeys successWhen (exit0 vs always) and idempotency/uncertain SQLite rules", async (t) => {
  const fx = await makeFixture(t);
  const counterFile = path.join(fx.dir, "count.txt");
  const failScript = await makeNodeScript(
    fx.scriptsDir,
    "fail.mjs",
    'process.stderr.write("boom-stderr\\n"); process.stdout.write("partial-out\\n"); process.exit(7);',
  );
  const countScript = await makeNodeScript(
    fx.scriptsDir,
    "count.mjs",
    `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(counterFile)}, "x\\n"); process.stdout.write("counted\\n");`,
  );
  fx.catalog.create({
    id: "fail-cmd",
    name: "Fail",
    kind: "exec",
    allow: { roles: ["admin"] },
    exec: { file: NODE_BIN, argv: [failScript] },
  });
  fx.catalog.create({
    id: "count-cmd",
    name: "Count",
    kind: "exec",
    allow: { roles: ["admin"] },
    exec: { file: NODE_BIN, argv: [countScript] },
  });

  const f1 = await fx.runner.runStep({
    user: { id: "admin", role: "admin" },
    workflowId: "wf-exit",
    stepId: "s1",
    definition: { directory: fx.dir },
    step: { id: "s1", type: "command", command: "fail-cmd", successWhen: "exit0" },
  });
  assert.equal(f1.state, "failed");
  assert.equal(f1.exitCode, 7);
  assert.equal(f1.nonRetryable, false);
  assert.match(fx.runner.commandMeta("wf-exit").s1.stderrTail, /boom-stderr/);

  const f2 = await fx.runner.runStep({
    user: { id: "admin", role: "admin" },
    workflowId: "wf-always",
    stepId: "s1",
    definition: { directory: fx.dir },
    step: { id: "s1", type: "command", command: "fail-cmd", successWhen: "always" },
  });
  assert.equal(f2.state, "done");
  assert.equal(f2.exitCode, 7);
  assert.equal((await fx.results.read("wf-always", "s1")).trim(), "partial-out");

  const c1 = await fx.runner.runStep({
    user: { id: "admin", role: "admin" },
    workflowId: "wf-idem",
    stepId: "s1",
    definition: { directory: fx.dir },
    step: { id: "s1", type: "command", command: "count-cmd" },
  });
  const c2 = await fx.runner.runStep({
    user: { id: "admin", role: "admin" },
    workflowId: "wf-idem",
    stepId: "s1",
    definition: { directory: fx.dir },
    step: { id: "s1", type: "command", command: "count-cmd" },
  });
  assert.equal(c1.state, "done");
  assert.equal(c2.state, "done");
  assert.equal((await readFile(counterFile, "utf8")).trim().split(/\r?\n/).length, 1);

  fx.db
    .prepare(
      `INSERT INTO command_runs (workflow_id, step, attempt, kind, command_id, state, started_at)
       VALUES ('wf-crash', 's1', 1, 'exec', 'count-cmd', 'running', ?)`,
    )
    .run(Date.now() - 10_000);
  const crashed = await fx.runner.runStep({
    user: { id: "admin", role: "admin" },
    workflowId: "wf-crash",
    stepId: "s1",
    definition: { directory: fx.dir },
    step: { id: "s1", type: "command", command: "count-cmd" },
  });
  assert.equal(crashed.state, "failed");
  assert.equal(crashed.nonRetryable, true);
  assert.equal(fx.runner.commandMeta("wf-crash").s1.state, "uncertain");
  assert.equal((await readFile(counterFile, "utf8")).trim().split(/\r?\n/).length, 1);
});

test("slot semaphore returns slot_wait when limit is reached and runSummary renders slot state", async (t) => {
  const fx = await makeFixture(t, { slotsLimit: 1 });
  const script = await makeNodeScript(fx.scriptsDir, "slow.mjs", 'setTimeout(() => { process.stdout.write("done\\n"); }, 350);');
  fx.catalog.create({
    id: "slow",
    name: "Slow",
    kind: "exec",
    allow: { roles: ["admin"] },
    exec: { file: NODE_BIN, argv: [script] },
  });

  const p1 = fx.runner.runStep({
    user: { id: "admin", role: "admin" },
    workflowId: "wf-slot-1",
    stepId: "s1",
    definition: { directory: fx.dir },
    step: { id: "s1", type: "command", command: "slow" },
  });
  await new Promise((r) => setTimeout(r, 40));
  const p2 = await fx.runner.runStep({
    user: { id: "admin", role: "admin" },
    workflowId: "wf-slot-2",
    stepId: "s1",
    definition: { directory: fx.dir },
    step: { id: "s1", type: "command", command: "slow" },
  });
  assert.equal(p2.state, "slot_wait");
  assert.equal(p2.reason, "command_slots_busy");

  const r1 = await p1;
  assert.equal(r1.state, "done");

  const sum = summarizeRun(
    {
      status: "RUNNING",
      state: { status: "running", steps: { s1: "slot_wait" }, waitReasons: { s1: "command_slots_busy" } },
    },
    [{ id: "s1", name: "Скрипт", type: "command" }],
  );
  assert.equal(sum.kind, "slot");
  assert.equal(sum.current?.id, "s1");
});

test("modelBridge routes step.type === command to commandStep and reports stepOutcome on failure", async (t) => {
  const fx = await makeFixture(t);
  const script = await makeNodeScript(fx.scriptsDir, "hello.mjs", 'process.stdout.write("from-bridge\\n");');
  fx.catalog.create({
    id: "hello",
    name: "Hello",
    kind: "exec",
    allow: { roles: ["admin"] },
    exec: { file: NODE_BIN, argv: [script] },
  });

  const definition = {
    id: "pipe-1",
    name: "Pipe 1",
    directory: fx.dir,
    inputs: [],
    steps: [{ id: "cmd1", type: "command", command: "hello" }],
  };
  const wfId = "11111111-2222-4333-8444-555555555555";
  const outcomes = [];
  const invoke = modelBridge({
    lookupStart: () => ({ owner: "admin", definitionId: "pipe-1", version: 1, inputs: "{}" }),
    getUser: () => ({ id: "admin", role: "admin" }),
    store: { get: () => ({ versions: [{ version: 1, definition }] }) },
    dirAllowed: () => true,
    adapters: {},
    results: fx.results,
    commandStep: fx.runner,
    stepOutcome: (ev) => outcomes.push(ev),
  });

  const out = await invoke("step", { workflowId: wfId, stepId: "cmd1" }, { signal: new AbortController().signal });
  assert.equal(out.state, "done");
  assert.equal((await fx.results.read(wfId, "cmd1")).trim(), "from-bridge");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].error, null);
});
