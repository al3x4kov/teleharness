// FEAT-18.8: /teleharness/api/git/* and /teleharness/api/me/git on the REAL server.js against
// the fake opencode, real temporary git repositories, the fake claude CLI and
// the real codex shim over the fake app-server.
//   - settings: defaults per role, validation, a tenant never gets push;
//   - admin: any ?directory=, push only with pushAllowed, push to a bare remote;
//   - tenant: its own chat folder (?sid=) — status, diff, commit with its
//     author; a foreign folder / chat → 403, unknown chat → 404, push → 403;
//     a tenant folder inside the owner's checkout is «not a repository»;
//   - «Предложить сообщение»: Claude (one-shot argv, not in the chat history),
//     Codex (ephemeral read-only thread), opencode (temporary session deleted),
//     a failing model → 502.
// Run: node --test --test-concurrency=1 tests/git-server.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLAUDE_FAKE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const CODEX_SHIM = path.join(ROOT, "tests", "fixtures", "codex-shim-runner.mjs");
const ADMIN = "g".repeat(24) + "-git-server-" + "5".repeat(24);
const TMP = mkdtempSync(path.join(os.tmpdir(), "teleharness-git-srv-"));
const DATA = path.join(TMP, "data");
mkdirSync(DATA);
writeFileSync(path.join(DATA, "codex-models.json"), JSON.stringify({ models: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true }] }));

const sh = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Seed", "-c", "user.email=seed@x", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function initRepo(dir, files = { "a.txt": "one\n", "b.txt": "bee\n" }) {
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  sh(dir, "config", "core.autocrlf", "false");
  for (const [n, t] of Object.entries(files)) writeFileSync(path.join(dir, n), t);
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

let up, srv, alice, bob, adminRepo, plain, bare;
let tmpSessions = 0;
const deleted = [];

function api(p, { method = "GET", body, token = ADMIN } = {}) {
  return fetch(srv.base + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const q = (o) => `?${new URLSearchParams(o)}`;
const dirQ = (d) => q({ directory: d });

before(async () => {
  adminRepo = initRepo(path.join(TMP, "admin-repo"));
  plain = path.join(TMP, "plain");
  mkdirSync(plain);
  bare = path.join(TMP, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  sh(adminRepo, "remote", "add", "origin", bare);
  sh(adminRepo, "push", "-q", "-u", "origin", "main");

  up = await startFakeOpencode();
  // temporary sessions of the opencode one-shot
  up.route("POST", "/session", (_req, body, url) => {
    const id = `ses_tmp${++tmpSessions}`;
    const directory = url.searchParams.get("directory");
    up.state.messages[id] = [
      { info: { id: "msg_u", sessionID: id, role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "x" }] },
      { info: { id: "msg_a", sessionID: id, role: "assistant", time: { created: 2, completed: 3 }, finish: "stop" }, parts: [{ type: "text", text: "```\nfeat: от opencode\n```" }] },
    ];
    return { json: { id, directory, title: body?.title } };
  });
  up.fallback((req, _body, url) => {
    const m = /^\/session\/([^/]+)$/.exec(url.pathname);
    if (!m || req.method !== "DELETE") return null;
    deleted.push(decodeURIComponent(m[1]));
    return { json: true };
  });
  srv = await spawnPortal({
    upstream: up.url,
    env: { TELEHARNESS_ADMIN_TOKEN: ADMIN, TELEHARNESS_DATA_DIR: DATA, TELEHARNESS_CLAUDE_BIN: CLAUDE_FAKE, TELEHARNESS_CODEX_SHIM: CODEX_SHIM, TELEHARNESS_CLAUDE_TIMEOUT_MS: "8000" },
  });
  alice = await (await api("/teleharness/api/admin/users", { method: "POST", body: { name: "git-alice" } })).json();
  // a tenant whose folder sits inside the owner's checkout
  const bobDir = path.join(adminRepo, "bob-home");
  mkdirSync(bobDir);
  const rb = await api("/teleharness/api/admin/users", { method: "POST", body: { name: "git-bob", directories: [bobDir] } });
  bob = rb.status === 201 ? await rb.json() : null;
  const aliceDir = alice.user.directories[0];
  initRepo(aliceDir, { "notes.md": "hello\n" });
  // alice's newer chat works in its own subfolder <root>\chats\<id> (FEAT-04.12)
  initRepo(path.join(aliceDir, "chats", "t2"), { "own.txt": "own\n" });
  up.state.sessions.push(
    { id: "ses_t1", directory: aliceDir, title: "alice chat", model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } },
    { id: "ses_t2", directory: aliceDir, title: "alice chat 2" },
    { id: "ses_adm", directory: adminRepo, title: "admin chat" },
    { id: "ses_cl", directory: adminRepo, title: "claude chat" },
    { id: "ses_cx", directory: adminRepo, title: "codex chat" },
    { id: "ses_oc", directory: adminRepo, title: "opencode chat", model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } },
    ...(bob ? [{ id: "ses_b1", directory: bob.user.directories[0], title: "bob" }] : []),
  );
});
after(async () => {
  await srv?.stop();
  await up?.close?.();
  rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("settings: defaults per role, validation, tenant push always off", async () => {
  const a = await (await api("/teleharness/api/me/git")).json();
  assert.match(a.authorEmail, /^[a-z0-9._-]+@teleharness\.local$/);
  assert.equal(a.messageLang, "ui");
  assert.equal(a.preselect, "modified");
  assert.equal(a.pushAllowed, true, "admin: push allowed by default");
  const t = await (await api("/teleharness/api/me/git", { token: alice.token })).json();
  assert.deepEqual(t, { authorName: "git-alice", authorEmail: "git-alice@teleharness.local", messageLang: "ui", preselect: "modified", pushAllowed: false });
  for (const bad of [{ authorEmail: "nope" }, { authorName: "a\nb" }, { authorName: "x".repeat(101) }, { messageLang: "de" }, { preselect: "all" }, { pushAllowed: "yes" }, { authorName: 5 }]) {
    assert.equal((await api("/teleharness/api/me/git", { method: "PUT", token: alice.token, body: bad })).status, 400, JSON.stringify(bad));
  }
  let r = await api("/teleharness/api/me/git", { method: "PUT", token: alice.token, body: { authorName: "Алиса Тест", authorEmail: "alice@example.org", messageLang: "en", pushAllowed: true } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { authorName: "Алиса Тест", authorEmail: "alice@example.org", messageLang: "en", preselect: "modified", pushAllowed: false });
  assert.equal((await (await api("/teleharness/api/me/git", { token: alice.token })).json()).authorName, "Алиса Тест", "stored");
  assert.equal((await (await api("/teleharness/api/me/git")).json()).authorName, a.authorName, "admin record untouched");
  r = await api("/teleharness/api/me/git", { method: "PUT", token: alice.token, body: { authorName: "" } });
  assert.equal((await r.json()).authorName, "git-alice", "empty → back to the default");
  await api("/teleharness/api/me/git", { method: "PUT", token: alice.token, body: { authorName: "Алиса Тест" } });
  assert.equal((await api("/teleharness/api/me/git", { method: "DELETE" })).status, 405);
  assert.equal((await fetch(srv.base + "/teleharness/api/me/git")).status, 401);
});

test("admin status: any folder; not a repository → {repo:false}; bad requests → 400", async () => {
  writeFileSync(path.join(adminRepo, "a.txt"), "one\ntwo\n");
  const r = await api(`/teleharness/api/git/status${dirQ(adminRepo)}`);
  assert.equal(r.status, 200);
  const st = await r.json();
  assert.equal(st.repo, true);
  assert.equal(st.branch, "main");
  assert.equal(st.upstream, "origin/main");
  assert.equal(st.pushAllowed, true);
  assert.deepEqual(st.files.map((f) => [f.path, f.status, f.additions]), [["a.txt", "M", 1]]);
  assert.deepEqual(await (await api(`/teleharness/api/git/status${dirQ(plain)}`)).json(), { repo: false });
  assert.equal((await api("/teleharness/api/git/status")).status, 400);
  assert.equal((await api(`/teleharness/api/git/status${dirQ("rel/dir")}`)).status, 400);
  assert.equal((await api(`/teleharness/api/git/status${q({ sid: "ses_nope" })}`)).status, 404);
  const d = await (await api(`/teleharness/api/git/diff${q({ directory: adminRepo, file: "a.txt" })}`)).json();
  assert.match(d.patch, /^\+two$/m);
  assert.equal((await api(`/teleharness/api/git/diff${q({ directory: adminRepo, file: "../x" })}`)).status, 400);
  assert.equal((await api(`/teleharness/api/git/diff${dirQ(adminRepo)}`)).status, 400, "file required");
  assert.equal((await api(`/teleharness/api/git/diff${q({ directory: plain, file: "a.txt" })}`)).status, 404, "not a repository");
});

test("tenant: own chat folder — status, diff, commit with its author; foreign → 403; push → 403", async () => {
  const aliceDir = alice.user.directories[0];
  writeFileSync(path.join(aliceDir, "notes.md"), "hello\nworld\n");
  writeFileSync(path.join(aliceDir, "new.md"), "fresh\n");
  writeFileSync(path.join(aliceDir, "keep.md"), "not now\n");
  const T = { token: alice.token };
  const st = await (await api(`/teleharness/api/git/status${q({ sid: "ses_t1" })}`, T)).json();
  assert.equal(st.repo, true);
  assert.equal(st.pushAllowed, false);
  assert.deepEqual(st.files.map((f) => f.path).sort(), ["keep.md", "new.md", "notes.md"]);
  assert.equal((await api(`/teleharness/api/git/status${dirQ(aliceDir)}`, T)).status, 200, "own ?directory=");
  // the newer chat's own subfolder is its folder
  const st2 = await (await api(`/teleharness/api/git/status${q({ sid: "ses_t2" })}`, T)).json();
  assert.equal(st2.repo, true);
  assert.equal(st2.root, null, "TASK-18.13 D4: no absolute server path for a tenant");
  assert.equal(st2.rootRel, "chats/t2", "the repo root relative to the chat's directory");
  // foreign
  assert.equal((await api(`/teleharness/api/git/status${dirQ(adminRepo)}`, T)).status, 403);
  assert.equal((await api(`/teleharness/api/git/status${q({ sid: "ses_adm" })}`, T)).status, 403);
  assert.equal((await api(`/teleharness/api/git/commit${q({ sid: "ses_adm" })}`, { ...T, method: "POST", body: { files: ["a.txt"], message: "x" } })).status, 403);
  assert.equal((await api(`/teleharness/api/git/status${q({ sid: "ses_nope" })}`, T)).status, 404);
  // diff
  const d = await (await api(`/teleharness/api/git/diff${q({ sid: "ses_t1", file: "new.md" })}`, T)).json();
  assert.match(d.patch, /^\+fresh$/m);
  assert.equal((await api(`/teleharness/api/git/diff${q({ sid: "ses_t1", file: "../../x" })}`, T)).status, 400);
  // commit exactly two files with the tenant's author
  let r = await api(`/teleharness/api/git/commit${q({ sid: "ses_t1" })}`, { ...T, method: "POST", body: { files: ["notes.md", "new.md"], message: "feat: notes" } });
  assert.equal(r.status, 200);
  const c = await r.json();
  assert.equal(c.subject, "feat: notes");
  assert.deepEqual(c.files, ["notes.md", "new.md"]);
  assert.equal(sh(aliceDir, "log", "-1", "--format=%an <%ae>").trim(), "Алиса Тест <alice@example.org>");
  assert.equal(sh(aliceDir, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort().join(","), "new.md,notes.md");
  assert.match(sh(aliceDir, "status", "--porcelain"), /\?\? keep\.md/, "the third file stays");
  r = await api(`/teleharness/api/git/commit${q({ sid: "ses_t1" })}`, { ...T, method: "POST", body: { files: ["keep.md"], message: "  " } });
  assert.equal(r.status, 400, "empty message");
  r = await api(`/teleharness/api/git/commit${q({ sid: "ses_t1" })}`, { ...T, method: "POST", body: { files: ["../outside"], message: "m" } });
  assert.equal(r.status, 400, "outside the repository");
  // push
  r = await api(`/teleharness/api/git/push${q({ sid: "ses_t1" })}`, { ...T, method: "POST", body: {} });
  assert.equal(r.status, 403);
});

// TASK-18.13 D4: /git/status never hands a tenant an absolute server path;
// admin keeps root. rootRel / name are enough for the client.
test("D4: status — tenant gets root:null + rootRel/name (no server path anywhere); admin keeps root", async () => {
  const aliceDir = alice.user.directories[0];
  const T = { token: alice.token };
  for (const query of [q({ sid: "ses_t1" }), q({ sid: "ses_t2" }), dirQ(aliceDir)]) {
    const text = await (await api(`/teleharness/api/git/status${query}`, T)).text();
    const st = JSON.parse(text);
    assert.equal(st.repo, true, query);
    assert.equal(st.root, null, query);
    assert.equal(text.includes(path.basename(TMP)), false, `no temp folder name in ${query}`);
    assert.equal(st.name, path.basename(aliceDir), "display name = the folder the client asked about");
  }
  assert.equal((await (await api(`/teleharness/api/git/status${q({ sid: "ses_t1" })}`, T)).json()).rootRel, "");
  const adm = await (await api(`/teleharness/api/git/status${dirQ(adminRepo)}`)).json();
  assert.equal(path.resolve(adm.root).toLowerCase(), path.resolve(adminRepo).toLowerCase(), "admin keeps the absolute root");
  assert.equal(adm.rootRel, "");
});

test("tenant folder inside the owner's checkout is not a repository for the tenant", async (t) => {
  if (!bob) return t.skip("tenant folders inside a checkout are refused by the user policy");
  const st = await (await api(`/teleharness/api/git/status${q({ sid: "ses_b1" })}`, { token: bob.token })).json();
  assert.deepEqual(st, { repo: false });
  assert.equal((await api(`/teleharness/api/git/diff${q({ sid: "ses_b1", file: "a.txt" })}`, { token: bob.token })).status, 404);
});

test("admin push: off in settings → 403; on → pushed to the bare remote", async () => {
  sh(adminRepo, "checkout", "--", "a.txt");
  writeFileSync(path.join(adminRepo, "b.txt"), "bee 2\n");
  let r = await api(`/teleharness/api/git/commit${dirQ(adminRepo)}`, { method: "POST", body: { files: ["b.txt"], message: "fix: bee" } });
  assert.equal(r.status, 200);
  await api("/teleharness/api/me/git", { method: "PUT", body: { pushAllowed: false } });
  assert.equal((await (await api(`/teleharness/api/git/status${dirQ(adminRepo)}`)).json()).pushAllowed, false);
  r = await api(`/teleharness/api/git/push${dirQ(adminRepo)}`, { method: "POST", body: {} });
  assert.equal(r.status, 403);
  await api("/teleharness/api/me/git", { method: "PUT", body: { pushAllowed: true } });
  r = await api(`/teleharness/api/git/push${dirQ(adminRepo)}`, { method: "POST", body: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, pushed: 1 });
  assert.equal(execFileSync("git", ["log", "-1", "--format=%s", "main"], { cwd: bare, encoding: "utf8" }).trim(), "fix: bee");
  // no upstream → 409 with the kind
  const lone = initRepo(path.join(TMP, "lone"));
  r = await api(`/teleharness/api/git/push${dirQ(lone)}`, { method: "POST", body: {} });
  assert.equal(r.status, 409);
  const e = await r.json();
  assert.equal(e.kind, "no-upstream");
  assert.equal(e.error.includes(TMP), false, "no server paths");
});

async function bind(sid, model) {
  for (let i = 0; i < 40; i++) {
    const r = await api(`/teleharness/api/session/${sid}/binding`, { method: "PATCH", body: { model } });
    if (r.status === 200) return;
    await new Promise((res) => setTimeout(res, 250)); // the Codex catalog loads after the start
  }
  assert.fail(`binding of ${sid} not accepted`);
}

test("suggest-message: Claude chat — one-shot CLI call, diff in the prompt, nothing in the chat history", async () => {
  await bind("ses_cl", { providerID: "anthropic", modelID: "claude-haiku-4-5" });
  writeFileSync(path.join(adminRepo, "a.txt"), "one\nECHO line\n");
  const r = await api(`/teleharness/api/git/suggest-message${q({ sid: "ses_cl" })}`, { method: "POST", body: { files: ["a.txt"], sid: "ses_cl" } });
  assert.equal(r.status, 200);
  const { message } = await r.json();
  assert.match(message, /\+ECHO line/, "the diff of the selected file is in the prompt");
  assert.match(message, /in Russian/, "messageLang ui → Russian");
  assert.match(message, /"--model","claude-haiku-4-5"/);
  assert.match(message, /"--tools",""/, "tools off");
  assert.match(message, /"--no-session-persistence"/);
  assert.equal(/--resume/.test(message), false);
  const hist = await (await api(`/teleharness/api/session/ses_cl/message${dirQ(adminRepo)}`)).json();
  assert.equal(Array.isArray(hist) ? hist.length : 0, 0, "the chat history stays empty");
  // English per settings
  await api("/teleharness/api/me/git", { method: "PUT", body: { messageLang: "en" } });
  const en = await (await api(`/teleharness/api/git/suggest-message${q({ sid: "ses_cl" })}`, { method: "POST", body: { files: ["a.txt"] } })).json();
  assert.match(en.message, /in English/);
  await api("/teleharness/api/me/git", { method: "PUT", body: { messageLang: "ui" } });
  // "ui" follows the interface language the client sends
  const ui = await (await api(`/teleharness/api/git/suggest-message${q({ sid: "ses_cl" })}`, { method: "POST", body: { files: ["a.txt"], lang: "en" } })).json();
  assert.match(ui.message, /in English/, "messageLang ui + English interface → English");
  await api("/teleharness/api/me/git", { method: "PUT", body: { messageLang: "ui" } });
  // a failing model → 502 with a readable text
  writeFileSync(path.join(adminRepo, "a.txt"), "one\nFAIL\n");
  const f = await api(`/teleharness/api/git/suggest-message${q({ sid: "ses_cl" })}`, { method: "POST", body: { files: ["a.txt"] } });
  assert.equal(f.status, 502);
  const fb = await f.json();
  assert.match(fb.error, /модел/i);
  assert.doesNotMatch(fb.error, /Не удалось получить сообщение от модели/, "TASK-18.13 D6: no stacked prefix");
  assert.equal(fb.detail, "boom", "the provider's raw text apart");
  // a subscription limit → its own Russian sentence (D6)
  writeFileSync(path.join(adminRepo, "a.txt"), "one\nLIMIT\n");
  const lim = await (await api(`/teleharness/api/git/suggest-message${q({ sid: "ses_cl" })}`, { method: "POST", body: { files: ["a.txt"] } })).json();
  assert.equal(lim.kind, "limit");
  assert.equal(lim.error, "Лимит модели этого чата исчерпан — напишите сообщение сами или попробуйте позже.");
  // nothing selected / unchanged
  assert.equal((await api(`/teleharness/api/git/suggest-message${q({ sid: "ses_cl" })}`, { method: "POST", body: { files: [] } })).status, 400);
  assert.equal((await api(`/teleharness/api/git/suggest-message${q({ sid: "ses_cl" })}`, { method: "POST", body: { files: ["b.txt"] } })).status, 400);
  sh(adminRepo, "checkout", "--", "a.txt");
});

test("suggest-message: Codex chat — the shim's one-shot mode: ephemeral read-only thread, approval never", async () => {
  await bind("ses_cx", { providerID: "openai-codex", modelID: "gpt-6.1-sol" });
  writeFileSync(path.join(adminRepo, "a.txt"), "one\nECHOTHREAD\n");
  const r = await api(`/teleharness/api/git/suggest-message${q({ sid: "ses_cx" })}`, { method: "POST", body: { files: ["a.txt"] } });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  const { method, params } = JSON.parse(body.message);
  assert.equal(method, "thread/start", "never a resume of the chat's thread");
  assert.equal(params.ephemeral, true);
  assert.equal(params.sandbox, "read-only");
  assert.equal(params.approvalPolicy, "never");
  assert.equal(params.model, "gpt-6.1-sol");
  sh(adminRepo, "checkout", "--", "a.txt");
});

test("suggest-message: opencode chat — temporary session with the chat's model, deleted after; tenant only its own chats", async () => {
  writeFileSync(path.join(adminRepo, "a.txt"), "one\nthree\n");
  const before = up.requests.length;
  const r = await api(`/teleharness/api/git/suggest-message${q({ sid: "ses_oc" })}`, { method: "POST", body: { files: ["a.txt"] } });
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  assert.equal(body.message, "feat: от opencode", "fences dropped");
  const reqs = up.requests.slice(before);
  const created = reqs.find((x) => x.method === "POST" && x.path === "/session");
  assert.ok(created, "a temporary session was created");
  assert.ok(path.resolve(created.directory).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()), "in the temp dir (hidden from chat lists)");
  const sid = `ses_tmp${tmpSessions}`;
  const prompt = reqs.find((x) => x.method === "POST" && x.path === `/session/${sid}/prompt_async`);
  assert.deepEqual(prompt.body.model, { providerID: "zai-coding-plan", modelID: "glm-5.3" });
  assert.match(prompt.body.parts[0].text, /\+three/);
  assert.ok(deleted.includes(sid), "the temporary session is deleted");
  assert.equal(reqs.some((x) => x.path.startsWith("/session/ses_oc/")), false, "the chat itself is not touched");
  // tenant: own chat ok, foreign chat 403
  writeFileSync(path.join(alice.user.directories[0], "keep.md"), "now\n");
  const t = await api(`/teleharness/api/git/suggest-message${q({ sid: "ses_t1" })}`, { method: "POST", token: alice.token, body: { files: ["keep.md"] } });
  assert.equal(t.status, 200);
  const foreign = await api(`/teleharness/api/git/suggest-message${q({ sid: "ses_t1" })}`, { method: "POST", token: alice.token, body: { files: ["keep.md"], sid: "ses_oc" } });
  assert.equal(foreign.status, 403);
  sh(adminRepo, "checkout", "--", "a.txt");
});

// TASK-18.13 D1 (P1): admin opening git of a tenant's chat SUBFOLDER (chats\<id>) — the tenant's repo
// config must stay untrusted: a program it names (core.fsmonitor) never runs; the admin gets 409 like the tenant.
test("admin + tenant chat subfolder: dangerous repo config refused (409), the program never runs", async () => {
  const aliceDir = alice.user.directories[0];
  const sub = path.join(aliceDir, "chats", "t2");
  const marker = path.join(sub, "fsmonitor-ran.txt");
  const script = path.join(sub, "mon.cmd");
  writeFileSync(script, `@echo ran> "${marker}"\r\n`);
  execFileSync("git", ["config", "core.fsmonitor", script.split(path.sep).join("/")], { cwd: sub });
  try {
    for (const p of [`/teleharness/api/git/status${q({ sid: "ses_t2" })}`, `/teleharness/api/git/status${dirQ(sub)}`]) {
      const r = await api(p);
      assert.equal(r.status, 409, `admin ${p}`);
    }
    assert.equal(existsSync(marker), false, "fsmonitor program did not run");
  } finally {
    execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: sub });
  }
});
