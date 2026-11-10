// FEAT-16.2 (EPIC-16, 2026-11-07): тесты slim-switch.mjs — переключение конфига
// opencode между OmO и oh-my-opencode-slim. Всё на временных папках (mkdtemp),
// ops-dir — настоящая папка ops/opencode проекта (только чтение).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply, rollback, status } from "../ops/deploy/slim-switch.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "ops", "deploy", "slim-switch.mjs");
const OPS_DIR = path.join(ROOT, "ops", "opencode");

function makeEnv(t, { withSlimJson = false, plugin } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "slim-switch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, "config");
  mkdirSync(configDir, { recursive: true });
  const rollbackDir = path.join(dir, "rollback");
  const omoFile = path.join(dir, "omo-store", "omo.jsonc");
  mkdirSync(path.dirname(omoFile), { recursive: true });

  // OmO-конфиг с «своими» полями стенда: apply трогает только plugin/default_agent.
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    model: "zai-coding-plan/glm-5.3",
    default_agent: "sisyphus",
    instructions: ["D:\\Obsidian\\agents\\_index.md"],
    plugin: plugin ?? ["oh-my-openagent@1.2.3", "./vault-cache.ts"],
    provider: { "zai-coding-plan": { baseURL: "https://api.z.ai/api/coding-plan", options: { timeout: 600000 } } },
    agent: { Sandbox: { mode: "primary", prompt: "{file:./prompts/sandbox.md}" } },
    permission: { edit: "allow", bash: { "*": "allow", "rm -rf *": "ask" } },
  };
  const cfgText = JSON.stringify(cfg, null, 2) + "\n";
  writeFileSync(path.join(configDir, "opencode.json"), cfgText, "utf8");
  const omoText = "// OMO profile (fixture)\n{\n  \"agents\": { \"sisyphus\": {} }\n}\n";
  writeFileSync(omoFile, omoText, "utf8");
  if (withSlimJson) writeFileSync(path.join(configDir, "oh-my-opencode-slim.json"), "{\n  \"preExisting\": true\n}\n", "utf8");

  return { dir, configDir, rollbackDir, omoFile, cfgText, omoText };
}

const optsOf = (env) => ({ configDir: env.configDir, omoFile: env.omoFile, rollbackDir: env.rollbackDir, opsDir: OPS_DIR });

test("apply on an OmO config swaps the plugin, keeps the rest, backs up originals", (t) => {
  const env = makeEnv(t);
  const res = apply(optsOf(env));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.action, "apply");
  assert.deepEqual(res.plugin, ["oh-my-opencode-slim@3.0.7", "./vault-cache.ts"]);
  assert.equal(res.default_agent, "orchestrator");

  const cfg = JSON.parse(readFileSync(path.join(env.configDir, "opencode.json"), "utf8"));
  assert.deepEqual(cfg.plugin, ["oh-my-opencode-slim@3.0.7", "./vault-cache.ts"]);
  assert.equal(cfg.default_agent, "orchestrator");
  // свои поля стенда/прода не тронуты
  assert.deepEqual(cfg.instructions, ["D:\\Obsidian\\agents\\_index.md"]);
  assert.equal(cfg.provider["zai-coding-plan"].baseURL, "https://api.z.ai/api/coding-plan");
  assert.deepEqual(cfg.agent.Sandbox, { mode: "primary", prompt: "{file:./prompts/sandbox.md}" });
  assert.deepEqual(cfg.permission, { edit: "allow", bash: { "*": "allow", "rm -rf *": "ask" } });
  // slim-json скопирован из ops, omo-файл удалён
  assert.equal(
    readFileSync(path.join(env.configDir, "oh-my-opencode-slim.json"), "utf8"),
    readFileSync(path.join(OPS_DIR, "oh-my-opencode-slim.json"), "utf8"),
  );
  assert.equal(existsSync(env.omoFile), false);
  // бандл хранит исходные байты opencode.json и omo-файла
  assert.equal(readFileSync(path.join(env.rollbackDir, "opencode.json"), "utf8"), env.cfgText);
  assert.equal(readFileSync(path.join(env.rollbackDir, "omo.jsonc"), "utf8"), env.omoText);
  const manifest = JSON.parse(readFileSync(path.join(env.rollbackDir, "manifest.json"), "utf8"));
  assert.equal(manifest.hadOmo, true);
  assert.equal(manifest.hadSlimJson, false);
  assert.equal(manifest.configDir, env.configDir);
  assert.equal(manifest.omoFile, env.omoFile);
  assert.match(manifest.created, /^\d{4}-\d{2}-\d{2}T/);
});

test("a repeated apply keeps the original OmO backup in the bundle", (t) => {
  const env = makeEnv(t);
  apply(optsOf(env));
  const bundleBefore = readFileSync(path.join(env.rollbackDir, "opencode.json"));
  const manifestBefore = readFileSync(path.join(env.rollbackDir, "manifest.json"), "utf8");

  const res = apply(optsOf(env));
  assert.equal(res.ok, true);
  assert.ok(bundleBefore.equals(readFileSync(path.join(env.rollbackDir, "opencode.json"))), "bundle bytes changed");
  assert.equal(readFileSync(path.join(env.rollbackDir, "manifest.json"), "utf8"), manifestBefore);
  // slim не задублировался
  const cfg = JSON.parse(readFileSync(path.join(env.configDir, "opencode.json"), "utf8"));
  assert.deepEqual(cfg.plugin, ["oh-my-opencode-slim@3.0.7", "./vault-cache.ts"]);
});

test("rollback restores opencode.json and the omo file byte for byte, removes slim json", (t) => {
  const env = makeEnv(t);
  apply(optsOf(env));

  const res = rollback(optsOf(env));
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.action, "rollback");
  assert.equal(readFileSync(path.join(env.configDir, "opencode.json"), "utf8"), env.cfgText);
  assert.equal(readFileSync(env.omoFile, "utf8"), env.omoText);
  assert.equal(existsSync(path.join(env.configDir, "oh-my-opencode-slim.json")), false);
});

test("rollback without a bundle reports ok:false and touches nothing", (t) => {
  const env = makeEnv(t);
  const res = rollback(optsOf(env));
  assert.equal(res.ok, false);
  assert.equal(res.error, "no rollback bundle");
  assert.equal(readFileSync(path.join(env.configDir, "opencode.json"), "utf8"), env.cfgText);
  assert.equal(existsSync(env.omoFile), true);
  assert.equal(existsSync(env.rollbackDir), false);
});

test("a broken opencode.json fails apply without writing anything", (t) => {
  const env = makeEnv(t);
  writeFileSync(path.join(env.configDir, "opencode.json"), "{ broken", "utf8");

  const res = apply(optsOf(env));
  assert.equal(res.ok, false);
  assert.match(res.error, /broken JSON/);
  assert.equal(existsSync(env.rollbackDir), false, "no bundle must be created");
  assert.equal(readFileSync(path.join(env.configDir, "opencode.json"), "utf8"), "{ broken");
  assert.equal(existsSync(path.join(env.configDir, "oh-my-opencode-slim.json")), false);
  assert.equal(existsSync(env.omoFile), true);
});

test("status tracks apply and rollback", (t) => {
  const env = makeEnv(t);
  const before = status(optsOf(env));
  assert.deepEqual(before, {
    framework: "omo",
    plugin: ["oh-my-openagent@1.2.3", "./vault-cache.ts"],
    default_agent: "sisyphus",
    slimJson: false,
    omoFile: true,
    bundle: false,
  });

  apply(optsOf(env));
  const afterApply = status(optsOf(env));
  assert.equal(afterApply.framework, "slim");
  assert.deepEqual(afterApply.plugin, ["oh-my-opencode-slim@3.0.7", "./vault-cache.ts"]);
  assert.equal(afterApply.default_agent, "orchestrator");
  assert.equal(afterApply.slimJson, true);
  assert.equal(afterApply.omoFile, false);
  assert.equal(afterApply.bundle, true);

  rollback(optsOf(env));
  const afterRollback = status(optsOf(env));
  assert.equal(afterRollback.framework, "omo");
  assert.equal(afterRollback.slimJson, false);
  assert.equal(afterRollback.omoFile, true);
  assert.equal(afterRollback.bundle, true);
});

test("CLI: status prints a JSON result to stdout", (t) => {
  const env = makeEnv(t);
  const out = execFileSync(
    process.execPath,
    [SCRIPT, "status", `--config-dir=${env.configDir}`, `--omo-file=${env.omoFile}`, `--rollback-dir=${env.rollbackDir}`],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.framework, "omo");
  assert.equal(parsed.bundle, false);
  assert.equal(parsed.default_agent, "sisyphus");
});

test("apply inserts slim first when the config has no OmO plugin", (t) => {
  const env = makeEnv(t, { plugin: ["./vault-cache.ts"] });
  const res = apply(optsOf(env));
  assert.equal(res.ok, true);
  assert.deepEqual(res.plugin, ["oh-my-opencode-slim@3.0.7", "./vault-cache.ts"]);
  // omo-файл в фикстуре есть, поэтому он всё равно попадает в бандл
  const manifest = JSON.parse(readFileSync(path.join(env.rollbackDir, "manifest.json"), "utf8"));
  assert.equal(manifest.hadOmo, true);
  assert.equal(existsSync(path.join(env.rollbackDir, "omo.jsonc")), true);
});

test("rollback keeps a slim json that existed before apply (hadSlimJson)", (t) => {
  const env = makeEnv(t, { withSlimJson: true });
  apply(optsOf(env));
  const res = rollback(optsOf(env));
  assert.equal(res.ok, true);
  assert.equal(existsSync(path.join(env.configDir, "oh-my-opencode-slim.json")), true);
});
