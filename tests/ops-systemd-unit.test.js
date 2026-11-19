// The sample systemd unit (ops/linux/teleharness.service): an agent turn that runs out of memory must
// not stop the portal — OOMPolicy=continue — and the memory limit leaves room for concurrent turns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const unit = readFileSync(new URL("../ops/linux/teleharness.service", import.meta.url), "utf8");
const directives = Object.fromEntries(
  unit
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && /^[A-Za-z]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

test("OOMPolicy=continue: the kernel kills only the process that ran out of memory", () => {
  assert.equal(directives.OOMPolicy, "continue");
  assert.equal(directives.Restart, "on-failure", "a killed portal comes back");
});

test("MemoryMax leaves room for the portal and concurrent agent turns (≥ 4G)", () => {
  const m = /^(\d+)G$/.exec(directives.MemoryMax ?? "");
  assert.ok(m && Number(m[1]) >= 4, `MemoryMax=${directives.MemoryMax}`);
});

test("the unit starts server.js from its working directory", () => {
  assert.match(directives.ExecStart, /node server\.js$/);
  assert.ok(directives.WorkingDirectory);
});
