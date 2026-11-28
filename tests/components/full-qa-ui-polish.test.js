// UI & PWA layout regression tests: Temporal .t-crumbs header, Settings -> Computer (/boot/efi),
// Settings -> Background agents (.t-input / .card-row), System prompt (.card .sheet-footer),
// and PWA mobile-web-app-capable meta tag in public/index.html.
import { readFileSync } from "node:fs";
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $$, createHarness, loadUI } from "./helpers/load.mjs";
import { installFetch } from "./helpers/dom.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({
    SettingsView: "src/components/views/SettingsView.jsx",
    BackgroundAgentsSection: "src/components/views/BackgroundAgentsSection.jsx",
  });
  t$ = createHarness(ui);
});

afterEach(() => {
  t$.cleanup();
  ui.store.me.value = null;
  ui.store.host.value = null;
  installFetch();
});

test("UI polish 1: .page-header > .t-crumbs uses grid-column 2 and is excluded from grid-column 3", () => {
  const css = readFileSync(new URL("../../src/claude-look.css", import.meta.url), "utf8");
  const col2 = css.match(/\.page-header\s*>\s*h1[\s\S]*?\{[^}]*grid-column\s*:\s*2\s*;[^}]*\}/);
  assert.ok(col2, "center column rule for .page-header must exist");
  assert.match(col2[0], /\.page-header\s*>\s*\.t-crumbs/, ".page-header > .t-crumbs must be in grid-column: 2");

  const col3 = css.match(/\.page-header\s*>\s*:last-child[^{]*\{[^}]*grid-column\s*:\s*3\s*;[^}]*\}/);
  assert.ok(col3, "right column rule for .page-header must exist");
  assert.match(col3[0], /:not\(\.t-crumbs\)/, "grid-column: 3 rule must exclude .t-crumbs");
});

test("UI polish 2: .host-label fits Linux mount paths (/boot/efi) with ellipsis and title attribute", async () => {
  const css = readFileSync(new URL("../../src/components/views.css", import.meta.url), "utf8");
  const rule = css.match(/\.host-label\s*\{([^}]*)\}/);
  assert.ok(rule, ".host-label rule must exist");
  const widthMatch = rule[1].match(/width\s*:\s*(\d+)px/);
  assert.ok(widthMatch && Number(widthMatch[1]) >= 72, `.host-label width must be >= 72px, got: ${widthMatch?.[0]}`);
  assert.match(rule[1], /overflow\s*:\s*hidden/);
  assert.match(rule[1], /text-overflow\s*:\s*ellipsis/);
  assert.match(rule[1], /white-space\s*:\s*nowrap/);

  const hostFixture = {
    cpu: { loadPct: 12, cores: 8 },
    ram: { usedGb: 8, totalGb: 32 },
    disks: [
      { drive: "/", usedGb: 75, totalGb: 460, usedPct: 17 },
      { drive: "/boot/efi", usedGb: 0.1, totalGb: 1, usedPct: 1 },
    ],
  };
  installFetch([
    { path: "/teleharness/api/host", reply: () => hostFixture },
    { path: /^\/teleharness\/api\//, reply: () => ({}) },
  ]);
  ui.store.me.value = { id: "admin", name: "Admin", role: "admin", engines: ["opencode"] };
  ui.store.providerCfg.value = { providers: [] };
  ui.store.agents.value = [{ name: "default" }];
  ui.store.mcp.value = [];
  ui.store.host.value = hostFixture;

  location.hash = "#/settings/computer";
  const h = t$.mount(ui.SettingsView, { section: "computer" });
  try {
    await t$.flush();
    const labels = [...$$(h.root, ".host-label")];
    const efi = labels.find((el) => el.textContent.trim() === "/boot/efi");
    assert.ok(efi, "/boot/efi row must render");
    assert.equal(efi.getAttribute("title"), "/boot/efi");
  } finally {
    h.unmount();
  }
});

test("UI polish 3: BackgroundAgentsSection uses .t-input.t-num (no .t-in) and styles .card-row", async () => {
  installFetch([
    {
      path: "/teleharness/api/admin/background",
      reply: () => ({
        adminStopped: false,
        claudeUsedToday: 0,
        claudePerDay: 10,
        claudeLeftToday: 10,
        userPerDay: 30,
        defaultPerHour: 6,
        defaultQueue: 20,
        triggersTotal: 1,
        triggersEnabled: 1,
        activeRuns: 0,
        connections: [{ owner: "admin", login: "demo-user", tokenLast4: "1234", status: "ok", expiresAt: "2026-12-22T00:00:00Z" }],
      }),
    },
  ]);

  const h = t$.mount(ui.BackgroundAgentsSection, {});
  await t$.waitFor(() => $$(h.root, 'input[type="number"]').length === 4);

  const inputs = [...$$(h.root, 'input[type="number"]')];
  assert.equal(inputs.length, 4);
  for (const inp of inputs) {
    assert.ok(inp.classList.contains("t-input"));
    assert.ok(inp.classList.contains("t-num"));
    assert.equal(inp.classList.contains("t-in"), false);
  }

  const css = readFileSync(new URL("../../src/components/views.css", import.meta.url), "utf8");
  const rowRule = css.match(/\[data-bg-admin\]\s+\.card-row\s*\{([^}]*)\}/);
  assert.ok(rowRule);
  assert.match(rowRule[1], /display\s*:\s*flex/);
  assert.match(rowRule[1], /justify-content\s*:\s*space-between/);
  h.unmount();
});

test("UI polish 4: .card .sheet-footer is transparent and static inside settings cards", () => {
  const css = readFileSync(new URL("../../src/components/views.css", import.meta.url), "utf8");
  const rule = css.match(/\.card\s+\.sheet-footer\s*\{([^}]*)\}/);
  assert.ok(rule);
  assert.match(rule[1], /background\s*:\s*transparent/);
  assert.match(rule[1], /position\s*:\s*static/);
});

test("UI polish 5: public/index.html declares mobile-web-app-capable alongside apple-mobile-web-app-capable", () => {
  const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<meta\s+name="mobile-web-app-capable"\s+content="yes"\s*\/?>/i);
});
