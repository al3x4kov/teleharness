// FEAT-19.4 / TASK-19.8: single-writer repository adapter for definitions.
// No execution receipts here. Production distributed control plane uses its own DB.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { writeJsonAtomic } from "../json-store.js";
import { validateDefinition, validDraftShape } from "../../shared/temporal-definition.js";
import { uniqueSlug, slugify } from "./workspace.js";
// FEAT-19.16: the pipe folder name (<project>/pipelines/<slug>); old records get a stable derived one.
export const slugOf = record => record.slug ?? (slugify(record.draft?.name) + "-" + String(record.id).slice(0, 4));

export class DefinitionError extends Error {
  constructor(status,message,errors) {super(message);this.status=status;this.errors=errors;}
}
const clone = v => structuredClone(v);
import { sameDefinition } from "../../shared/temporal-definition.js"; // BUG-259
const validId = id => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);
function cleanDraft(draft) {
  let serialized;
  try {serialized=JSON.stringify(draft);} catch {throw new DefinitionError(400,"Некорректное определение");}
  if (!draft || typeof draft !== "object" || Array.isArray(draft) || !serialized || Buffer.byteLength(serialized)>128*1024) throw new DefinitionError(400,"Определение превышает допустимый размер");
  if (typeof draft.name !== "string" || !draft.name.trim() || draft.name.length>160 || typeof draft.directory !== "string" || !draft.directory || draft.directory.length>2048 || !Array.isArray(draft.steps) || draft.steps.length>64 || !Array.isArray(draft.inputs) || draft.inputs.length>32) throw new DefinitionError(400,"Некорректные поля определения");
  if (Object.keys(draft).some(k=>!["name","directory","inputs","steps"].includes(k))) throw new DefinitionError(400,"Неизвестные поля определения");
  const copy=JSON.parse(serialized);
  if (!validDraftShape(copy)) throw new DefinitionError(400,"Некорректная структура черновика");
  return copy;
}
export class DefinitionStore {
  constructor({file,write=writeJsonAtomic}) {this.file=file;this.write=write;}
  read() {
    try {
      const state=JSON.parse(readFileSync(this.file,"utf8"));
      if (state.schema!==1 || !Array.isArray(state.items) || state.items.some(item=>!item || !validId(item.id) || typeof item.owner!=="string" || !item.owner || !Number.isSafeInteger(item.revision) || item.revision<1 || !item.draft || !Array.isArray(item.versions) || item.versions.some(v=>!Number.isSafeInteger(v.version)||!v.definition)) || new Set(state.items.map(x=>x.id)).size!==state.items.length) throw new Error("schema");
      for(const item of state.items) {
        cleanDraft(item.draft);
        for(const [index,v] of item.versions.entries()) if(v.version!==index+1 || !validDraftShape(v.definition) || !validateDefinition(v.definition).valid) throw new Error("version schema");
      }
      return state;
    } catch(e) {
      if (e.code==="ENOENT") return {schema:1,items:[]};
      throw new DefinitionError(503,"Хранилище пайпов недоступно. Данные сохранены без изменений");
    }
  }
  commit(state) {if (!this.write(this.file,state)) throw new DefinitionError(503,"Не удалось сохранить пайп");}
  own(state,owner,id) {
    const record=validId(id) && state.items.find(x=>x.id===id && x.owner===owner);
    if (!record) throw new DefinitionError(404,"Пайп не найден");
    return record;
  }
  checkRevision(record,revision) {if (!Number.isSafeInteger(revision) || record.revision!==revision) throw new DefinitionError(409,"Пайп изменён в другом окне. Обновите данные перед сохранением");}
  list(owner) {return this.read().items.filter(x=>x.owner===owner).map(x=>({id:x.id,name:x.draft.name,directory:x.draft.directory,folder:"pipelines/"+slugOf(x),revision:x.revision,latestVersion:x.versions.at(-1)?.version??null,updatedAt:x.updatedAt}));}
  get(owner,id) {return clone(this.own(this.read(),owner,id));}
  create(owner,draft) {
    if (typeof owner!=="string" || !owner) throw new DefinitionError(403,"Требуется авторизация");
    const state=this.read();
    if (state.items.filter(x=>x.owner===owner).length>=200) throw new DefinitionError(400,"Достигнут лимит 200 пайпов");
    const now=new Date().toISOString();
    const clean=cleanDraft(draft);
    const taken=new Set(state.items.filter(x=>x.owner===owner&&x.draft.directory===clean.directory).map(slugOf));
    const record={id:randomUUID(),owner,revision:1,draft:clean,slug:uniqueSlug(clean.name,taken),versions:[],createdAt:now,updatedAt:now};
    state.items.push(record);this.commit(state);return clone(record);
  }
  save(owner,id,revision,draft) {
    const state=this.read(),record=this.own(state,owner,id);this.checkRevision(record,revision);
    record.draft=cleanDraft(draft);record.revision++;record.updatedAt=new Date().toISOString();this.commit(state);return clone(record);
  }
  publish(owner,id,revision) {
    const state=this.read(),record=this.own(state,owner,id);this.checkRevision(record,revision);
    const validation=validateDefinition(record.draft);
    if (!validation.valid) throw new DefinitionError(400,"Проверьте схему пайпа",validation.errors);
    const last=record.versions.at(-1);
    if (last && sameDefinition(last.definition,record.draft)) throw Object.assign(new DefinitionError(409,`Изменений нет — версия ${last.version} уже актуальна`),{unchanged:last.version});
    record.versions.push({version:record.versions.length+1,definition:clone(record.draft),publishedAt:new Date().toISOString()});
    record.revision++;record.updatedAt=new Date().toISOString();this.commit(state);return clone(record);
  }
}
