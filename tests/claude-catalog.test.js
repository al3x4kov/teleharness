// FEAT-11.17: Claude model catalog matches what claude CLI reports for the
// subscription (probe 2026-11-10, claude CLI 2.1.322, modelUsage.contextWindow
// of `claude -p --output-format json`, 12/12 "Reply OK").
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, normalizeCatalog } from "../shared/engine.js";

const CLI_CONTEXT = {
  "claude-fable-5-2": 1_000_000,
  "claude-fable-5-1": 1_000_000,
  "claude-fable-5": 1_000_000,
  "claude-opus-5-5": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-haiku-5-5": 1_000_000,
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-haiku-4-5": 200_000,
};

test("catalog has Claude Fable 5.2 (FEAT-11.17)", () => {
  const m = CLAUDE_MODELS.find((x) => x.id === "claude-fable-5-2");
  assert.ok(m, "claude-fable-5-2 is in the catalog");
  assert.equal(m.name, "Claude Fable 5.2");
});

test("default claude model stays Opus 5.5 (owner 2026-11-10)", () => {
  assert.equal(DEFAULT_CLAUDE_MODEL, "claude-opus-5-5");
});

test("catalog is exactly the CLI-probed set, context = CLI contextWindow", () => {
  assert.deepEqual(CLAUDE_MODELS.map((m) => m.id).sort(), Object.keys(CLI_CONTEXT).sort());
  for (const m of CLAUDE_MODELS) assert.equal(m.context, CLI_CONTEXT[m.id], `context of ${m.id}`);
});

test("built-in catalog survives normalization unchanged", () => {
  assert.deepEqual(normalizeCatalog(CLAUDE_MODELS), CLAUDE_MODELS.map((m) => ({ ...m })));
});
