// lib/host.js additions (Г5): SMART disk temperature parsing (BUG-03.5) and
// the opencode version for «О приложении» (BUG-01.41 п.4). Pure helpers and
// an injected fetch only — no PowerShell, no upstream.
// Run: node --test tests/g5-host.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { diskTempCelsius, opencodeVersion, parseHealthVersion } from "../lib/host.js";

test("diskTempCelsius: single object, array (hottest wins), junk and denied access", () => {
  assert.equal(diskTempCelsius({ Temperature: 46 }), 46);
  assert.equal(diskTempCelsius([{ Temperature: 38 }, { Temperature: 51 }, { Temperature: 0 }]), 51);
  assert.equal(diskTempCelsius([]), null); // Limited token: CIM access denied → empty
  assert.equal(diskTempCelsius(null), null);
  assert.equal(diskTempCelsius([{ Temperature: "abc" }, { Temperature: 300 }]), null);
});

test("parseHealthVersion: only a version-looking string", () => {
  assert.equal(parseHealthVersion({ healthy: true, version: "1.19.5" }), "1.19.5");
  assert.equal(parseHealthVersion({ version: " 1.20.0-beta.1 " }), "1.20.0-beta.1");
  assert.equal(parseHealthVersion({ version: "<script>" }), null);
  assert.equal(parseHealthVersion(null), null);
});

test("opencodeVersion: fetched once, cached, survives an upstream hiccup", async () => {
  let n = 0;
  const ok = async () => {
    n += 1;
    return { ok: true, json: async () => ({ healthy: true, version: "1.19.5" }) };
  };
  const t0 = 1_000_000;
  assert.equal(await opencodeVersion(ok, t0), "1.19.5");
  assert.equal(await opencodeVersion(ok, t0 + 1000), "1.19.5");
  assert.equal(n, 1, "cached within TTL");
  const down = async () => {
    throw new Error("ECONNREFUSED");
  };
  assert.equal(await opencodeVersion(down, t0 + 60 * 60_000), "1.19.5", "last known version kept");
});

test("BUG-143: версии harness — OmO из plugin конфигурации opencode, Claude Code из --version", async () => {
  const { parseOmoVersion, parseClaudeVersion } = await import("../lib/host.js");
  assert.equal(parseOmoVersion({ plugin: ["oh-my-openagent@5.1.60", "./vault-cache.ts"] }), "5.1.60");
  assert.equal(parseOmoVersion({ plugin: ["oh-my-opencode@3.2.0"] }), "3.2.0");
  assert.equal(parseOmoVersion({ plugin: ["oh-my-openagent"] }), null, "без пина версии — не выдумываем");
  assert.equal(parseOmoVersion(null), null);
  assert.equal(parseClaudeVersion("2.1.316 (Claude Code)\n"), "2.1.316");
  assert.equal(parseClaudeVersion("garbage"), null);
});

test("BUG-190: opencode 2.x — версия из адаптера (/api/info), а не из HTML /global/health", async () => {
  const host = await import("../lib/host.js");
  // v2 отдаёт на /global/health HTML веб-интерфейса — версии там нет
  const html = async () => ({ ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } });
  host.setOpencodeInfoSource(async () => ({ version: "2.2.6", pid: 1 }));
  try {
    assert.equal(await host.opencodeVersion(html, 9_000_000_000), "2.2.6");
  } finally {
    host.setOpencodeInfoSource(null);
  }
});

test("BUG-190: harness — slim из `plugins` (v2) и `plugin` (v1), OmO как раньше", async () => {
  const { parseHarness } = await import("../lib/host.js");
  assert.deepEqual(parseHarness({ plugins: ["oh-my-opencode-slim@3.0.7", "./plugin-v2"] }), { name: "slim", version: "3.0.7" });
  assert.deepEqual(parseHarness({ plugin: ["oh-my-opencode-slim@3.0.7"] }), { name: "slim", version: "3.0.7" });
  assert.deepEqual(parseHarness({ plugin: ["oh-my-openagent@5.1.60"] }), { name: "OmO", version: "5.1.60" });
  assert.deepEqual(parseHarness({ plugins: [{ package: "oh-my-opencode-slim@3.0.8" }] }), { name: "slim", version: "3.0.8" });
  assert.equal(parseHarness({ plugins: ["oh-my-opencode-slim"] }), null, "без пина версии — не выдумываем");
  assert.equal(parseHarness(null), null);
});
