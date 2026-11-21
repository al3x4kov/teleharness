// FEAT-20.4 — тот же процесс ждёт ответ того же пользователя.
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { GeminiLoginSessions } from "../lib/acp-login-session.js";

test("чужая или устаревшая попытка, повторная отправка и перенос строки запрещены", () => {
  const child = Object.assign(new EventEmitter(), {stdin:new PassThrough(), stdout:new PassThrough(), stderr:new PassThrough(), kill() {}});
  const login = new GeminiLoginSessions(() => child);
  const {id} = login.start("owner");
  child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"authMethods":[{"id":"oauth-personal"}]}}\n');
  child.stdout.write("https://accounts.google.com/oauth?state=x\nEnter the authorization code: ");
  assert.equal(login.get("owner").status, "awaiting-code");
  for (const args of [["other",id,"x"], ["owner","stale","x"], ["owner",id,"x\ny"]]) assert.throws(() => login.submit(...args));
  login.submit("owner",id,"4/example");
  assert.throws(() => login.submit("owner",id,"4/example"));
  child.stdout.write('4/example\n{"jsonrpc":"2.0","id":2,"result":{}}\n');
  assert.deepEqual(login.get("owner"), {id,status:"ready"});
});

test("отказ в поддержке клиента Google — отдельный конечный статус",()=>{
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){}});
  const login=new GeminiLoginSessions(()=>child);
  login.start("owner");
  child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"authMethods":[{"id":"oauth-personal"}]}}\n');
  child.stdout.write('{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"This client is no longer supported for Gemini Code Assist for individuals."}}\n');
  assert.equal(login.get("owner").status,"unsupported");
});
