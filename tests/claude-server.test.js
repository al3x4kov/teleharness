// Server-level claude runner e2e: the REAL server.js against a fake upstream
// and the fake claude CLI - prompt routing by model.providerID, /message
// merge, /provider catalog injection. Mirrors tests/server.test.js harness
// (spawn + ZAI_ADMIN_TOKEN login cookie).
// Run: node --test tests/claude-server.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// FEAT-13.19: a Claude answer is several parts (steps, tools, text) — its text is every text part.
const textOf = (m) => (m?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("\n\n");

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const HOME = mkdtempSync(path.join(tmpdir(), "zai-claude-srv-home-"));
const DATA = mkdtempSync(path.join(tmpdir(), "zai-claude-srv-data-"));
const ADMIN_TOKEN = "c".repeat(20) + "-claude-srv-test-" + "8".repeat(24);

const seen = [];
const upstream = createUpstream();
function createUpstream() {
  return {
    hits: [],
    created: 0,
    async listen() {
      const http = await import("node:http");
      this.server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://x");
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          this.hits.push({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString("utf8") });
          if (req.method === "GET" && url.pathname === "/session") {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify([{ id: "ses_x", directory: HOME }]));
          }
          if (req.method === "POST" && url.pathname === "/session") {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(JSON.stringify({ id: `ses_c${++this.created}`, directory: HOME }));
          }
          if (url.pathname === "/session/ses_x/message") {
            // opencode-side history for this session (from before claude)
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(
              JSON.stringify([
                { info: { id: "msg_up_1", sessionID: "ses_x", role: "user", time: { created: 1000 } }, parts: [{ type: "text", text: "старый вопрос" }] },
                { info: { id: "msg_up_2", sessionID: "ses_x", role: "assistant", providerID: "zai-coding-plan", modelID: "glm-5.3", time: { created: 2000, completed: 2500 } }, parts: [{ type: "text", text: "старый ответ" }] },
              ]),
            );
          }
          if (url.pathname === "/provider") {
            res.writeHead(200, { "content-type": "application/json" });
            return res.end(
              JSON.stringify({
                connected: ["zai-coding-plan", "zai"],
                all: [{ id: "zai-coding-plan", models: { "glm-5.3": { id: "glm-5.3", name: "GLM 5.3", status: "active" } } }],
                default: { "zai-coding-plan": "glm-5.3" },
              }),
            );
          }
          if (url.pathname === "/event") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            const t = setInterval(() => res.write(": ping\n\n"), 1000);
            req.on("close", () => clearInterval(t));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, url: req.url }));
        });
      });
      await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${this.server.address().port}`;
    },
    close() {
      this.server?.close();
    },
  };
}
const UPSTREAM_BASE = await upstream.listen();

// Isolated env (TASK-14.4): no ZAI_* inherited from the shell.
const srv = await spawnPortal({
  upstream: UPSTREAM_BASE,
  env: {
    ZAI_HOME: HOME,
    ZAI_CHAT_DIR: HOME,
    ZAI_DATA_DIR: DATA,
    ZAI_ADMIN_TOKEN: ADMIN_TOKEN,
    ZAI_CLAUDE_BIN: FIXTURE,
    ZAI_CLAUDE_TIMEOUT_MS: "8000",
  },
});
// Teardown order matters on Windows: while the portal lives it holds open
// handles inside HOME (fs.watch), so rmSync there throws EPERM — and a
// crashed after hook makes node:test skip the REST of the teardown, leaving
// the child alive and its SSE socket pinning the whole runner forever.
after(async () => {
  await srv.stop();
  upstream.close();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  rmSync(DATA, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
const base = srv.base;

const loginRes = await fetch(`${base}/zai/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ token: ADMIN_TOKEN }),
});
assert.equal(loginRes.status, 200, "admin login must succeed");
const AUTH = (typeof loginRes.headers.getSetCookie === "function" ? loginRes.headers.getSetCookie() : [loginRes.headers.get("set-cookie")].filter(Boolean))
  .join("\n")
  .match(/zai_t=[^;]+/)[0];
const call = (p, opts = {}) => fetch(`${base}${p}`, { ...opts, headers: { ...(opts.headers ?? {}), cookie: AUTH } });

test("provider route injects the claude catalog and honors ETag", async () => {
  const res = await call("/zai/api/provider");
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.connected.includes("anthropic"));
  const models = json.all.find((p) => p.id === "anthropic").models;
  assert.ok(models["claude-haiku-4-5"]);
  assert.ok(models["claude-sonnet-4-6"]);
  assert.ok(json.all.some((p) => p.id === "zai-coding-plan")); // upstream intact
  const etag = res.headers.get("etag");
  assert.ok(etag);
  const res304 = await call("/zai/api/provider", { headers: { "if-none-match": etag } });
  assert.equal(res304.status, 304);
});

test("prompt with an anthropic model runs claude, merges history", async () => {
  const created = await call("/zai/api/session?directory=" + encodeURIComponent(HOME), { method: "POST" });
  assert.equal(created.status, 200);

  const res = await call("/zai/api/session/ses_x/prompt?directory=" + encodeURIComponent(HOME), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      parts: [{ type: "text", text: "привет из портала" }],
    }),
  });
  assert.equal(res.status, 204);

  // the turn finalizes into a merged, time-sorted history
  let msgs = null;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const m = await (await call("/zai/api/session/ses_x/message?directory=" + encodeURIComponent(HOME))).json();
    // BUG-164 serves the RUNNING answer too: wait for the finished one (BUG-184 race)
    if (Array.isArray(m) && m.length >= 4 && m.at(-1)?.info?.role === "assistant" && m.at(-1).info.time?.completed) {
      msgs = m;
      break;
    }
  }
  assert.ok(msgs, "merged history must finalize with an assistant message");
  assert.equal(msgs.length, 4); // 2 upstream (old) + user + assistant
  assert.equal(msgs[0].info.id, "msg_up_1"); // oldest first
  assert.equal(msgs[2].info.role, "user");
  assert.equal(textOf(msgs[2]), "привет из портала");
  assert.equal(msgs[3].info.providerID, "anthropic");
  assert.equal(textOf(msgs[3]), "Привет, мир!");
});

// BUG-13.2 end-to-end through server.js: the prompt reaches the CLI via
// stdin as text (a leading "--version" is NOT a flag, Cyrillic intact) and
// the child env carries no portal secrets (the server runs with
// ZAI_ADMIN_TOKEN set).
test("claude prompt via the server: stdin UTF-8 text, no ZAI_* in the CLI env", async () => {
  const prompt = "--version ECHO проверка кириллицы 🙂";
  const res = await call("/zai/api/session/ses_e/prompt?directory=" + encodeURIComponent(HOME), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: "anthropic", modelID: "claude-haiku-4-5" }, parts: [{ type: "text", text: prompt }] }),
  });
  assert.equal(res.status, 204);
  let echo = null;
  for (let i = 0; i < 100 && !echo; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const m = await (await call("/zai/api/session/ses_e/message?directory=" + encodeURIComponent(HOME))).json();
    const last = Array.isArray(m) ? m.at(-1) : null;
    if (last?.info?.role === "assistant" && last.info.time?.completed) echo = JSON.parse(textOf(last));
  }
  assert.ok(echo, "the claude turn must finalize");
  assert.equal(echo.prompt, prompt);
  assert.equal(echo.argv.includes(prompt), false);
  assert.equal(echo.envKeys.some((k) => /^zai_/i.test(k)), false, "env: " + echo.envKeys.join(","));
});

// BUG-11.1 (2026-11-02): the chat's binding decides the engine, never the
// body. ses_x is claude-bound by now — a glm body (stale client with the
// global default) must NOT leak upstream.
test("claude-bound chat ignores a glm model in the prompt body", async () => {
  const before = upstream.hits.filter((h) => h.url.includes("/session/ses_x/prompt_async")).length;
  const res = await call("/zai/api/session/ses_x/prompt?directory=" + encodeURIComponent(HOME), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: { providerID: "zai-coding-plan", modelID: "glm-5.3" },
      agent: "Sisyphus - ultraworker",
      parts: [{ type: "text", text: "glm turn" }],
    }),
  });
  assert.ok(res.status === 204 || res.status === 409, `claude runner answers (got ${res.status})`);
  const after = upstream.hits.filter((h) => h.url.includes("/session/ses_x/prompt_async")).length;
  assert.equal(after, before, "nothing proxied to opencode");
});

test("engine switch of a prompted chat is refused with 409", async () => {
  const res = await call("/zai/api/session/ses_x/binding?directory=" + encodeURIComponent(HOME), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } }),
  });
  assert.equal(res.status, 409);
  const list = await (await call("/zai/api/session")).json();
  const x = list.find((s) => s.id === "ses_x");
  assert.equal(x.zai.engine, "claude", "binding unchanged");
  assert.equal(x.zai.agent, null, "claude chats carry no agent");
});

test("an unbound chat binds to its first prompt and proxies opencode with the agent", async () => {
  const res = await call("/zai/api/session/ses_y/prompt?directory=" + encodeURIComponent(HOME), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: { providerID: "zai-coding-plan", modelID: "glm-5.3" },
      agent: "Sisyphus - ultraworker",
      parts: [{ type: "text", text: "glm turn" }],
    }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.url.includes("/session/ses_y/prompt_async"));
  const hit = upstream.hits.filter((h) => h.url.includes("/session/ses_y/prompt_async")).at(-1);
  const sent = JSON.parse(hit.body);
  assert.deepEqual(sent.model, { providerID: "zai-coding-plan", modelID: "glm-5.3" });
  assert.equal(sent.agent, "Sisyphus - ultraworker");
  // a later claude body cannot re-route it
  const res2 = await call("/zai/api/session/ses_y/prompt?directory=" + encodeURIComponent(HOME), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, parts: [{ type: "text", text: "x" }] }),
  });
  assert.equal(res2.status, 200, "still proxied upstream");
  const hit2 = upstream.hits.filter((h) => h.url.includes("/session/ses_y/prompt_async")).at(-1);
  assert.equal(JSON.parse(hit2.body).model.providerID, "zai-coding-plan");
});

// FEAT-11.4: POST /session with {model, agent} records the chat's binding
// immediately (prompted:false) — the pills in the empty chat, and BUG-11.2:
// a claude chat never carries an agent, whatever was chosen.
test("POST /session records the chosen binding; claude drops the agent", async () => {
  const cl = await call("/zai/api/session?directory=" + encodeURIComponent(HOME), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: { providerID: "anthropic", modelID: "claude-opus-5-5" },
      agent: "Sisyphus - ultraworker",
    }),
  });
  assert.equal(cl.status, 200);
  const cj = await cl.json();
  assert.match(cj.id, /^ses_c\d+$/);
  assert.equal(cj.zai.engine, "claude");
  assert.deepEqual(cj.zai.model, { providerID: "anthropic", modelID: "claude-opus-5-5" });
  assert.equal(cj.zai.agent, null, "claude chats carry no agent (BUG-11.2)");
  assert.equal(cj.zai.prompted, false, "binding not frozen before the first prompt");

  const oc = await call("/zai/api/session?directory=" + encodeURIComponent(HOME), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: { providerID: "zai-coding-plan", modelID: "glm-5.3" },
      agent: "Sisyphus - ultraworker",
    }),
  });
  assert.equal(oc.status, 200);
  const oj = await oc.json();
  assert.equal(oj.zai.engine, "opencode");
  assert.equal(oj.zai.agent, "Sisyphus - ultraworker");
  assert.equal(oj.zai.prompted, false);
});

// BUG-013 (dogfood 2026-11-02): a relative project path landed the session in
// the service cwd (C:\WINDOWS\system32). The route must refuse it up front.
test("POST /session with a relative or parent-hopping directory → 400", async () => {
  for (const dir of ["relative\\folder", "..\\x", "C:\\Users\\..\\Windows"]) {
    const r = await call("/zai/api/session?directory=" + encodeURIComponent(dir), { method: "POST" });
    assert.equal(r.status, 400, `${dir} must be refused`);
    // BUG-12.11: one path policy; the machine-readable code is the contract.
    assert.equal((await r.json()).code, "not-absolute");
  }
});

// FEAT-11.5: an EMPTY chat may still switch engines freely — the lock (409)
// appears only after the first prompt. DELETE must forget the binding, so a
// recreated chat starts unbound.
test("PATCH flips the engine of an unprompted chat; DELETE forgets the binding", async (t) => {
  const mk = async (model, agent) =>
    (
      await call("/zai/api/session?directory=" + encodeURIComponent(HOME), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, agent }),
      })
    ).json();
  const fresh = await mk({ providerID: "zai-coding-plan", modelID: "glm-5.3" }, "Sisyphus - ultraworker");

  // opencode → claude: allowed while the chat is empty; the agent is dropped.
  const toClaude = await call(`/zai/api/session/${fresh.id}/binding?directory=` + encodeURIComponent(HOME), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" } }),
  });
  assert.equal(toClaude.status, 200);
  const tj = await toClaude.json();
  assert.equal(tj.zai.engine, "claude");
  assert.equal(tj.zai.agent, null, "engine switch away from opencode must not keep the agent");
  assert.deepEqual(tj.zai.model, { providerID: "anthropic", modelID: "claude-sonnet-4-6" });

  // claude → opencode without naming an agent: allowed, agent stays null
  // (the old engine's agent must not leak across engines).
  const toOc = await call(`/zai/api/session/${fresh.id}/binding?directory=` + encodeURIComponent(HOME), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } }),
  });
  assert.equal(toOc.status, 200);
  assert.equal((await toOc.json()).zai.agent, null);

  // DELETE forgets: without the binding (and with the id unknown to the
  // upstream index and the claude store) the PATCH route must answer 404.
  const del = await call(`/zai/api/session/${fresh.id}?directory=` + encodeURIComponent(HOME), { method: "DELETE" });
  assert.ok(del.status === 200 || del.status === 204, `upstream delete proxied (got ${del.status})`);
  const gone = await call(`/zai/api/session/${fresh.id}/binding?directory=` + encodeURIComponent(HOME), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } }),
  });
  assert.equal(gone.status, 404, "binding must be forgotten after DELETE");
});

// ---- FEAT-13.17: Claude agents through the real server ------------------------

const OPUS_M = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const jsonCall = (p, method, b) => call(p, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
async function lastAnswer(id, count) {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const m = await (await call(`/zai/api/session/${id}/message?directory=` + encodeURIComponent(HOME))).json();
    const asst = Array.isArray(m) ? m.filter((x) => x.info?.role === "assistant" && x.info?.time?.completed) : [];
    if (asst.length >= count) return asst.at(-1);
  }
  throw new Error(`no ${count} answers in ${id}`);
}
const promptEcho = (id) =>
  jsonCall(`/zai/api/session/${id}/prompt?directory=` + encodeURIComponent(HOME), "POST", { agent: "Sisyphus - ultraworker", model: OPUS_M, parts: [{ type: "text", text: "ECHO агент" }] });

test("GET /zai/api/claude/agents: admin gets id/name/description (Workflow), no prompt; tenant → 403; new file without restart", async () => {
  const r = await call("/zai/api/claude/agents");
  assert.equal(r.status, 200);
  const { agents } = await r.json();
  const wf = agents.find((a) => a.id === "workflow");
  assert.equal(wf.name, "Workflow");
  assert.match(wf.description, /флоу разработки/);
  assert.deepEqual(Object.keys(wf).sort(), ["description", "id", "name"], "no prompt, no paths");

  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(path.join(DATA, "claude-agents"), { recursive: true });
  writeFileSync(path.join(DATA, "claude-agents", "reviewer.md"), "---\nname: Reviewer\ndescription: Ревью кода\n---\nТы ревьюер.\n");
  const again = await (await call("/zai/api/claude/agents")).json();
  assert.ok(again.agents.some((a) => a.id === "reviewer" && a.name === "Reviewer"), "a new file shows up without a restart");

  const t = await (await call("/zai/api/admin/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "clagtenant" }) })).json();
  assert.ok(t.token, "tenant created");
  const tr = await fetch(`${base}/zai/api/claude/agents`, { headers: { authorization: `Bearer ${t.token}` } });
  assert.equal(tr.status, 403);
});

test("Claude chat agent: default none; pick Workflow; change after the first message without 409; the engine stays locked", async () => {
  const created = await (await jsonCall("/zai/api/session?directory=" + encodeURIComponent(HOME), "POST", { model: OPUS_M })).json();
  const id = created.id;
  assert.equal(created.zai.engine, "claude");
  assert.equal(created.zai.agent, null, "a new Claude chat has no agent");

  // first message without an agent: the CLI gets no --agents/--agent (the body's opencode agent is ignored)
  assert.equal((await promptEcho(id)).status, 204);
  let argv = JSON.parse(textOf(await lastAnswer(id, 1))).argv;
  assert.equal(argv.includes("--agent"), false);
  assert.equal(argv.includes("--agents"), false);
  assert.equal(argv.some((x) => x.includes("Sisyphus")), false);

  // after the first message: the agent may change (no 409)
  let p = await jsonCall(`/zai/api/session/${id}/binding?directory=` + encodeURIComponent(HOME), "PATCH", { agent: "workflow" });
  assert.equal(p.status, 200);
  assert.equal((await p.json()).zai.agent, "workflow");
  assert.equal((await promptEcho(id)).status, 204);
  const withAgent = await lastAnswer(id, 2);
  argv = JSON.parse(textOf(withAgent).replace(/ \(resumed\)/g, "")).argv;
  assert.equal(argv[argv.indexOf("--agent") + 1], "workflow");
  assert.equal(argv[argv.indexOf("--agents") + 1], path.join(DATA, "claude-agents.compiled.json"));
  assert.ok(argv.includes("--resume"), "same claude session");
  assert.equal(withAgent.info.agent, "workflow", "the answer records its agent");

  // the stored binding keeps the agent (a model change within claude shows it)
  p = await jsonCall(`/zai/api/session/${id}/binding?directory=` + encodeURIComponent(HOME), "PATCH", { model: OPUS_M });
  assert.equal((await p.json()).zai.agent, "workflow");

  // back to «Без агента»; an opencode name is never stored; the engine is locked
  p = await jsonCall(`/zai/api/session/${id}/binding?directory=` + encodeURIComponent(HOME), "PATCH", { agent: null });
  assert.equal((await p.json()).zai.agent, null);
  p = await jsonCall(`/zai/api/session/${id}/binding?directory=` + encodeURIComponent(HOME), "PATCH", { agent: "Sisyphus - ultraworker" });
  assert.equal((await p.json()).zai.agent, null);
  p = await jsonCall(`/zai/api/session/${id}/binding?directory=` + encodeURIComponent(HOME), "PATCH", { model: { providerID: "zai-coding-plan", modelID: "glm-5.3" } });
  assert.equal(p.status, 409);
});

test("a Claude agent gone from the catalog: the turn runs without it and the binding resets to none", async () => {
  const { mkdirSync, writeFileSync, unlinkSync } = await import("node:fs");
  mkdirSync(path.join(DATA, "claude-agents"), { recursive: true });
  const file = path.join(DATA, "claude-agents", "temp-agent.md");
  writeFileSync(file, "---\nname: Временный\ndescription: исчезнет\n---\nПромпт.\n");
  const created = await (await jsonCall("/zai/api/session?directory=" + encodeURIComponent(HOME), "POST", { model: OPUS_M, agent: "temp-agent" })).json();
  assert.equal(created.zai.agent, "temp-agent", "POST /session takes a catalog agent");
  unlinkSync(file);
  assert.equal((await promptEcho(created.id)).status, 204);
  const ans = await lastAnswer(created.id, 1);
  const argv = JSON.parse(textOf(ans)).argv;
  assert.equal(argv.includes("--agent"), false);
  assert.equal("agent" in ans.info, false);
  const p = await jsonCall(`/zai/api/session/${created.id}/binding?directory=` + encodeURIComponent(HOME), "PATCH", { model: OPUS_M });
  assert.equal((await p.json()).zai.agent, null, "binding reset");
});

// ---- FEAT-03.22: the user's system prompt reaches the Claude CLI ---------------

test("FEAT-03.22: a saved system prompt rides --append-system-prompt-file of the next Claude turn; cleared → none", async () => {
  const { readFileSync } = await import("node:fs");
  const put = (text) => jsonCall("/zai/api/me/system-prompt", "PUT", { text });
  assert.equal((await put("Начинай ответ со слова ПРОБА")).status, 200);
  const created = await (await jsonCall("/zai/api/session?directory=" + encodeURIComponent(HOME), "POST", { model: OPUS_M })).json();
  assert.equal((await promptEcho(created.id)).status, 204);
  let argv = JSON.parse(textOf(await lastAnswer(created.id, 1))).argv;
  const file = argv[argv.indexOf("--append-system-prompt-file") + 1];
  assert.ok(file && readFileSync(file, "utf8").includes("Начинай ответ со слова ПРОБА"));
  assert.equal(argv.some((x) => x.includes("ПРОБА")), false, "the text itself is not on argv");

  assert.equal((await put("")).status, 200);
  assert.equal((await promptEcho(created.id)).status, 204);
  argv = JSON.parse(textOf(await lastAnswer(created.id, 2)).replace(/ \(resumed\)/g, "")).argv;
  // FEAT-05.29: файл остаётся — в нём только правило портала о файлах, инструкций пользователя нет
  const kept = readFileSync(argv[argv.indexOf("--append-system-prompt-file") + 1], "utf8");
  assert.equal(kept.includes("ПРОБА"), false, "cleared: no user prompt");
  assert.match(kept, /Правило портала о файлах/);
  assert.equal(argv[argv.indexOf("--system-prompt-snapshot") + 1], "off", "the old recorded prompt is not replayed");
});
