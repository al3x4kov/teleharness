// Default configuration values are portable: the same layout on Windows, macOS and Linux —
// everything under the user's home, optional pieces under ~/.zai. The listen address is
// ZAI_LISTEN_HOST (loopback by default).
import { test } from "node:test";
import assert from "node:assert/strict";
import { platformDefaults, loadConfig } from "../lib/config.js";

test("platformDefaults(linux / darwin): POSIX paths under home, no drive letters", () => {
  for (const [platform, home] of [["linux", "/home/zai"], ["darwin", "/Users/zai"]]) {
    const d = platformDefaults(platform, home);
    assert.equal(d.home, home);
    assert.equal(d.tenantHome, `${home}/.zai-tenants`);
    assert.equal(d.tenantVault, `${home}/.zai/tenants-vault`);
    assert.deepEqual(d.fileRoots, [home]);
    assert.equal(d.kbRoot, "off", "the knowledge-base snapshot is opt-in");
    assert.equal(d.voicePython, `${home}/.zai/voice/venv/bin/python3`);
    assert.equal(d.voiceModels, `${home}/.zai/voice/models`);
    for (const v of Object.values(d).flat()) assert.ok(!/^[A-Za-z]:|\\/.test(v), `no Windows path: ${v}`);
  }
});

test("platformDefaults(win32): the same layout with Windows separators", () => {
  const d = platformDefaults("win32", "C:\\Users\\me");
  assert.equal(d.home, "C:\\Users\\me");
  assert.equal(d.tenantHome, "C:\\Users\\me\\.zai-tenants");
  assert.equal(d.tenantVault, "C:\\Users\\me\\.zai\\tenants-vault");
  assert.deepEqual(d.fileRoots, ["C:\\Users\\me"]);
  assert.equal(d.kbRoot, "off");
  assert.equal(d.voicePython, "C:\\Users\\me\\.zai\\voice\\venv\\Scripts\\python.exe");
  assert.equal(d.voiceModels, "C:\\Users\\me\\.zai\\voice\\models");
});

test("the schema defaults of this machine match platformDefaults()", () => {
  const { config } = loadConfig({});
  const d = platformDefaults();
  assert.equal(config.ZAI_HOME, d.home);
  assert.equal(config.ZAI_TENANT_HOME, d.tenantHome);
  assert.equal(config.ZAI_TENANT_VAULT, d.tenantVault);
  assert.deepEqual(config.ZAI_FILE_ROOTS, d.fileRoots);
  assert.equal(config.ZAI_KB_ROOT, d.kbRoot);
  assert.equal(config.ZAI_VOICE_PYTHON, d.voicePython);
  assert.equal(config.ZAI_VOICE_MODELS, d.voiceModels);
});

test("ZAI_LISTEN_HOST: 127.0.0.1 by default, 0.0.0.0 inside a container", () => {
  assert.equal(loadConfig({}).config.ZAI_LISTEN_HOST, "127.0.0.1");
  assert.equal(loadConfig({ ZAI_LISTEN_HOST: "0.0.0.0" }).config.ZAI_LISTEN_HOST, "0.0.0.0");
});
