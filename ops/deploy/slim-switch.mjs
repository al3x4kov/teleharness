#!/usr/bin/env node
// FEAT-16.2 (EPIC-16, 2026-11-07): переключение конфигурации opencode между OmO
// (oh-my-openagent@ / oh-my-opencode@) и oh-my-opencode-slim.
//
// CLI:
//   node ops/deploy/slim-switch.mjs <apply|rollback|status> --config-dir=<папка конфига opencode>
//        --omo-file=<путь к omo.jsonc> --rollback-dir=<папка бандла отката> [--ops-dir=<папка ops/opencode>]
//
// apply    — бэкап текущего opencode.json и omo-файла в бандл (создаётся один раз,
//            повторный apply исходный OmO-бэкап не уничтожает); замена OmO-плагина
//            на slim и default_agent из ops/opencode/opencode.json (остальное
//            содержимое конфига — instructions, provider, agent, mcp, permission —
//            сохраняется как есть); копия oh-my-opencode-slim.json; удаление omo-файла.
// rollback — восстановление opencode.json и omo-файла из бандла байт в байт;
//            slim-json удаляется, только если его до apply не было.
// status   — что стоит сейчас (slim | omo | none) и что где лежит.
//
// Скрипт ничего не знает о стенде и проде: все пути задаёт вызывающий (задача S4U,
// tasks.md 3.6/4.1). Гарантия: сначала читаем и проверяем всё, потом пишем —
// ошибка не оставляет частичных изменений.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// --ops-dir по умолчанию: ../opencode относительно самого скрипта (ops/opencode).
const DEFAULT_OPS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "opencode");

const OMO_PREFIXES = ["oh-my-openagent@", "oh-my-opencode@"];
const SLIM_PREFIX = "oh-my-opencode-slim@";
// slim начинается с "oh-my-opencode-", а не "oh-my-opencode@", поэтому в OMO_PREFIXES не попадает.
const isOmoPlugin = (el) => typeof el === "string" && OMO_PREFIXES.some((p) => el.startsWith(p));
const isSlimPlugin = (el) => typeof el === "string" && el.startsWith(SLIM_PREFIX);

function readJsonIfExists(file) {
  if (!existsSync(file)) return { exists: false };
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { exists: true, error: `${file}: broken JSON (${err.message})` };
  }
  return { exists: true, data };
}

export function apply(opts = {}) {
  const configDir = opts.configDir;
  const rollbackDir = opts.rollbackDir;
  const opsDir = opts.opsDir || DEFAULT_OPS_DIR;
  const omoFile = opts.omoFile || null;
  if (!configDir) return { ok: false, error: "missing --config-dir" };
  if (!rollbackDir) return { ok: false, error: "missing --rollback-dir" };

  const configFile = path.join(configDir, "opencode.json");
  const configSlimJson = path.join(configDir, "oh-my-opencode-slim.json");
  const bundleConfig = path.join(rollbackDir, "opencode.json");
  const bundleOmo = path.join(rollbackDir, "omo.jsonc");
  const manifestFile = path.join(rollbackDir, "manifest.json");

  // --- фаза чтения: проверить всё до первой записи ---
  if (!existsSync(configFile)) return { ok: false, error: `no ${configFile}` };
  const cfg = readJsonIfExists(configFile);
  if (cfg.error) return { ok: false, error: cfg.error };
  if (!cfg.data || typeof cfg.data !== "object" || Array.isArray(cfg.data)) {
    return { ok: false, error: `${configFile}: not a JSON object` };
  }
  if (cfg.data.plugin !== undefined && !Array.isArray(cfg.data.plugin)) {
    return { ok: false, error: `${configFile}: "plugin" is not an array` };
  }
  const cfgBytes = readFileSync(configFile);

  const opsConfigFile = path.join(opsDir, "opencode.json");
  const ops = readJsonIfExists(opsConfigFile);
  if (!ops.exists) return { ok: false, error: `no ${opsConfigFile}` };
  if (ops.error) return { ok: false, error: ops.error };
  const slimPlugin = (Array.isArray(ops.data.plugin) ? ops.data.plugin : []).find(isSlimPlugin);
  if (!slimPlugin) return { ok: false, error: `${opsConfigFile}: no ${SLIM_PREFIX}* plugin` };
  const defaultAgent = ops.data.default_agent;
  if (typeof defaultAgent !== "string" || defaultAgent === "") {
    return { ok: false, error: `${opsConfigFile}: no default_agent` };
  }
  const opsSlimJson = path.join(opsDir, "oh-my-opencode-slim.json");
  if (!existsSync(opsSlimJson)) return { ok: false, error: `no ${opsSlimJson}` };
  const slimJsonBytes = readFileSync(opsSlimJson);

  const hadOmo = !!(omoFile && existsSync(omoFile));
  const omoBytes = hadOmo ? readFileSync(omoFile) : null;
  const hadSlimJson = existsSync(configSlimJson);

  // --- фаза записи ---
  // Бандл отката создаётся один раз: повторный apply не должен уничтожить
  // исходный OmO-бэкап.
  if (!existsSync(bundleConfig)) {
    mkdirSync(rollbackDir, { recursive: true });
    writeFileSync(bundleConfig, cfgBytes);
    if (hadOmo) writeFileSync(bundleOmo, omoBytes);
    const manifest = { created: new Date().toISOString(), configDir, omoFile, hadOmo, hadSlimJson };
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  }

  // Плагин: OmO-элемент заменяется на slim на своём месте, остальные
  // (./vault-cache.ts и т.п.) сохраняют порядок; если OmO-элемента не было —
  // slim вставляется первым (уже стоящий slim не дублируется).
  const plugin = Array.isArray(cfg.data.plugin) ? [...cfg.data.plugin] : [];
  const omoIdx = plugin.findIndex(isOmoPlugin);
  if (omoIdx >= 0) plugin[omoIdx] = slimPlugin;
  else if (!plugin.some(isSlimPlugin)) plugin.unshift(slimPlugin);
  cfg.data.plugin = plugin;
  cfg.data.default_agent = defaultAgent;
  writeFileSync(configFile, JSON.stringify(cfg.data, null, 2) + "\n");

  writeFileSync(configSlimJson, slimJsonBytes);
  if (hadOmo) rmSync(omoFile);

  return { ok: true, action: "apply", plugin, default_agent: defaultAgent };
}

export function rollback(opts = {}) {
  const configDir = opts.configDir;
  const rollbackDir = opts.rollbackDir;
  if (!configDir) return { ok: false, error: "missing --config-dir" };
  if (!rollbackDir) return { ok: false, error: "missing --rollback-dir" };

  const bundleConfig = path.join(rollbackDir, "opencode.json");
  const configSlimJson = path.join(configDir, "oh-my-opencode-slim.json");

  // --- фаза чтения ---
  if (!existsSync(bundleConfig)) return { ok: false, error: "no rollback bundle" };
  const bundleBytes = readFileSync(bundleConfig);
  const manifest = readJsonIfExists(path.join(rollbackDir, "manifest.json"));
  if (!manifest.exists || manifest.error) return { ok: false, error: "no/broken rollback manifest" };
  const { omoFile, hadOmo, hadSlimJson } = manifest.data || {};
  let omoBytes = null;
  if (hadOmo) {
    if (!omoFile) return { ok: false, error: "manifest.hadOmo is true but manifest.omoFile is empty" };
    const bundleOmo = path.join(rollbackDir, "omo.jsonc");
    if (!existsSync(bundleOmo)) return { ok: false, error: `no ${bundleOmo}` };
    omoBytes = readFileSync(bundleOmo);
  }

  // --- фаза записи ---
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "opencode.json"), bundleBytes); // байт в байт
  if (hadOmo) {
    mkdirSync(path.dirname(omoFile), { recursive: true });
    writeFileSync(omoFile, omoBytes);
  }
  // slim-json убираем, только если до apply его в конфиге не было (manifest.hadSlimJson).
  if (!hadSlimJson && existsSync(configSlimJson)) rmSync(configSlimJson);

  return { ok: true, action: "rollback" };
}

export function status(opts = {}) {
  const configDir = opts.configDir;
  const rollbackDir = opts.rollbackDir;
  const omoFile = opts.omoFile || null;
  const configFile = path.join(configDir, "opencode.json");

  let framework = "none";
  let plugin = [];
  let default_agent = null;
  if (existsSync(configFile)) {
    const cfg = readJsonIfExists(configFile);
    if (cfg.error) return { ok: false, error: cfg.error };
    const data = cfg.data && typeof cfg.data === "object" && !Array.isArray(cfg.data) ? cfg.data : {};
    plugin = Array.isArray(data.plugin) ? data.plugin : [];
    default_agent = typeof data.default_agent === "string" ? data.default_agent : null;
    if (plugin.some(isSlimPlugin)) framework = "slim";
    else if (plugin.some(isOmoPlugin)) framework = "omo";
  }

  return {
    framework,
    plugin,
    default_agent,
    slimJson: configDir ? existsSync(path.join(configDir, "oh-my-opencode-slim.json")) : false,
    omoFile: !!(omoFile && existsSync(omoFile)),
    bundle: !!(rollbackDir && existsSync(path.join(rollbackDir, "opencode.json"))),
  };
}

const USAGE =
  "usage: node ops/deploy/slim-switch.mjs <apply|rollback|status> --config-dir=<dir> " +
  "--omo-file=<file> --rollback-dir=<dir> [--ops-dir=<dir>]";

function parseCli(argv) {
  let command = null;
  const opts = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      if (command !== null) return { error: `${USAGE} (unexpected argument: ${arg})` };
      command = arg;
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq < 0) return { error: `${USAGE} (expected --key=value, got: ${arg})` };
    const key = arg.slice(2, eq);
    if (!["config-dir", "omo-file", "rollback-dir", "ops-dir"].includes(key)) {
      return { error: `${USAGE} (unknown option: ${arg})` };
    }
    opts[key] = arg.slice(eq + 1);
  }
  return { command, opts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { command, opts, error } = parseCli(process.argv.slice(2));
  const fnOpts = {
    configDir: opts["config-dir"],
    omoFile: opts["omo-file"],
    rollbackDir: opts["rollback-dir"],
    opsDir: opts["ops-dir"],
  };
  let result;
  if (error) result = { ok: false, error };
  else if (command === "apply") result = apply(fnOpts);
  else if (command === "rollback") result = rollback(fnOpts);
  else if (command === "status") result = status(fnOpts);
  else result = { ok: false, error: `${USAGE} (got: ${command === null ? "no command" : command})` };
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok === false ? 1 : 0);
}
