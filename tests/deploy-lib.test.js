// BUG-157 (BUG-15.8): ops/deploy/zai-deploy-lib.ps1 — the helpers deploy scripts use for
// checks and rollback. Reproduces both failures of the 1.11.2 deploy (2026-11-05):
// a ~1 MB JSON read by Invoke-RestMethod comes back as a string (check said FAILED), and a
// rollback copy made through a PowerShell pipeline turns UTF-8 Cyrillic into mojibake.
// Windows only (Windows PowerShell 5.1 is what the S4U deploy tasks run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LIB = path.join(ROOT, "ops", "deploy", "zai-deploy-lib.ps1");
const win = process.platform === "win32";

// Async: the test's own http server must keep answering while PowerShell runs.
function ps(script) {
  return new Promise((resolve) => {
    const c = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `. '${LIB}'; $ZaiNode = '${process.execPath}'; ${script}`]);
    let out = "", err = "";
    c.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    c.stderr.setEncoding("utf8").on("data", (d) => (err += d));
    const kill = setTimeout(() => c.kill(), 60_000);
    c.on("close", (status) => { clearTimeout(kill); resolve({ out: out.trim(), err: err.trim(), status }); });
  });
}

// opencode-like /config: big, with keys differing only by case (both break PS 5.1 JSON).
function bigConfig(snapshot) {
  const cmd = {};
  for (let i = 0; i < 400; i++) cmd[`c${i}`] = { template: "x".repeat(2500), description: "команда" };
  return JSON.stringify({ $schema: "https://opencode.ai/config.json", command: cmd, Agent: 1, agent: { a: 1 }, ...(snapshot === undefined ? {} : { snapshot }) });
}

async function withServer(body, fn) {
  const srv = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}/config`); } finally { srv.close(); }
}

test("Get-ZaiJsonValue reads a field of a ~1 MB JSON that Invoke-RestMethod cannot parse", { skip: !win }, async () => {
  const body = bigConfig(false);
  assert.ok(body.length > 900_000);
  await withServer(body, async (url) => {
    // the old check: Invoke-RestMethod gives a string, .snapshot is empty
    const old = await ps(`$r = Invoke-RestMethod -Uri '${url}'; '[' + $r.GetType().Name + '|' + $r.snapshot + ']'`);
    assert.equal(old.out, "[String|]", "precondition: PS 5.1 returns the raw string");
    assert.equal((await ps(`Get-ZaiJsonValue -Uri '${url}' -Field snapshot`)).out, "false");
    assert.equal((await ps(`Get-ZaiJsonValue -Uri '${url}' -Field agent.a`)).out, "1");
    assert.equal((await ps(`Get-ZaiJsonValue -Uri '${url}' -Field nope`)).out, "<absent>");
  });
  await withServer(bigConfig(undefined), async (url) => {
    assert.equal((await ps(`Get-ZaiJsonValue -Uri '${url}' -Field snapshot`)).out, "<absent>");
  });
  assert.match((await ps(`Get-ZaiJsonValue -Uri 'http://127.0.0.1:1/x' -Field a -TimeoutSec 3`)).out, /^<error: /);
});

test("Restore-ZaiFromGit restores UTF-8 Cyrillic byte for byte; the old pipeline did not", { skip: !win }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zai-deploy-lib-"));
  try {
    const git = (...a) => {
      const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "core.autocrlf", "false");
    const orig = '// «Прервано рестартом портала»\nconst MARK = "[Отменено]";\n';
    writeFileSync(path.join(dir, "server.js"), orig);
    git("add", ".");
    git("commit", "-qm", "base");
    const rev = git("rev-parse", "--short", "HEAD");
    writeFileSync(path.join(dir, "server.js"), "// new version\n");

    // the old way: git show | Set-Content -Encoding utf8 → not the committed bytes
    const bad = path.join(dir, "old-backup.js");
    await ps(`Set-Location '${dir}'; git show "${rev}:server.js" | Set-Content -Encoding utf8 '${bad}'`);
    assert.notDeepEqual(readFileSync(bad), Buffer.from(orig, "utf8"), "precondition: the pipeline corrupts the file");

    const r = await ps(`Restore-ZaiFromGit -Rev ${rev} -Files 'server.js','lib\\absent.js' -Repo '${dir}'`);
    assert.equal(r.out, "server.js", r.err);
    assert.deepEqual(readFileSync(path.join(dir, "server.js")), Buffer.from(orig, "utf8"));
    assert.equal(git("diff", "--cached", "--name-only"), "", "index untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// BUG-183 (BUG-12.25): after serve restarts the DEFAULT opencode instance answered GET /mcp with
// 499 and an empty body. Deploy scripts that restart zai-opencode-serve call Test-ZaiOpencodeMcp:
// a failing /mcp → POST /instance/dispose (default instance) → check again; the line goes to the log.
async function withFakeOc(behaviour, fn) {
  const calls = [];
  let disposed = 0;
  const srv = http.createServer((q, res) => {
    calls.push(`${q.method} ${q.url}`);
    if (q.method === "POST" && q.url.startsWith("/instance/dispose")) { disposed++; res.writeHead(200, { "content-type": "application/json" }); return res.end("true"); }
    if (q.method === "GET" && q.url.startsWith("/mcp")) {
      const ok = behaviour === "ok" || (behaviour === "heals" && disposed > 0);
      if (!ok) { res.writeHead(499); return res.end(""); }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ playwright: { status: "connected" }, marketplace: { status: "failed", error: "ENOENT" } }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${srv.address().port}`, calls); } finally { srv.close(); }
}

test("Test-ZaiOpencodeMcp: healthy /mcp → ok, no dispose; summary names failed servers", { skip: !win }, async () => {
  await withFakeOc("ok", async (base, calls) => {
    const r = await ps(`$x = Test-ZaiOpencodeMcp -Base '${base}'; "$($x.Ok)|$($x.Text)"`);
    assert.match(r.out, /^True\|/, r.out + r.err);
    assert.match(r.out, /marketplace=failed/);
    assert.equal(calls.filter((c) => c.startsWith("POST")).length, 0);
  });
});

test("Test-ZaiOpencodeMcp: stuck default instance (499) → dispose → ok", { skip: !win }, async () => {
  await withFakeOc("heals", async (base, calls) => {
    const r = await ps(`$x = Test-ZaiOpencodeMcp -Base '${base}'; "$($x.Ok)|$($x.Text)"`);
    assert.match(r.out, /^True\|/, r.out + r.err);
    assert.match(r.out, /499/);
    assert.match(r.out, /dispose/);
    assert.equal(calls.filter((c) => c.startsWith("POST /instance/dispose")).length, 1);
  });
});

test("negative: Test-ZaiOpencodeMcp still 499 after dispose → not ok, says so", { skip: !win }, async () => {
  await withFakeOc("broken", async (base) => {
    const r = await ps(`$x = Test-ZaiOpencodeMcp -Base '${base}'; "$($x.Ok)|$($x.Text)"`);
    assert.match(r.out, /^False\|/, r.out + r.err);
    assert.match(r.out, /after dispose/);
  });
});
