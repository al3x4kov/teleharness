// AppShell visualViewport / virtual-keyboard guard.
// Verifies that hidden clipboard/readOnly/disabled textareas never trigger
// .kb or shrink --vvh, orientation changes reset tall, focus transfer between
// editable inputs does not flash close prediction, and unmount cleans up
// --vvh, --vv-top, classes and timers.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";
import { KB_KEY } from "../../src/lib/kb-predict.js";

let ui, t$;
let origVV;

function makeVV({ width = 440, height = 956, offsetTop = 0, scale = 1 } = {}) {
  const listeners = new Map();
  return {
    width,
    height,
    offsetTop,
    scale,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn({ type, target: this });
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

before(async () => {
  ui = await loadUI({ AppShell: "src/components/AppShell.jsx" });
  t$ = createHarness(ui);
  origVV = Object.getOwnPropertyDescriptor(window, "visualViewport");
});

afterEach(() => {
  t$.cleanup();
  ui.store.me.value = null;
  document.documentElement.classList.remove("kb", "kb-move");
  document.documentElement.style.removeProperty("--vvh");
  document.documentElement.style.removeProperty("--vv-top");
  try {
    localStorage.removeItem(KB_KEY);
  } catch {}
  if (origVV) Object.defineProperty(window, "visualViewport", origVV);
  else delete window.visualViewport;
  installFetch();
});

function mountShell(vv) {
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: vv.height, configurable: true, writable: true });
  installFetch([
    { method: "GET", path: "/teleharness/api/auth/me", reply: () => ({ id: "u1", name: "Admin", role: "member" }) },
    { method: "GET", path: "/teleharness/api/session", reply: () => [] },
    { method: "GET", path: "/teleharness/api/board", reply: () => ({ items: [], counts: {} }) },
    { method: "GET", path: "/teleharness/api/version", reply: () => ({ version: "2.8.0" }) },
    { method: "GET", path: "/teleharness/api/mcp", reply: () => ({ demo: { status: "connected" } }) },
  ]);
  ui.store.me.value = { id: "u1", name: "Admin", role: "member" };
  return t$.mount(ui.AppShell);
}

test("focusin on readonly / data-teleharness-clipboard / disabled textarea does NOT trigger .kb or shrink --vvh", async () => {
  localStorage.setItem(KB_KEY, "340");
  const vv = makeVV({ width: 440, height: 956 });
  mountShell(vv);
  await t$.flush();
  assert.equal(document.documentElement.style.getPropertyValue("--vvh"), "956px");
  assert.equal(document.documentElement.classList.contains("kb"), false);

  const taClip = document.createElement("textarea");
  taClip.setAttribute("readonly", "");
  taClip.readOnly = true;
  taClip.setAttribute("data-teleharness-clipboard", "1");
  document.body.appendChild(taClip);
  taClip.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  await t$.flush();
  assert.equal(document.documentElement.classList.contains("kb"), false, "clipboard textarea must not set .kb");
  assert.equal(document.documentElement.style.getPropertyValue("--vvh"), "956px", "clipboard textarea must not shrink --vvh");
  taClip.remove();

  const taRo = document.createElement("textarea");
  taRo.readOnly = true;
  document.body.appendChild(taRo);
  taRo.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  await t$.flush();
  assert.equal(document.documentElement.classList.contains("kb"), false, "readOnly textarea must not set .kb");
  assert.equal(document.documentElement.style.getPropertyValue("--vvh"), "956px");
  taRo.remove();

  const inpDis = document.createElement("input");
  inpDis.disabled = true;
  document.body.appendChild(inpDis);
  inpDis.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  await t$.flush();
  assert.equal(document.documentElement.classList.contains("kb"), false, "disabled input must not set .kb");
  assert.equal(document.documentElement.style.getPropertyValue("--vvh"), "956px");
  inpDis.remove();
});

test("focusin on real editable textarea predicts keyboard open and shrinks --vvh", async () => {
  localStorage.setItem(KB_KEY, "340");
  const vv = makeVV({ width: 440, height: 956 });
  mountShell(vv);
  await t$.flush();

  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  ta.focus();
  ta.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  await t$.flush();
  assert.equal(document.documentElement.classList.contains("kb"), true, "real editable textarea opens keyboard prediction");
  assert.equal(document.documentElement.style.getPropertyValue("--vvh"), "616px");
  ta.remove();
});

test("switching focus between two editable inputs does not flash close prediction", async () => {
  localStorage.setItem(KB_KEY, "340");
  const vv = makeVV({ width: 440, height: 956 });
  mountShell(vv);
  await t$.flush();

  const a = document.createElement("input");
  const b = document.createElement("textarea");
  document.body.appendChild(a);
  document.body.appendChild(b);

  vv.height = 616;
  a.focus();
  a.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  vv.emit("resize");
  await t$.flush();
  assert.equal(document.documentElement.classList.contains("kb"), true);

  // Focus leaves `a` directly to `b`: relatedTarget is editable, so no close prediction!
  a.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: b }));
  assert.equal(document.documentElement.style.getPropertyValue("--vvh"), "616px", "no jump back to 956px on focus transfer");
  a.remove();
  b.remove();
});

test("portrait -> landscape orientation change resets tall so landscape is not misclassified as .kb", async () => {
  const vv = makeVV({ width: 440, height: 956 });
  mountShell(vv);
  await t$.flush();
  assert.equal(document.documentElement.style.getPropertyValue("--vvh"), "956px");

  // Rotate to landscape: width grows 440 -> 956, height shrinks 956 -> 440 (no keyboard!)
  vv.width = 956;
  vv.height = 440;
  Object.defineProperty(window, "innerHeight", { value: 440, configurable: true, writable: true });
  vv.emit("resize");
  await t$.flush();
  assert.equal(document.documentElement.style.getPropertyValue("--vvh"), "440px");
  assert.equal(document.documentElement.classList.contains("kb"), false);

  // Even when focusing a field without keyboard resize yet, tall=440 so 440 is not "shrank"
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  ta.focus();
  vv.emit("resize");
  await t$.flush();
  assert.equal(document.documentElement.classList.contains("kb"), false, "tall reset on landscape prevents false .kb");
  ta.remove();
});

test("AppShell unmount removes --vvh, --vv-top, .kb and all viewport listeners", async () => {
  const vv = makeVV({ width: 440, height: 956, offsetTop: 24 });
  const h = mountShell(vv);
  await t$.flush();
  assert.equal(document.documentElement.style.getPropertyValue("--vv-top"), "24px");
  assert.equal(vv.listenerCount("resize"), 1);

  h.unmount();
  await t$.flush();
  assert.equal(document.documentElement.style.getPropertyValue("--vvh"), "");
  assert.equal(document.documentElement.style.getPropertyValue("--vv-top"), "", "--vv-top must be cleaned up on unmount");
  assert.equal(document.documentElement.classList.contains("kb"), false);
  assert.equal(vv.listenerCount("resize"), 0);
});
