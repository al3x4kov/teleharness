// TASK-12.30: защитные заголовки — запрет встраивания HTML портала во фрейм, nosniff и
// Referrer-Policy на статике и ответах API; просмотр файлов (/file) встраивается как раньше.
// Run: node --test tests/security-headers.test.js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const ADMIN = "s".repeat(20) + "-admin-token-" + "7".repeat(24);
let up, srv, cookie;
const DIR = mkdtempSync(path.join(tmpdir(), "zai-sech-"));

before(async () => {
  up = await startFakeOpencode();
  srv = await spawnPortal({ upstream: up.url, env: { ZAI_ADMIN_TOKEN: ADMIN } });
  const r = await fetch(srv.base + "/zai/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: srv.base }, body: JSON.stringify({ token: ADMIN }) });
  cookie = (r.headers.getSetCookie?.() ?? []).join(";").match(/(zai_[a-z0-9_]+=[^;]+)/i)?.[1] ?? "";
  writeFileSync(path.join(DIR, "page.html"), "<html><body>x</body></html>");
});
after(async () => {
  await srv?.stop?.();
  await up?.close?.();
  rmSync(DIR, { recursive: true, force: true });
});

const base = (h) => {
  assert.equal(h.get("x-content-type-options"), "nosniff");
  assert.equal(h.get("referrer-policy"), "no-referrer");
};

test("TASK-12.30: HTML портала — запрет встраивания во фрейм, nosniff, no-referrer", async () => {
  const r = await fetch(srv.base + "/zai/");
  assert.equal(r.status, 200);
  base(r.headers);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
});

test("TASK-12.30: статика и ответы API (в том числе ошибки) — nosniff и no-referrer", async () => {
  for (const p of ["/zai/app.js", "/zai/api/healthz", "/zai/api/session", "/zai/api/nope"]) {
    const r = await fetch(srv.base + p);
    base(r.headers);
    await r.arrayBuffer();
  }
});

test("TASK-12.30: просмотр файла — своя песочница CSP, без запрета встраивания (viewer показывает его во фрейме)", async () => {
  const r = await fetch(`${srv.base}/zai/api/file?directory=${encodeURIComponent(DIR)}&path=${encodeURIComponent(path.join(DIR, "page.html"))}`, { headers: { cookie } });
  assert.equal(r.status, 200, await r.clone().text());
  base(r.headers);
  assert.equal(r.headers.get("x-frame-options"), null);
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /sandbox/);
  assert.ok(!/frame-ancestors/.test(csp));
});
