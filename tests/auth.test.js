// Tenancy contract tests: server.js is spawned against a fake upstream with
// an isolated ZAI_DATA_DIR, and the suite walks the whole auth surface —
// login/cookie/me, tenant scoping of sessions/status/dialogs/projects/files/
// uploads/SSE, admin-only routes, token lifecycle (regenerate/disable/
// delete). The fake upstream FILTERS /event per directory exactly like the
// real opencode does (verified live 2026-10-31), so the SSE scope test
// mirrors production behavior.
// Run: node --test tests/auth.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { waitFor } from "./helpers/wait.mjs"; // BUG-222/QA-07: ждать условие, а не паузу
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(path.join(tmpdir(), "zai-auth-test-"));

const ADMIN_TOKEN = "t".repeat(20) + "-admin-token-" + "9".repeat(24);
const HOME = mkdtempSync(path.join(TMP, "home-"));
const DIR_FOREIGN = path.join(TMP, "foreign");
const WIN = process.platform === "win32";
// The owner's shared vault: an absolute path outside every tenant root.
const SHARED_VAULT_NOTE = path.join(path.parse(TMP).root, "Obsidian", "_index.md");
// Deterministic tenant folder: createUser defaults to ZAI_TENANT_HOME/<name>.
// The fake upstream parks ses_own here so the tenant scope tests have a
// session that genuinely belongs to alice.
const ALICE_DIR = path.join(TMP, "tenants", "alice");
mkdirSync(DIR_FOREIGN, { recursive: true });
mkdirSync(ALICE_DIR, { recursive: true });

// --- fake upstream -------------------------------------------------------------

const seen = [];
// Fake-upstream switches flipped by individual tests.
const FLAGS = { aliceAsk: false, failDelete: false };
function note(req, body = Buffer.alloc(0)) {
  seen.push({ url: req.url, method: req.method, body });
}

function sseFrame(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const samePath = (a, b) => {
  try {
    return path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
  } catch {
    return false;
  }
};

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/session") {
    note(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        { id: "ses_foreign", directory: DIR_FOREIGN, title: "F" },
        { id: "ses_own", directory: ALICE_DIR, title: "O" },
        // never prompted in this suite: an UNBOUND tenant chat (BUG-12.5 gate)
        { id: "ses_own2", directory: ALICE_DIR, title: "O2" },
        // 2026-11-05: a chat opencode remembers on an OmO subagent (a tenant on multimodal-looker)
        { id: "ses_own3", directory: ALICE_DIR, title: "O3", agent: "looker", model: { providerID: "zai-coding-plan", id: "glm-5.3" } },
      ]),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/event") {
    // Production upstream filters /event per directory (live-verified); the
    // fake does the same so the tenant-visibility test is honest.
    const dir = url.searchParams.get("directory") ?? "";
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (samePath(dir, DIR_FOREIGN)) sseFrame(res, { type: "session.created", properties: { sessionID: "ses_foreign" } });
    else if (samePath(dir, ALICE_DIR)) sseFrame(res, { type: "session.created", properties: { sessionID: "ses_own" } });
    return; // stays open; nothing else is streamed
  }
  if (req.method === "GET" && url.pathname === "/session/status") {
    note(req);
    const dir = url.searchParams.get("directory") ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(samePath(dir, ALICE_DIR) ? { ses_own: { type: "busy" } } : { ses_foreign: { type: "busy" } }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/permission") {
    note(req);
    // Production /permission is directory-scoped (silently EMPTY without a
    // matching ?directory=, verified 2026-11-01): the fake mirrors that, so
    // the tenant-dialog filter is tested against honest upstream behavior.
    const dir = url.searchParams.get("directory") ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    const own = FLAGS.aliceAsk ? [{ id: "per_own", sessionID: "ses_own", permission: "bash" }] : [];
    res.end(JSON.stringify(samePath(dir, DIR_FOREIGN) ? [{ id: "per_foreign", sessionID: "ses_foreign", permission: "bash" }] : samePath(dir, ALICE_DIR) ? own : []));
    return;
  }
  if (req.method === "DELETE" && url.pathname === "/session/ses_foreign" && FLAGS.failDelete) {
    note(req);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "boom" }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/question") {
    note(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([]));
    return;
  }
  if (req.method === "GET" && url.pathname === "/agent") {
    // opencode 1.19.5 ruleset shape: "build" can run a shell, "planner" has no
    // shell but can delegate (task) to one, "safe" denies bash, task and
    // external_directory (BUG-12.5 policy input, 2026-11-04 hardening).
    note(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        { name: "build", mode: "primary", prompt: "SECRET PROMPT", permission: [{ permission: "*", pattern: "*", action: "allow" }] },
        {
          name: "safe",
          mode: "primary",
          prompt: "SECRET PROMPT",
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "*", action: "deny" },
            { permission: "task", pattern: "*", action: "deny" },
            { permission: "external_directory", pattern: "*", action: "deny" },
          ],
        },
        {
          name: "looker",
          mode: "subagent",
          prompt: "SECRET PROMPT",
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "*", action: "deny" },
            { permission: "task", pattern: "*", action: "deny" },
            { permission: "external_directory", pattern: "*", action: "deny" },
          ],
        },
        {
          name: "planner",
          mode: "primary",
          prompt: "SECRET PROMPT",
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "bash", pattern: "*", action: "deny" },
            { permission: "external_directory", pattern: "*", action: "deny" },
          ],
        },
      ]),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/provider") {
    note(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        connected: ["zai-coding-plan"],
        all: [
          { id: "zai-coding-plan", models: { "glm-5.3": { id: "glm-5.3" } } },
          { id: "unconnected-huge", models: { x: { id: "x" } } },
        ],
        default: { "zai-coding-plan": "glm-5.3" },
      }),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/project") {
    note(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        { id: "p_foreign", worktree: DIR_FOREIGN },
        { id: "p_own", worktree: ALICE_DIR },
      ]),
    );
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    note(req, Buffer.concat(chunks));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

// --- spawn the portal server ----------------------------------------------------

// Isolated env (TASK-14.4): no ZAI_* inherited from the shell.
const srv = await spawnPortal({
  upstream: `http://127.0.0.1:${upstream.address().port}`,
  env: {
    ZAI_HOME: HOME,
    ZAI_CHAT_DIR: HOME,
    ZAI_DATA_DIR: path.join(TMP, "data"),
    ZAI_ADMIN_TOKEN: ADMIN_TOKEN,
    ZAI_TENANT_HOME: path.join(TMP, "tenants"),
    ZAI_TENANT_VAULT: path.join(TMP, "vault"),
    ZAI_TENANT_UPLOAD_LIMIT: "4096",
    ZAI_LOG_DIR: path.join(TMP, "logs"),
    ZAI_ACCESS_LOG: "1", // TASK-12.20 test reads the access log
    ZAI_FILE_ROOTS: TMP,
  },
});
// Same teardown contract as claude-server.test.js: kill the portal FIRST,
// wait for exit, then close the upstream and delete temp dirs. A failed early
// hook (EPERM on a watched dir) makes node:test skip the rest of teardown and
// the runner hangs forever.
after(async () => {
  await srv.stop();
  upstream.close();
  rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const base = srv.base;

function apiHits() {
  return seen.filter((h) => !h.url.startsWith("/event"));
}
function resetHits() {
  seen.length = 0;
}

// --- helpers --------------------------------------------------------------------

function setCookieList(res) {
  return typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
}

function extractCookie(res) {
  const joined = setCookieList(res).join("\n");
  const m = joined.match(/zai_t=[^;]+/);
  assert.ok(m, `login must set the zai_t cookie, got: ${joined}`);
  return m[0];
}

async function login(token) {
  const res = await fetch(`${base}/zai/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return { res, cookie: res.ok ? extractCookie(res) : null };
}

// A: admin session (cookie). T: tenant under test (cookie + raw token).
const A = { cookie: null };
const T = { token: null, cookie: null, dirs: null, vault: null };

const admin = (p, opts = {}) =>
  fetch(`${base}${p}`, { ...opts, headers: { ...(opts.headers ?? {}), cookie: A.cookie } });
const tenant = (p, opts = {}) =>
  fetch(`${base}${p}`, { ...opts, headers: { ...(opts.headers ?? {}), cookie: T.cookie } });

// Replay from ring start; the fake upstream pushes its frames on connect, so
// by test time they are already in the hub's ring.
// ADR-005: wire ids are `<epoch>.<seq>`; a bare "0" is a legacy id and gets
// zai.resync instead of a replay. Learn the epoch from x-zai-epoch first.
async function readSse(cookie, until) {
  const probe = await fetch(`${base}/zai/api/event`, { headers: { cookie } });
  const epoch = probe.headers.get("x-zai-epoch");
  await probe.body?.cancel().catch(() => {});
  const res = await fetch(`${base}/zai/api/event`, { headers: { cookie, "last-event-id": epoch ? `${epoch}.0` : "0" } });
  assert.equal(res.status, 200);
  assert.ok((res.headers.get("content-type") ?? "").includes("text/event-stream"));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 5000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (until(buf)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return buf;
}

// --- suite ------------------------------------------------------------------------

test("admin bootstrap: ZAI_ADMIN_TOKEN seeds the admin login", async () => {
  const { res, cookie } = await login(ADMIN_TOKEN);
  assert.equal(res.status, 200, "admin login must succeed");
  const flags = setCookieList(res).join(" ");
  assert.ok(flags.includes("HttpOnly"), "session cookie must be HttpOnly");
  assert.ok(/Max-Age=\d+/.test(flags), "session cookie must be persistent (the device remembers)");
  A.cookie = cookie;
});

test("anonymous API access is rejected with 401 (fail-closed)", async () => {
  const res = await fetch(`${base}/zai/api/session`);
  assert.equal(res.status, 401);
  const me = await fetch(`${base}/zai/api/auth/me`);
  assert.equal(me.status, 401);
  // The gate returns before handleApi, so nothing upstream is dialed for
  // anonymous requests (structurally guaranteed — the hub's own background
  // polls share this fake upstream and are excluded from API assertions by
  // the POST-only/no-URL filters in the scoped tests).
});

test("login rejects a wrong token and never sets a cookie", async () => {
  const { res, cookie } = await login("x".repeat(64));
  assert.equal(res.status, 401);
  assert.equal(cookie, null);
});

test("admin /me resolves the cookie; admin sees every directory", async () => {
  const me = await admin("/zai/api/auth/me");
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.user.role, "admin");
  assert.equal(body.user.id, "admin");

  const list = await (await admin("/zai/api/session")).json();
  const ids = new Set(list.map((s) => s.id));
  assert.ok(ids.has("ses_foreign") && ids.has("ses_own"), "admin must see all tenants' sessions");
});

test("admin creates a tenant; token is returned exactly once, folders provisioned", async () => {
  const res = await admin("/zai/api/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "alice" }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(typeof body.token === "string" && body.token.length >= 48, "the token must be long");
  assert.ok(!JSON.stringify(body).includes("tokenHash"), "no hash may leak");
  assert.equal(body.user.role, "user");
  assert.equal(body.user.directories.length, 1, "a personal chat directory is provisioned");
  assert.ok(existsSync(body.user.directories[0]), "the chat dir must exist before the first prompt (realPath incident)");
  assert.ok(existsSync(body.user.obsidianRoot), "the personal obsidian zone must exist");
  T.token = body.token;
  T.dirs = body.user.directories;
  T.vault = body.user.obsidianRoot;
});

test("tenant login works; the store never holds the plaintext token", async () => {
  const { res, cookie } = await login(T.token);
  assert.equal(res.status, 200);
  T.cookie = cookie;
  const me = await fetch(`${base}/zai/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.user.id, "alice");
  assert.equal(body.user.role, "user");
  const store = readFileSync(path.join(TMP, "data", "users.json"), "utf8");
  assert.ok(!store.includes(T.token), "the plaintext token must never touch the disk");
});

test("tenant session list contains only their own directories", async () => {
  const res = await tenant("/zai/api/session");
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.deepEqual(list.map((s) => s.id), ["ses_own", "ses_own2", "ses_own3"], "foreign sessions must be invisible");
  assert.ok(list.every((s) => samePath(s.directory, ALICE_DIR)));
});

test("tenant POST /session defaults to their folder; foreign directory is 403", async () => {
  resetHits();
  const ok = await tenant("/zai/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(ok.status, 200);
  const hit = apiHits().find((h) => h.method === "POST" && h.url.startsWith("/session"));
  assert.ok(hit, "upstream must receive the create");
  assert.equal(new URL("http://x" + hit.url).searchParams.get("directory"), T.dirs[0], "an unscoped create pins the tenant's own folder");

  const bad = await tenant(`/zai/api/session?directory=${encodeURIComponent(DIR_FOREIGN)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(bad.status, 403);
  assert.equal(apiHits().filter((h) => h.method === "POST").length, 1, "a rejected create must not reach upstream (the only POST is the ok one; hub noise is GET-only)");
});

test("tenant prompt: own passes pinned; foreign 403s without an upstream dial; unknown 404s", async () => {
  resetHits();
  const payload = JSON.stringify({ parts: [{ type: "text", text: "hi" }] });
  const own = await tenant("/zai/api/session/ses_own/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  assert.equal(own.status, 200);
  const ownHit = apiHits().find((h) => h.url.includes("/session/ses_own/prompt_async"));
  assert.ok(ownHit, "own prompt must reach upstream");
  assert.equal(new URL("http://x" + ownHit.url).searchParams.get("directory"), ALICE_DIR, "the resolved directory must pin the call");
  // BUG-12.5: no agent named → the tenant default (first shell-free agent).
  assert.equal(JSON.parse(ownHit.body.toString("utf8")).agent, "safe", "a tenant prompt runs on a shell-free agent");

  const foreign = await tenant("/zai/api/session/ses_foreign/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  assert.equal(foreign.status, 403);
  assert.ok(!apiHits().some((h) => h.url.includes("ses_foreign")), "a foreign prompt must not reach upstream");

  const ghost = await tenant("/zai/api/session/ses_ghost/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  assert.equal(ghost.status, 404, "an unknown session must 404 for tenants, not leak upstream");
});

test("2026-11-05: subagents are not tenant agents; a chat bound to one runs on the tenant default", async () => {
  const list = await (await tenant("/zai/api/agent")).json();
  assert.equal(list.some((a) => a.name === "looker"), false, "a subagent is not offered to a tenant");
  resetHits();
  const r = await jsonPost(tenant, "/zai/api/session/ses_own3/prompt", { parts: [{ type: "text", text: "hi" }] });
  assert.equal(r.status, 200);
  const hit = apiHits().find((h) => h.url.includes("/session/ses_own3/prompt_async"));
  assert.ok(hit, "the prompt reaches upstream");
  assert.equal(JSON.parse(hit.body.toString("utf8")).agent, "safe");
  // the client sends the chat's bound agent in the body — same fallback
  resetHits();
  const r2 = await jsonPost(tenant, "/zai/api/session/ses_own3/prompt", { agent: "looker", parts: [{ type: "text", text: "hi" }] });
  assert.equal(r2.status, 200);
  const hit2 = apiHits().find((h) => h.url.includes("/session/ses_own3/prompt_async"));
  assert.equal(JSON.parse(hit2.body.toString("utf8")).agent, "safe");
});

test("tenant /status and /dialogs only carry their own scope", async () => {
  const st = await (await tenant("/zai/api/status")).json();
  assert.deepEqual(Object.keys(st), ["ses_own"], "foreign busy sessions must be filtered");

  const dl = await (await tenant("/zai/api/dialogs")).json();
  assert.ok(dl.every((d) => d.sessionID !== "ses_foreign"), "foreign dialogs must be filtered");
  assert.equal(dl.length, 0, "alice has no dialogs of her own");

  const adl = await (await admin("/zai/api/dialogs")).json();
  assert.ok(adl.some((d) => d.sessionID === "ses_foreign"), "admin still sees everything");
});

test("tenant /project is filtered to their worktrees", async () => {
  const res = await tenant("/zai/api/project");
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.deepEqual(list.map((x) => x.id), ["p_own"]);
});

test("admin routes and usage are admin-only", async () => {
  assert.equal((await tenant("/zai/api/admin/users")).status, 403);
  const create = await tenant("/zai/api/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "eve" }),
  });
  assert.equal(create.status, 403);
  assert.equal((await tenant("/zai/api/usage")).status, 403);
  assert.notEqual((await admin("/zai/api/usage")).status, 403, "admin keeps usage access");
});

test("tenant file scope: own dir + own vault yes, foreign dir/vault no", async () => {
  writeFileSync(path.join(T.vault, "note.md"), "alice note");
  const good = await tenant(`/zai/api/file?directory=${encodeURIComponent(T.dirs[0])}&path=${encodeURIComponent(path.join(T.vault, "note.md"))}`);
  assert.equal(good.status, 200);
  assert.equal((await good.text()).trim(), "alice note");

  assert.equal(
    (await tenant(`/zai/api/file?directory=${encodeURIComponent(DIR_FOREIGN)}&path=anything`)).status,
    403,
    "a foreign chat directory is out of scope",
  );
  assert.equal(
    (await tenant(`/zai/api/file?directory=${encodeURIComponent(T.dirs[0])}&path=${encodeURIComponent(SHARED_VAULT_NOTE)}`)).status,
    403,
    "the shared vault is not in a tenant's roots",
  );
});

test("BUG-092: turn-files — own folder lists files changed in the window; foreign folder 403; no directory 400", async () => {
  const at = Date.now() - 5000;
  const p = path.join(T.dirs[0], "gen", "chart.png");
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, "png");
  const w = `${at}-${Date.now() + 1000}`;
  const own = await tenant(`/zai/api/turn-files?directory=${encodeURIComponent(T.dirs[0])}&w=${w}`);
  assert.equal(own.status, 200);
  const body = await own.json();
  assert.ok(body.files[0].includes(p), JSON.stringify(body));
  assert.ok(!body.files[0].some((f) => f.includes(".zai-uploads")), "uploads are not agent results");
  assert.equal((await tenant(`/zai/api/turn-files?directory=${encodeURIComponent(DIR_FOREIGN)}&w=${w}`)).status, 403);
  assert.equal((await tenant(`/zai/api/turn-files?w=${w}`)).status, 400);
});

test("BUG-090: file/exists — batch existence check, 200 for the own folder (no 404 in the console); foreign 403", async () => {
  const p = path.join(T.dirs[0], "probe", "real.png");
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, "png");
  const q = (dir, paths) => `/zai/api/file/exists?directory=${encodeURIComponent(dir)}` + paths.map((x) => `&path=${encodeURIComponent(x)}`).join("");
  const own = await tenant(q(T.dirs[0], [p, "probe/gone.png", SHARED_VAULT_NOTE]));
  assert.equal(own.status, 200);
  assert.deepEqual((await own.json()).exists, [true, false, false], "missing and out-of-roots are both false");
  assert.equal((await tenant(q(DIR_FOREIGN, ["x.png"]))).status, 403);
  assert.equal((await tenant(q(T.dirs[0], []))).status, 400, "no path");
  const many = Array.from({ length: 101 }, (_, i) => `f${i}.png`);
  assert.equal((await tenant(q(T.dirs[0], many))).status, 400, "batch is capped");
});

test("BUG-141: malformed ?directory= (UNC, device, alias, relative) → 400 before upstream on any route; drive root / system tree still readable", async () => {
  const before = seen.length;
  const bad = { unc: "\\\\evil\\share", "device-namespace": "\\\\?\\C:\\x", alias: WIN ? "C:\\Users\\USER\\file.txt:stream" : "/home/u/file*stream", "not-absolute": "relative\\folder" };
  for (const [code, dir] of Object.entries(bad)) {
    for (const route of ["/zai/api/session", "/zai/api/session/ses_a/message", "/zai/api/file/exists"]) {
      const r = await admin(`${route}?directory=${encodeURIComponent(dir)}&path=x.png`);
      assert.equal(r.status, 400, `${route} ${code}`);
      assert.equal((await r.json()).code, code);
    }
  }
  // a duplicated param cannot smuggle the bad one past the first
  assert.equal((await admin(`/zai/api/session?directory=${encodeURIComponent(WIN ? "C:\\Users" : "/home")}&directory=${encodeURIComponent("\\\\evil\\share")}`)).status, 400);
  assert.equal((await tenant(`/zai/api/session?directory=${encodeURIComponent("\\\\evil\\share")}`)).status, 400, "tenants too");
  assert.equal(seen.slice(before).filter((h) => /evil|stream|relative/.test(decodeURIComponent(h.url))).length, 0, "nothing reached upstream");
  // read-only-safe shapes are NOT cut here (BUG-02.5: old chats in System32)
  for (const dir of WIN ? ["C:\\", "C:\\Windows\\System32"] : ["/", "/usr/bin"]) {
    const r = await admin(`/zai/api/session?directory=${encodeURIComponent(dir)}`);
    assert.notEqual(r.status, 400, dir);
  }
});

test("tenant upload lands in their scope; foreign upload is 403", async () => {
  const ok = await tenant("/zai/api/upload?name=doc.txt", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "hi",
  });
  assert.equal(ok.status, 200);
  const out = await ok.json();
  assert.ok(existsSync(path.join(T.dirs[0], ".zai-uploads", out.name)), "the upload must land in the tenant's own folder");

  const bad = await tenant(`/zai/api/upload?directory=${encodeURIComponent(DIR_FOREIGN)}&name=evil.txt`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "hi",
  });
  assert.equal(bad.status, 403);
});

test("SSE replay is tenant-filtered", async () => {
  const adminBuf = await readSse(A.cookie, (buf) => buf.includes("ses_foreign") && buf.includes("ses_own"));
  assert.ok(adminBuf.includes("ses_foreign") && adminBuf.includes("ses_own"), "admin sees both directories' events");

  const aliceBuf = await readSse(T.cookie, (buf) => buf.includes("ses_own"));
  assert.ok(aliceBuf.includes("ses_own"), "alice sees her own directory's events");
  assert.ok(!aliceBuf.includes("ses_foreign"), "foreign events must never reach a tenant stream");
});

// ---- Г1 2026-11-02: tenant policy (BUG-12.5, BUG-12.10, BUG-12.6, FEAT-12.16) ----

const jsonPost = (who, p, body, method = "POST") =>
  who(p, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("BUG-12.10 / FEAT-03.21: /host is admin-only, /mcp is filtered for tenants; /agent and /provider are filtered for tenants", async () => {
  // FEAT-03.21 (owner 2026-11-05): a tenant sees its own MCP servers again —
  // never 403, never a server outside TENANT_MCP (tests/system-prompt-server.test.js).
  const tm = await tenant("/zai/api/mcp");
  assert.notEqual(tm.status, 403);
  if (tm.status === 200) {
    const names = Object.keys(await tm.json());
    assert.ok(names.every((n) => ["websearch", "context7", "grep_app", "marketplace"].includes(n)), names.join(","));
  }
  assert.equal((await tenant("/zai/api/host")).status, 403);
  assert.notEqual((await admin("/zai/api/mcp")).status, 403);

  const agents = await (await tenant("/zai/api/agent")).json();
  assert.deepEqual(agents.map((a) => a.name), ["safe"], "shell-capable and delegating agents are hidden from tenants");
  assert.ok(!JSON.stringify(agents).includes("SECRET PROMPT"), "agent prompts never reach tenants");
  assert.ok(!("permission" in agents[0]), "permission rules never reach tenants");
  const adminAgents = await (await admin("/zai/api/agent")).json();
  assert.equal(adminAgents.length, 4, "admin keeps the full catalog");

  const prov = await (await tenant("/zai/api/provider")).json();
  assert.ok(!prov.connected.includes("anthropic"), "claude is not offered to a tenant by default");
  assert.ok(!prov.all.some((p) => p.id === "anthropic" || p.id === "unconnected-huge"), "only connected, allowed providers");
  const aprov = await (await admin("/zai/api/provider")).json();
  assert.ok(aprov.connected.includes("anthropic"), "admin still sees claude");
});

test("BUG-12.5: tenant cannot bind or prompt claude, nor run a shell agent — refused before any side effect", async () => {
  resetHits();
  // ses_own2 is unbound: ses_own got bound to the default model by its
  // model-less prompt above (BUG-11.13), and a bound chat routes by its binding.
  const claudeModel = { providerID: "anthropic", modelID: "claude-haiku-4-5" };
  const p1 = await jsonPost(tenant, "/zai/api/session/ses_own2/prompt", { model: claudeModel, parts: [{ type: "text", text: "whoami" }] });
  assert.equal(p1.status, 403);
  assert.equal((await p1.json()).error, "engine not allowed");
  const p2 = await jsonPost(tenant, "/zai/api/session/ses_own2/prompt", { agent: "build", parts: [{ type: "text", text: "whoami" }] });
  assert.equal(p2.status, 403, "a shell-capable agent is refused");
  assert.ok(!apiHits().some((h) => h.url.includes("prompt_async")), "refused prompts never reach upstream");

  assert.equal((await jsonPost(tenant, "/zai/api/session/ses_own2/binding", { model: claudeModel }, "PATCH")).status, 403);
  assert.equal((await jsonPost(tenant, "/zai/api/session/ses_own2/binding", { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: "build" }, "PATCH")).status, 403);
  assert.equal((await jsonPost(tenant, "/zai/api/session", { model: claudeModel })).status, 403, "creating a claude chat is refused");
  const ok = await jsonPost(tenant, "/zai/api/session/ses_own2/binding", { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: "safe" }, "PATCH");
  assert.equal(ok.status, 200, "a shell-free agent binding is accepted");
});

test("BUG-12.5/12.10: tenant replies — foreign dialog 404, shell permission reject-only, pinned directory", async () => {
  const foreign = await jsonPost(tenant, `/zai/api/permission/per_foreign/reply?directory=${encodeURIComponent(ALICE_DIR)}&directory=${encodeURIComponent(DIR_FOREIGN)}`, { reply: "once" });
  assert.equal(foreign.status, 404, "a dialog outside the tenant's scope does not exist for them");
  FLAGS.aliceAsk = true;
  try {
    const allow = await jsonPost(tenant, "/zai/api/permission/per_own/reply", { reply: "always" });
    assert.equal(allow.status, 403, "a tenant cannot approve a shell permission");
    resetHits();
    const rej = await jsonPost(tenant, `/zai/api/permission/per_own/reply?directory=${encodeURIComponent(DIR_FOREIGN)}`, { reply: "reject" });
    assert.equal(rej.status, 200);
    const hit = apiHits().find((h) => h.url.startsWith("/permission/per_own/reply"));
    assert.ok(hit);
    assert.deepEqual(new URL("http://x" + hit.url).searchParams.getAll("directory"), [ALICE_DIR], "upstream sees only the dialog's own directory");
  } finally {
    FLAGS.aliceAsk = false;
  }
});

test("FEAT-12.16: tenant /message carries no raw commands or server paths", async () => {
  // The generic fake answers {ok,url}; serve a tool part through a patched
  // response is not possible here, so the redaction is unit-tested in
  // tests/g1-policy.test.js — this checks the route stays scoped & JSON.
  const r = await tenant("/zai/api/session/ses_own/message");
  assert.equal(r.status, 200);
  assert.equal((await tenant("/zai/api/session/ses_foreign/message")).status, 403);
});

test("BUG-12.6: foreign DELETE is 403 with no side effects; upstream 5xx keeps local data", async () => {
  const bind = await jsonPost(admin, "/zai/api/session/ses_foreign/binding", { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: "build" }, "PATCH");
  assert.equal(bind.status, 200);
  const del = await tenant("/zai/api/session/ses_foreign", { method: "DELETE" });
  assert.equal(del.status, 403);
  const bindingOf = async () => (await (await admin("/zai/api/session")).json()).find((s) => s.id === "ses_foreign")?.zai;
  assert.equal((await bindingOf())?.source, "stored", "the foreign binding survives a refused DELETE");

  FLAGS.failDelete = true;
  try {
    const d5 = await admin("/zai/api/session/ses_foreign", { method: "DELETE" });
    assert.equal(d5.status, 500);
    assert.equal((await bindingOf())?.source, "stored", "an upstream failure keeps the binding");
  } finally {
    FLAGS.failDelete = false;
  }
  const ok = await admin("/zai/api/session/ses_foreign", { method: "DELETE" });
  assert.equal(ok.status, 200);
  assert.notEqual((await bindingOf())?.source, "stored", "a confirmed delete forgets the binding");
});

test("BUG-12.10: tenant upload per-file limit → 413 and no partial file", async () => {
  const before = existsSync(path.join(T.dirs[0], ".zai-uploads")) ? readdirSync(path.join(T.dirs[0], ".zai-uploads")).length : 0;
  const big = await tenant("/zai/api/upload?name=big.bin", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.alloc(8192, 1) });
  assert.equal(big.status, 413);
  await new Promise((r) => setTimeout(r, 100)); // пауза по смыслу (QA-07): окно, за которое 413 не должен оставить частичный файл
  assert.equal(readdirSync(path.join(T.dirs[0], ".zai-uploads")).length, before, "nothing is left behind");
});

test("ADR-009/BUG-12.9: session cookie is Path=/zai, Secure behind https, clears the legacy Path=/ cookie", async () => {
  const res = await fetch(`${base}/zai/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
    body: JSON.stringify({ token: T.token }),
  });
  assert.equal(res.status, 200);
  const list = setCookieList(res);
  assert.match(list[0], /Path=\/zai;/);
  assert.match(list[0], /Secure/);
  assert.ok(!list[0].includes(T.token), "the cookie carries a session id, not the token");
  assert.ok(list.some((c) => /Path=\/;.*Max-Age=0/.test(c)), "the legacy Path=/ cookie is expired");
});

test("BUG-12.9: login is JSON-only; cross-site mutations are refused", async () => {
  const form = await fetch(`${base}/zai/api/auth/login`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ token: T.token }) });
  assert.equal(form.status, 415);
  const cross = await tenant("/zai/api/session", { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: "{}" });
  assert.equal(cross.status, 403);
  const sfs = await tenant("/zai/api/session", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: "{}" });
  assert.equal(sfs.status, 403);
  const same = await tenant("/zai/api/session", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{}" });
  assert.equal(same.status, 200, "same-origin requests pass");
});

test("ADR-009: a legacy raw-token cookie still works once and is migrated to a session cookie", async () => {
  const res = await fetch(`${base}/zai/api/auth/me`, { headers: { cookie: `zai_t=${T.token}` } });
  assert.equal(res.status, 200);
  const list = setCookieList(res);
  assert.match(list[0] ?? "", /^zai_t=[^;]+; Path=\/zai/, "a sid cookie replaces the legacy one");
});

test("BUG-12.10: regenerating a tenant token closes their live SSE stream", async () => {
  const res = await fetch(`${base}/zai/api/event`, { headers: { cookie: T.cookie } });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  await reader.read(); // stream is live
  const regen = await admin("/zai/api/admin/users/alice/token", { method: "POST" });
  assert.equal(regen.status, 201);
  T.token = (await regen.json()).token;
  const deadline = Date.now() + 3000;
  let closed = false;
  while (Date.now() < deadline) {
    try {
      const { done } = await reader.read();
      if (done) {
        closed = true;
        break;
      }
    } catch {
      closed = true;
      break;
    }
  }
  assert.ok(closed, "the stream must be closed by the server");
  const relog = await login(T.token);
  T.cookie = relog.cookie;
});

test("TASK-12.20: /healthz is loopback-direct only; access log has no query strings or tokens", async () => {
  const h = await fetch(`${base}/zai/api/healthz`);
  assert.ok(h.status === 200 || h.status === 503);
  const body = await h.json();
  assert.equal(typeof body.uptimeS, "number");
  assert.ok(h.headers.get("x-request-id"), "every response carries a request id");
  assert.equal((await fetch(`${base}/zai/api/healthz`, { headers: { "x-forwarded-for": "1.2.3.4" } })).status, 404, "edge-relayed callers get 404");
  const viaOldEdge = await new Promise((resolve) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: "/zai/api/healthz", headers: { host: "192.168.0.10" } }, (r) => {
      r.resume();
      resolve(r.statusCode);
    });
  });
  assert.equal(viaOldEdge, 404, "a request relayed with the browser's Host gets 404 too");

  await tenant(`/zai/api/file?directory=${encodeURIComponent(T.dirs[0])}&path=secret-query-marker`);
  // QA-07: журнал пишется асинхронно — ждём строку, а не фиксированные 200 мс.
  const logs = await waitFor(
    () => {
      const all = readdirSync(path.join(TMP, "logs")).map((f) => readFileSync(path.join(TMP, "logs", f), "utf8")).join("");
      return all.includes('"path":"/zai/api/file"') ? all : null;
    },
    { label: "строка access-журнала о /zai/api/file" },
  );
  assert.ok(logs.includes('"path":"/zai/api/file"'), "requests are journaled");
  assert.ok(!logs.includes("secret-query-marker"), "query strings are not journaled");
  assert.ok(!logs.includes(T.token) && !logs.includes(ADMIN_TOKEN), "tokens are never journaled");
  assert.ok(logs.includes('"user":"alice"'), "the user id is journaled");
});

test("BUG-12.12: an internal error answers a generic 500 with rid; the process keeps serving", async () => {
  const r = await admin("/zai/api/admin/users/%E0%A4%A/token", { method: "POST" });
  assert.ok(r.status === 500 || r.status === 400 || r.status === 404);
  const txt = await r.text();
  assert.ok(!/URIError|at .*\.js/.test(txt), "no internal error text leaks");
  assert.equal((await admin("/zai/api/auth/me")).status, 200, "the server is still alive");
});

test("token lifecycle: regenerate invalidates the old token", async () => {
  const regen = await admin("/zai/api/admin/users/alice/token", { method: "POST" });
  assert.equal(regen.status, 201);
  const fresh = (await regen.json()).token;
  assert.equal((await tenant("/zai/api/auth/me")).status, 401, "the old cookie must stop working immediately");

  const relog = await login(fresh);
  assert.equal(relog.res.status, 200);
  T.token = fresh;
  T.cookie = relog.cookie;
});

test("disable a tenant: API access and login stop; enable restores", async () => {
  const off = await admin("/zai/api/admin/users/alice", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ disabled: true }),
  });
  assert.equal(off.status, 200);
  assert.equal((await tenant("/zai/api/auth/me")).status, 401, "a disabled tenant loses access immediately");
  assert.equal((await login(T.token)).res.status, 401, "disabled users cannot log in (the token resolves to nothing)");

  const on = await admin("/zai/api/admin/users/alice", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ disabled: false }),
  });
  assert.equal(on.status, 200);
  // TASK-12.21: disabling revoked the server sessions — the old cookie stays
  // dead, a fresh login with the (unchanged) token works again.
  assert.equal((await tenant("/zai/api/auth/me")).status, 401, "disable revokes existing sessions");
  const relog = await login(T.token);
  assert.equal(relog.res.status, 200, "re-enabled access is restored by logging in");
  T.cookie = relog.cookie;
  assert.equal((await tenant("/zai/api/auth/me")).status, 200);
});

test("admin is protected: no patch/regenerate/delete via the API; list carries no hash material", async () => {
  assert.equal((await admin("/zai/api/admin/users/admin", { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
  assert.equal((await admin("/zai/api/admin/users/admin/token", { method: "POST" })).status, 404);
  assert.equal((await admin("/zai/api/admin/users/admin", { method: "DELETE" })).status, 404);
  const list = await (await admin("/zai/api/admin/users")).json();
  assert.ok(!JSON.stringify(list).includes("tokenHash"), "the user list must not carry hash material");
});

// ISSUE-015: the folders the portal provisioned for the account go with it.
test("delete a tenant: token dies, its provisioned folders are removed", async () => {
  assert.equal((await admin("/zai/api/admin/users/alice", { method: "DELETE" })).status, 200);
  assert.equal((await tenant("/zai/api/auth/me")).status, 401);
  assert.ok(!existsSync(T.dirs[0]), "provisioned chat folder is removed");
  assert.ok(!existsSync(T.vault), "provisioned vault folder is removed");
});

test("logout expires the cookie; the next request is anonymous again", async () => {
  const out = await admin("/zai/api/auth/logout", { method: "POST" });
  assert.equal(out.status, 200);
  assert.ok(/Max-Age=0/.test(setCookieList(out).join(" ")), "logout must expire the cookie");
  // TASK-12.21: the session is revoked server-side — a replayed cookie is dead.
  assert.equal((await admin("/zai/api/auth/me")).status, 401, "logout revokes the session id");
});
