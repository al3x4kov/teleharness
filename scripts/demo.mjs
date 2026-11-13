#!/usr/bin/env node
// `npm run demo`: the portal with synthetic chats — no opencode, no claude CLI,
// no keys. Starts server.js in mock mode (lib/mock.js) on 127.0.0.1 with the
// fixtures from fixtures-demo/, a throwaway data dir in the OS temp folder
// (nothing is written into the repo) and a fixed admin token. Ctrl+C stops the
// server and removes the temp folder.
//
// Env: PORT (default: first free port from 4171), ZAI_DEMO_TOKEN (default
// "demo-demo-demo-demo"; lib/auth.js accepts tokens of 16+ characters only).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES_SRC = path.join(ROOT, "fixtures-demo");
const TOKEN = process.env.ZAI_DEMO_TOKEN || "demo-demo-demo-demo";
const DEFAULT_PORT = 4171;

function fail(msg) {
  console.error(`Teleharness demo: ${msg}`);
  process.exit(1);
}

if (TOKEN.length < 16) fail("ZAI_DEMO_TOKEN is shorter than 16 characters; the server would reject it");

// 1. Frontend bundle: public/app.js + app.css are build artifacts (gitignored).
// build.mjs refuses to write public/ without ZAI_BUILD_PROD=1 (a guard for the
// owner's live checkout); in a fresh clone public/ IS the place to build into.
if (!["app.js", "app.css"].every((f) => existsSync(path.join(ROOT, "public", f)))) {
  console.log("Teleharness demo: public/app.js not found, building the frontend (node build.mjs)...");
  const r = spawnSync(process.execPath, [path.join(ROOT, "build.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ZAI_OUT_DIR: "", ZAI_BUILD_PROD: "1" },
  });
  if (r.status !== 0) fail("frontend build failed; run `npm ci`, then `npm run demo` again");
}

// 2. Port: PORT if given, else the first free one from 4171.
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}
async function pickPort() {
  if (process.env.PORT) {
    const p = Number(process.env.PORT);
    if (!Number.isInteger(p) || p < 1 || p > 65535) fail(`PORT=${process.env.PORT} is not a valid port number`);
    if (!(await portFree(p))) fail(`port ${p} is busy; pick another one: PORT=4180 npm run demo`);
    return p;
  }
  for (let p = DEFAULT_PORT; p < DEFAULT_PORT + 30; p++) if (await portFree(p)) return p;
  fail(`no free port in ${DEFAULT_PORT}..${DEFAULT_PORT + 29}; set PORT`);
}

// 3. Throwaway workspace: data dir, chat home and a copy of the fixtures with
// every timestamp shifted so the newest chat is "a couple of minutes ago"
// (the chat list groups by date). The mock also appends captured POSTs to
// its fixtures dir — the copy keeps the repo clean.
const TIME_KEYS = new Set(["created", "updated", "completed", "start", "end", "fetchedAt", "resetAt", "at"]);
function shiftTimes(node, delta) {
  if (Array.isArray(node)) return node.map((x) => shiftTimes(x, delta));
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    out[k] = TIME_KEYS.has(k) && typeof v === "number" && v > 1e12 ? v + delta : shiftTimes(v, delta);
  }
  return out;
}

function prepareWorkspace() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "zai-demo-"));
  const dirs = {
    tmp,
    data: path.join(tmp, "data"),
    fixtures: path.join(tmp, "fixtures"),
    home: path.join(tmp, "home"),
    tenants: path.join(tmp, "tenants"),
    vault: path.join(tmp, "vault"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const sessions = JSON.parse(readFileSync(path.join(FIXTURES_SRC, "sessions.json"), "utf8"));
  const newest = Math.max(...sessions.map((s) => Number(s?.time?.updated) || 0));
  const delta = Date.now() - 2 * 60_000 - newest;
  for (const name of readdirSync(FIXTURES_SRC)) {
    const src = path.join(FIXTURES_SRC, name);
    const raw = readFileSync(src, "utf8");
    const text = name.endsWith(".json") ? JSON.stringify(shiftTimes(JSON.parse(raw), delta)) : raw;
    writeFileSync(path.join(dirs.fixtures, name), text, "utf8");
  }
  return dirs;
}

const port = await pickPort();
const dirs = prepareWorkspace();

// 4. Server env: start from the caller's env WITHOUT any ZAI_* / claude token
// (a dev shell may point at a real instance), then the demo settings.
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("ZAI_") || k === "CLAUDE_CODE_OAUTH_TOKEN" || k === "PORT") continue;
  env[k] = v;
}
Object.assign(env, {
  PORT: String(port),
  ZAI_MOCK: "1",
  ZAI_ENV: "test",
  ZAI_FIXTURES: dirs.fixtures,
  ZAI_DATA_DIR: dirs.data,
  ZAI_HOME: dirs.home,
  ZAI_CHAT_DIR: dirs.home,
  ZAI_TENANT_HOME: dirs.tenants,
  ZAI_TENANT_VAULT: dirs.vault,
  ZAI_FILE_ROOTS: dirs.home,
  ZAI_KB_ROOT: "off",
  ZAI_ADMIN_TOKEN: TOKEN,
  // Never reach a real opencode: port 1 refuses at once.
  ZAI_UPSTREAM: "http://127.0.0.1:1",
  ZAI_TITLE_LLM: "0",
  ZAI_VOICE: "0",
  ZAI_PUSH: "0",
  ZAI_ACCESS_LOG: "0",
});

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    rmSync(dirs.tmp, { recursive: true, force: true });
  } catch {}
}

const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  cwd: ROOT,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

const verbose = process.env.ZAI_DEMO_VERBOSE === "1";
let announced = false;
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  if (verbose) process.stdout.write(chunk);
  if (announced) return;
  buf += chunk;
  if (/zai listening on/.test(buf)) {
    announced = true;
    buf = "";
    const url = `http://127.0.0.1:${port}/zai/`;
    console.log("");
    console.log(`Teleharness demo → ${url}  (login token: ${TOKEN})`);
    console.log("demo mode: synthetic chats, no engines or API keys needed; press Ctrl+C to stop");
    console.log("");
  }
});
child.stderr.setEncoding("utf8");
// The mock has no opencode behind it: "fetch failed" lines about the upstream
// are expected noise (shown with ZAI_DEMO_VERBOSE=1).
child.stderr.on("data", (chunk) => {
  const text = verbose ? chunk : chunk.split(/\r?\n/).filter((l) => !/^\[zai-err\].*fetch failed/.test(l)).join("\n");
  if (text.trim()) process.stderr.write(text.endsWith("\n") ? text : text + "\n");
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  if (child.exitCode == null) child.kill();
  // Exit even if the child ignores the signal.
  setTimeout(() => {
    cleanup();
    process.exit(0);
  }, 3000).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
process.on("exit", cleanup);

// Ctrl+C in a terminal reaches the server too and it may exit first: give
// our own SIGINT handler a moment before calling that a crash.
child.on("exit", (code, signal) => setTimeout(() => {
  cleanup();
  if (stopping) {
    console.log("Teleharness demo: stopped");
    process.exit(0);
  }
  console.error(`Teleharness demo: server exited (${signal ?? `code ${code}`})`);
  process.exit(code || 1);
}, 300));
