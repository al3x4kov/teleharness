// zai mock API: replays recorded fixtures for /zai/api/* so the frontend can
// develop without hitting (or paying for) the real opencode server.
// mockHandler(req, res) returns true when it fully handled the request.
import { appendFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ZAI_FIXTURES overrides the fixtures dir for QA harnesses (unit tests read
// the repo fixtures directly and are unaffected by the override).
const FIXTURES = process.env.ZAI_FIXTURES
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

export function mockHandler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  if (!p.startsWith("/zai/api/")) return false;

  if (req.method === "POST") {
    // Uploads answer like the real endpoint (the mock never touches disk).
    if (p === "/zai/api/upload") {
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
    if (/^\/zai\/api\/(question|permission)\/[^/]+\/reply$/.test(p)) {
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
    capturePost(req, res).catch(() => res.destroy());
    return true;
  }
  // A removed attachment chip deletes its upload (ISSUE-009); the mock
  // never wrote one.
  const answer = (obj) => {
    sendJson(res, 200, JSON.stringify(obj));
    return true;
  };
  if (req.method === "DELETE" && p === "/zai/api/upload") return answer({ ok: true });
  // FEAT-03.22: the user's system prompt — empty in the mock; PUT echoes.
  if (req.method === "PUT" && p === "/zai/api/me/system-prompt") return answer({ text: "", max: 4000 });
  if (req.method !== "GET") return false;

  if (p === "/zai/api/about") return answer({ version: null, opencodeVersion: "1.19.5", mock: true });
  if (p === "/zai/api/dircheck") return answer({ ok: true });
  // Routes the mock has no recordings for: empty answers instead of 404s.
  if (p === "/zai/api/claude/agents") return answer({ agents: [] });
  if (p === "/zai/api/me/pins") return answer({ ids: [] });
  if (p === "/zai/api/voice") return answer({ enabled: false });
  if (p === "/zai/api/turn-files") return answer({ files: [] });
  if (p === "/zai/api/me/system-prompt") return answer({ text: "", max: 4000 });

  // Merged busy/idle statuses: the client polls this every 3s; an empty
  // record = every session idle (real route exists only on the live proxy).
  if (p === "/zai/api/status") return answer({});
  if (p === "/zai/api/session") return sendFixture(res, "sessions.json");
  const message = p.match(/^\/zai\/api\/session\/([^/]+)\/message$/);
  if (message) return sendFixture(res, `messages-${decodeURIComponent(message[1])}.json`);
  if (p === "/zai/api/provider") return sendFixture(res, "provider.json");
  if (p === "/zai/api/agent") return sendFixture(res, "agents.json");
  if (p === "/zai/api/project") return sendFixture(res, "projects.json");
  if (p === "/zai/api/mcp") return sendFixture(res, "mcp.json");
  if (p === "/zai/api/host") return sendFixture(res, "host.json");
  if (p === "/zai/api/usage") return sendFixture(res, "usage.json");
  if (p === "/zai/api/dialogs") return sendFixture(res, "dialogs.json");
  if (p === "/zai/api/event") {
    streamEvents(res).catch(() => res.destroy());
    return true;
  }
  return false;
}
