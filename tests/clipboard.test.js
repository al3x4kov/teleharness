// copyText (src/lib/clipboard.js, BUG-01.30/R-24): async clipboard in secure
// contexts, textarea + execCommand fallback on plain http.
// Run: node --test tests/clipboard.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyText } from "../src/lib/clipboard.js";

function fakeDoc(execResult = true, { selection = null } = {}) {
  const log = { appended: 0, removed: 0, exec: [], attrs: {}, el: null, restoredRanges: [] };
  const doc = {
    activeElement: null,
    body: {
      appendChild: (el) => {
        log.appended += 1;
        log.el = el;
      },
    },
    createElement: () => {
      const el = {
        value: "",
        style: {},
        readOnly: false,
        tabIndex: 0,
        attrs: log.attrs,
        setAttribute(k, v) {
          log.attrs[k] = v;
        },
        select() {},
        setSelectionRange() {},
        remove: () => (log.removed += 1),
      };
      return el;
    },
    execCommand: (cmd) => {
      log.exec.push(cmd);
      return execResult;
    },
    getSelection: selection
      ? () => ({
          rangeCount: selection.length,
          getRangeAt: (i) => selection[i],
          removeAllRanges: () => (log.clearedSel = true),
          addRange: (r) => log.restoredRanges.push(r),
        })
      : undefined,
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
  assert.equal(log.attrs["data-teleharness-clipboard"], "1", "BUG-300: fallback textarea marked for AppShell keyboard guard");
  assert.equal(log.attrs["aria-hidden"], "true");
  assert.equal(log.attrs.readonly, "");
  assert.equal(log.el.readOnly, true);
  assert.equal(log.el.tabIndex, -1);
});

test("copyText: fallback preserves existing user selection and avoids stealing focus", async () => {
  const range = { id: "r1", cloneRange() { return { id: "r1-clone" }; } };
  const { doc, log } = fakeDoc(true, { selection: [range] });
  const env = { isSecureContext: false, navigator: {}, document: doc };
  assert.equal(await copyText("фрагмент", env), true);
  assert.equal(log.clearedSel, true);
  assert.deepEqual(log.restoredRanges, [{ id: "r1-clone" }]);
});

test("copyText: rejected clipboard write falls back; failure reports false", async () => {
  const { doc } = fakeDoc(false);
  const env = { navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } }, document: doc };
  assert.equal(await copyText("x", env), false);
  assert.equal(await copyText("", env), false, "empty text is a no-op");
  assert.equal(await copyText("x", {}), false, "no DOM at all");
});
