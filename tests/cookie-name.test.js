// ZAI_COOKIE_NAME: an isolated stand (127.0.0.1:4172 next to prod :4170)
// must mint a DIFFERENT cookie — cookies ignore ports, so the default shared
// name made a stand login silently log the admin out of prod (2026-11-02).
// Run: node --test tests/cookie-name.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = mkdtempSync(path.join(tmpdir(), "zai-cookie-home-"));
const DATA = mkdtempSync(path.join(tmpdir(), "zai-cookie-data-"));
const ADMIN_TOKEN = "k".repeat(20) + "-cookie-name-" + "4".repeat(24);

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/session") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify([{ id: "ses_x", directory: HOME }]));
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
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));

// Isolated env (TASK-14.4): no ZAI_* inherited from the shell.
const srv = await spawnPortal({
  upstream: `http://127.0.0.1:${upstream.address().port}`,
  env: { ZAI_HOME: HOME, ZAI_CHAT_DIR: HOME, ZAI_DATA_DIR: DATA, ZAI_ADMIN_TOKEN: ADMIN_TOKEN, ZAI_COOKIE_NAME: "zai_t_stage" },
});
// Same teardown contract as claude-server.test.js: kill the portal FIRST.
after(async () => {
  await srv.stop();
  upstream.close();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  rmSync(DATA, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
const base = srv.base;

test("login mints the ZAI_COOKIE_NAME cookie and it authenticates", async () => {
  const login = await fetch(`${base}/zai/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ADMIN_TOKEN }),
  });
  assert.equal(login.status, 200);
  const setCookie = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [login.headers.get("set-cookie")].filter(Boolean);
  const minted = setCookie.find((c) => c.startsWith("zai_t_stage="));
  assert.ok(minted, `cookie must be named zai_t_stage, got: ${setCookie.join(" | ")}`);
  const token = minted.match(/zai_t_stage=([^;]+)/)[1];
  const list = await fetch(`${base}/zai/api/session`, { headers: { cookie: `zai_t_stage=${token}` } });
  assert.equal(list.status, 200);
});
