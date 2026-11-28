// TASK-18.1: bin/teleharness.mjs — установка одной командой (npx github:al3x4kov/teleharness).
// Сервер здесь не запускается: проверяются справка, разбор флагов, проверка версии Node,
// поиск движков (подмена PATH), каталог данных и окружение сервера.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DEMO_TOKEN,
  DEFAULT_PORT,
  dataHome,
  demoServerEnv,
  hasPrebuiltPublic,
  prepareDemoWorkspace,
  shiftFixtureTimes,
  engineReport,
  findEngines,
  findInPath,
  needsBuild,
  nodeVersionProblem,
  opencodeHint,
  parseArgs,
  serverEnv,
} from "../bin/teleharness.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(ROOT, "bin", "teleharness.mjs");

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), "th-bin-"));
}

test("package.json: bin teleharness и сборка фронта в dependencies (npx не ставит devDependencies)", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.bin?.teleharness, "bin/teleharness.mjs");
  for (const dep of ["esbuild", "preact", "@preact/signals", "marked", "dompurify", "highlight.js"]) {
    assert.ok(pkg.dependencies?.[dep], `${dep} должен быть в dependencies`);
  }
});

test("--help: справка, код 0, сервер не запускается", () => {
  const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /npx github:al3x4kov\/teleharness/);
  assert.match(r.stdout, /--port/);
  assert.doesNotMatch(r.stdout, /Teleharness is running/);
});

test("неизвестный флаг — код 2 и понятная ошибка", () => {
  const r = spawnSync(process.execPath, [BIN, "--bogus"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option "--bogus"/);
});

test("parseArgs: --port N, --port=N, --host, --rebuild, ошибки", () => {
  assert.equal(parseArgs(["--port", "4191"]).port, 4191);
  assert.equal(parseArgs(["--port=4192"]).port, 4192);
  assert.equal(parseArgs(["--host", "0.0.0.0"]).host, "0.0.0.0");
  assert.equal(parseArgs(["--rebuild"]).rebuild, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.match(parseArgs(["--port", "abc"]).error, /port number/);
  assert.match(parseArgs(["--port", "70000"]).error, /port number/);
  assert.match(parseArgs(["--port"]).error, /port number/);
  // 4190 — «bad port» WHATWG: браузер страницу не откроет
  assert.match(parseArgs(["--port", "4190"]).error, /browsers refuse to open/);
});

test("версия Node: 22+ проходит, 20 — ошибка с подсказкой", () => {
  assert.equal(nodeVersionProblem("22.0.0"), null);
  assert.equal(nodeVersionProblem("v24.22.1"), null);
  const msg = nodeVersionProblem("20.11.1");
  assert.match(msg, /Node\.js 22 or newer/);
  assert.match(msg, /20\.11\.1/);
  assert.match(msg, /nodejs\.org/);
  assert.ok(nodeVersionProblem("garbage"));
});

test("каталог данных: ~/.teleharness по умолчанию, TELEHARNESS_HOME перекрывает", () => {
  const home = path.join(os.tmpdir(), "fake-home");
  assert.equal(dataHome({}, home), path.join(home, ".teleharness"));
  const custom = path.join(os.tmpdir(), "th-custom");
  assert.equal(dataHome({ TELEHARNESS_HOME: custom }, home), custom);
});

test("поиск движков: пустой PATH — оба не найдены, подсказки установки", () => {
  const dir = tmp();
  try {
    const home = path.join(dir, "home");
    const engines = findEngines({ PATH: path.join(dir, "empty") }, process.platform, home);
    assert.equal(engines.claude.bin, null);
    assert.equal(engines.opencode, null);
    const report = engineReport(engines).join("\n");
    assert.match(report, /claude\s+not found — install: npm i -g @anthropic-ai\/claude-code/);
    assert.match(report, /opencode\s+not found — install: https:\/\/opencode\.ai/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("поиск движков (win32): claude.exe и opencode.cmd в PATH, PATHEXT", () => {
  const dir = tmp();
  try {
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(path.join(a, "claude.exe"), "");
    writeFileSync(path.join(b, "opencode.cmd"), "");
    const env = { PATH: `${a};${b}`, PATHEXT: ".EXE;.CMD" };
    assert.equal(findInPath("opencode", env, "win32"), path.join(b, "opencode.cmd"));
    const engines = findEngines(env, "win32", path.join(dir, "home"));
    assert.deepEqual(engines.claude, { bin: path.join(a, "claude.exe"), runnable: true });
    assert.match(engineReport(engines).join("\n"), /claude\s+found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("поиск движков (win32): npm-обёртка claude.cmd разворачивается в cli.js пакета", () => {
  const dir = tmp();
  try {
    const pkg = path.join(dir, "node_modules", "@anthropic-ai", "claude-code");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(dir, "claude.cmd"), "");
    writeFileSync(path.join(pkg, "cli.js"), "");
    const engines = findEngines({ PATH: dir, PATHEXT: ".CMD" }, "win32", path.join(dir, "home"));
    assert.deepEqual(engines.claude, { bin: path.join(pkg, "cli.js"), runnable: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("поиск движков: claude нативного установщика в ~/.local/bin вне PATH", () => {
  const dir = tmp();
  try {
    const home = path.join(dir, "home");
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    const exe = path.join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
    writeFileSync(exe, "");
    assert.equal(findEngines({ PATH: "" }, process.platform, home).claude.bin, exe);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencodeHint: команда serve с портом из TELEHARNESS_UPSTREAM", () => {
  assert.match(opencodeHint("http://127.0.0.1:4096"), /opencode serve --port 4096/);
  assert.match(opencodeHint("http://127.0.0.1:5000"), /opencode serve --port 5000/);
});

test("serverEnv: данные и фронт в ~/.teleharness, переносимые пути, явный env пользователя не перекрыт", () => {
  const home = path.join(os.tmpdir(), "fake-home");
  const thHome = path.join(home, ".teleharness");
  const env = serverEnv({ env: { PATH: "x", TELEHARNESS_UPSTREAM: "http://127.0.0.1:5000" }, home, thHome, port: DEFAULT_PORT, host: "127.0.0.1", claudeBin: null });
  assert.equal(env.PORT, String(DEFAULT_PORT));
  assert.equal(env.TELEHARNESS_DATA_DIR, path.join(thHome, "data"));
  assert.equal(env.TELEHARNESS_PUBLIC_DIR, path.join(thHome, "public"));
  assert.equal(env.TELEHARNESS_HOME, home);
  assert.equal(env.TELEHARNESS_FILE_ROOTS, home);
  assert.equal(env.TELEHARNESS_KB_ROOT, "off");
  assert.ok(env.TELEHARNESS_TENANT_HOME.startsWith(thHome));
  assert.ok(env.TELEHARNESS_TENANT_VAULT.startsWith(thHome));
  assert.equal(env.TELEHARNESS_UPSTREAM, "http://127.0.0.1:5000");
  assert.equal(env.TELEHARNESS_CLAUDE_BIN, undefined);
  const own = serverEnv({ env: { TELEHARNESS_DATA_DIR: path.join(home, "mine") }, home, thHome, port: 4191, host: "0.0.0.0", claudeBin: "c" });
  assert.equal(own.TELEHARNESS_DATA_DIR, path.join(home, "mine"));
  assert.equal(own.TELEHARNESS_LISTEN_HOST, "0.0.0.0");
  assert.equal(own.TELEHARNESS_CLAUDE_BIN, "c");
  assert.notEqual(DEFAULT_PORT, 4170);
  assert.notEqual(DEFAULT_PORT, 4172);
});

test("needsBuild: нет сборки / другая версия — собрать; та же версия — нет", () => {
  const dir = tmp();
  try {
    assert.equal(needsBuild(dir, "1.0.0"), true);
    writeFileSync(path.join(dir, "app.js"), "");
    writeFileSync(path.join(dir, "app.css"), "");
    assert.equal(needsBuild(dir, "1.0.0"), true);
    writeFileSync(path.join(dir, ".teleharness-build"), "1.0.0\n");
    assert.equal(needsBuild(dir, "1.0.0"), false);
    assert.equal(needsBuild(dir, "1.0.1"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseArgs: --demo flag and --help mentions --demo", () => {
  assert.equal(parseArgs(["--demo"]).demo, true);
  assert.equal(parseArgs(["--demo", "--port", "4191", "--host", "0.0.0.0"]).demo, true);
  assert.equal(parseArgs([]).demo, false);
  const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--demo/);
  assert.match(r.stdout, /npx teleharness/);
  assert.match(r.stdout, /TELEHARNESS_DEMO=1/);
});

test("shiftFixtureTimes & prepareDemoWorkspace: shifts timestamps and isolates fixtures", () => {
  const shifted = shiftFixtureTimes({ updated: 1700000000000, count: 42, nested: [{ created: 1700000001000 }] }, 5000);
  assert.equal(shifted.updated, 1700000005000);
  assert.equal(shifted.count, 42);
  assert.equal(shifted.nested[0].created, 1700000006000);

  const now = 1800000000000;
  const dirs = prepareDemoWorkspace(path.join(ROOT, "fixtures-demo"), os.tmpdir(), now);
  try {
    const sessions = JSON.parse(readFileSync(path.join(dirs.fixtures, "sessions.json"), "utf8"));
    const newest = Math.max(...sessions.map((s) => Number(s?.time?.updated) || 0));
    assert.equal(newest, now - 2 * 60_000);
    assert.ok(existsSync(dirs.data));
    assert.ok(existsSync(dirs.home));
  } finally {
    rmSync(dirs.tmp, { recursive: true, force: true });
  }
});

test("demoServerEnv: strips host TELEHARNESS_* and configures isolated mock sandbox", () => {
  const dirs = {
    tmp: "/tmp/demo",
    data: "/tmp/demo/data",
    fixtures: "/tmp/demo/fixtures",
    home: "/tmp/demo/home",
    tenants: "/tmp/demo/tenants",
    vault: "/tmp/demo/vault",
  };
  const env = demoServerEnv({
    env: { PATH: "/usr/bin", TELEHARNESS_ADMIN_TOKEN: "host-secret", CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret", PORT: "4170" },
    dirs,
    publicDir: "/tmp/demo/public",
    port: 4189,
    host: "0.0.0.0",
  });
  assert.equal(env.PORT, "4189");
  assert.equal(env.TELEHARNESS_LISTEN_HOST, "0.0.0.0");
  assert.equal(env.TELEHARNESS_MOCK, "1");
  assert.equal(env.TELEHARNESS_ADMIN_TOKEN, DEFAULT_DEMO_TOKEN);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.TELEHARNESS_PUBLIC_DIR, "/tmp/demo/public");
  assert.equal(env.TELEHARNESS_UPSTREAM, "http://127.0.0.1:1");
});

test("--demo live smoke: starts sandbox, serves /teleharness/api/healthz 200, cleans up temp dir on exit", async () => {
  const port = 4389;
  const child = spawn(process.execPath, [BIN, "--demo", "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env, TELEHARNESS_DEMO_TOKEN: DEFAULT_DEMO_TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  let tmpDir = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => { out += c; });
  child.stderr.on("data", (c) => { err += c; });

  try {
    const deadline = Date.now() + 25_000;
    let health = null;
    while (Date.now() < deadline && child.exitCode === null) {
      if (out.includes("Teleharness demo is running:")) {
        const r = await fetch(`http://127.0.0.1:${port}/teleharness/api/healthz`);
        if (r.ok) {
          health = await r.json();
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const tmpMatch = out.match(/temporary sandbox:\s+(.+)/);
    tmpDir = tmpMatch ? tmpMatch[1].trim() : null;

    assert.ok(health?.ok, `demo healthz failed. stdout=${out}\nstderr=${err}`);
    assert.match(out, /Login token: demo-demo-demo-demo/);
    assert.ok(tmpDir, "expected temporary sandbox path in stdout");

    if (process.platform === "win32") {
      // Windows has no graceful POSIX SIGTERM for detached child trees; kill tree cleanly.
      spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
      await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve));
    } else {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve));
      assert.equal(existsSync(tmpDir), false, `expected temp sandbox ${tmpDir} to be removed on SIGTERM`);
    }
  } finally {
    if (child.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
      else child.kill("SIGKILL");
    }
    if (tmpDir && existsSync(tmpDir)) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
});
