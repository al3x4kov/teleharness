// Unit tests for the pure half of src/lib/router.js: match() and cleanPath()
// (the hashchange bootstrap is DOM-guarded, so importing here is safe).
// Run: node --test tests/router.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPath, match } from "../src/lib/router.js";

test("cleanPath: '#/' and empty hashes normalize to '/'", () => {
  assert.equal(cleanPath("#/"), "/");
  assert.equal(cleanPath("#"), "/");
  assert.equal(cleanPath(""), "/");
});

test("cleanPath: strips the query, collapses repeated slashes, drops a trailing slash", () => {
  assert.equal(cleanPath("#/chat/ses_1?x=1"), "/chat/ses_1");
  assert.equal(cleanPath("#//chat///ses_1/"), "/chat/ses_1");
  assert.equal(cleanPath("chat"), "/chat", "a hash without a leading slash still becomes a path");
});

test("match: '#/' resolves home with no params", () => {
  const m = match(cleanPath("#/"));
  assert.equal(m.view, "home");
  assert.deepEqual(m.params, {});
});

test("match: '/chat/:id' carries the session id", () => {
  const m = match(cleanPath("#/chat/ses_abc"));
  assert.equal(m.view, "chat");
  assert.deepEqual(m.params, { id: "ses_abc" });
});

test("match: '/project/:id' decodes percent-encoded directories", () => {
  const m = match(cleanPath("#/project/D%3A%5CPortal%5Czai"));
  assert.equal(m.view, "project");
  assert.equal(m.params.id, "D:\\Portal\\zai");
  const ru = match("/project/D%3A%5C%D0%9F%D1%80%D0%BE%D0%B5%D0%BA%D1%82%D1%8B");
  assert.equal(ru.params.id, "D:\\Проекты");
});

test("match: a malformed escape falls back to the raw segment", () => {
  assert.equal(match("/project/%zz").params.id, "%zz");
});

test("match: literal routes resolve; '/projects' is not '/project/:id'", () => {
  assert.equal(match("/projects").view, "projects");
  assert.equal(match("/settings").view, "settings");
  assert.equal(match("/access").view, "access");
  assert.equal(match("/project/x").view, "project");
});

test("match: unknown or arity-mismatched paths return null (caller redirects home)", () => {
  assert.equal(match("/nope"), null);
  assert.equal(match("/chat"), null, "'/chat' without an id matches nothing");
  assert.equal(match("/chat/a/extra"), null);
});

test("match: trailing slash and empty path both fall back to segment matching", () => {
  assert.equal(match("/chat/abc/").params.id, "abc", "empty segments are filtered out");
  assert.equal(match("").view, "home", "'' and '/' both split to zero segments");
});
