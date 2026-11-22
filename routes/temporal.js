// FEAT-19.4 / TASK-19.8: owner and current project/engine checks on the server.
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { DefinitionError, slugOf } from "../lib/temporal/definitions.js";
import { workspaceOf, runFolderName, isPipelineFolder, pipeEngineAllowed } from "../lib/temporal/workspace.js";
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
  const stepShape=definition=>(definition.steps??[]).map(s=>({id:s.id,name:s.name,type:s.type,...(s.type==="model"?{engine:s.engine,model:s.model}:{}),...(s.type==="artifact"?{filename:s.filename,source:s.source}:{}),...(s.type==="condition"?{check:s.check}:{}),...(s.type==="approval"&&s.reworkTarget?{reworkTarget:s.reworkTarget,maxReworks:s.maxReworks??3}:{}),...(s.type==="pull_request"?{mode:s.mode==='same-branch'?'same-branch':'new'}:{})}));
  const source=(id,stored)=>stored??(/^teleharness-scheduled?-/.test(String(id))?"schedule":"manual");
  const prOutcome=(detail,steps)=>{for(const [id,v] of Object.entries(detail?.state?.pr??{}))if(v&&steps.some(s=>s.id===id))return v;return null;};
  const parseJson=(text)=>{if(typeof text!=="string"||!text)return null;try{return JSON.parse(text);}catch{return null;}};
  async function visibleRuns(user){
    const entries=await deps.listRuns(user.id);
    const visible=[];
    for (const entry of entries) {
      try {
        const record=deps.store.get(user.id,entry.definitionId,{deleted:true}); // BUG-264 п.6: history of a deleted pipe stays
        const version=record.versions.find(v=>v.version===entry.version);
        if (!version) continue;
        access(user,version.definition,{engines:true});
        const {inputs,stepError,...rest}=entry;
        visible.push({...rest,stepError:parseJson(stepError),accepted:Boolean(entry.accepted),name:version.definition.name,source:source(entry.workflowId,entry.source),steps:stepShape(version.definition),...(record.deletedAt?{pipeDeleted:true}:{})});
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
    return runs.map((run,i)=>({...run,summary:summarizeRun(details[i],run.steps),pr:prOutcome(details[i],run.steps)}));
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
  // FEAT-20.2: запуски пользователя для доски внимания — тот же источник, что список и «Ждут вашего решения».
  // null — исполнение Temporal не подключено.
  deps.boardRuns=async user=>deps.listRuns?withSummaries(await visibleRuns(user)):null;
  return [
    route("GET",base+"/capabilities",({res,user})=>{
      const subscriptionModels=Object.fromEntries(Object.entries(deps.subscriptionModels??{}).filter(([e])=>pipeEngineAllowed(deps.engineAllowed,user,e)));
      const allowedIds=new Set(Object.values(subscriptionModels).flat());
      const modelLabels=Object.fromEntries(Object.entries(deps.modelLabels??{}).filter(([id])=>allowedIds.has(id)));
      return deps.sendJson(res,200,{definitions:true,subscriptionModels,modelLabels,pipelineAvailable:!!deps.startPipeline,schedulesAvailable:!!deps.schedules,runListAvailable:typeof deps.listRuns==="function",timerStartAvailable:typeof deps.startTimer==="function",triggersAvailable:typeof deps.enabledTriggers==="function",
        triggers:{available:typeof deps.enabledTriggers==="function",publicUrl:Boolean(deps.publicUrl),adminStopped:deps.adminStopped?deps.adminStopped():false,claudeLeftToday:deps.claudeLeftToday?deps.claudeLeftToday():null},
        execution:{available:!!deps.startPipeline,reason:deps.startPipeline?"Исполнение подключено":"Исполнение Temporal ещё не подключено"},engines:["claude","codex","acp","opencode"].filter(e=>pipeEngineAllowed(deps.engineAllowed,user,e)),codexTextOnly:user.role!=="admin"});
    }),
    route("GET", /^\/teleharness\/api\/temporal\/runs\/([a-zA-Z0-9:.+-]{1,150})$/, async ({user,res,match})=>{
      if (!deps.lookupRun) throw new DefinitionError(503,"Исполнение Temporal ещё не подключено");
      const row=await deps.lookupRun(user.id,match[1]);
      if (!row) throw new DefinitionError(404,"Запуск не найден");
      const record=deps.store.get(user.id,row.definitionId,{deleted:true});
      const version=record.versions.find(v=>v.version===row.version);
      if (!version) throw new DefinitionError(404,"Опубликованная версия не найдена");
      access(user,version.definition,{engines:true});
      const detail=await deps.describeRun(match[1]);
      const steps=stepShape(version.definition);
      // FEAT-19.16: the run folder, its files, the step chats and the inputs it ran with.
      const workspace=workspaceOf(version.definition.directory,slugOf(record));
      const folder=deps.results?.runFolder?.(match[1]);
      let inputs={};try{inputs=JSON.parse(row.inputs||"{}")??{};}catch{}
      deps.sendJson(res,200,{...detail,resultSteps:deps.results?.steps(match[1])??[],name:version.definition.name,version:row.version,
        definitionId:row.definitionId,directory:version.definition.directory,source:source(match[1],row.source),triggerId:row.triggerId??null,eventRef:row.eventRef??null,
        eventUrl:row.eventUrl??null,attempt:Number.isSafeInteger(row.attempt)&&row.attempt>0?row.attempt:null,stepError:parseJson(row.stepError),steps,summary:summarizeRun(detail,steps),
        workspace,runFolder:folder?"runs/"+folder:null,files:folder?listRunFiles(workspace,"runs/"+folder):[],
        chats:deps.results?.chats?.(match[1])??{},inputs,...(record.deletedAt?{pipeDeleted:true}:{})});
    }),
    route("GET", /^\/teleharness\/api\/temporal\/runs\/([a-zA-Z0-9:.+-]{1,150})\/results\/([a-zA-Z][a-zA-Z0-9_-]{0,63})$/,async({res,user,match})=>{
      const row=await deps.lookupRun?.(user.id,match[1]);
      if(!row || !deps.results) throw new DefinitionError(404,"Результат не найден");
      const v=deps.store.get(user.id,row.definitionId,{deleted:true}).versions.find(v=>v.version===row.version);
      if(!v) throw new DefinitionError(404,"Версия не найдена");
      access(user,v.definition,{engines:true});
      const text=await deps.results.read(match[1],match[2]);
      deps.sendJson(res,200,{text});
    }),
    route("POST", /^\/teleharness\/api\/temporal\/runs\/([a-zA-Z0-9:.+-]{1,150})\/actions$/,async({req,res,user,match})=>{
      const command=await body(req,["action","actionId","runId","stepId","generation","reason","note"]);
      if(!deps.applyAction) throw new DefinitionError(503,"Управление не подключено");
      const row=await deps.lookupRun(user.id,match[1]);
      if(!row) throw new DefinitionError(404,"Запуск не найден");
      const record=deps.store.get(user.id,row.definitionId,{deleted:true});
      const v=record.versions.find(x=>x.version===row.version);
      if(!v) throw new DefinitionError(404,"Версия не найдена");
      access(user,v.definition,{engines:true});
      if(command.action==="rework"){
        const step=v.definition.steps?.find(s=>s.id===command.stepId);
        if(!step || step.type!=="approval" || !step.reworkTarget)
          throw new DefinitionError(409,"Для этого шага доработка не настроена");
        const note=typeof command.note==="string"?command.note.trim():"";
        if(!note || note.length>8000)
          throw new DefinitionError(400,"Укажите замечания для доработки (до 8000 символов)");
        const workspace=workspaceOf(v.definition.directory,slugOf(record));
        const folder=deps.results?.runFolder?.(match[1],()=>runFolderName(match[1]))??runFolderName(match[1]);
        const dir=path.join(workspace,"runs",folder);
        await mkdir(dir,{recursive:true});
        await writeFile(path.join(dir,`rework-${step.reworkTarget}.md`),note,"utf8");
      }
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
    // BUG-264 п.6: delete = tombstone, no cascade. Finished runs, their files and the
    // published versions stay (run history reads them); a running/waiting run or an
    // active schedule blocks the delete with a reason — the owner settles them first.
    route("DELETE",/^\/teleharness\/api\/temporal\/definitions\/([a-zA-Z0-9_-]+)$/,async({res,user,match})=>{
      const id=match[1],{draft:{name}}=own(user,id),reasons=[];
      if (deps.listRuns) {
        const ids=(await deps.listRuns(user.id)).filter(e=>e.definitionId===id).map(e=>e.workflowId);
        const cached=reader()?await reader().many(ids):ids.map(()=>null);
        // A cached «running» may be up to ttl old — re-read those; an unreadable run (history
        // older than 14 days, Temporal down) does not block: the tombstone keeps its version.
        const live=await Promise.all(cached.map(async(d,i)=>d?.status==="RUNNING"?await deps.describeRun(ids[i]).catch(()=>null):d));
        const running=live.filter(d=>d?.status==="RUNNING");
        if (running.length) {
          const waiting=running.filter(d=>summarizeRun(d).waiting).length;
          reasons.push(`идёт запусков: ${running.length}${waiting?`, из них ждут вашего решения: ${waiting}`:""}. Дождитесь их завершения или отмените на вкладке «Запуски».`);
        }
      }
      if (deps.schedules) {
        let active=0;
        for (const row of deps.schedules.list(user.id).filter(r=>r.definitionId===id)) {
          let state;
          try { state=await deps.schedules.describe(row); }
          catch { throw new DefinitionError(503,"Не удалось проверить расписания пайпа в Temporal — пайп не удалён. Повторите через минуту"); }
          if (!state.paused) active++;
        }
        if (active) reasons.push(`у него активные расписания: ${active}. Поставьте их на паузу на вкладке «Расписания».`);
      }
      const triggersOn=deps.enabledTriggers?.(user,id)??[];
      if (triggersOn.length) reasons.push(`у него включённые триггеры GitHub (${triggersOn.map(t=>t.repo).join(", ")}). Выключите их на вкладке «Триггеры».`);
      if (reasons.length) throw new DefinitionError(409,`Пайп «${name}» нельзя удалить: ${reasons.join(" Кроме того, ")} Затем удалите пайп. Завершённые запуски и их файлы сохранятся.`);
      own(user,id); // re-check after the awaits, as publish does
      deps.sendJson(res,200,deps.store.remove(user.id,id));
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
