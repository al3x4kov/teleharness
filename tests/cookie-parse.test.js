// P0 (full review 2026-11-02): a malformed %-escape in any cookie threw
// URIError inside parseCookies and crashed server.js for an unauthenticated
// request on the public address. parseCookies must never throw.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCookies } from "../lib/auth.js";

test("parseCookies never throws on malformed escapes, keeps the raw value", () => {
  assert.doesNotThrow(() => parseCookies("x=%"));
  assert.doesNotThrow(() => parseCookies("a=%E0%A4%A; zai_t=abc"));
  const c = parseCookies("x=%; zai_t=tok%20en; y=%zz");
  assert.equal(c.x, "%");
  assert.equal(c.y, "%zz");
  assert.equal(c.zai_t, "tok en", "well-formed values still decode");
});

test("parseCookies tolerates empty/odd headers", () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies("novalue; ;="), { "": "" });
});
