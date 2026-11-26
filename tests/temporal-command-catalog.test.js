// Command catalog validation, symlink escape protection,
// role projection, CRUD, schedule discovery, admin routes and audit logging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommandCatalog, commandAllowed, projectCommand, validateCommandEntry } from "../lib/temporal/command-catalog.js";
import { auditTemporalCommand } from "../lib/accesslog.js";
import { temporalRoutes } from "../routes/temporal.js";
import { adminRoutes } from "../routes/admin.js";
import { dispatchRoute, validateTable } from "../routes/router.js";

function setupFixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "teleharness-cmd-cat-")));
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  const data = path.join(root, "data");
  mkdirSync(allowed, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(data, { recursive: true });

  const okScript = path.join(allowed, "ok.sh");
  writeFileSync(okScript, "#!/bin/sh\necho ok\n", "utf8");
  chmodSync(okScript, 0o755);

  const noExecScript = path.join(allowed, "noexec.sh");
  writeFileSync(noExecScript, "#!/bin/sh\necho no\n", "utf8");
  chmodSync(noExecScript, 0o644);

  const outsideScript = path.join(outside, "evil.sh");
  writeFileSync(outsideScript, "#!/bin/sh\necho evil\n", "utf8");
  chmodSync(outsideScript, 0o755);

  const escapeLink = path.join(allowed, "escape.sh");
  let hasSymlink = false;
  try {
    symlinkSync(outsideScript, escapeLink);
    hasSymlink = true;
  } catch {}

  const catalogFile = path.join(data, "temporal-commands.json");
  return {
    root,
    allowed,
    outside,
    catalogFile,
    okScript,
    noExecScript,
    outsideScript,
    escapeLink,
    hasSymlink,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const ADMIN = { id: "admin-1", role: "admin" };
const TENANT = { id: "alice", role: "user" };
const OTHER_TENANT = { id: "bob", role: "user" };

test("CommandCatalog: missing file is an empty valid catalog; corrupt JSON yields 503", () => {
  const f = setupFixture();
  try {
    const cat = new CommandCatalog({ file: f.catalogFile, allowedRoots: [f.allowed] });
    assert.equal(cat.status().status, "ok");
    assert.deepEqual(cat.listForUser(ADMIN), []);
    assert.equal(cat.hasAnyForUser(ADMIN), false);

    writeFileSync(f.catalogFile, "{broken json", "utf8");
    const reload = cat.reload();
    assert.equal(reload.ok, false);
    assert.equal(cat.status().status, "corrupted");
    assert.throws(() => cat.listForUser(ADMIN), (err) => err.status === 503);
    assert.throws(() => cat.get("anything"), (err) => err.status === 503);
    assert.equal(cat.hasAnyForUser(ADMIN), false);
  } finally {
    f.cleanup();
  }
});

test("validateCommandEntry: rejects relative path, non-executable, outside root, symlink escape, invalid regex, bad temporal XOR", () => {
  const f = setupFixture();
  try {
    const baseExec = {
      id: "run-check",
      name: "Проверка",
      kind: "exec",
      exec: { file: f.okScript, argv: ["--date", "{{param.date}}"], env: { NO_PROXY: "*" } },
      params: [{ name: "date", required: true, pattern: "^\\d{4}-\\d{2}-\\d{2}$" }],
    };
    assert.equal(validateCommandEntry(baseExec, { allowedRoots: [f.allowed] }).valid, true);

    // Relative path
    assert.equal(validateCommandEntry({ ...baseExec, exec: { file: "ok.sh" } }, { allowedRoots: [f.allowed] }).valid, false);
    // Not executable (POSIX chmod -x check)
    if (process.platform !== "win32") {
      assert.equal(validateCommandEntry({ ...baseExec, exec: { file: f.noExecScript } }, { allowedRoots: [f.allowed] }).valid, false);
    }
    // Outside root
    assert.equal(validateCommandEntry({ ...baseExec, exec: { file: f.outsideScript } }, { allowedRoots: [f.allowed] }).valid, false);
    // Symlink escape outside allowed roots
    if (f.hasSymlink) {
      const esc = validateCommandEntry({ ...baseExec, exec: { file: f.escapeLink } }, { allowedRoots: [f.allowed] });
      assert.equal(esc.valid, false);
      assert.match(esc.errors.join(" "), /разрешённых корней|симлинк/i);
    }
    // Invalid regex
    assert.equal(validateCommandEntry({ ...baseExec, params: [{ name: "x", pattern: "[unclosed" }] }, { allowedRoots: [f.allowed] }).valid, false);
    // Reserved param name
    assert.equal(validateCommandEntry({ ...baseExec, params: [{ name: "__proto__" }] }, { allowedRoots: [f.allowed] }).valid, false);

    // temporal-workflow XOR
    const wfSchedule = {
      id: "ext-sched",
      name: "Внешний отчёт",
      kind: "temporal-workflow",
      temporal: { address: "127.0.0.1:7233", namespace: "default", schedule: "daily-job", uiBase: "http://localhost:8233" },
    };
    const rSched = validateCommandEntry(wfSchedule, { allowedRoots: [f.allowed] });
    assert.equal(rSched.valid, true);
    assert.equal(rSched.entry.temporal.cancelChild, true);

    // Both schedule and workflow -> invalid
    assert.equal(
      validateCommandEntry({ ...wfSchedule, temporal: { ...wfSchedule.temporal, workflow: "RunWf", taskQueue: "q" } }, { allowedRoots: [f.allowed] }).valid,
      false,
    );
    // Neither schedule nor workflow -> invalid
    assert.equal(
      validateCommandEntry({ ...wfSchedule, temporal: { address: "127.0.0.1:7233", namespace: "default" } }, { allowedRoots: [f.allowed] }).valid,
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("CommandCatalog: role filtering and non-admin projection hide exec.file/env and temporal.address", () => {
  const f = setupFixture();
  try {
    const cat = new CommandCatalog({ file: f.catalogFile, allowedRoots: [f.allowed] });
    cat.create({
      id: "admin-script",
      name: "Скрипт админа",
      kind: "exec",
      exec: { file: f.okScript, argv: ["--flag"], env: { MY_VAR: "secret-val" } },
      allow: { roles: ["admin"], users: [] },
    });
    cat.create({
      id: "tenant-script",
      name: "Скрипт тенанта",
      kind: "exec",
      exec: { file: f.okScript, argv: ["--user"], env: { INTERNAL_ENV: "val" } },
      allow: { roles: ["admin"], users: ["alice"] },
      tenantSafe: true,
    });
    cat.create({
      id: "shared-wf",
      name: "Общий workflow",
      kind: "temporal-workflow",
      temporal: { address: "127.0.0.1:7233", namespace: "prod-ns", schedule: "nightly-sync", uiBase: "http://localhost:8233" },
      allow: { roles: ["admin", "user"], users: [] },
    });

    const adminView = cat.listForUser(ADMIN);
    assert.equal(adminView.length, 3);
    assert.equal(adminView[0].exec.file, f.okScript);
    assert.equal(adminView[2].temporal.address, "127.0.0.1:7233");

    const aliceView = cat.listForUser(TENANT);
    assert.deepEqual(aliceView.map((x) => x.id), ["tenant-script", "shared-wf"]);
    for (const item of aliceView) {
      assert.equal("exec" in item, false, "non-admin must not receive exec");
      assert.equal("temporal" in item, false, "non-admin must not receive temporal address/namespace");
      assert.equal("allow" in item, false, "non-admin must not receive allow ACL");
    }

    const bobView = cat.listForUser(OTHER_TENANT);
    assert.deepEqual(bobView.map((x) => x.id), ["shared-wf"]);
  } finally {
    f.cleanup();
  }
});

test("CommandCatalog: CRUD atomic persistence, auto-slug id, update, delete, and listExternalSchedules", async () => {
  const f = setupFixture();
  try {
    let calls = [];
    const cat = new CommandCatalog({
      file: f.catalogFile,
      allowedRoots: [f.allowed],
      cli: "/bin/temporal",
      address: "127.0.0.1:7233",
      namespace: "default",
      execute: async (bin, args) => {
        calls.push([bin, args]);
        return JSON.stringify([
          { scheduleId: "nightly-report", info: { workflowType: { name: "ReportWorkflow" }, paused: false } },
          { scheduleId: "paused-job", state: { paused: true }, action: { startWorkflow: { workflowType: { name: "SyncWorkflow" } } } },
        ]);
      },
    });

    const created = cat.create({
      name: "Синхронизация данных",
      kind: "exec",
      exec: { file: f.okScript, argv: [] },
    });
    assert.match(created.id, /^[a-z][a-z0-9-]{0,63}$/);
    const rawOnDisk = JSON.parse(readFileSync(f.catalogFile, "utf8"));
    assert.equal(rawOnDisk.schema, 1);
    assert.equal(rawOnDisk.items.length, 1);

    // Duplicate id rejected with 409
    assert.throws(() => cat.create({ id: created.id, name: "Dup", kind: "exec", exec: { file: f.okScript } }), (e) => e.status === 409);

    // Update
    const updated = cat.update(created.id, { name: "Новое имя", kind: "exec", exec: { file: f.okScript, argv: ["--v2"] }, timeoutSeconds: 120 });
    assert.equal(updated.name, "Новое имя");
    assert.equal(updated.timeoutSeconds, 120);

    // Fresh instance sees persisted data
    const reloaded = new CommandCatalog({ file: f.catalogFile, allowedRoots: [f.allowed] });
    assert.equal(reloaded.get(created.id).name, "Новое имя");

    // External schedules discovery
    const sched = await cat.listExternalSchedules({ address: "127.0.0.1:7233", namespace: "default" });
    assert.equal(sched.warning, null);
    assert.deepEqual(sched.items, [
      { scheduleId: "nightly-report", workflowType: "ReportWorkflow", paused: false },
      { scheduleId: "paused-job", workflowType: "SyncWorkflow", paused: true },
    ]);
    assert.equal(calls.length, 1);

    // Delete
    assert.deepEqual(cat.remove(created.id), { id: created.id, deleted: true });
    assert.equal(cat.get(created.id), null);
    assert.throws(() => cat.remove(created.id), (e) => e.status === 404);
  } finally {
    f.cleanup();
  }
});

test("Routes: GET /temporal/commands + admin CRUD /reload /schedules enforce roles and write audit", async () => {
  const f = setupFixture();
  try {
    const audits = [];
    const cat = new CommandCatalog({
      file: f.catalogFile,
      allowedRoots: [f.allowed],
      cli: "/bin/temporal",
      execute: async () => {
        throw new Error("connection refused");
      },
    });
    const sendJson = (res, status, body) => {
      res.status = status;
      res.body = body;
    };
    const deps = {
      sendJson,
      apiError: (res, err) => sendJson(res, err?.status ?? 500, { error: err?.message ?? "err" }),
      readJsonBody: async (req) => req._body ?? null,
      dirAllowed: () => true,
      engineAllowed: () => true,
      commandCatalog: cat,
      auditCommand: (entry) => auditTemporalCommand((x) => audits.push(x), entry),
    };
    const table = validateTable([...temporalRoutes(deps), ...adminRoutes(deps)]);
    const call = async (user, method, urlStr, bodyObj = null) => {
      const res = {};
      const handled = await dispatchRoute(
        table,
        { req: { method, _body: bodyObj }, res, url: new URL(urlStr, "http://x"), user, admin: user.role === "admin" },
        { sendJson, dirAllowed: () => true },
      );
      return { handled, status: res.status, body: res.body };
    };

    // Tenant gets 403 on all admin command routes
    for (const [m, p] of [
      ["GET", "/teleharness/api/admin/temporal-commands"],
      ["POST", "/teleharness/api/admin/temporal-commands"],
      ["PUT", "/teleharness/api/admin/temporal-commands/foo"],
      ["DELETE", "/teleharness/api/admin/temporal-commands/foo"],
      ["POST", "/teleharness/api/admin/temporal-commands/reload"],
      ["GET", "/teleharness/api/admin/temporal-commands/schedules"],
    ]) {
      const r = await call(TENANT, m, p, {});
      assert.equal(r.status, 403, `tenant must get 403 on ${m} ${p}`);
    }

    // Admin creates command via POST
    const post = await call(ADMIN, "POST", "/teleharness/api/admin/temporal-commands", {
      id: "demo-cmd",
      name: "Демо",
      kind: "exec",
      exec: { file: f.okScript, argv: ["--hello"], env: { SECRET_CHECK: "nope" } },
      allow: { roles: ["admin", "user"] },
    });
    assert.equal(post.status, 201);
    assert.equal(post.body.id, "demo-cmd");

    // GET /temporal/commands for tenant hides exec
    const tList = await call(TENANT, "GET", "/teleharness/api/temporal/commands");
    assert.equal(tList.status, 200);
    assert.equal(tList.body.items.length, 1);
    assert.equal("exec" in tList.body.items[0], false);

    // Capabilities reports commandsAvailable: true
    const caps = await call(TENANT, "GET", "/teleharness/api/temporal/capabilities");
    assert.equal(caps.status, 200);
    assert.equal(caps.body.commandsAvailable, true);

    // Schedules gracefully returns warning when server unavailable
    const sched = await call(ADMIN, "GET", "/teleharness/api/admin/temporal-commands/schedules");
    assert.equal(sched.status, 200);
    assert.deepEqual(sched.body.items, []);
    assert.match(sched.body.warning, /connection refused/);

    // Reload returns 200
    const rel = await call(ADMIN, "POST", "/teleharness/api/admin/temporal-commands/reload");
    assert.equal(rel.status, 200);
    assert.equal(rel.body.ok, true);

    // Update & Delete
    const put = await call(ADMIN, "PUT", "/teleharness/api/admin/temporal-commands/demo-cmd", {
      name: "Демо 2",
      kind: "exec",
      exec: { file: f.okScript, argv: [] },
      allow: { roles: ["admin"] },
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.name, "Демо 2");

    const del = await call(ADMIN, "DELETE", "/teleharness/api/admin/temporal-commands/demo-cmd");
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, true);

    // Audit recorded all 4 admin catalog operations without leaking env values
    assert.deepEqual(audits.map((a) => a.action), ["create", "reload", "update", "delete"]);
    assert.equal(JSON.stringify(audits).includes("SECRET_CHECK"), false);
  } finally {
    f.cleanup();
  }
});
