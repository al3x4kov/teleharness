// teleharness mock API: replays recorded fixtures for /teleharness/api/* so the frontend can
// develop without hitting (or paying for) the real opencode server.
// mockHandler(req, res) returns true when it fully handled the request.
import { appendFile } from "node:fs/promises";
import { mockTemporal } from "./mock-temporal.js";
import { mock249 } from "./mock-249.js";
import { readdirSync, readFileSync } from "node:fs";
import { buildSnippet, extractMessageText, tokenizeQuery } from "./chat-search.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

// TELEHARNESS_FIXTURES overrides the fixtures dir for QA harnesses (unit tests read
// the repo fixtures directly and are unaffected by the override).
const FIXTURES = process.env.TELEHARNESS_FIXTURES
  ?? path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "fixtures");

function sendJson(res, status, text) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

function sendFixture(res, file) {
  try {
    const raw = readFileSync(path.join(FIXTURES, file));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(raw);
    return true;
  } catch {
    sendJson(res, 404, JSON.stringify({ error: `no fixture: ${file}` }));
    return true;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function capturePost(req, res) {
  const body = await readBody(req);
  await appendFile(
    path.join(FIXTURES, "_captured.jsonl"),
    JSON.stringify({ ts: Date.now(), url: req.url, body }) + "\n",
  );
  sendJson(res, 200, JSON.stringify({ mock: true }));
}

async function streamEvents(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const frames = readFileSync(path.join(FIXTURES, "events.sse"), "utf8")
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0);
  for (const frame of frames) {
    res.write(frame + "\n\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const ping = setInterval(() => res.write(": ping\n\n"), 10_000);
  res.on("close", () => clearInterval(ping));
}

const mockAutoRelay = { on: false, order: [] };

// Turn changes and Git in the demo: the api-server project is a repository
// with the two files the "Refactor the auth module" chat changed. Synthetic
// data only — nothing on disk is read or written.
const DEMO_REPO = "/home/dev/projects/api-server";
const DEMO_REPO_SIDS = new Set(["ses_demo_auth_refactor", "ses_demo_ci_node22", "ses_demo_slow_join", "ses_demo_precommit", "ses_demo_codex_flaky_test", "ses_demo_orders_migration"]);
const DEMO_PATCHES = {
  "src/auth/session.ts": [
    "diff --git a/src/auth/session.ts b/src/auth/session.ts",
    "--- a/src/auth/session.ts",
    "+++ b/src/auth/session.ts",
    "@@ -1,12 +1,14 @@",
    " import type { Request, Response } from \"express\";",
    "-import { decodeJwt, isExpired } from \"./jwt\";",
    "+import { readToken, refreshIfNeeded, validToken } from \"./token\";",
    " import { setSessionCookie } from \"./cookies\";",
    " ",
    " export async function handleSession(req: Request, res: Response) {",
    "-  const raw = req.headers.authorization?.slice(7) ?? req.cookies.session;",
    "-  if (!raw) return res.status(401).end();",
    "-  const token = decodeJwt(raw);",
    "-  if (!token || isExpired(token)) return res.status(401).end();",
    "+  const raw = readToken(req);",
    "+  const token = raw && (await validToken(raw));",
    "+  if (!token) return res.status(401).end();",
    "+  if (await refreshIfNeeded(token)) setSessionCookie(res, raw);",
    "   res.locals.user = token.sub;",
    "   return true;",
    " }",
    "+",
    "+export const SESSION_TTL_MINUTES = 30;",
    "",
  ].join("\n"),
  "src/auth/token.ts": [
    "diff --git a/src/auth/token.ts b/src/auth/token.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/auth/token.ts",
    "@@ -0,0 +1,3 @@",
    "+export function readToken(req: Request): string | null { /* ... */ }",
    "+export async function validToken(raw: string) { /* ... */ }",
    "+export async function refreshIfNeeded(token: Token) { /* ... */ }",
    "",
  ].join("\n"),
};
const demoGit = { pushAllowed: true, authorName: "Demo User", authorEmail: "demo-user@teleharness.local", messageLang: "ui", preselect: "modified", committed: false };
function demoGitStatus() {
  const files = demoGit.committed
    ? []
    : [
        { path: "src/auth/session.ts", status: "M", staged: false, additions: 7, deletions: 5 },
        { path: "src/auth/token.ts", status: "?", staged: false, additions: 3, deletions: 0 },
      ];
  return {
    repo: true,
    root: DEMO_REPO,
    branch: "feature/auth-refresh",
    detached: false,
    upstream: "origin/feature/auth-refresh",
    ahead: demoGit.committed ? 2 : 1,
    behind: 0,
    lastCommit: demoGit.committed
      ? { hash: "4e7a91c", subject: demoGit.committed, at: Date.now() - 5_000 }
      : { hash: "9f3c2e1", subject: "feat(auth): session middleware", at: Date.now() - 2 * 3600_000 },
    files,
    filesTruncated: false,
    pushAllowed: demoGit.pushAllowed,
  };
}
// → true when handled. GET status/diff, me/git; POST commit/suggest/push; PUT me/git.
function mockGit(req, res, url, p) {
  if (!p.startsWith("/teleharness/api/git/") && p !== "/teleharness/api/me/git") return false;
  const reply = (status, obj) => {
    sendJson(res, status, JSON.stringify(obj));
    return true;
  };
  const sid = url.searchParams.get("sid");
  const dir = url.searchParams.get("directory");
  const inRepo = sid ? DEMO_REPO_SIDS.has(sid) : String(dir ?? "").replace(/\/+$/, "") === DEMO_REPO;
  const { committed, ...settings } = demoGit;
  if (p === "/teleharness/api/me/git") {
    if (req.method === "GET") return reply(200, settings);
    if (req.method !== "PUT") return reply(405, { error: "method not allowed" });
    (async () => {
      const body = await readBody(req);
      for (const k of ["authorName", "authorEmail", "messageLang", "preselect", "pushAllowed"]) if (body && body[k] !== undefined) demoGit[k] = body[k];
      const { committed: _c, ...next } = demoGit;
      sendJson(res, 200, JSON.stringify(next));
    })().catch(() => res.destroy());
    return true;
  }
  if (req.method === "GET" && p === "/teleharness/api/git/status") return reply(200, inRepo ? demoGitStatus() : { repo: false });
  if (req.method === "GET" && p === "/teleharness/api/git/diff") {
    const file = url.searchParams.get("file") ?? "";
    const patch = inRepo && !demoGit.committed ? DEMO_PATCHES[file] : null;
    if (!patch) return reply(200, { file, patch: "", additions: 0, deletions: 0, binary: false, truncated: false });
    const lines = patch.split("\n");
    const additions = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const deletions = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
    return reply(200, { file, patch, additions, deletions, binary: false, truncated: false });
  }
  if (req.method !== "POST") return reply(405, { error: "method not allowed" });
  (async () => {
    const body = await readBody(req);
    if (!inRepo) return sendJson(res, 200, JSON.stringify({ repo: false }));
    if (p === "/teleharness/api/git/suggest-message") {
      return sendJson(res, 200, JSON.stringify({ message: "refactor(auth): move token checks into token.ts\n\nhandleSession reads, validates and refreshes the token through the new helpers;\nthe session cookie is renewed when the token is refreshed." }));
    }
    if (p === "/teleharness/api/git/commit") {
      const files = Array.isArray(body?.files) ? body.files : [];
      const subject = String(body?.message ?? "").split("\n")[0] || "demo commit";
      demoGit.committed = subject;
      return sendJson(res, 200, JSON.stringify({ hash: "4e7a91c", subject, files }));
    }
    if (p === "/teleharness/api/git/push") return sendJson(res, 200, JSON.stringify({ ok: true, pushed: demoGitStatus().ahead }));
    sendJson(res, 404, JSON.stringify({ error: "unknown route" }));
  })().catch(() => res.destroy());
  return true;
}

// Chats created in this demo run (memory only; never written to fixtures).
const created = [];

export function mockHandler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  if (!p.startsWith("/teleharness/api/")) return false;
  if (mockGit(req, res, url, p)) return true;
  if (mockTemporal(req, res, url, p, { sendJson, readBody })) return true; // README demo of Temporal pipelines
  if (mock249(req, res, url, p, { sendJson, readBody })) return true; // README demo of 2.4.9 features

  if (req.method === "POST") {
    // Uploads answer like the real endpoint (the mock never touches disk).
    if (p === "/teleharness/api/upload") {
      (async () => {
        const chunks = [];
        for await (const c of req) chunks.push(c); // raw bytes: no JSON parsing
        const size = Buffer.concat(chunks).length;
        sendJson(res, 200, JSON.stringify({ name: url.searchParams.get("name") ?? "file", size }));
      })().catch(() => res.destroy());
      return true;
    }
    // Dialog replies validate like upstream 1.19.5 — the QA matrix must catch
    // contract drift here instead of green-lighting a broken payload shape:
    //   question   {answers: string[][]}  (per question: array of labels)
    //   permission {reply: "once"|"always"|"reject"}
    if (/^\/teleharness\/api\/(question|permission)\/[^/]+\/reply$/.test(p)) {
      (async () => {
        const body = await readBody(req);
        const okShape =
          p.includes("/question/") &&
          Array.isArray(body?.answers) &&
          body.answers.every((a) => Array.isArray(a) && a.every((x) => typeof x === "string"));
        const okPerm =
          p.includes("/permission/") &&
          ["once", "always", "reject"].includes(body?.reply);
        if (okShape || okPerm) sendJson(res, 200, JSON.stringify(true));
        else {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ name: "BadRequest", data: { message: "mock: invalid reply shape" } }));
        }
      })().catch(() => res.destroy());
      return true;
    }
    // A new chat: the demo keeps it in memory (listed first, empty history) so
    // «New chat» opens a real chat instead of #/chat/undefined.
    if (p === "/teleharness/api/session") {
      (async () => {
        const body = (await readBody(req)) ?? {};
        const now = Date.now();
        const model = body.model && typeof body.model === "object" ? body.model : null;
        const s = {
          id: `ses_demo_new_${now.toString(36)}${(created.length + 1).toString(36)}`,
          slug: "new-chat",
          projectID: "global",
          directory: url.searchParams.get("directory") || "/home/dev",
          title: "",
          time: { created: now, updated: now },
          teleharness: { model, agent: typeof body.agent === "string" ? body.agent : null, prompted: false },
        };
        created.unshift(s);
        sendJson(res, 200, JSON.stringify(s));
      })().catch(() => res.destroy());
      return true;
    }
    // Settings → Connect a phone: a one-time sign-in link like the real
    // POST /auth/pair (the mock points it at this very server; claiming it
    // fails, which is what a demo link should do).
    if (p === "/teleharness/api/auth/pair") {
      const code = `demo${Math.random().toString(36).slice(2, 12)}`;
      const host = req.headers.host ?? "127.0.0.1";
      sendJson(res, 200, JSON.stringify({ configured: true, url: `http://${host}/teleharness/#/pair/${code}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }));
      return true;
    }
    capturePost(req, res).catch(() => res.destroy());
    return true;
  }
  // A removed attachment chip deletes its upload (ISSUE-009); the mock
  // never wrote one.
  const answer = (obj) => {
    sendJson(res, 200, JSON.stringify(obj));
    return true;
  };
  if (req.method === "DELETE" && p === "/teleharness/api/upload") return answer({ ok: true });
  // FEAT-03.22: the user's system prompt — empty in the mock; PUT echoes.
  if (req.method === "PUT" && p === "/teleharness/api/me/system-prompt") return answer({ text: "", max: 4000 });
  // Auto-handoff on a usage limit: kept in memory for the life of the mock.
  if (req.method === "PUT" && p === "/teleharness/api/me/auto-relay") {
    (async () => {
      const body = await readBody(req);
      if (typeof body?.on === "boolean") mockAutoRelay.on = body.on;
      if (Array.isArray(body?.order)) mockAutoRelay.order = body.order.slice(0, 3);
      sendJson(res, 200, JSON.stringify({ ...mockAutoRelay, max: 3 }));
    })().catch(() => res.destroy());
    return true;
  }
  if (req.method !== "GET") return false;
  if (p === "/teleharness/api/me/auto-relay") return answer({ ...mockAutoRelay, max: 3 });

  if (p === "/teleharness/api/about") return answer({ version: null, opencodeVersion: "2.2.6", harness: { name: "slim", version: "3.0.7" }, mock: true });
  if (p === "/teleharness/api/dircheck") return answer({ ok: true });
  // Routes the mock has no recordings for: empty answers instead of 404s.
  if (p === "/teleharness/api/claude/agents") return answer({ agents: [] });
  if (p === "/teleharness/api/me/pins") return answer({ ids: [] });
  if (p === "/teleharness/api/voice") return answer({ enabled: false });
  if (p === "/teleharness/api/turn-files") return answer({ files: [] });
  if (p === "/teleharness/api/me/system-prompt") return answer({ text: "", max: 4000 });

  // Merged busy/idle statuses: the client polls this every 3s; an empty
  // record = every session idle (real route exists only on the live proxy).
  if (p === "/teleharness/api/status") return answer({});
  if (p === "/teleharness/api/session/search") {
    const q = url.searchParams.get("q") ?? "";
    const { raw, words } = tokenizeQuery(q);
    if (!raw || words.length === 0) return answer({ query: raw, hits: [], indexing: { ready: true, indexed: 0, total: 0 } });
    const hits = [];
    try {
      const files = readdirSync(FIXTURES).filter((f) => /^messages-.+\.json$/.test(f));
      for (const f of files) {
        const sid = f.slice("messages-".length, -".json".length);
        const list = JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8"));
        let best = null;
        let matchCount = 0;
        for (const m of Array.isArray(list) ? list : []) {
          const ex = extractMessageText(m);
          if (!ex) continue;
          const low = ex.text.toLowerCase();
          if (!words.every((w) => low.includes(w))) continue;
          matchCount += 1;
          if (!best || ex.created >= best.created) best = ex;
        }
        if (best) {
          hits.push({
            sessionId: sid,
            messageId: best.mid,
            role: best.role,
            created: best.created,
            snippet: buildSnippet(best.text, words),
            matchCount,
          });
        }
      }
      hits.sort((a, b) => b.created - a.created);
    } catch {}
    return answer({ query: raw, hits, indexing: { ready: true, indexed: hits.length, total: hits.length } });
  }
  if (p === "/teleharness/api/session") {
    if (created.length === 0) return sendFixture(res, "sessions.json");
    let list = [];
    try {
      list = JSON.parse(readFileSync(path.join(FIXTURES, "sessions.json"), "utf8"));
    } catch {}
    return answer([...created, ...list]);
  }
  const message = p.match(/^\/teleharness\/api\/session\/([^/]+)\/message$/);
  if (message && created.some((s) => s.id === decodeURIComponent(message[1]))) return answer([]);
  if (message) return sendFixture(res, `messages-${decodeURIComponent(message[1])}.json`);
  if (p === "/teleharness/api/provider") return sendFixture(res, "provider.json");
  if (p === "/teleharness/api/agent") return sendFixture(res, "agents.json");
  if (p === "/teleharness/api/project") return sendFixture(res, "projects.json");
  if (p === "/teleharness/api/mcp") return sendFixture(res, "mcp.json");
  if (p === "/teleharness/api/host") return sendFixture(res, "host.json");
  if (p === "/teleharness/api/usage") return sendFixture(res, "usage.json");
  // FEAT-11.18: раздел «Подписки» — карточки провайдеров; z.ai берётся из той же фикстуры usage.json
  if (p === "/teleharness/api/subscriptions") {
    let u = null;
    try {
      u = JSON.parse(readFileSync(path.join(FIXTURES, "usage.json"), "utf8"));
    } catch {}
    const zai = u?.ok ? { id: "zai", title: "z.ai", badge: "Coding Plan", state: "ok", plan: u.plan ?? null, fetchedAt: u.fetchedAt ?? Date.now(), windows: u.windows ?? [] } : { id: "zai", title: "z.ai", badge: "Coding Plan", state: "error", reason: "network" };
    sendJson(res, 200, JSON.stringify({ providers: [zai, { id: "claude", title: "Claude", badge: "подписка", state: "no-api", hint: "claude-subscription" }] }));
    return true;
  }
  if (p === "/teleharness/api/dialogs") return sendFixture(res, "dialogs.json");
  if (p === "/teleharness/api/event") {
    streamEvents(res).catch(() => res.destroy());
    return true;
  }
  return false;
}
