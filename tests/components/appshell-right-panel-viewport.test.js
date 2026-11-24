// BUG-307: AppShell does not mount RightPanel below 1024 px (a phone viewport makes
// no idle /mcp, /skills or /plan requests) and mounts/unmounts it when the
// matchMedia("(min-width: 1024px)") query flips.
// The virtual-keyboard guard of the same component stays covered by appshell-viewport.test.js.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, createHarness, loadUI } from "./helpers/load.mjs";
import { fetchCalls, installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ AppShell: "src/components/AppShell.jsx" });
  t$ = createHarness(ui);
});

let origMatchMedia;
afterEach(() => {
  t$.cleanup();
  ui.store.resetPlans();
  ui.store.me.value = null;
  if (origMatchMedia !== undefined) {
    window.matchMedia = origMatchMedia;
    origMatchMedia = undefined;
  }
  window.location.hash = "";
  installFetch();
});

function mockMatchMedia(initialMatches) {
  origMatchMedia = window.matchMedia;
  let matches = initialMatches;
  const listeners = new Set();
  const mq = {
    media: "(min-width: 1024px)",
    get matches() {
      return matches;
    },
    addEventListener(type, fn) {
      if (type === "change") listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === "change") listeners.delete(fn);
    },
  };
  window.matchMedia = () => mq;
  return {
    set(next) {
      matches = next;
      for (const fn of [...listeners]) fn({ matches: next, media: mq.media });
    },
  };
}

function baseRoutes() {
  return [
    { method: "GET", path: "/teleharness/api/auth/me", reply: () => ({ id: "admin", name: "Admin", role: "admin" }) },
    { method: "GET", path: "/teleharness/api/session", reply: () => [] },
    { method: "GET", path: "/teleharness/api/project", reply: () => [] },
    { method: "GET", path: "/teleharness/api/provider", reply: () => ({ all: [], default: {}, connected: [] }) },
    { method: "GET", path: "/teleharness/api/agent", reply: () => [] },
    { method: "GET", path: "/teleharness/api/status", reply: () => ({}) },
    { method: "GET", path: "/teleharness/api/dialogs", reply: () => [] },
    { method: "GET", path: "/teleharness/api/board", reply: () => ({ items: [] }) },
    { method: "GET", path: /^\/teleharness\/api\/session\/[^/]+\/message$/, reply: () => [] },
    { method: "GET", path: "/teleharness/api/mcp", reply: () => ({ playwright: { status: "connected" } }) },
    { method: "GET", path: "/teleharness/api/skills", reply: () => [{ id: "teleharness-xlsx", name: "teleharness-xlsx", description: "Excel" }] },
    { method: "GET", path: /^\/teleharness\/api\/session\/[^/]+\/plan$/, reply: () => ({ sessionID: "ses_mob", todos: [] }) },
  ];
}

test("BUG-307: below 1024 px RightPanel is not mounted and sends no /mcp, /skills or /plan requests; at >= 1024 px it mounts", async () => {
  const mm = mockMatchMedia(false);
  installFetch(baseRoutes());
  window.location.hash = "#/chat/ses_mob";
  ui.store.me.value = { id: "admin", name: "Admin", role: "admin" };

  const { root } = t$.mount(ui.AppShell, {});
  await t$.flush();
  await new Promise((r) => setTimeout(r, 30));

  assert.equal($(root, "aside.right-panel"), null, "below 1024 px RightPanel is absent from the DOM");
  assert.equal($(root, ".shell.has-right-panel"), null, "the has-right-panel class is not set below 1024 px");
  assert.equal(ui.store.panelMcp.value, null, "RightPanel did not start loading panelMcp below 1024 px");
  const panelOnlyCalls = fetchCalls.filter((c) => c.path === "/teleharness/api/skills" || /\/plan$/.test(c.path));
  assert.equal(panelOnlyCalls.length, 0, `below 1024 px there must be no /skills or /plan requests, got: ${JSON.stringify(panelOnlyCalls.map((c) => c.path))}`);

  // Resized to desktop (>= 1024 px): the panel mounts and loads its data.
  const mcpCountBefore = fetchCalls.filter((c) => c.path === "/teleharness/api/mcp").length;
  t$.act(() => mm.set(true));
  await t$.waitFor(() => $(root, "aside.right-panel") != null);
  await t$.waitFor(() => fetchCalls.some((c) => c.path === "/teleharness/api/skills"));
  await t$.waitFor(() => fetchCalls.some((c) => /\/plan$/.test(c.path)));
  await t$.waitFor(() => fetchCalls.filter((c) => c.path === "/teleharness/api/mcp").length > mcpCountBefore);
  assert.ok($(root, ".shell.has-right-panel") != null);

  // Resized back below 1024 px: the panel unmounts.
  t$.act(() => mm.set(false));
  await t$.waitFor(() => $(root, "aside.right-panel") == null);
});
