// FEAT-20.4. Администратор входит в отдельный профиль, без ключей окружения портала.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

import { agents, agentEntry } from "./acp-registry.js";
import { groupSpawnOpts } from "./proc.js";

// FEAT-20.4. Профиль входа ключуется владельцем и агентом; маркер .portal-ready
// переживает рестарт портала — каталог моделей не должен зависеть от памяти процесса.
export function acpProfileDir(dataDir, owner, id) {
  return path.join(dataDir, "acp-auth", createHash("sha256").update(owner).digest("hex"), id);
}

export function acpProfileReady(dataDir, owner, id) {
  return existsSync(path.join(acpProfileDir(dataDir, owner, id), ".portal-ready"));
}

// ready — маркер ставится, rejected — снимается (креды отклонены), остальные
// статусы попытки состояние входа не меняют.
export function markAcpProfile(dataDir, owner, id, status) {
  const marker = path.join(acpProfileDir(dataDir, owner, id), ".portal-ready");
  if (status === "rejected") rmSync(path.join(path.dirname(marker), "models-v1.json"), {force:true});
  if (status === "ready") {
    mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    writeFileSync(marker, "1");
  } else if (status === "rejected") {
    rmSync(marker, { force: true });
  }
}

function launchLogin(dataDir, owner, id, args, directory = null, extraEnv = null) {
  const profile = acpProfileDir(dataDir, owner, id);
  mkdirSync(profile, {recursive:true, mode:0o700});
  const cli = agentEntry(dataDir, id);
  // FEAT-20.4. Бинарный агент (antigravity) — самодостаточный исполняемый файл,
  // запускается напрямую; npm-агенты по-прежнему идут через node.
  const env = { HOME:profile, USERPROFILE:profile, XDG_CONFIG_HOME:path.join(profile,"config"),
    PATH:path.dirname(process.execPath), NO_BROWSER:"true", ...extraEnv };
  const binary = agents.get(id)?.kind === "binary";
  const opts = groupSpawnOpts({ cwd: directory ?? profile, stdio: "pipe", windowsHide: true, env });
  return binary ? spawn(cli, args, opts) : spawn(process.execPath, [cli, ...args], opts);
}

export const launchGeminiLogin = (dir, owner) => launchLogin(dir, owner, "gemini", ["--acp"]);
export const launchCopilotLogin = (dir, owner) => launchLogin(dir, owner, "github-copilot-cli", ["login", "--device-code"]);
// FEAT-20.4. Antigravity говорит по ACP без флагов; ключ Gemini API запасного
// входа передаётся через env GEMINI_API_KEY и нигде не логируется.
export const launchAgyLogin = (dir, owner, extraEnv = null) => launchLogin(dir, owner, "antigravity", [], null, extraEnv);

export const launchAcpChat = (dir, owner, id, cwd) =>
  launchLogin(dir, owner, id, agents.get(id)?.kind === "binary" ? [] : ["--acp"], cwd,
    process.platform === "linux"
      ? { PATH: [path.dirname(process.execPath), "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"].join(path.delimiter) }
      : null);
