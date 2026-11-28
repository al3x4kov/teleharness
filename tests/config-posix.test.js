// Default configuration values are portable: the same layout on Windows, macOS and Linux —
// everything under the user's home, optional pieces under ~/.teleharness. The listen address is
// TELEHARNESS_LISTEN_HOST (loopback by default).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { platformDefaults, loadConfig, parseDotEnv, applyDotEnvFile } from "../lib/config.js";

test("platformDefaults(linux / darwin): POSIX paths under home, no drive letters", () => {
  for (const [platform, home] of [["linux", "/home/teleharness"], ["darwin", "/Users/teleharness"]]) {
    const d = platformDefaults(platform, home);
    assert.equal(d.home, home);
    assert.equal(d.tenantHome, `${home}/.teleharness-tenants`);
    assert.equal(d.tenantVault, `${home}/.teleharness/tenants-vault`);
    assert.deepEqual(d.fileRoots, [home]);
    assert.equal(d.kbRoot, "off", "the knowledge-base snapshot is opt-in");
    assert.equal(d.voicePython, `${home}/.teleharness/voice/venv/bin/python3`);
    assert.equal(d.voiceModels, `${home}/.teleharness/voice/models`);
    for (const v of Object.values(d).flat()) assert.ok(!/^[A-Za-z]:|\\/.test(v), `no Windows path: ${v}`);
  }
});

test("platformDefaults(win32): the same layout with Windows separators", () => {
  const d = platformDefaults("win32", "C:\\Users\\me");
  assert.equal(d.home, "C:\\Users\\me");
  assert.equal(d.tenantHome, "C:\\Users\\me\\.teleharness-tenants");
  assert.equal(d.tenantVault, "C:\\Users\\me\\.teleharness\\tenants-vault");
  assert.deepEqual(d.fileRoots, ["C:\\Users\\me"]);
  assert.equal(d.kbRoot, "off");
  assert.equal(d.voicePython, "C:\\Users\\me\\.teleharness\\voice\\venv\\Scripts\\python.exe");
  assert.equal(d.voiceModels, "C:\\Users\\me\\.teleharness\\voice\\models");
});

test("the schema defaults of this machine match platformDefaults()", () => {
  const { config } = loadConfig({});
  const d = platformDefaults();
  assert.equal(config.TELEHARNESS_HOME, d.home);
  assert.equal(config.TELEHARNESS_TENANT_HOME, d.tenantHome);
  assert.equal(config.TELEHARNESS_TENANT_VAULT, d.tenantVault);
  assert.deepEqual(config.TELEHARNESS_FILE_ROOTS, d.fileRoots);
  assert.equal(config.TELEHARNESS_KB_ROOT, d.kbRoot);
  assert.equal(config.TELEHARNESS_VOICE_PYTHON, d.voicePython);
  assert.equal(config.TELEHARNESS_VOICE_MODELS, d.voiceModels);
});

test("TELEHARNESS_LISTEN_HOST: 127.0.0.1 by default, 0.0.0.0 inside a container", () => {
  assert.equal(loadConfig({}).config.TELEHARNESS_LISTEN_HOST, "127.0.0.1");
  assert.equal(loadConfig({ TELEHARNESS_LISTEN_HOST: "0.0.0.0" }).config.TELEHARNESS_LISTEN_HOST, "0.0.0.0");
});

test("parseDotEnv & applyDotEnvFile: parses quotes/comments and never overrides explicit env", () => {
  const parsed = parseDotEnv([
    "# comment",
    "PORT=4394 # inline comment",
    "export TELEHARNESS_OC_API=v2",
    "TELEHARNESS_ADMIN_TOKEN=\"tok-with-\\\"quote\\\"\"",
    "SINGLE='literal # not comment'",
    "EMPTY=",
  ].join("\n"));
  assert.equal(parsed.PORT, "4394");
  assert.equal(parsed.TELEHARNESS_OC_API, "v2");
  assert.equal(parsed.TELEHARNESS_ADMIN_TOKEN, "tok-with-\"quote\"");
  assert.equal(parsed.SINGLE, "literal # not comment");
  assert.equal(parsed.EMPTY, "");

  const dir = mkdtempSync(path.join(os.tmpdir(), "th-dotenv-"));
  try {
    const file = path.join(dir, ".env");
    writeFileSync(file, "PORT=4394\nTELEHARNESS_OC_API=v2\nTELEHARNESS_TITLE_LLM=0\n", "utf8");
    const target = { PORT: "4180" };
    const count = applyDotEnvFile(file, target);
    assert.equal(count, 2);
    assert.equal(target.PORT, "4180", "explicit env must win over .env");
    assert.equal(target.TELEHARNESS_OC_API, "v2");
    assert.equal(target.TELEHARNESS_TITLE_LLM, "0");
    assert.equal(applyDotEnvFile(path.join(dir, "missing.env"), target), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("direct node server.js reads .env via TELEHARNESS_ENV_FILE and signs in with token from .env", async () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = mkdtempSync(path.join(os.tmpdir(), "th-srv-dotenv-"));
  const dataDir = path.join(dir, "data");
  const homeDir = path.join(dir, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const port = 4394;
  const token = "dotenv-live-test-token-1234";
  const envFile = path.join(dir, ".env");
  writeFileSync(envFile, [
    `PORT=${port}`,
    "TELEHARNESS_LISTEN_HOST=127.0.0.1",
    `TELEHARNESS_DATA_DIR=${dataDir}`,
    `TELEHARNESS_HOME=${homeDir}`,
    `TELEHARNESS_FILE_ROOTS=${homeDir}`,
    `TELEHARNESS_ADMIN_TOKEN=${token}`,
    "TELEHARNESS_UPSTREAM=http://127.0.0.1:1",
    "TELEHARNESS_TITLE_LLM=0",
    "TELEHARNESS_VOICE=0",
    "TELEHARNESS_PUSH=0",
  ].join("\n") + "\n", "utf8");

  const child = spawn(process.execPath, [path.join(repoRoot, "server.js")], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH || "", HOME: homeDir, USERPROFILE: homeDir, TELEHARNESS_ENV_FILE: envFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });

  try {
    const deadline = Date.now() + 25_000;
    let ready = false;
    while (Date.now() < deadline && child.exitCode === null) {
      if (out.includes(`listening on http://127.0.0.1:${port}`)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(ready, `server.js did not start from .env. out=${out}\nerr=${err}`);
    const loginRes = await fetch(`http://127.0.0.1:${port}/teleharness/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(loginRes.status, 200);
    const body = await loginRes.json();
    assert.equal(body?.user?.role, "admin");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((r) => child.once("exit", r)),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
