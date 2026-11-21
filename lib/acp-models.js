import path from "node:path";
import { launchAcpChat, acpProfileDir } from "./acp-login-launch.js";
import { runAcpChat } from "./acp-chat.js";
import { readJsonStore, writeJsonAtomic } from "./json-store.js";
import { killChildTree } from "./proc.js";

const pending = new Map();
const cachePath = (dir, owner, id) => path.join(acpProfileDir(dir, owner, id), "models-v1.json");
export function cachedAcpModels(dir, owner, id) {
  return readJsonStore(cachePath(dir, owner, id), { fallback: () => null,
    validate: value => Array.isArray(value?.availableModels) && typeof value?.promptCapabilities?.image === "boolean" });
}

export async function discoverAcpModels(dir, owner, id) {
  const cached = cachedAcpModels(dir, owner, id);
  if (cached && Date.now() - cached.updated < 3600000) return cached;
  const key = cachePath(dir, owner, id);
  if (!pending.has(key)) {
    const refresh = async () => {
      const cwd = acpProfileDir(dir, owner, id);
      const child = launchAcpChat(dir, owner, id, cwd);
      try {
        const models = await runAcpChat(child, { cwd, discoverModels: true });
        const availableModels = (models?.availableModels ?? []).filter(m => typeof m?.modelId === "string" && m.modelId);
        const value = { availableModels: availableModels.map(({modelId,name}) => ({modelId,name})),
          currentModelId: models?.currentModelId,
          promptCapabilities: { image: Boolean(models?.promptCapabilities?.image) },
          updated: Date.now() };
        writeJsonAtomic(key, value);
        return value;
      } catch { return cached; }
      finally { killChildTree(child); }
    };
    pending.set(key, refresh().finally(() => pending.delete(key)));
  }
  return cached ?? pending.get(key);
}
