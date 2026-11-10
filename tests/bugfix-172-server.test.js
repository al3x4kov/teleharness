// bugfix-1.7.2 server e2e: the REAL server.js against the fake opencode and
// the fake claude CLI.
//   BUG-13.14 / BUG-083  Claude chats get an auto title (LLM, heuristic
//                        fallback), visible in GET /session, rename wins
//   BUG-01.27 / BUG-018  a snapshot-derived opencode title is replaced once
//   BUG-04.6  / BUG-077  account deletion: chats → dispose → folders, an
//                        undeletable folder answers `warnings` and is retried
//   BUG-01.48 / BUG-078  empty-chat gc deletes only truly empty old chats
//   BUG-11.13 / BUG-082  prompt without model → default model; empty turn →
//                        turn error (live SSE + history)
//   BUG-02.5  / BUG-057  chat without a project lands in ZAI_CHAT_DIR; a
//                        system-tree ZAI_CHAT_DIR refuses to start
// Run: node --test --test-concurrency=1 tests/bugfix-172-server.test.js
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";
import { makeTmpRoot } from "./helpers/env.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE_CLI = path.join(ROOT, "tests", "fixtures", "claude-fake.mjs");
const ADMIN = "a".repeat(24) + "-bugfix-172-" + "1".repeat(24);
const DEF_TITLE = "New session - 2026-11-03T08:00:00.000Z";
const SNAP =
  "[obsidian-cache] Снапшот базы знаний (Obsidian)\n" +
  "Последний дайджест: zai.home.example.net HTTPS IPv6\n" +
  "Правила кэша: читай vault, если нужно больше\n\n---\n\n";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 15_000, stepMs = 100, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timeout waiting for ${what}`);
    await sleep(stepMs);
  }
}

// Fake opencode with the routes these scenarios need.
async function fakeUpstream(initial = []) {
  const up = await startFakeOpencode({ sessions: initial });
  let n = 0;
  up.route("POST", "/session", (req, body, url) => {
    const s = { id: `ses_new${++n}`, directory: url.searchParams.get("directory"), title: DEF_TITLE, time: { created: Date.now(), updated: Date.now() } };
    up.state.sessions.push(s);
    return { json: s };
  });
  up.route("GET", "/config", () => ({ json: { model: "zai-coding-plan/glm-5.3" } }));
  up.route("GET", "/agent", () => ({ json: [{ name: "ask", mode: "primary", permission: [{ permission: "*", pattern: "*", action: "deny" }] }] }));
  up.route("POST", "/instance/dispose", () => ({ json: true }));
  up.fallback((req, body, url) => {
    const m = /^\/session\/([^/]+)$/.exec(url.pathname);
    if (!m) return undefined;
    const id = decodeURIComponent(m[1]);
    const i = up.state.sessions.findIndex((s) => s.id === id);
    // PATCH answers but does NOT change the list: GET /session must show the
    // portal's own title overlay for claude chats.
    if (req.method === "PATCH") return i < 0 ? { status: 404, json: {} } : { json: { ...up.state.sessions[i], ...body } };
    if (req.method === "DELETE") {
      if (i < 0) return { status: 404, json: {} };
      up.state.sessions.splice(i, 1);
      return { json: true };
    }
    return undefined;
  });
  return up;
}

function api(srv, p, { method = "GET", body, token = ADMIN } = {}) {
  return fetch(`${srv.base}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// SSE reader on /zai/api/event: resolves with the first data frame that
// satisfies pred, rejects on timeout.
function sseUntil(srv, pred, { timeoutMs = 10_000, token = ADMIN } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${srv.base}/zai/api/event`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("\n");
          if (!data) continue;
          let evt;
          try {
            evt = JSON.parse(data);
          } catch {
            continue;
          }
          if (pred(evt)) {
            clearTimeout(t);
            req.destroy();
            resolve(evt);
            return;
          }
        }
      });
    });
    req.on("error", () => {});
    const t = setTimeout(() => {
      req.destroy();
      reject(new Error("SSE: expected frame did not arrive"));
    }, timeoutMs);
    req.ready = new Promise((r) => req.on("response", r));
  });
}

const patchesOf = (up, id) => up.requests.filter((r) => r.method === "PATCH" && r.path === `/session/${id}`);

// ---- the main instance --------------------------------------------------------

let up;
let srv;
let tmp;
let CHAT_DIR;

before(async () => {
  tmp = makeTmpRoot("zai-172-");
  CHAT_DIR = path.join(tmp.root, "chats");
  mkdirSync(CHAT_DIR, { recursive: true });
  up = await fakeUpstream();
  srv = await spawnPortal({
    upstream: up.url,
    tmp,
    env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_CLAUDE_BIN: FAKE_CLI, ZAI_TITLE_LLM: "1", ZAI_CHAT_DIR: CHAT_DIR, ZAI_TITLE_TIMEOUT_MS: "5000" },
  });
  await up.waitForSubscription(tmp.home);
});
after(async () => {
  await srv?.stop();
  await up?.close();
});

const OPUS = { providerID: "anthropic", modelID: "claude-opus-5-5" };

async function claudeChat(text) {
  const r = await api(srv, "/zai/api/session", { method: "POST", body: { model: OPUS } });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.zai?.engine, "claude");
  return s;
}

async function promptDone(id) {
  await waitFor(
    async () => {
      const list = await (await api(srv, `/zai/api/session/${id}/message`)).json();
      return Array.isArray(list) && list.some((m) => m.info?.role === "assistant" && m.info.time?.completed);
    },
    { what: `answer in ${id}` },
  );
}

async function promptAndWait(id, text) {
  const r = await api(srv, `/zai/api/session/${id}/prompt`, { method: "POST", body: { parts: [{ type: "text", text }] } });
  assert.equal(r.status, 204);
  await waitFor(
    async () => {
      const list = await (await api(srv, `/zai/api/session/${id}/message`)).json();
      return Array.isArray(list) && list.some((m) => m.info?.role === "assistant" && m.info.time?.completed);
    },
    { what: `answer in ${id}` },
  );
}

test("BUG-02.5: a chat without a project is created in ZAI_CHAT_DIR (never the service cwd)", async () => {
  const s = await claudeChat();
  assert.equal(s.directory, CHAT_DIR);
  const call = up.requests.find((r) => r.method === "POST" && r.path === "/session");
  assert.equal(call.directory, CHAT_DIR);
});

test("BUG-13.14: a Claude chat gets an LLM title from the typed question (snapshot stripped), shown in GET /session and announced via SSE", async () => {
  const s = await claudeChat();
  const sse = sseUntil(srv, (e) => e.type === "session.updated" && e.properties?.info?.id === s.id && e.properties.info.title && e.properties.info.title !== DEF_TITLE);
  await promptAndWait(s.id, SNAP + "Как настроить резервное копирование NAS?");
  const patch = await waitFor(() => patchesOf(up, s.id)[0], { what: "title PATCH upstream" });
  assert.equal(patch.body.title, "Тема Как настроить резервное", "LLM output cleaned («Заголовок: «…»» → title)");
  assert.equal(patch.directory, CHAT_DIR, "PATCH pinned to the chat's directory");
  const evt = await sse;
  assert.equal(evt.properties.info.title, "Тема Как настроить резервное");
  const list = await (await api(srv, "/zai/api/session")).json();
  assert.equal(list.find((x) => x.id === s.id).title, "Тема Как настроить резервное", "the portal title overlays the upstream default");
  // Once per chat: a second turn does not retitle.
  await promptAndWait(s.id, "А ещё вопрос про что-то другое");
  await sleep(400);
  assert.equal(patchesOf(up, s.id).length, 1);
});

// BUG-140 (FEAT-03.12): a picture for a text-only opencode model is saved to
// .zai-uploads and referenced by path (the agent hands it to look_at); a
// vision model keeps the inline picture.
test("BUG-140: picture → file + path for a model without image input; inline for a vision model", async () => {
  up.route("GET", "/provider", () => ({
    json: {
      all: [{ id: "zai-coding-plan", models: {
        "glm-5.3": { id: "glm-5.3", capabilities: { input: { text: true, image: false } } },
        "glm-5.3-flash": { id: "glm-5.3-flash", capabilities: { input: { text: true, image: true } } },
      } }],
      connected: ["zai-coding-plan"],
      default: { "zai-coding-plan": "glm-5.3" },
    },
  }));
  const png = { type: "file", mime: "image/png", filename: "vision.png", url: "data:image/png;base64,iVBORw0KGgo=" };
  const sent = async (modelID) => {
    const r = await api(srv, "/zai/api/session", { method: "POST", body: { model: { providerID: "zai-coding-plan", modelID } } });
    const s = await r.json();
    const before = up.requests.length;
    const p = await api(srv, `/zai/api/session/${s.id}/prompt`, { method: "POST", body: { model: { providerID: "zai-coding-plan", modelID }, parts: [{ type: "text", text: "Опиши картинку" }, png] } });
    assert.equal(p.status, 204);
    const hit = await waitFor(() => up.requests.slice(before).find((x) => x.method === "POST" && x.path === `/session/${s.id}/prompt_async`), { what: "prompt upstream" });
    return { s, body: hit.body };
  };
  const text = await sent("glm-5.3");
  assert.equal(text.body.parts.some((x) => x.type === "file"), false, "no inline picture for glm-5.3");
  const ref = text.body.parts.find((x) => x.type === "text" && x.text.includes(".zai-uploads/vision"));
  assert.ok(ref, JSON.stringify(text.body.parts));
  assert.match(ref.text, /look_at/);
  const abs = ref.text.match(/полный путь (.+?) инструменту/)[1];
  assert.ok(existsSync(abs), "the picture is on disk at the referenced path");
  const vision = await sent("glm-5.3-flash");
  assert.equal(vision.body.parts.filter((x) => x.type === "file").length, 1, "a vision model keeps the inline picture");
});

// BUG-142: a long Claude turn (Workflow agent: hours) must not leave the chat
// «Без названия» — the title comes as soon as the question is stored.
test("BUG-142: a Claude chat is titled and announced while its first turn is still running", async () => {
  const s = await claudeChat();
  const sse = sseUntil(srv, (e) => e.type === "session.updated" && e.properties?.info?.id === s.id && e.properties.info.title && e.properties.info.title !== DEF_TITLE, { timeoutMs: 15_000 });
  const r = await api(srv, `/zai/api/session/${s.id}/prompt`, { method: "POST", body: { parts: [{ type: "text", text: "HANG Как подключить сетевой принтер?" }] } });
  assert.equal(r.status, 204);
  const evt = await sse;
  assert.match(evt.properties.info.title, /^Тема /);
  const list = await (await api(srv, `/zai/api/session/${s.id}/message`)).json();
  assert.equal(list.some((m) => m.info?.role === "assistant" && m.info.time?.completed), false, "the turn is still running");
  const st = await (await api(srv, "/zai/api/session/status")).json().catch(() => null);
  if (st && typeof st === "object" && st[s.id]) assert.equal(st[s.id].type, "busy");
  assert.equal(patchesOf(up, s.id).length, 1, "titled once");
  await api(srv, `/zai/api/session/${s.id}/abort`, { method: "POST" });
  await sleep(300);
  assert.equal(patchesOf(up, s.id).length, 1, "the turn end does not retitle");
});

// BUG-13.16 / BUG-085: claude turns never touch the upstream record (its
// time.updated stays at creation) — the portal lifts it from the claude store
// and announces the bump over SSE, so the chat climbs the list like an
// opencode one.
test("BUG-13.16: after a Claude turn GET /session carries a fresh time.updated, and SSE announces session.updated at start and end", async () => {
  const s = await claudeChat();
  const rec = up.state.sessions.find((x) => x.id === s.id);
  rec.time = { created: rec.time.created - 60_000, updated: rec.time.created - 60_000 }; // an older chat
  const createdUp = rec.time.updated;
  const t0 = Date.now();
  const bumpOf = (e) => e.type === "session.updated" && e.properties?.info?.id === s.id && !e.properties.info.title && e.properties.info.time?.updated >= t0;
  const startBump = sseUntil(srv, bumpOf);
  await sleep(150); // the SSE stream is subscribed before the prompt
  const r = await api(srv, `/zai/api/session/${s.id}/prompt`, { method: "POST", body: { parts: [{ type: "text", text: "Сколько будет 2+2?" }] } });
  assert.equal(r.status, 204);
  const evt = await startBump;
  assert.equal(evt.properties.info.directory, CHAT_DIR, "the bump is routed by the chat's folder");
  const endBump = sseUntil(srv, (e) => bumpOf(e) && e.properties.info.time.updated > evt.properties.info.time.updated);
  await promptDone(s.id);
  await endBump;
  assert.equal(up.state.sessions.find((x) => x.id === s.id).time.updated, createdUp, "upstream record untouched (the root cause)");
  const list = await (await api(srv, "/zai/api/session")).json();
  const mine = list.find((x) => x.id === s.id);
  const msgs = await (await api(srv, `/zai/api/session/${s.id}/message`)).json();
  const done = msgs.filter((m) => m.info?.role === "assistant").at(-1).info.time.completed;
  assert.equal(mine.time.updated, done, "time.updated = the answer's completion");
  assert.equal(mine.time.created, rec.time.created, "created untouched");
  const others = list.filter((x) => x.id !== s.id && x.time?.updated);
  assert.ok(others.every((x) => x.time.updated <= mine.time.updated), "the most recent chat sorts first");
});

test("BUG-13.14: generator failure → heuristic title (first phrase of the question)", async () => {
  const s = await claudeChat();
  await promptAndWait(s.id, SNAP + "TITLEFAIL расскажи про погоду в Москве. И ещё что-нибудь.");
  const patch = await waitFor(() => patchesOf(up, s.id)[0], { what: "heuristic title PATCH" });
  assert.equal(patch.body.title, "TITLEFAIL расскажи про погоду в Москве");
});

test("BUG-13.14: a manual rename is never overwritten by the auto title", async () => {
  const s = await claudeChat();
  const r = await api(srv, `/zai/api/session/${s.id}`, { method: "PATCH", body: { title: "Моё название" } });
  assert.equal(r.status, 200);
  await promptAndWait(s.id, "Как дела у проекта?");
  await sleep(600);
  const titles = patchesOf(up, s.id).map((p) => p.body.title);
  assert.deepEqual(titles, ["Моё название"], "only the user's own PATCH reached upstream");
  const list = await (await api(srv, "/zai/api/session")).json();
  assert.equal(list.find((x) => x.id === s.id).title, "Моё название");
});

test("BUG-01.27: a snapshot-derived opencode title is replaced once; a sane one and a renamed one are kept", async () => {
  const now = Date.now();
  const mk = (id, title) => ({ id, directory: tmp.home, title, time: { created: now, updated: now } });
  up.state.sessions.push(mk("ses_oc1", "zai.home.example.net HTTPS IPv6"), mk("ses_oc2", "Столица Италии"), mk("ses_oc3", "IPv6 HTTPS"));
  const userMsg = (text) => [{ info: { id: "msg_u", role: "user" }, parts: [{ type: "text", text }] }];
  up.state.messages.ses_oc1 = userMsg(SNAP + "Ответь одним словом: столица Италии?");
  up.state.messages.ses_oc2 = userMsg(SNAP + "Ответь одним словом: столица Италии?");
  up.state.messages.ses_oc3 = userMsg(SNAP + "Ответь одним словом: столица Италии?");
  // ses_oc3 was renamed by its user through the portal.
  assert.equal((await api(srv, "/zai/api/session/ses_oc3", { method: "PATCH", body: { title: "IPv6 HTTPS" } })).status, 200);
  const before = patchesOf(up, "ses_oc3").length;
  for (const s of up.state.sessions.filter((x) => x.id.startsWith("ses_oc"))) up.emit({ type: "session.updated", properties: { info: s } }, tmp.home);
  const p = await waitFor(() => patchesOf(up, "ses_oc1")[0], { what: "snapshot title replaced" });
  assert.equal(p.body.title, "Тема Ответь одним словом:");
  assert.ok(!/zai\.zaichat|IPv6/.test(p.body.title));
  // The same event again: once per session.
  up.emit({ type: "session.updated", properties: { info: up.state.sessions.find((x) => x.id === "ses_oc1") } }, tmp.home);
  await sleep(500);
  assert.equal(patchesOf(up, "ses_oc1").length, 1);
  assert.equal(patchesOf(up, "ses_oc2").length, 0, "a title about the question stays");
  assert.equal(patchesOf(up, "ses_oc3").length, before, "a user rename stays");
});

test("BUG-11.13: a prompt without model runs on the default model (admin and tenant)", async () => {
  up.state.sessions.push({ id: "ses_nm1", directory: tmp.home, title: DEF_TITLE });
  let r = await api(srv, "/zai/api/session/ses_nm1/prompt", { method: "POST", body: { parts: [{ type: "text", text: "привет" }] } });
  assert.equal(r.status, 204);
  const adminCall = up.requests.filter((x) => x.path === "/session/ses_nm1/prompt_async").at(-1);
  assert.deepEqual(adminCall.body.model, { providerID: "zai-coding-plan", modelID: "glm-5.3" });

  const created = await (await api(srv, "/zai/api/admin/users", { method: "POST", body: { name: "tprompt" } })).json();
  const tdir = created.user.directories[0];
  up.state.sessions.push({ id: "ses_nm2", directory: tdir, title: DEF_TITLE });
  r = await api(srv, "/zai/api/session/ses_nm2/prompt", { method: "POST", token: created.token, body: { parts: [{ type: "text", text: "привет" }] } });
  assert.equal(r.status, 204);
  const tCall = up.requests.filter((x) => x.path === "/session/ses_nm2/prompt_async").at(-1);
  assert.deepEqual(tCall.body.model, { providerID: "zai-coding-plan", modelID: "glm-5.3" });
  assert.equal(tCall.body.agent, "ask", "tenant: its allowed default agent");
  assert.equal(tCall.directory, tdir);
  // The chat is bound now: the next prompt keeps the same model.
  const b = await (await api(srv, "/zai/api/session")).json();
  assert.equal(b.find((x) => x.id === "ses_nm2").zai.model.modelID, "glm-5.3");

  // BUG-02.5 for tenants: no directory → the tenant's own folder.
  const s = await (await api(srv, "/zai/api/session", { method: "POST", token: created.token, body: {} })).json();
  assert.equal(s.directory, tdir);
});

test("BUG-083 relay: a tenant's SSE carries zai.* frames and the auto-title session.updated of its own chats (redaction transform passes them)", async () => {
  const created = await (await api(srv, "/zai/api/admin/users", { method: "POST", body: { name: "trelay" } })).json();
  const tok = created.token;
  const tdir = created.user.directories[0];
  assert.equal((await api(srv, "/zai/api/admin/users/trelay", { method: "PATCH", body: { engines: ["opencode", "claude"] } })).status, 200);

  // A chat in the tenant's folder (the hub subscribes to folders that hold chats).
  const r = await api(srv, "/zai/api/session", { method: "POST", token: tok, body: { model: OPUS } });
  assert.equal(r.status, 200);
  const s = await r.json();
  assert.equal(s.zai?.engine, "claude");
  assert.equal(s.directory.toLowerCase(), tdir.toLowerCase());

  // 1) an upstream zai.* frame in the tenant's folder reaches the tenant.
  const zai = sseUntil(srv, (e) => e.type === "zai.relay.probe", { token: tok });
  let got = false;
  zai.then(() => (got = true), () => {});
  for (let i = 0; i < 50 && !got; i++) {
    up.emit({ type: "zai.relay.probe", properties: { sessionID: "ses_rp" } }, tdir);
    await sleep(200);
  }
  assert.equal((await zai).properties.sessionID, "ses_rp");

  // 2) the portal titler's session.updated (hub.emit) for the tenant's Claude chat.
  const titled = sseUntil(srv, (e) => e.type === "session.updated" && e.properties?.info?.id === s.id && e.properties.info.title && e.properties.info.title !== DEF_TITLE, { token: tok, timeoutMs: 15_000 });
  await sleep(300);
  const pr = await api(srv, `/zai/api/session/${s.id}/prompt`, { method: "POST", token: tok, body: { parts: [{ type: "text", text: "Как полить кактус зимой?" }] } });
  assert.equal(pr.status, 204);
  const evt = await titled;
  assert.ok(evt.properties.info.title.length > 0);
  const list = await (await api(srv, "/zai/api/session", { token: tok })).json();
  assert.equal(list.find((x) => x.id === s.id)?.title, evt.properties.info.title, "the tenant's list shows the same title");
});

test("BUG-11.13: an answer that completes with no content and no error becomes a turn error (live + history)", async () => {
  const sid = "ses_empty1";
  up.state.sessions.push({ id: sid, directory: tmp.home, title: DEF_TITLE });
  const sse = sseUntil(srv, (e) => e.type === "session.error" && e.properties?.sessionID === sid);
  await sleep(300); // the SSE client is attached
  const t = Date.now();
  up.emit({ type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } }, tmp.home);
  up.emit({ type: "message.updated", properties: { sessionID: sid, info: { id: "msg_a1", sessionID: sid, role: "assistant", time: { created: t } } } }, tmp.home);
  up.emit({ type: "message.part.updated", properties: { sessionID: sid, part: { id: "p1", messageID: "msg_a1", type: "step-start" } } }, tmp.home);
  up.emit({ type: "message.updated", properties: { sessionID: sid, info: { id: "msg_a1", sessionID: sid, role: "assistant", time: { created: t, completed: t + 5 } } } }, tmp.home);
  up.emit({ type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } }, tmp.home);
  const evt = await sse;
  assert.equal(evt.properties.error.name, "EmptyTurnError");
  assert.equal(evt.properties.zai.emptyTurn, true);
  assert.equal(evt.properties.zai.messageID, "msg_a1");

  up.state.messages[sid] = [
    { info: { id: "msg_u1", role: "user" }, parts: [{ type: "text", text: "q" }] },
    { info: { id: "msg_a1", role: "assistant", time: { created: t, completed: t + 5 } }, parts: [{ type: "step-start" }, { type: "step-finish" }] },
  ];
  const hist = await (await api(srv, `/zai/api/session/${sid}/message?limit=20`)).json();
  assert.equal(hist.at(-1).info.error?.name, "EmptyTurnError", "a reload still shows the error card");
});

test("BUG-11.13: a normal answer raises no empty-turn error", async () => {
  const sid = "ses_full1";
  let got = null;
  const sse = sseUntil(srv, (e) => (e.type === "session.error" && e.properties?.sessionID === sid ? ((got = e), true) : e.type === "zai.test.done"), { timeoutMs: 8000 });
  await sleep(300);
  const t = Date.now();
  up.emit({ type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } }, tmp.home);
  up.emit({ type: "message.updated", properties: { sessionID: sid, info: { id: "msg_b1", sessionID: sid, role: "assistant", time: { created: t } } } }, tmp.home);
  up.emit({ type: "message.part.delta", properties: { sessionID: sid, messageID: "msg_b1", partID: "p", field: "text", delta: "Рим" } }, tmp.home);
  up.emit({ type: "message.updated", properties: { sessionID: sid, info: { id: "msg_b1", sessionID: sid, role: "assistant", time: { created: t, completed: t + 5 } } } }, tmp.home);
  up.emit({ type: "session.status", properties: { sessionID: sid, status: { type: "idle" } } }, tmp.home);
  await sleep(500);
  up.emit({ type: "zai.test.done", properties: {} }, tmp.home);
  await sse;
  assert.equal(got, null);
});

test("BUG-04.6: account deletion removes its chats, disposes the instance, reports an undeletable folder and retries it later", async (t) => {
  // POSIX: an open file or a process cwd does not block deletion; a folder
  // without write permission does — unless we run as root (bypasses modes).
  const posix = process.platform !== "win32";
  if (posix && process.getuid?.() === 0) return t.skip("root ignores folder permissions — no way to make a folder undeletable");
  const created = await (await api(srv, "/zai/api/admin/users", { method: "POST", body: { name: "gone1" } })).json();
  const tdir = created.user.directories[0];
  const vdir = created.user.obsidianRoot;
  assert.ok(existsSync(tdir) && existsSync(vdir));
  up.state.sessions.push({ id: "ses_g1", directory: tdir, title: "чат УЗ" }, { id: "ses_keep", directory: tmp.home, title: "чужой" });
  // A process sitting in the folder (like opencode serve) — Windows refuses to remove it.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { cwd: tdir, stdio: "ignore", windowsHide: true });
  const holderExit = new Promise((r) => holder.once("exit", r));
  // POSIX: a file inside a read-only folder cannot be unlinked → rm fails (EACCES).
  if (posix) {
    writeFileSync(path.join(tdir, "held.txt"), "x");
    chmodSync(tdir, 0o555);
  }
  await sleep(300);
  try {
    const r = await api(srv, "/zai/api/admin/users/gone1", { method: "DELETE" });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.ok, true);
    assert.equal(out.removedSessions, 1);
    assert.ok(!up.state.sessions.some((s) => s.id === "ses_g1"), "the account's chat is gone upstream");
    assert.ok(up.state.sessions.some((s) => s.id === "ses_keep"), "foreign chats untouched");
    const del = up.requests.findIndex((x) => x.method === "DELETE" && x.path === "/session/ses_g1");
    const disp = up.requests.findIndex((x) => x.method === "POST" && x.path === "/instance/dispose" && x.directory === tdir);
    assert.ok(del >= 0 && disp > del, "chats first, then the instance dispose");
    assert.equal(up.requests[del].directory, tdir);
    assert.ok(!existsSync(vdir), "the free folder is removed");
    const w = out.warnings.find((x) => x.kind === "folder");
    assert.ok(w, `warnings must name the held folder: ${JSON.stringify(out)}`);
    assert.equal(w.path.toLowerCase(), tdir.toLowerCase());
    assert.match(w.reason, /E[A-Z]+/);
    assert.equal(w.retry, true);
    assert.ok(existsSync(tdir));
    assert.match(srv.log, /folder left behind/);
    const report = await (await api(srv, "/zai/api/admin/gc")).json();
    assert.equal(report.pendingRemovals.length, 1);
  } finally {
    holder.kill();
    await holderExit;
    if (posix && existsSync(tdir)) chmodSync(tdir, 0o755); // the deferred retry below must succeed
  }
  await sleep(300);
  const sweep = await (await api(srv, "/zai/api/admin/gc", { method: "POST" })).json();
  assert.deepEqual(sweep.pendingRemovals, []);
  assert.ok(!existsSync(tdir), "the deferred retry removed the folder");
});

test("BUG-02.5: a system-tree ZAI_CHAT_DIR refuses to start", async () => {
  await assert.rejects(spawnPortal({ upstream: up.url, env: { ZAI_CHAT_DIR: "C:\\Windows\\System32" } }), /ZAI_CHAT_DIR/);
});

// ---- empty-chat gc on its own instance -----------------------------------------------

test("BUG-01.48: the gc sweep deletes only old, untitled, message-less, idle chats", async () => {
  const t2 = makeTmpRoot("zai-172-gc-");
  const old = Date.now() - 2 * 3_600_000;
  const S = (id, extra = {}) => ({ id, directory: t2.home, title: DEF_TITLE, time: { created: old, updated: old }, ...extra });
  const up2 = await fakeUpstream([
    S("ses_g_empty"),
    S("ses_g_msgs"),
    S("ses_g_titled", { title: "Про NAS" }),
    S("ses_g_busy"),
    S("ses_g_dialog"),
    S("ses_g_fresh", { time: { created: Date.now(), updated: Date.now() } }),
    S("ses_g_child", { parentID: "ses_g_msgs" }),
  ]);
  up2.state.messages.ses_g_msgs = [{ info: { id: "m", role: "user" }, parts: [{ type: "text", text: "q" }] }];
  up2.state.status = { ses_g_busy: { type: "busy" } };
  up2.state.permissions = [{ id: "per_1", sessionID: "ses_g_dialog", permission: "edit" }];
  const srv2 = await spawnPortal({ upstream: up2.url, tmp: t2, env: { ZAI_ADMIN_TOKEN: ADMIN, ZAI_GC_EMPTY_MIN: "30" } });
  try {
    await waitFor(async () => (await (await api(srv2, "/zai/api/status")).json()).ses_g_busy, { what: "busy seeded" });
    await waitFor(async () => (await (await api(srv2, "/zai/api/dialogs")).json()).some((d) => d.id === "per_1"), { what: "dialog seeded" });
    // Dry-run report: same rule + same ZAI_GC_EMPTY_MIN (30 min) as the sweep —
    // a 2 h old empty chat is listed (the old 24 h emptyHours rule hid it).
    const dry = await api(srv2, "/zai/api/admin/gc?emptyHours=24");
    assert.equal(dry.status, 200);
    const rep = await dry.json();
    assert.equal(rep.dryRun, true);
    assert.equal(rep.emptyChatMinutes, 30);
    assert.deepEqual(rep.emptyChats.map((c) => c.id), ["ses_g_empty"]);
    assert.deepEqual(rep.emptyChatsKept.map((k) => `${k.id}:${k.reason}`), ["ses_g_msgs:has-messages"]);
    assert.equal(up2.requests.filter((x) => x.method === "DELETE").length, 0, "the dry run deletes nothing");
    const r = await api(srv2, "/zai/api/admin/gc", { method: "POST" });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.deepEqual(out.empty.deleted, rep.emptyChats.map((c) => c.id), "report == sweep");
    assert.deepEqual(out.empty.deleted, ["ses_g_empty"]);
    const deletes = up2.requests.filter((x) => x.method === "DELETE").map((x) => x.path);
    assert.deepEqual(deletes, ["/session/ses_g_empty"]);
    assert.match(srv2.log, /deleted empty chat ses_g_empty/);
    assert.deepEqual(up2.state.sessions.map((s) => s.id).sort(), ["ses_g_busy", "ses_g_child", "ses_g_dialog", "ses_g_fresh", "ses_g_msgs", "ses_g_titled"]);
  } finally {
    await srv2.stop();
    await up2.close();
  }
});
