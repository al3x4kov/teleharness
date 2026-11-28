#!/usr/bin/env node
// One-command install & instant demo: `npx teleharness` / `npx teleharness --demo`.
// (Also works via `npx github:al3x4kov/teleharness`.)
//
// What it does:
//   1. checks Node >= 22 (a clear error instead of a syntax crash);
//   2. in --demo mode (or TELEHARNESS_DEMO=1): runs synthetic chats from
//      fixtures-demo/ in a throwaway OS temp directory — no engines, no API
//      keys, nothing written to ~/.teleharness, temp dir cleaned up on exit;
//   3. in normal mode: data directory — ~/.teleharness (TELEHARNESS_HOME):
//      data/ (users.json, admin-token.txt …), public/ (the built UI), tenants/
//      — all outside the package folder, so updates never touch user data;
//   4. uses the prebuilt public/ bundle shipped in the npm package when
//      available (or builds the UI on demand when missing / --rebuild);
//   5. looks for claude, opencode and codex in PATH and prints what was found
//      and how to install what is missing; it does NOT start opencode serve;
//   6. starts server.js with portable paths and prints the address and token.
//
// It never takes over another running portal: its own default port (4180),
// its own data directory, a busy port is an error, not a takeover.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const MIN_NODE_MAJOR = 22;
export const DEFAULT_PORT = 4180;
export const DEFAULT_DEMO_TOKEN = "demo-demo-demo-demo";
const BUILD_MARK = ".teleharness-build";
const DEMO_TIME_KEYS = new Set(["created", "updated", "completed", "start", "end", "fetchedAt", "resetAt", "at", "askedAt"]);

export const HELP = `Teleharness — a desktop web control room (with optional mobile PWA) for Claude Code, Codex, Gemini (ACP) and opencode.

Usage:  npx teleharness [--demo] [--port N] [--host ADDRESS] [--rebuild]
   or:  npx github:al3x4kov/teleharness [--demo] [--port N] [--host ADDRESS] [--rebuild]

  --demo            start an instant sandbox with synthetic chats (no engines or API keys needed)
  --port N          portal port (default ${DEFAULT_PORT} or PORT from the environment)
  --host ADDRESS    listen address (default 127.0.0.1; 0.0.0.0 — reachable from your LAN)
  --rebuild         rebuild the UI even if the prebuilt bundle matches the version
  -h, --help        this help

Demo mode can also be enabled with TELEHARNESS_DEMO=1 (and token via TELEHARNESS_DEMO_TOKEN, ≥ 16 chars).
Data: ~/.teleharness (another folder — TELEHARNESS_HOME, data only — TELEHARNESS_DATA_DIR).
opencode: the portal talks to opencode serve at TELEHARNESS_UPSTREAM (default http://127.0.0.1:4096).
Claude Code: CLI path — TELEHARNESS_CLAUDE_BIN (searched in PATH by default).
Codex: found in PATH or the npm global folder (TELEHARNESS_CODEX_BIN overrides); admin-only engine.`;

// --- pure functions (tests: tests/teleharness-bin.test.js) -------------------

export function parseArgs(argv) {
  const out = { port: null, host: null, rebuild: false, demo: false, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(0, eq) : a;
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]);
    if (key === "-h" || key === "--help") out.help = true;
    else if (key === "--rebuild") out.rebuild = true;
    else if (key === "--demo") out.demo = true;
    else if (key === "--port") {
      const v = val();
      const n = Number(v);
      if (!/^\d+$/.test(String(v ?? "")) || n < 1 || n > 65535) out.error = `--port: expected a port number 1–65535, got "${v ?? ""}"`;
      else if (BROWSER_BLOCKED_PORTS.has(n)) out.error = `--port: browsers refuse to open port ${n}, pick another one (e.g. ${DEFAULT_PORT})`;
      else out.port = n;
    } else if (key === "--host") {
      const v = val();
      if (!v) out.error = "--host: no address given";
      else out.host = v;
    } else out.error = `unknown option "${a}" (see --help)`;
  }
  return out;
}

// Ports browsers refuse to open (WHATWG fetch "bad port", >= 1024): the
// portal would start on such a port, but the page would never load.
export const BROWSER_BLOCKED_PORTS = new Set([1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

// null — the version is fine, otherwise the error text.
export function nodeVersionProblem(version = process.versions.node, min = MIN_NODE_MAJOR) {
  const major = Number(String(version).replace(/^v/, "").split(".")[0]);
  if (Number.isInteger(major) && major >= min) return null;
  return `Node.js ${min} or newer is required, this is ${version}. Install a current Node.js: https://nodejs.org/`;
}

export function dataHome(env = process.env, home = os.homedir()) {
  return env.TELEHARNESS_HOME ? path.resolve(env.TELEHARNESS_HOME) : path.join(home, ".teleharness");
}

// Find an executable in PATH (on Windows — with the PATHEXT extensions).
export function findInPath(name, env = process.env, platform = process.platform) {
  const win = platform === "win32";
  const sep = win ? ";" : ":";
  const pathVar = env.PATH ?? env.Path ?? "";
  const exts = win ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of pathVar.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir.replace(/^"|"$/g, ""), name + ext.toLowerCase());
      if (existsSync(file)) return file;
    }
  }
  return null;
}

// Claude Code: PATH, then the native installer location (~/.local/bin is not
// always in PATH). The portal runner starts an exe or a .js through node; the
// npm wrapper claude.cmd cannot run without a shell on Windows — it is
// unwrapped to the package's cli.js.
export function findClaude(env = process.env, platform = process.platform, home = os.homedir()) {
  let bin = findInPath("claude", env, platform);
  if (!bin && existsSync(nativeClaudePath(platform, home))) bin = nativeClaudePath(platform, home);
  if (bin && platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    const pkg = path.join(path.dirname(bin), "node_modules", "@anthropic-ai", "claude-code");
    const target = [path.join(pkg, "bin", "claude.exe"), path.join(pkg, "cli.js")].find((f) => existsSync(f));
    return { bin: target ?? bin, runnable: Boolean(target) };
  }
  return { bin, runnable: Boolean(bin) };
}

export function nativeClaudePath(platform = process.platform, home = os.homedir()) {
  return path.join(home, ".local", "bin", platform === "win32" ? "claude.exe" : "claude");
}

export function findEngines(env = process.env, platform = process.platform, home = os.homedir()) {
  return { claude: findClaude(env, platform, home), opencode: findInPath("opencode", env, platform), codex: findInPath("codex", env, platform) };
}

export const INSTALL_HINTS = {
  claude: "npm i -g @anthropic-ai/claude-code   (then run `claude` once to sign in)",
  opencode: "https://opencode.ai — install, then `opencode serve --port 4096`",
  codex: "npm i -g @openai/codex   (then `codex login`; optional, admin-only engine)",
};

// Engine report lines for the console.
export function engineReport(engines) {
  const lines = [];
  const c = engines.claude;
  if (c.bin && c.runnable) lines.push(`  claude    found: ${c.bin}`);
  else if (c.bin) lines.push(`  claude    found ${c.bin}, but the portal cannot run it — set TELEHARNESS_CLAUDE_BIN to claude.exe or cli.js`);
  else lines.push(`  claude    not found — install: ${INSTALL_HINTS.claude}`);
  if (engines.opencode) lines.push(`  opencode  found: ${engines.opencode}`);
  else lines.push(`  opencode  not found — install: ${INSTALL_HINTS.opencode}`);
  if (engines.codex) lines.push(`  codex     found: ${engines.codex}`);
  else if ("codex" in engines) lines.push(`  codex     not found — install: ${INSTALL_HINTS.codex}`);
  return lines;
}

// The bin does not start opencode serve itself: serve has its own provider
// keys, port and API version (1.x/2.x), outlives the portal and is often run
// as a service already. A child serve would die with the portal's Ctrl+C or
// stay an orphan — so only a hint with the exact command.
export function opencodeHint(upstream) {
  let port = "4096";
  try {
    port = new URL(upstream).port || "4096";
  } catch {}
  return `  opencode serve does not answer at ${upstream} — start it in another window: opencode serve --port ${port}`;
}

// Server environment: portable paths under ~/.teleharness. Variables the
// user set explicitly are never overridden.
export function serverEnv({ env = process.env, home = os.homedir(), thHome, port, host, claudeBin, publicDir = path.join(thHome, "public") }) {
  const defaults = {
    PORT: String(port),
    TELEHARNESS_DATA_DIR: path.join(thHome, "data"),
    TELEHARNESS_PUBLIC_DIR: publicDir,
    TELEHARNESS_HOME: home,
    TELEHARNESS_TENANT_HOME: path.join(thHome, "tenants"),
    TELEHARNESS_TENANT_VAULT: path.join(thHome, "tenants-vault"),
    TELEHARNESS_FILE_ROOTS: home,
    TELEHARNESS_KB_ROOT: "off",
    TELEHARNESS_VOICE_PYTHON: path.join(thHome, "voice", "venv", process.platform === "win32" ? "Scripts\\python.exe" : "bin/python3"),
    TELEHARNESS_VOICE_MODELS: path.join(thHome, "voice", "models"),
    TELEHARNESS_PUSH_SUBJECT: "https://github.com/al3x4kov/teleharness",
  };
  if (host) defaults.TELEHARNESS_LISTEN_HOST = host;
  if (claudeBin) defaults.TELEHARNESS_CLAUDE_BIN = claudeBin;
  const out = { ...env };
  for (const [k, v] of Object.entries(defaults)) {
    if (k === "PORT" || k === "TELEHARNESS_LISTEN_HOST") out[k] = v; // flags / the chosen port always win
    else if (!out[k]) out[k] = v;
  }
  return out;
}

export function hasPrebuiltPublic(pkgRoot = PKG_ROOT) {
  const dir = path.join(pkgRoot, "public");
  return existsSync(path.join(dir, "app.js")) && existsSync(path.join(dir, "app.css"));
}

export function needsBuild(publicDir, version) {
  if (!existsSync(path.join(publicDir, "app.js")) || !existsSync(path.join(publicDir, "app.css"))) return true;
  try {
    return readFileSync(path.join(publicDir, BUILD_MARK), "utf8").trim() !== version;
  } catch {
    return true;
  }
}

// --- demo mode helpers -------------------------------------------------------

export function shiftFixtureTimes(node, delta) {
  if (Array.isArray(node)) return node.map((x) => shiftFixtureTimes(x, delta));
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = DEMO_TIME_KEYS.has(k) && typeof v === "number" && v > 1e12 ? v + delta : shiftFixtureTimes(v, delta);
  }
  return out;
}

export function prepareDemoWorkspace(fixturesSrc = path.join(PKG_ROOT, "fixtures-demo"), tmpRoot = os.tmpdir(), now = Date.now()) {
  const tmp = mkdtempSync(path.join(tmpRoot, "teleharness-demo-"));
  const dirs = {
    tmp,
    data: path.join(tmp, "data"),
    fixtures: path.join(tmp, "fixtures"),
    home: path.join(tmp, "home"),
    tenants: path.join(tmp, "tenants"),
    vault: path.join(tmp, "vault"),
    public: path.join(tmp, "public"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const sessions = JSON.parse(readFileSync(path.join(fixturesSrc, "sessions.json"), "utf8"));
  const newest = Math.max(...sessions.map((s) => Number(s?.time?.updated) || 0));
  const delta = now - 2 * 60_000 - newest;
  for (const name of readdirSync(fixturesSrc)) {
    const src = path.join(fixturesSrc, name);
    const raw = readFileSync(src, "utf8");
    const text = name.endsWith(".json") ? JSON.stringify(shiftFixtureTimes(JSON.parse(raw), delta)) : raw;
    writeFileSync(path.join(dirs.fixtures, name), text, "utf8");
  }
  return dirs;
}

export function demoServerEnv({ env = process.env, dirs, publicDir, port, host = "127.0.0.1", token = DEFAULT_DEMO_TOKEN }) {
  // Start from the caller's env WITHOUT any TELEHARNESS_* / CLAUDE_CODE_OAUTH_TOKEN
  // so a host installation never leaks into the synthetic demo.
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("TELEHARNESS_") || k === "CLAUDE_CODE_OAUTH_TOKEN" || k === "PORT") continue;
    out[k] = v;
  }
  return Object.assign(out, {
    PORT: String(port),
    TELEHARNESS_LISTEN_HOST: host,
    TELEHARNESS_MOCK: "1",
    TELEHARNESS_ENV: "test",
    TELEHARNESS_FIXTURES: dirs.fixtures,
    TELEHARNESS_DATA_DIR: dirs.data,
    TELEHARNESS_PUBLIC_DIR: publicDir,
    TELEHARNESS_HOME: dirs.home,
    TELEHARNESS_CHAT_DIR: dirs.home,
    TELEHARNESS_TENANT_HOME: dirs.tenants,
    TELEHARNESS_TENANT_VAULT: dirs.vault,
    TELEHARNESS_FILE_ROOTS: dirs.home,
    TELEHARNESS_KB_ROOT: "off",
    TELEHARNESS_ADMIN_TOKEN: token,
    TELEHARNESS_COOKIE_NAME: "teleharness_t_demo",
    TELEHARNESS_UPSTREAM: "http://127.0.0.1:1",
    TELEHARNESS_TITLE_LLM: "0",
    TELEHARNESS_VOICE: "0",
    TELEHARNESS_PUSH: "0",
    TELEHARNESS_ACCESS_LOG: "0",
  });
}

// --- run ---------------------------------------------------------------------

function fail(msg, code = 1) {
  console.error(`Teleharness: ${msg}`);
  process.exit(code);
}

function portFree(port, host) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

// node:http, not fetch: fetch (and browsers) refuse "unsafe" ports (4190,
// 6000 …) before connecting — the check would never see them.
function reachable(url, ms = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: ms }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

function buildFrontend(publicDir, version) {
  console.log(`Teleharness: building the UI ${version} into ${publicDir} …`);
  mkdirSync(publicDir, { recursive: true });
  // static files (index.html, icons, fonts, sw.js) come from the package; app.js/app.css are built
  cpSync(path.join(PKG_ROOT, "public"), publicDir, { recursive: true });
  const r = spawnSync(process.execPath, [path.join(PKG_ROOT, "build.mjs")], {
    cwd: PKG_ROOT,
    stdio: "inherit",
    env: { ...process.env, TELEHARNESS_OUT_DIR: publicDir, TELEHARNESS_BUILD_PROD: "" },
  });
  if (r.status !== 0) fail("the UI build failed (see the output above). Run again with --rebuild.");
  writeFileSync(path.join(publicDir, BUILD_MARK), version + "\n", "utf8");
}

async function waitListening(url, child, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null) return false;
    if (await reachable(url, 1000)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

async function pickDemoPort(explicitPort, host) {
  if (explicitPort !== null) {
    if (!(await portFree(explicitPort, host))) fail(`port ${explicitPort} is busy. Pick another one: --port ${explicitPort + 1}`);
    return explicitPort;
  }
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + 30; p++) {
    if (!BROWSER_BLOCKED_PORTS.has(p) && (await portFree(p, host))) return p;
  }
  fail(`no free port in ${DEFAULT_PORT}..${DEFAULT_PORT + 29}; pass --port N`);
}

async function runDemo({ version, explicitPort, host, rebuild }) {
  const token = process.env.TELEHARNESS_DEMO_TOKEN || DEFAULT_DEMO_TOKEN;
  if (token.length < 16) fail("TELEHARNESS_DEMO_TOKEN must be at least 16 characters", 2);
  const fixturesSrc = path.join(PKG_ROOT, "fixtures-demo");
  if (!existsSync(path.join(fixturesSrc, "sessions.json"))) fail("fixtures-demo/ not found in package");

  const port = await pickDemoPort(explicitPort, host);
  const dirs = prepareDemoWorkspace(fixturesSrc);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(dirs.tmp, { recursive: true, force: true });
    } catch {}
  };

  let publicDir;
  if (!rebuild && hasPrebuiltPublic(PKG_ROOT)) {
    publicDir = path.join(PKG_ROOT, "public");
  } else {
    publicDir = dirs.public;
    try {
      buildFrontend(publicDir, version);
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  console.log(`Teleharness ${version} (demo mode) — temporary sandbox: ${dirs.tmp}`);
  const env = demoServerEnv({ dirs, publicDir, port, host, token });
  const child = spawn(process.execPath, [path.join(PKG_ROOT, "server.js")], { cwd: PKG_ROOT, env, stdio: "inherit" });

  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null) child.kill(sig);
    setTimeout(() => {
      cleanup();
      process.exit(0);
    }, 3000).unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGHUP", () => stop("SIGHUP"));
  process.on("exit", cleanup);
  child.on("exit", (code, sig) => {
    cleanup();
    process.exit(stopping ? 0 : code ?? (sig ? 1 : 0));
  });

  const local = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}/teleharness/`;
  if (!(await waitListening(local, child))) {
    if (child.exitCode === null) console.error(`Teleharness: demo did not answer at ${local} within 30 s — see the server output above.`);
    return;
  }
  const lines = [
    "",
    `Teleharness demo is running: ${local}`,
    `  Login token: ${token}`,
  ];
  if (host === "0.0.0.0" || host === "::") for (const ip of lanAddresses()) lines.push(`  on your LAN: http://${ip}:${port}/teleharness/`);
  lines.push("Demo mode: synthetic chats, no engines or API keys needed. Press Ctrl+C to stop.", "");
  console.log(lines.join("\n"));
}

export async function main(argv = process.argv.slice(2)) {
  const problem = nodeVersionProblem();
  if (problem) fail(problem);
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.error) fail(args.error, 2);

  const version = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).version;
  const host = args.host ?? process.env.TELEHARNESS_LISTEN_HOST ?? "127.0.0.1";
  const explicitPort = args.port ?? (process.env.PORT ? Number(process.env.PORT) : null);
  const port = explicitPort ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`PORT=${process.env.PORT} is not a port number`, 2);
  if (BROWSER_BLOCKED_PORTS.has(port)) fail(`browsers refuse to open port ${port}, pick another one: --port ${DEFAULT_PORT}`, 2);

  const isDemo = args.demo || process.env.TELEHARNESS_DEMO === "1";
  if (isDemo) {
    await runDemo({ version, explicitPort, host, rebuild: args.rebuild });
    return;
  }

  const thHome = dataHome();
  const engines = findEngines();
  // claude not found — point at the native installer path in THIS user's
  // profile: install it, restart, done.
  const usePrebuilt = !args.rebuild && hasPrebuiltPublic(PKG_ROOT);
  const publicDir = usePrebuilt ? path.join(PKG_ROOT, "public") : path.join(thHome, "public");
  const env = serverEnv({ thHome, port, host, claudeBin: engines.claude.bin ?? nativeClaudePath(), publicDir });
  const dataDir = env.TELEHARNESS_DATA_DIR;
  mkdirSync(dataDir, { recursive: true });
  const firstRun = !existsSync(path.join(dataDir, "users.json"));

  console.log(`Teleharness ${version} — data: ${dataDir}`);
  if (!usePrebuilt && (args.rebuild || needsBuild(publicDir, version))) buildFrontend(publicDir, version);

  console.log("Engines:");
  for (const line of engineReport(engines)) console.log(line);
  const upstream = env.TELEHARNESS_UPSTREAM || "http://127.0.0.1:4096";
  if (engines.opencode && !(await reachable(upstream))) console.log(opencodeHint(upstream));
  if (!engines.claude.bin && !engines.opencode) console.log("  The portal starts without engines: chats work once you install at least one.");

  if (!(await portFree(port, host))) fail(`port ${port} is busy. Pick another one: --port ${port + 1}`);

  const child = spawn(process.execPath, [path.join(PKG_ROOT, "server.js")], { cwd: PKG_ROOT, env, stdio: "inherit" });
  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null) child.kill(sig);
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGHUP", () => stop("SIGHUP"));
  child.on("exit", (code, sig) => process.exit(stopping ? 0 : code ?? (sig ? 1 : 0)));

  const local = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${port}/teleharness/`;
  if (!(await waitListening(local, child))) {
    if (child.exitCode === null) console.error(`Teleharness: the portal did not answer at ${local} within 30 s — see the server output above.`);
    return;
  }
  const lines = ["", `Teleharness is running: ${local}`];
  if (host === "0.0.0.0" || host === "::") for (const ip of lanAddresses()) lines.push(`  on your LAN: http://${ip}:${port}/teleharness/`);
  const tokenFile = path.join(dataDir, "admin-token.txt");
  if (firstRun && existsSync(tokenFile)) lines.push(`Admin token (sign in to the portal): ${readFileSync(tokenFile, "utf8").trim()}`);
  lines.push(`The admin token is stored in ${tokenFile}`);
  lines.push("Stop with Ctrl+C.", "");
  console.log(lines.join("\n"));
}

function isMain() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) await main();
