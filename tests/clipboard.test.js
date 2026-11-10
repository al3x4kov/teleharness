// copyText (src/lib/clipboard.js, BUG-01.30/R-24): async clipboard in secure
// contexts, textarea + execCommand fallback on plain http.
// Run: node --test tests/clipboard.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyText } from "../src/lib/clipboard.js";

function fakeDoc(execResult = true) {
  const log = { appended: 0, removed: 0, exec: [] };
  const doc = {
    activeElement: null,
    body: {
      appendChild: () => (log.appended += 1),
    },
    createElement: () => ({
      value: "",
      style: {},
      setAttribute() {},
      select() {},
      setSelectionRange() {},
      remove: () => (log.removed += 1),
    }),
    execCommand: (cmd) => {
      log.exec.push(cmd);
      return execResult;
    },
  };
  return { doc, log };
}

test("copyText: secure context uses navigator.clipboard", async () => {
  let got = null;
  const env = { isSecureContext: true, navigator: { clipboard: { writeText: async (s) => (got = s) } } };
  assert.equal(await copyText("привет", env), true);
  assert.equal(got, "привет");
});

test("copyText: http (no clipboard API) falls back to execCommand and cleans up", async () => {
  const { doc, log } = fakeDoc(true);
  assert.equal(await copyText("текст", { isSecureContext: false, navigator: {}, document: doc }), true);
  assert.deepEqual(log.exec, ["copy"]);
  assert.equal(log.appended, 1);
  assert.equal(log.removed, 1);
});

test("copyText: rejected clipboard write falls back; failure reports false", async () => {
  const { doc } = fakeDoc(false);
  const env = { navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } }, document: doc };
  assert.equal(await copyText("x", env), false);
  assert.equal(await copyText("", env), false, "empty text is a no-op");
  assert.equal(await copyText("x", {}), false, "no DOM at all");
});
