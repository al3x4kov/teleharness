// FEAT-20.4
import path from "node:path";
import { readJsonStore, writeJsonAtomic } from "./json-store.js";

const registryUrl = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
// FEAT-20.4. Версия схемы кэша: смена логики каталога (id, installable) должна
// сбрасывать кэш, а не жить в нём до истечения суток.
const CACHE_VERSION = 3;
// FEAT-20.4. Google отклонил OAuth-клиент Gemini CLI — наружу вместо него
// выставлен бинарный ACP-сервер Google Antigravity. Запись gemini остаётся
// для внутренних тестов и фикстур, но в каталог провайдеров больше не попадает.
export const agents = new Map([
  ["antigravity", {kind:"binary", registryId:"antigravity-acp", version:"1.5.2", entry:"agy_acp_server.par",
    archive:"https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.5.2-linux-x86_64.zip",
    sha256:"99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852"}],
  ["gemini", {name:"@google/gemini-cli", version:"0.70.0", entry:"bundle/gemini.js", deprecated:true}],
  ["github-copilot-cli", {name:"@github/copilot", version:"1.0.114", entry:"npm-loader.js"}]
]);

export function agentDirectory(dataDir, id) {
  const pkg = agents.get(id);
  if (!pkg) throw new Error("Неизвестный агент");
  return path.join(dataDir,"acp-agents",id,pkg.version);
}

export function agentEntry(dataDir, id) {
  const pkg = agents.get(id);
  // FEAT-20.4. Бинарная поставка распаковывается прямо в папку версии, без node_modules.
  return pkg.kind === "binary"
    ? path.join(agentDirectory(dataDir,id), pkg.entry)
    : path.join(agentDirectory(dataDir,id),"node_modules",pkg.name,pkg.entry);
}

export class AcpRegistry {
  constructor(dataDir, request = fetch) {
    this.file = path.join(dataDir,"acp-registry-cache.json");
    this.request = request;
    this.cache = readJsonStore(this.file, {fallback:() => null, validate:value => value?.version === CACHE_VERSION && Array.isArray(value?.agents)});
  }

  async read(force = false) {
    if (!force && this.cache && Date.now()-this.cache.fetchedAt < 86400000) return this.cache;
    this.pending ??= this.refresh().finally(() => { this.pending = null; });
    return this.pending;
  }

  async refresh() {
    try {
      const headers = this.cache?.etag ? {"If-None-Match":this.cache.etag} : {};
      const res = await this.request(registryUrl,{headers, signal:AbortSignal.timeout(10000)});
      let next;
      if (res.status === 304 && this.cache) next = {...this.cache, fetchedAt:Date.now()};
      else {
        if (!res.ok) throw new Error("registry");
        const raw = await res.json();
        const list = [];
        for (const entry of raw.agents) {
          if (!entry?.distribution || typeof entry.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id) || typeof entry.version !== "string") continue;
          // FEAT-20.4. Реестровый id может отличаться от внутреннего ключа
          // (antigravity-acp → antigravity): сопоставляем и по registryId,
          // наружу отдаём внутренний, чтобы установка и статус били в один id.
          const match = [...agents.entries()].find(([key,v]) => key === entry.id || v.registryId === entry.id);
          const pkg = match?.[1];
          // FEAT-20.4. Для бинарных агентов поставка описана distribution.binary
          // по платформам, для npm — distribution.npx как раньше.
          const installable = Boolean(pkg && !pkg.deprecated && entry.version === pkg.version &&
            (pkg.kind === "binary"
              ? Boolean(entry.distribution.binary?.["linux-x86_64"])
              : entry.distribution.npx?.package === pkg.name+"@"+pkg.version));
          list.push({id: pkg ? match[0] : entry.id,name:entry.name,description:entry.description,license:entry.license,version:entry.version,installable});
        }
        next = {version:CACHE_VERSION, agents:list, fetchedAt:Date.now(), etag:res.headers.get("etag"), skipped:raw.agents.length-list.length};
      }
      writeJsonAtomic(this.file,next);
      this.cache=next;
      return next;
    } catch {
      return {...(this.cache ?? {agents:[],skipped:0}), error:"Не удалось обновить каталог ACP"};
    }
  }
}

// FEAT-20.4. Группы подписок добавляются только в ответ текущего администратора.
const agentNames = {antigravity:"Google Antigravity", gemini:"Gemini CLI", "github-copilot-cli":"GitHub Copilot CLI"};
export function acpProviderCatalog(base, ids, catalogs = {}) {
  const providers=ids.map(id=>{
    const key="acp-"+id;
    const name=agentNames[id] ?? id;
    const entries = catalogs[id]?.availableModels ?? [];
    const imageInput = typeof catalogs[id]?.promptCapabilities?.image === "boolean"
      ? catalogs[id].promptCapabilities.image
      : id === "antigravity";
    const models = Object.fromEntries((entries.length ? entries : [{modelId:key,name}]).map(m =>
      [m.modelId,{id:m.modelId,name:m.name || m.modelId,providerID:key,status:"active",capabilities:{input:{text:true,image:imageInput}}}]));
    return {id:key,name,models};
  });
  return {...base,all:[...(base.all??[]),...providers],connected:[...(base.connected??[]),...providers.map(p=>p.id)],
    default:{...base.default,...Object.fromEntries(providers.map(p=>[p.id,catalogs[p.id.slice(4)]?.currentModelId || Object.keys(p.models)[0]]))}};
}
