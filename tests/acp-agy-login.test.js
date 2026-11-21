// FEAT-20.4 — вход Antigravity: ссылка Google в stderr, вставка адреса
// страницы после входа (релейный GET), запасной путь по ключу Gemini API.
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import http from "node:http";
import { AgyLoginSessions } from "../lib/acp-agy-login.js";

function child() {
  return Object.assign(new EventEmitter(), {stdin:new PassThrough(), stdout:new PassThrough(), stderr:new PassThrough(), kill() {}});
}
const frames = (c) => { const out=[]; c.stdin.on("data", d => out.push(...d.toString().trim().split("\n").map(JSON.parse))); return out; };
const initOk = (c, methods = [{id:"oauth-personal"},{id:"gemini-api-key"}]) =>
  c.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{protocolVersion:1,authMethods:methods}})+"\n");

test("старт публикует ссылку Google и принимает только адрес loopback-редиректа", async t => {
  const c = child();
  const launches = [];
  const login = new AgyLoginSessions((owner, env) => { launches.push({owner, env}); return c; });
  const {id} = login.start("owner");
  assert.deepEqual(login.get("owner"), {id, status:"starting"});
  initOk(c);
  // Ссылка приходит в stderr, возможно частями.
  c.stderr.write("Open the following link to authenticate the ACP server: https://accounts.google.");
  c.stderr.write("com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A39549%2F&state=abc\n");
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A39549%2F&state=abc";
  assert.deepEqual(login.get("owner"), {id, status:"awaiting-code", url:authUrl});
  // Чужая попытка и посторонние строки отклоняются до какого-либо запроса.
  for (const args of [["other",id,"http://127.0.0.1:1/?code=1"], ["owner","stale","http://127.0.0.1:1/?code=1"]]) await assert.rejects(login.submit(...args), /Попытка входа завершена/);
  assert.throws(() => login.start("owner", {method:"api-key", key:"short"}), {status:400});
});

test("submit передаёт адрес слушателю и завершает вход после ответа authenticate", async t => {
  const c = child();
  const login = new AgyLoginSessions(() => c);
  const {id} = login.start("owner");
  initOk(c);
  const seen = [];
  const relay = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, {"content-type":"text/html"});
    res.end("Authentication successful");
  });
  await new Promise(resolve => relay.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => relay.close(resolve)));
  const port = relay.address().port;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent("http://127.0.0.1:" + port + "/")}&state=st`;
  c.stderr.write("Open the following link to authenticate the ACP server: " + url + "\n");
  assert.equal(login.get("owner").status, "awaiting-code");
  // Невалидная строка отклоняется до запроса: слушатель не тронут.
  await assert.rejects(login.submit("owner", id, "https://evil.example/?code=1"), /адрес/);
  assert.deepEqual(seen, []);
  const state = await login.submit("owner", id, `http://127.0.0.1:${port}/?code=4%2Ftest&scope=a+b&state=st`);
  assert.equal(state.status, "verifying");
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^\/\?code=4%2Ftest&scope=a\+b&state=st$/);
  // Повторная отправка в состоянии проверки запрещена.
  await assert.rejects(login.submit("owner", id, `http://127.0.0.1:${port}/?code=x`), /Попытка/);
  c.stdout.write('{"jsonrpc":"2.0","id":2,"result":{}}\n');
  assert.deepEqual(login.get("owner"), {id, status:"ready"});
});

test("отказ authenticate отдаёт только статус, сырой текст ошибки наружу не идёт", async t => {
  const c = child();
  const login = new AgyLoginSessions(() => c);
  const {id} = login.start("owner");
  initOk(c);
  const relay = http.createServer((req, res) => { res.writeHead(200); res.end("Authentication successful"); });
  await new Promise(resolve => relay.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => relay.close(resolve)));
  const port = relay.address().port;
  const url = `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent("http://127.0.0.1:" + port + "/")}`;
  c.stderr.write("Open the following link to authenticate the ACP server: " + url + "\n");
  await login.submit("owner", id, `http://127.0.0.1:${port}/?code=4%2Fno&state=x`);
  c.stderr.write("Onboarding failed: private details nobody should see\n");
  c.stdout.write('{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Onboarding failed: private details"}}\n');
  assert.deepEqual(login.get("owner"), {id, status:"rejected"});
  assert.ok(!JSON.stringify(login.get("owner")).includes("private"));
});

test("нет oauth-personal в authMethods — попытка завершается отказом", () => {
  const c = child();
  const login = new AgyLoginSessions(() => c);
  const {id} = login.start("owner");
  initOk(c, [{id:"gemini-api-key"}]);
  c.stderr.write("Open the following link to authenticate the ACP server: https://accounts.google.com/x\n");
  assert.deepEqual(login.get("owner"), {id, status:"failed"});
});

test("BUG-279: вход по платному ключу Gemini API отключён (400)", () => {
  const launches = [];
  const login = new AgyLoginSessions((owner, env) => { launches.push(env); return child(); });
  assert.throws(() => login.start("owner", { method: "api-key", key: "AIzaSyTEST_key-1234567890" }), { status: 400 });
  assert.deepEqual(launches, []);
});

test("onFinish вызывает маркер профиля: ready ставит, rejected снимает", async t => {
  const {mkdtempSync, existsSync} = await import("node:fs");
  const {tmpdir} = await import("node:os");
  const {join} = await import("node:path");
  const {markAcpProfile, acpProfileReady, acpProfileDir} = await import("../lib/acp-login-launch.js");
  const dir = mkdtempSync(join(tmpdir(),"agy-marker-"));
  markAcpProfile(dir, "admin", "antigravity", "ready");
  assert.ok(acpProfileReady(dir, "admin", "antigravity"));
  assert.ok(existsSync(join(acpProfileDir(dir, "admin", "antigravity"), ".portal-ready")));
  markAcpProfile(dir, "admin", "antigravity", "rejected");
  assert.ok(!acpProfileReady(dir, "admin", "antigravity"));
  // Промежуточные статусы состояние входа не меняют.
  markAcpProfile(dir, "admin", "antigravity", "expired");
  assert.ok(!acpProfileReady(dir, "admin", "antigravity"));
  markAcpProfile(dir, "admin", "antigravity", "ready");
  markAcpProfile(dir, "admin", "antigravity", "expired");
  assert.ok(acpProfileReady(dir, "admin", "antigravity"));

  const c = child();
  const events = [];
  const login = new AgyLoginSessions(() => c, (owner, status) => events.push([owner, status]));
  const {id} = login.start("owner");
  initOk(c);
  const relay = http.createServer((req, res) => { res.writeHead(200); res.end("ok"); });
  await new Promise(r => relay.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => relay.close(r)));
  const port = relay.address().port;
  c.stderr.write(`Open the following link to authenticate the ACP server: https://accounts.google.com/x?redirect_uri=${encodeURIComponent("http://127.0.0.1:" + port + "/")}\n`);
  await login.submit("owner", id, `http://127.0.0.1:${port}/?code=1&state=s`);
  c.stdout.write('{"jsonrpc":"2.0","id":2,"result":{}}\n');
  assert.equal(login.get("owner").status, "ready");
  assert.deepEqual(events, [["owner","ready"]]);
});
