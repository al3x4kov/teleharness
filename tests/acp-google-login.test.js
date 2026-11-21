// FEAT-20.4 — код Google может вернуться в терминальном эхо CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { GeminiLoginOutput } from "../lib/acp-google-login.js";

test("публикует ссылку Google и ждёт приглашения, разбитого между чанками", () => {
  const login = new GeminiLoginOutput();
  login.feed("Please visit the following URL to authorize the application:\n\nhttps://accounts.google.");
  login.feed("com/o/oauth2/v2/auth?state=abc\n\nEnter the author");
  assert.equal(login.state.status, "starting");
  login.feed("ization code: ");
  assert.deepEqual(login.state, {status:"awaiting-code", url:"https://accounts.google.com/o/oauth2/v2/auth?state=abc"});
});

test("после отправки кода скрывает ссылку и не публикует эхо или сырой текст ошибки", () => {
  const login = new GeminiLoginOutput();
  login.feed("https://accounts.google.com/o/oauth2/v2/auth?state=test\nEnter the authorization code: ");
  login.submitted();
  login.feed("private-example\nFailed to authenticate with authorization code: private-example\n");
  assert.deepEqual(login.state, {status:"rejected"});
});

test("отклоняет посторонний домен", () => {
  const login = new GeminiLoginOutput();
  login.feed("https://accounts.google.com.evil.example/oauth\nEnter the authorization code: ");
  assert.deepEqual(login.state, {status:"starting"});
});
