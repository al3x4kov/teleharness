// FEAT-18.7: каталог моделей Codex для раннера (ClaudeRunner.setCodexCatalog).
//
// Codex предлагается, только когда codex CLI установлен и в нём выполнен вход
// (подписка ChatGPT владельца). Узнаёт это посредник: `node lib/codex-shim.mjs
// --teleharness-catalog` поднимает `codex app-server`, спрашивает вход и model/list и
// печатает одну строку JSON {ok, loggedIn, plan, models} (или {ok:false, error}).
//
// Старт портала не ждёт Codex: сначала читается кэш data/codex-models.json
// (прошлый удачный ответ), затем в фоне — свежий ответ посредника, и раз в
// сутки снова. Правила:
//   - ok и loggedIn → каталог обновлён, кэш перезаписан;
//   - ok и не вошёл → Codex выключен, кэш удалён (вход потерян — не предлагать);
//   - ошибка (нет бинаря, таймаут, сбой app-server) → остаётся то, что было:
//     разовый сбой не выключает работающий движок; без кэша Codex и так выключен;
//   - TELEHARNESS_CODEX=off → Codex выключен всегда, посредник не запускается.
// Ноль зависимостей — только stdlib.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCodexCatalog } from "../shared/engine.js";
import { writeJsonAtomic } from "./json-store.js";

const DEFAULT_SHIM = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-shim.mjs");
const DAY_MS = 24 * 60 * 60 * 1000;

// Чистая: строка вывода посредника → {state: "on"|"off"|"error", models, plan, error}.
export function parseCatalogLine(text) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  let j = null;
  try {
    j = JSON.parse(line ?? "");
  } catch {
    return { state: "error", models: null, plan: null, error: "ответ посредника не JSON" };
  }
  if (!j || j.ok !== true) return { state: "error", models: null, plan: null, error: typeof j?.error === "string" ? j.error.slice(0, 200) : "посредник сообщил об ошибке" };
  if (j.loggedIn !== true) return { state: "off", models: [], plan: null, error: null };
  const models = normalizeCodexCatalog(j.models);
  if (!models) return { state: "off", models: [], plan: null, error: null };
  return { state: "on", models, plan: typeof j.plan === "string" ? j.plan : null, error: null };
}

export function createCodexCatalog({
  dataDir,
  shimPath = process.env.TELEHARNESS_CODEX_SHIM || DEFAULT_SHIM,
  env = process.env,
  onChange = () => {},
  log = (m) => console.log(m),
  spawnImpl = spawn,
  timeoutMs = 30_000,
  refreshMs = DAY_MS,
} = {}) {
  const cacheFile = dataDir ? path.join(dataDir, "codex-models.json") : null;
  const disabled = String(env.TELEHARNESS_CODEX ?? "").toLowerCase() === "off";
  let models = [];
  let plan = null;
  let timer = null;
  let running = null;

  const set = (list, why) => {
    const before = JSON.stringify(models);
    models = Array.isArray(list) ? list : [];
    if (JSON.stringify(models) !== before) {
      log(`[teleharness-codex] каталог: ${models.length ? models.map((m) => m.id).join(", ") : "Codex выключен"} (${why})`);
      try {
        onChange(models.slice());
      } catch (err) {
        log(`[teleharness-codex] onChange: ${err?.message ?? err}`);
      }
    }
  };

  function load() {
    if (disabled || !cacheFile || !existsSync(cacheFile)) return set([], disabled ? "TELEHARNESS_CODEX=off" : "кэша нет");
    try {
      const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
      plan = typeof raw?.plan === "string" ? raw.plan : null;
      set(normalizeCodexCatalog(raw?.models) ?? [], "кэш");
    } catch (err) {
      log(`[teleharness-codex] кэш не читается: ${err?.message ?? err}`);
      set([], "кэш испорчен");
    }
  }

  function runShim() {
    return new Promise((resolve) => {
      let out = "";
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve(v);
      };
      let child;
      try {
        child = spawnImpl(process.execPath, [shimPath, "--teleharness-catalog"], { env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      } catch (err) {
        return finish({ state: "error", models: null, plan: null, error: String(err?.message ?? err) });
      }
      const t = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish({ state: "error", models: null, plan: null, error: "таймаут посредника" });
      }, timeoutMs);
      child.stdout?.on("data", (d) => (out += d));
      child.on("error", (err) => finish({ state: "error", models: null, plan: null, error: String(err?.message ?? err) }));
      child.on("close", () => finish(parseCatalogLine(out)));
    });
  }

  async function refresh() {
    if (disabled) return { state: "off" };
    if (running) return running;
    running = (async () => {
      const r = await runShim();
      if (r.state === "on") {
        plan = r.plan;
        if (cacheFile) {
          try {
            writeJsonAtomic(cacheFile, { at: new Date().toISOString(), plan, models: r.models.map((m) => ({ id: m.id, displayName: m.name, isDefault: m.isDefault, context: m.context })) });
          } catch (err) {
            log(`[teleharness-codex] кэш не записан: ${err?.message ?? err}`);
          }
        }
        set(r.models, "codex app-server");
      } else if (r.state === "off") {
        if (cacheFile) rmSync(cacheFile, { force: true });
        set([], "в codex не выполнен вход");
      } else {
        log(`[teleharness-codex] каталог не обновлён: ${r.error}`);
      }
      return r;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function start() {
    load();
    if (disabled) return;
    void refresh();
    timer = setInterval(() => void refresh(), refreshMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { load, refresh, start, stop, models: () => models.slice(), plan: () => plan };
}
