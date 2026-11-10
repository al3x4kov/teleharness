// FEAT-16.2 (EPIC-16, 2026-11-07): after OmO → oh-my-opencode-slim the OmO agents
// («Sisyphus - ultraworker», Prometheus, Atlas…) are gone from the opencode catalog.
// An admin chat bound to one continues on the opencode default agent; a known agent
// is kept; an unknown catalog (opencode down) changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adminAgentFor, adminDefaultAgent } from "../lib/policy.js";

const LIST = [
  { name: "orchestrator", mode: "primary" },
  { name: "Hephaestus - deep worker", mode: "primary" },
  { name: "Sandbox", mode: "primary" },
  { name: "explorer", mode: "subagent" },
  { name: "title", mode: "primary", hidden: true },
];

test("a bound agent gone from the catalog → the opencode default agent", () => {
  assert.equal(adminAgentFor("Sisyphus - ultraworker", LIST, "orchestrator"), "orchestrator");
  assert.equal(adminAgentFor("Prometheus - Plan Builder", LIST, "orchestrator"), "orchestrator");
});

test("an agent still in the catalog is kept (primary or subagent)", () => {
  assert.equal(adminAgentFor("Hephaestus - deep worker", LIST, "orchestrator"), "Hephaestus - deep worker");
  assert.equal(adminAgentFor("explorer", LIST, "orchestrator"), "explorer");
});

test("no agent / unknown catalog → unchanged (the portal does not guess)", () => {
  assert.equal(adminAgentFor(null, LIST, "orchestrator"), null);
  assert.equal(adminAgentFor("Sisyphus - ultraworker", [], "orchestrator"), "Sisyphus - ultraworker");
  assert.equal(adminAgentFor("Sisyphus - ultraworker", null, "orchestrator"), "Sisyphus - ultraworker");
});

test("default: the configured one if it is a visible non-subagent, else the first primary", () => {
  assert.equal(adminDefaultAgent(LIST, "orchestrator"), "orchestrator");
  assert.equal(adminDefaultAgent(LIST, "Sisyphus - ultraworker"), "orchestrator");
  assert.equal(adminDefaultAgent(LIST, "explorer"), "orchestrator");
  assert.equal(adminDefaultAgent(LIST, "title"), "orchestrator");
  assert.equal(adminDefaultAgent(LIST, null), "orchestrator");
  assert.equal(adminDefaultAgent([], "orchestrator"), null);
  assert.equal(adminAgentFor("gone", [{ name: "explorer", mode: "subagent" }], null), "gone", "nothing to fall back to → unchanged");
});

test("a hidden agent counts as gone", () => {
  assert.equal(adminAgentFor("title", LIST, "orchestrator"), "orchestrator");
});
