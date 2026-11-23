// FEAT-19.6. Durable, owner-scoped launch intents and commands.
import {createRequire} from "node:module";
import {randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {DefinitionError} from "./definitions.js";

const execute=promisify(execFile);
export const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function pipelineRuntime(databasePath,options) {
  const {DatabaseSync}=createRequire(import.meta.url)("node:sqlite");
  const db=new DatabaseSync(databasePath);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS starts(owner TEXT NOT NULL,request_id TEXT NOT NULL,definition_id TEXT NOT NULL,
      version INTEGER NOT NULL,workflow_id TEXT UNIQUE NOT NULL,accepted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,request_id));
    CREATE TABLE IF NOT EXISTS actions(owner TEXT NOT NULL,id TEXT NOT NULL,workflow_id TEXT NOT NULL,
      payload TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,id));`);
  // FEAT-19.16: run inputs live in the portal (never in Temporal history).
  try {db.exec("ALTER TABLE starts ADD COLUMN inputs TEXT");} catch {}
  // FEAT-20.3: источник запуска (manual|schedule|github), триггер и событие —
  // для списка запусков и деталей («GitHub · owner/repo#142 · метка agent»).
  try {db.exec("ALTER TABLE starts ADD COLUMN source TEXT");} catch {}
  try {db.exec("ALTER TABLE starts ADD COLUMN trigger_id TEXT");} catch {}
  try {db.exec("ALTER TABLE starts ADD COLUMN event_ref TEXT");} catch {}
  // FEAT-20.3 (2.5): попытка «Починить CI» (N из CI_ATTEMPTS_MAX), ссылка на
  // событие GitHub и текст отказа шага PR — воркер падает по неповторяемой ошибке,
  // в истории Temporal этого текста нет, экран запуска читает его отсюда.
  try {db.exec("ALTER TABLE starts ADD COLUMN attempt INTEGER");} catch {}
  try {db.exec("ALTER TABLE starts ADD COLUMN event_url TEXT");} catch {}
  try {db.exec("ALTER TABLE starts ADD COLUMN step_error TEXT");} catch {}
  // FEAT-19.32: продолжение запуска с последнего успешного шага — ссылка на исходный запуск и seed.
  try {db.exec("ALTER TABLE starts ADD COLUMN resumed_from TEXT");} catch {}
  try {db.exec("ALTER TABLE starts ADD COLUMN resume_from_step TEXT");} catch {}
  try {db.exec("ALTER TABLE starts ADD COLUMN resume_seed TEXT");} catch {}
  const columns="owner,workflow_id AS workflowId,definition_id AS definitionId,version,accepted,inputs,source,trigger_id AS triggerId,event_ref AS eventRef,attempt,event_url AS eventUrl,step_error AS stepError,resumed_from AS resumedFrom,resume_from_step AS resumeFromStep,resume_seed AS resumeSeed";
  const lookupStart=id=>db.prepare("SELECT "+columns+" FROM starts WHERE workflow_id=?").get(id);
  async function cli(args) {
    const {stdout}=await (options.execute??execute)(options.cli??"/opt/temporal/temporal",["workflow",...args,
      "--address",options.address,"--namespace",options.namespace,"-o","json"],{timeout:15000,maxBuffer:1024*1024});
    return stdout.trim()?JSON.parse(stdout):{};
  }
  async function startPipeline({owner,definitionId,version,requestId,inputs={},source=null,triggerId=null,eventRef=null,attempt=null,eventUrl=null}) {
    db.prepare("INSERT INTO starts(owner,request_id,definition_id,version,workflow_id,accepted,inputs,source,trigger_id,event_ref,attempt,event_url) VALUES(?,?,?,?,?,0,?,?,?,?,?,?) ON CONFLICT(owner,request_id) DO NOTHING")
      .run(owner,requestId,definitionId,version,randomUUID(),JSON.stringify(inputs??{}),source,triggerId,eventRef,attempt,eventUrl).changes;
    const row=db.prepare("SELECT "+columns+" FROM starts WHERE owner=? AND request_id=?").get(owner,requestId);
    if(definitionId!==row.definitionId || version!==row.version) throw new DefinitionError(409,"Ключ запуска уже использован");
    if(!row.accepted) {
      try {
        await cli(["start","-w",row.workflowId,"--type","TeleharnessPipelineV1","--task-queue",options.taskQueue,
          "--input",JSON.stringify({launchRef:row.workflowId}),"--id-reuse-policy","RejectDuplicate"]);

      } catch {
        try {await cli(["describe","-w",row.workflowId]);} catch {throw new DefinitionError(503,"Temporal не подтвердил запуск. Повторите с прежним ключом");}
      }
      db.prepare("UPDATE starts SET accepted=1 WHERE workflow_id=?").run(row.workflowId);
    }
    return {workflowId:row.workflowId,definitionId,version};
  }
  async function resumePipeline({owner,definitionId,version,requestId,inputs={},resumedFrom,resumeFromStep,seed,reusedSteps=[],inheritArtifacts=null}) {
    const seedJson=JSON.stringify(seed??{steps:{},conditions:{},files:{},pr:{},reworks:{}});
    db.prepare("INSERT INTO starts(owner,request_id,definition_id,version,workflow_id,accepted,inputs,source,resumed_from,resume_from_step,resume_seed) VALUES(?,?,?,?,?,0,?,'manual',?,?,?) ON CONFLICT(owner,request_id) DO NOTHING")
      .run(owner,requestId,definitionId,version,randomUUID(),JSON.stringify(inputs??{}),resumedFrom,resumeFromStep,seedJson);
    const row=db.prepare("SELECT "+columns+" FROM starts WHERE owner=? AND request_id=?").get(owner,requestId);
    if(definitionId!==row.definitionId || version!==row.version || resumedFrom!==row.resumedFrom || resumeFromStep!==row.resumeFromStep)
      throw new DefinitionError(409,"Ключ запуска уже использован");
    inheritArtifacts?.(resumedFrom,row.workflowId,reusedSteps);
    if(!row.accepted) {
      try {
        await cli(["start","-w",row.workflowId,"--type","TeleharnessPipelineV1","--task-queue",options.taskQueue,
          "--input",JSON.stringify({launchRef:row.workflowId}),"--id-reuse-policy","RejectDuplicate"]);
      } catch {
        try {await cli(["describe","-w",row.workflowId]);} catch {throw new DefinitionError(503,"Temporal не подтвердил запуск. Повторите с прежним ключом");}
      }
      db.prepare("UPDATE starts SET accepted=1 WHERE workflow_id=?").run(row.workflowId);
    }
    return {workflowId:row.workflowId,definitionId,version,resumedFrom,fromStepId:resumeFromStep,reusedSteps};
  }
  async function describeRun(id) {
    try {
      const description=await cli(["describe","-w",id]);
      const info=description.workflowExecutionInfo;
      const status=info.status.replace(/^WORKFLOW_EXECUTION_STATUS_/,"");
      const runId=info.execution.runId;
      let state=null;
      const pipeline=info.type?.name==="TeleharnessPipelineV1";
      if(status==="RUNNING" && pipeline) {
        const reply=await cli(["query","-w",id,"-r",runId,"--type","state"]);
        state=Array.isArray(reply)?reply[0]:reply;
        if(Array.isArray(state?.queryResult)) state=state.queryResult[0];
      }
      if(status==="COMPLETED" && pipeline && description.result?.steps) state=description.result;
      // FEAT-19.14: a rejected approval fails the workflow; the step map tells «Отклонён» from «Ошибка».
      if(["FAILED","TIMED_OUT","CANCELED","TERMINATED"].includes(status) && pipeline) {
        try {
          const reply=await cli(["query","-w",id,"-r",runId,"--type","state"]);
          state=Array.isArray(reply)?reply[0]:reply;
          if(Array.isArray(state?.queryResult)) state=state.queryResult[0];
          if(!state?.steps) state=null;
        } catch {state=null;}
      }
      return {workflowId:id,runId,status,state,startTime:info.startTime,closeTime:info.closeTime};
    } catch {throw new DefinitionError(503,"Не удалось прочитать состояние Temporal");}
  }
  async function applyAction(owner,id,body) {
    const {action,runId,actionId,reason,stepId,generation}=body;
    if(!uuid.test(runId)||!uuid.test(actionId)||!["pause","resume","approve","reject","rework","cancel","terminate"].includes(action))
      throw new DefinitionError(400,"Некорректное действие");
    if(action==="terminate" && (typeof reason!=="string" || !reason.trim() || reason.length>256))
      throw new DefinitionError(400,"Укажите причину остановки");
    if(["approve","reject","rework"].includes(action) && (generation!==runId || typeof stepId!=="string" || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(stepId)))
      throw new DefinitionError(409,"Требуется актуальное решение по шагу");
    const payload=JSON.stringify({action,runId,reason,stepId,generation});
    db.prepare("INSERT INTO actions VALUES(?,?,?,?,0) ON CONFLICT(owner,id) DO NOTHING").run(owner,actionId,id,payload);
    const prior=db.prepare("SELECT * FROM actions WHERE owner=? AND id=?").get(owner,actionId);
    if(prior.workflow_id!==id || prior.payload!==payload) throw new DefinitionError(409,"Ключ действия уже использован");
    if(!prior.done) {
      try {
        if(action==="terminate") await cli(["terminate","-w",id,"-r",runId,"--reason","owner_requested"]);
        else if(action==="cancel") await cli(["cancel","-w",id,"-r",runId]);
        else await cli(["update","execute","-w",id,"-r",runId,"--name","control","--update-id",actionId,
          "--input",JSON.stringify({action,stepId,generation,actionId})]);
      } catch {
        const expected={cancel:"CANCELED",terminate:"TERMINATED"}[action];
        const current=expected?await describeRun(id):null;
        if(!expected || current.runId!==runId || current.status!==expected) throw new DefinitionError(409,"Temporal не подтвердил действие");
      }
      db.prepare("UPDATE actions SET done=1 WHERE owner=? AND id=?").run(owner,actionId);
    }
    return {actionId,action,accepted:true};
  }
  // FEAT-20.3 (2.5): отказ шага PR — {stepId, message, code, sha} или null (шаг
  // прошёл после повтора — запись очищается). Текст обрезан: это экран, не лог.
  function setStepError(workflowId,stepId,error) {
    const text=error?JSON.stringify({stepId,message:String(error.message??"").slice(0,300),
      ...(error.code?{code:String(error.code).slice(0,40)}:{}),...(error.sha?{sha:String(error.sha).slice(0,40)}:{}),at:Date.now()}):null;
    db.prepare("UPDATE starts SET step_error=? WHERE workflow_id=?").run(text,workflowId);
  }
  return {db,lookupStart,startPipeline,resumePipeline,describeRun,applyAction,setStepError,
    lookupRun:(owner,id)=>db.prepare("SELECT "+columns+" FROM starts WHERE owner=? AND workflow_id=?").get(owner,id),
    listRuns:owner=>db.prepare("SELECT "+columns+" FROM starts WHERE owner=? ORDER BY rowid DESC").all(owner)};
}
