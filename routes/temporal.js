// FEAT-19.4 / TASK-19.8: owner and current project/engine checks on the server.
import path from "node:path";
import { DefinitionError, slugOf } from "../lib/temporal/definitions.js";
import { workspaceOf, isPipelineFolder, pipeEngineAllowed } from "../lib/temporal/workspace.js";
import { cleanInputs } from "../lib/temporal/inputs.js";
import { listRunFiles } from "../lib/temporal/run-files.js";
import { validateDefinition, validDraftShape } from "../shared/temporal-definition.js";
import { summarizeRun, runSummaryCache } from "../lib/temporal/run-summary.js";

export function temporalRoutes(deps) {
  const base="/teleharness/api/temporal";
  const allowedEngine=()=>true; // FEAT-19.16: Codex in pipes for everyone (text-only for tenants)
  // FEAT-19.14: list summaries read Temporal through a cache (closed runs once).
  let summaries=null;
  const reader=()=>summaries??=deps.describeRun?runSummaryCache(id=>deps.describeRun(id)):null;
  const stepShape=definition=>(definition.steps??[]).map(s=>({id:s.id,name:s.name,type:s.type,...(s.type==="model"?{engine:s.engine,model:s.model}:{}),...(s.type==="artifact"?{filename:s.filename,source:s.source}:{}),...(s.type==="condition"?{check:s.check}:{})}));
  const source=id=>/^teleharness-scheduled?-/.test(String(id))?"schedule":"manual"; // schedule runs: teleharness-scheduled-<id>-<time>
  async function visibleRuns(user){
    const entries=await deps.listRuns(user.id);
    const visible=[];
    for (const entry of entries) {
      try {
        const record=deps.store.get(user.id,entry.definitionId);
        const version=record.versions.find(v=>v.version===entry.version);
        if (!version) continue;
        access(user,version.definition,{engines:true});
        visible.push({...entry,accepted:Boolean(entry.accepted),name:version.definition.name,source:source(entry.workflowId),steps:stepShape(version.definition)});
      } catch (error) {
        if (!(error instanceof DefinitionError && [403,404].includes(error.status))) throw error;
      }
    }
    return visible.slice(0,200);
  }
  async function withSummaries(runs){
    const r=reader();
    if(!r) return runs.map(run=>({...run,summary:null}));
    const details=await r.many(runs.map(run=>run.workflowId));
    return runs.map((run,i)=>({...run,summary:summarizeRun(details[i],run.steps)}));
  }
  function access(user,draft,{engines=false}={}) {
    if (!validDraftShape(draft)) throw new DefinitionError(400,"Некорректная структура черновика");
    if (typeof draft?.directory!=="string" || !path.isAbsolute(draft.directory)) throw new DefinitionError(400,"Укажите абсолютный путь проекта");
    if (!deps.dirAllowed(user,draft.directory)) throw new DefinitionError(403,"outside your scope");
    if (engines) for(const step of draft.steps??[]) if(step?.type==="model" && (!allowedEngine(user,step.engine) || !pipeEngineAllowed(deps.engineAllowed,user,step.engine))) throw new DefinitionError(403,"Движок шага недоступен");
  }
  function own(user,id) {
    const record=deps.store.get(user.id,id);
    access(user,record.draft);
    for(const version of record.versions) access(user,version.definition);
    return record;
  }
  async function body(req,keys) {
    const value=await deps.readJsonBody(req,128*1024);
    if (!value || typeof value!=="object" || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k))) throw new DefinitionError(400,"Некорректное тело запроса");
    return value;
  }
  function route(method,path,handler) {
    return {method,path,scope:"user",handler:async ctx=>{
      try { if(!ctx.user?.id) throw new DefinitionError(403,"Требуется авторизация");await handler(ctx); }
      catch(e) { if(e instanceof DefinitionError) return deps.sendJson(ctx.res,e.status,{error:e.message,...(e.errors?{errors:e.errors}:{}),...(e.unchanged?{unchanged:e.unchanged}:{})}); throw e; }
    }};
  }
  return [
    route("GET",base+"/capabilities",({res,user})=>deps.sendJson(res,200,{definitions:true,subscriptionModels:Object.fromEntries(Object.entries(deps.subscriptionModels??{}).filter(([e])=>pipeEngineAllowed(deps.engineAllowed,user,e))),pipelineAvailable:!!deps.startPipeline,schedulesAvailable:!!deps.schedules,runListAvailable:typeof deps.listRuns==="function",timerStartAvailable:typeof deps.startTimer==="function",execution:{available:!!deps.startPipeline,reason:deps.startPipeline?"Исполнение подключено":"Исполнение Temporal ещё не подключено"},engines:["claude","codex"].filter(e=>pipeEngineAllowed(deps.engineAllowed,user,e)),codexTextOnly:user.role!=="admin"})),
    route("GET", /^\/teleharness\/api\/temporal\/runs\/([a-zA-Z0-9:.+-]{1,150})$/, async ({user,res,match})=>{
      if (!deps.lookupRun) throw new DefinitionError(503,"Исполнение Temporal ещё не подключено");
      const row=await deps.lookupRun(user.id,match[1]);
      if (!row) throw new DefinitionError(404,"Запуск не найден");
      const {versions}=deps.store.get(user.id,row.definitionId);
      const version=versions.find(v=>v.version===row.version);
      if (!version) throw new DefinitionError(404,"Опубликованная версия не найдена");
      access(user,version.definition,{engines:true});
      const detail=await deps.describeRun(match[1]);
      const steps=stepShape(version.definition);
      // FEAT-19.16: the run folder, its files, the step chats and the inputs it ran with.
      const record=deps.store.get(user.id,row.definitionId);
      const workspace=workspaceOf(version.definition.directory,slugOf(record));
      const folder=deps.results?.runFolder?.(match[1]);
      let inputs={};try{inputs=JSON.parse(row.inputs||"{}")??{};}catch{}
      deps.sendJson(res,200,{...detail,resultSteps:deps.results?.steps(match[1])??[],name:version.definition.name,version:row.version,
        definitionId:row.definitionId,directory:version.definition.directory,source:source(match[1]),steps,summary:summarizeRun(detail,steps),
        workspace,runFolder:folder?"runs/"+folder:null,files:folder?listRunFiles(workspace,"runs/"+folder):[],
        chats:deps.results?.chats?.(match[1])??{},inputs});
    }),
    route("GET", /^\/teleharness\/api\/temporal\/runs\/([a-zA-Z0-9:.+-]{1,150})\/results\/([a-zA-Z][a-zA-Z0-9_-]{0,63})$/,async({res,user,match})=>{
      const row=await deps.lookupRun?.(user.id,match[1]);
      if(!row || !deps.results) throw new DefinitionError(404,"Результат не найден");
      const v=deps.store.get(user.id,row.definitionId).versions.find(v=>v.version===row.version);
      if(!v) throw new DefinitionError(404,"Версия не найдена");
      access(user,v.definition,{engines:true});
      const text=await deps.results.read(match[1],match[2]);
      deps.sendJson(res,200,{text});
    }),
    route("POST", /^\/teleharness\/api\/temporal\/runs\/([a-zA-Z0-9:.+-]{1,150})\/actions$/,async({req,res,user,match})=>{
      const command=await body(req,["action","actionId","runId","stepId","generation","reason"]);
      if(!deps.applyAction) throw new DefinitionError(503,"Управление не подключено");
      const row=await deps.lookupRun(user.id,match[1]);
      if(!row) throw new DefinitionError(404,"Запуск не найден");
      const v=deps.store.get(user.id,row.definitionId).versions.find(x=>x.version===row.version);
      if(!v) throw new DefinitionError(404,"Версия не найдена");
      access(user,v.definition,{engines:true});
      deps.sendJson(res,200,await deps.applyAction(user.id,match[1],command));
    }),
    route("POST", base+"/runs", async ({req,res,user}) => {
      const b = await body(req, ["definitionId","version","requestId","inputs"]);
      if (typeof b.definitionId !== "string" || !Number.isSafeInteger(b.version) || b.version < 1 ||
          typeof b.requestId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(b.requestId))
        throw new DefinitionError(400, "Некорректные параметры запуска");
      const record = deps.store.get(user.id, b.definitionId);
      const published = record.versions.find(v => v.version === b.version);
      if (!published) throw new DefinitionError(404, "Опубликованная версия не найдена");
      access(user, published.definition, {engines:true});
      if (deps.startPipeline) {
        deps.validatePipeline(published.definition);
        const inputs=cleanInputs(published.definition.inputs,b.inputs);
        return deps.sendJson(res,202,await deps.startPipeline({...b,inputs,owner:user.id}));
      }
      if (!deps.startTimer) throw new DefinitionError(503, "Исполнение Temporal ещё не подключено");
      const {inputs,steps} = published.definition;
      const [step] = steps;
      if (inputs.length || steps.length !== 1 || step.type !== "timer" || step.when || Object.keys(step.mapping ?? {}).length)
        throw new DefinitionError(422, "На стенде доступен одиночный таймер без входов");
      const result = await deps.startTimer({...b, owner:user.id, seconds:step.seconds});
      deps.sendJson(res, 202, result);
    }),
    route("GET",base+"/runs",async ({res,user})=>{
      if (!deps.listRuns) throw new DefinitionError(503,"Исполнение Temporal ещё не подключено");
      deps.sendJson(res,200,await withSummaries(await visibleRuns(user)));
    }),
    // FEAT-19.14: «ждут вашего решения» for the Drawer badge.
    route("GET",base+"/attention",async ({res,user})=>{
      if (!deps.listRuns) return deps.sendJson(res,200,{waiting:0});
      const runs=await withSummaries((await visibleRuns(user)).slice(0,50));
      deps.sendJson(res,200,{waiting:runs.filter(r=>r.summary?.waiting).length});
    }),
    route("GET",base+"/definitions",({res,user})=>deps.sendJson(res,200,deps.store.list(user.id).filter(record=>deps.dirAllowed(user,record.directory)))),
    route("POST",base+"/definitions",async({req,res,user})=>{
      const b=await body(req,["draft"]);access(user,b.draft,{engines:true});
      const record=deps.store.create(user.id,b.draft);
      // FEAT-19.16 (U013 п.1): the pipe gets its own folder right away.
      try{deps.ensureDir?.(workspaceOf(record.draft.directory,slugOf(record)));}catch(e){deps.errLog?.("temporal.workspace",e);}
      deps.sendJson(res,201,{...record,folder:"pipelines/"+slugOf(record)});
    }),
    // BUG-251: projects the user may build pipes in + the one to preselect. No path is typed.
    route("GET",base+"/projects",async({res,user})=>{
      const list=(await deps.projectsFor?.(user)??[]).filter(d=>typeof d==="string"&&path.isAbsolute(d)&&!isPipelineFolder(d)&&deps.dirAllowed(user,d));
      const recent=deps.store.list(user.id).filter(r=>deps.dirAllowed(user,r.directory)).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]?.directory;
      const fallback=deps.defaultProject?.(user);
      const dirs=[...new Set([recent,fallback,...list].filter(d=>d&&deps.dirAllowed(user,d)&&!isPipelineFolder(d)))];
      deps.sendJson(res,200,{projects:dirs.map(d=>({directory:d,name:path.basename(d)||d})),default:dirs[0]??null});
    }),
    route("GET",/^\/teleharness\/api\/temporal\/definitions\/([a-zA-Z0-9_-]+)$/,({res,user,match})=>{const r=own(user,match[1]);deps.sendJson(res,200,{...r,folder:"pipelines/"+slugOf(r)});}),
    route("PUT",/^\/teleharness\/api\/temporal\/definitions\/([a-zA-Z0-9_-]+)$/,async({req,res,user,match})=>{
      own(user,match[1]);const b=await body(req,["draft","revision"]);
      own(user,match[1]);access(user,b.draft,{engines:true});
      deps.sendJson(res,200,deps.store.save(user.id,match[1],b.revision,b.draft));
    }),
    route("POST",/^\/teleharness\/api\/temporal\/definitions\/([a-zA-Z0-9_-]+)\/validate$/,({res,user,match})=>{
      const record=own(user,match[1]);access(user,record.draft,{engines:true});deps.sendJson(res,200,validateDefinition(record.draft));
    }),
    route("POST",/^\/teleharness\/api\/temporal\/definitions\/([a-zA-Z0-9_-]+)\/publish$/,async({req,res,user,match})=>{
      own(user,match[1]);const b=await body(req,["revision"]);
      // The body may arrive slowly; re-read after that await. ACL and publish
      // must examine the same current record in this single-writer process.
      const record=own(user,match[1]);access(user,record.draft,{engines:true});
      deps.sendJson(res,200,deps.store.publish(user.id,match[1],b.revision));
    }),
  ];
}
