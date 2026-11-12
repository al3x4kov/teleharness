// FEAT-16.3, task 3.9: policy on the LIVE opencode 2.x agent shape.
// GET /api/agent (api-map §9) returns agents with an ordered `permissions`
// ruleset [{action, resource, effect}] (last-match-wins) instead of the 1.x
// `permission` [{permission, pattern, action}]. Before the fix agentCan saw no
// `permission` field and treated every v2 agent as unsandboxed — tenants saw
// nothing. v1 fixtures and expectations stay untouched (g1-units.test.js).
// Run: node --test tests/policy-v2.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentCan, agentHasShell, agentIsSandboxed, defaultTenantAgent, setTenantVaultRoots, tenantAgents } from "../lib/policy.js";

// the fixtures below use this tenant knowledge-base root (the default one is ~/.zai/tenants-vault)
setTenantVaultRoots(["D:\\Obsidian\\tenants"]);

// The live build agent (api-map §9, 2026-11-07): broad allow, everything legal.
const BUILD = {
  id: "build",
  name: "Build",
  description: "The default agent. Executes tools based on configured permissions.",
  mode: "primary",
  hidden: false,
  permissions: [
    { action: "*", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
  ],
};

// The Sandbox we ship in ops/opencode/opencode.v2.json (design §8): deny
// delegation and outside files after the broad allow; vault-zone and opencode
// spool exemptions are fine to grant — the sandbox core confines tenants to
// their own folder anyway (BUG-171 semantics).
const SANDBOX_V2 = {
  id: "sandbox",
  name: "Sandbox",
  mode: "primary",
  hidden: false,
  permissions: [
    { action: "*", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "external_directory", resource: "D:\\Obsidian\\tenants\\*", effect: "allow" },
    { action: "external_directory", resource: "C:\\Users\\USER\\AppData\\Local\\opencode\\tool-output\\*", effect: "allow" },
    { action: "shell", resource: "*", effect: "allow" },
    { action: "webfetch", resource: "*", effect: "allow" },
  ],
};

const GENERAL = { id: "general", name: "General", mode: "subagent", hidden: false, permissions: [{ action: "*", resource: "*", effect: "allow" }] };
const COMPACT = { id: "compaction", name: "Compaction", mode: "primary", hidden: true, permissions: [] };
// A 1.x agent beside v2 ones (mixed catalogs must keep working).
const V1_SANDBOX = { name: "Sandbox-v1", mode: "primary", permission: [{ permission: "*", pattern: "*", action: "deny" }, { permission: "bash", pattern: "*", action: "allow" }] };

test("v2 build: broad allow means every capability → not sandboxed, invisible to tenants", () => {
  assert.equal(agentCan(BUILD, "bash"), true);
  assert.equal(agentCan(BUILD, "task"), true);
  assert.equal(agentCan(BUILD, "external_directory"), true);
  assert.equal(agentHasShell(BUILD), true);
  assert.equal(agentIsSandboxed(BUILD), false);
  assert.equal(tenantAgents([BUILD]).length, 0);
});

test("v2 Sandbox: deny task/external_directory after allow-* → sandboxed", () => {
  assert.equal(agentCan(SANDBOX_V2, "task"), false);
  assert.equal(agentCan(SANDBOX_V2, "external_directory"), false, "vault-zone and spool allows must not re-open the wildcard deny");
  assert.equal(agentCan(SANDBOX_V2, "bash"), true);
  assert.equal(agentHasShell(SANDBOX_V2), true);
  assert.equal(agentIsSandboxed(SANDBOX_V2), true);
  assert.deepEqual(tenantAgents([BUILD, GENERAL, COMPACT, SANDBOX_V2, V1_SANDBOX]).map((a) => a.name), ["Sandbox", "Sandbox-v1"]);
});

test("v2 order matters: last-match-wins (allow-* after the denies un-sandboxes)", () => {
  const loose = {
    name: "Loose",
    mode: "primary",
    permissions: [
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "external_directory", resource: "*", effect: "deny" },
      { action: "*", resource: "*", effect: "allow" },
    ],
  };
  assert.equal(agentCan(loose, "task"), true);
  assert.equal(agentIsSandboxed(loose), false);
});

test("v2 tool-name aliases: shell ≙ bash, subagent ≙ task, either spelling", () => {
  const shellSpelling = { name: "A", mode: "primary", permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "deny" }] };
  const bashSpelling = { name: "B", mode: "primary", permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "bash", resource: "*", effect: "deny" }] };
  const taskSpelling = { name: "C", mode: "primary", permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "task", resource: "*", effect: "deny" }] };
  for (const a of [shellSpelling, bashSpelling]) assert.equal(agentCan(a, "bash"), false, a.name);
  for (const a of [taskSpelling]) assert.equal(agentCan(a, "task"), false, a.name);
  const subagentSpelling = { name: "D", mode: "primary", permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "subagent", resource: "*", effect: "deny" }] };
  assert.equal(agentCan(subagentSpelling, "task"), false);
});

test("v2 external_directory: spool/vault exemptions grant nothing by themselves (BUG-171)", () => {
  const onlyExemptions = {
    name: "E",
    mode: "primary",
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "deny" },
      { action: "external_directory", resource: "D:\\Obsidian\\tenants\\*", effect: "allow" },
    ],
  };
  assert.equal(agentCan(onlyExemptions, "external_directory"), false);
  assert.equal(agentCan(onlyExemptions, "bash"), true);
  assert.equal(agentIsSandboxed(onlyExemptions), true);
});

test("v2 ask is not deny (a narrowed ask re-opens a wildcard deny like 1.x)", () => {
  const a = { name: "F", mode: "primary", permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "webfetch", resource: "*", effect: "ask" }] };
  assert.equal(agentCan(a, "webfetch"), true);
  assert.equal(agentCan(a, "bash"), false);
});

test("no ruleset at all: legacy fail-open behaviour unchanged", () => {
  assert.equal(agentCan({ name: "legacy" }, "bash"), true);
  assert.equal(agentCan({ name: "legacy", tools: { bash: false } }, "bash"), false);
  assert.equal(agentIsSandboxed({ name: "legacy" }), false);
});

test("v1 ruleset wins when both fields exist (conservative)", () => {
  const both = { name: "G", mode: "primary", permission: [{ permission: "*", pattern: "*", action: "deny" }, { permission: "bash", pattern: "*", action: "allow" }], permissions: [{ action: "*", resource: "*", effect: "allow" }] };
  assert.equal(agentCan(both, "task"), false);
  assert.equal(agentCan(both, "bash"), true);
  assert.equal(agentIsSandboxed(both), true);
});

test("defaultTenantAgent on the live-shaped catalog: the Sandbox primary", () => {
  assert.equal(defaultTenantAgent([BUILD, GENERAL, COMPACT, SANDBOX_V2]), "Sandbox");
  assert.equal(defaultTenantAgent([BUILD, GENERAL, SANDBOX_V2], "Build"), "Sandbox");
});
