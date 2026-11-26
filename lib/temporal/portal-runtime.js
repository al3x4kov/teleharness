// FEAT-19.5/19.6/19.7. Private worker socket and public route dependencies.
import {codexTextAdapter} from "./codex-text.js";
import {chatAdapter} from "./chat-adapter.js";
import path from "node:path";
import {mkdir,unlink,lstat,readFile} from "node:fs/promises";
import net from "node:net";
import {pipelineArtifacts} from "./artifacts.js";
import {pipelineRuntime} from "./runtime.js";
import {scheduleService} from "./schedules.js";
import {prepareRun,projectPlan} from "./prepare-bridge.js";
import {modelBridge,listenModelBridge} from "./model-bridge.js";
import {claudeTextAdapter} from "./claude-text.js";
import {opencodeTextAdapter} from "./opencode-text.js";
import {createOcClient} from "../oc-client.js";
import {DefinitionError} from "./definitions.js";
import {socketPathProblem} from "./cli.js";
import {createCommandStepRunner} from "./command-step.js";

export async function connectPipeline(deps,options) {
  const {socketPath,databasePath}=options;
  const ledger=options.ledger==="none"?"none":"postgres";
  const runtime=pipelineRuntime(databasePath,options);
  const schedules=scheduleService(databasePath,options);
  const artifactDirectory=path.join(path.dirname(databasePath),"temporal-artifacts");
  const results=pipelineArtifacts(runtime.db,artifactDirectory);
  const commandStep=createCommandStepRunner({
    db:runtime.db,
    catalog:deps.commandCatalog,
    results,
    artifactDirectory,
    dirAllowed:deps.dirAllowed,
    slotsLimit:options.commandSlots ?? 2,
    tenantHome:options.tenantHome ?? null,
    auditCommand:deps.auditCommand ?? null,
    cli:options.cli,
  });
  const adapters={};
  if(ledger!=="none") {
    if(options.subscriptionToken && !options.chatSteps) adapters.claude=claudeTextAdapter({token:options.subscriptionToken,artifactDirectory,attested:!!options.subscriptionAttested});
    for(const [engine,models] of Object.entries(options.chatModels??{}))
      if(options.chatSteps) adapters[engine]=chatAdapter({engine,models,runner:options.chatSteps,artifactDirectory});
    if(options.codexModels) adapters.codexText=codexTextAdapter({models:options.codexModels,artifactDirectory,...(options.codexHome?{home:options.codexHome}:{})});
    if(options.openCodeDirectory && !adapters.opencode) {
      const directory=options.openCodeDirectory;
      const metadata=await lstat(directory), credential=path.join(directory,"password");
      const secret=await lstat(credential);
      if(!path.isAbsolute(directory) || !metadata.isDirectory() || metadata.uid!==process.getuid() ||
          metadata.mode&0o077 || !secret.isFile() || secret.uid!==process.getuid() || secret.mode&0o077)
        throw Error("Некорректные права каталога подписочного исполнителя");
      const oc=createOcClient({api:"v2",base:options.openCodeAddress,password:(await readFile(credential,"utf8")).trim()});
      adapters.opencode=opencodeTextAdapter({oc,workDirectory:path.join(directory,"work"),artifactDirectory});
    }
  }
  function validatePipeline(definition) {
    if(options.drain)throw new DefinitionError(503,"Новые запуски приостановлены");
    projectPlan(definition);
    for(const step of definition.steps) {
      if(step.type==="model") {
        if(ledger==="none")
          throw new DefinitionError(422,"Модельные шаги требуют журнала PostgreSQL (TELEHARNESS_TEMPORAL_LEDGER=postgres)");
        if(!adapters[step.engine]?.models.includes(step.model))
          throw new DefinitionError(422,"Подписочное исполнение этой модели пока недоступно");
      }
    }
  }
  const sockErr=socketPathProblem(socketPath);
  if(sockErr) throw new Error(sockErr);
  const folder=path.dirname(socketPath);
  await mkdir(folder,{recursive:true,mode:0o700});
  const parent=await lstat(folder);
  if(!parent.isDirectory() || parent.uid!==process.getuid() || (parent.mode & 0o077)) throw Error("Небезопасный каталог сокета");
  try {
    const socket=await lstat(socketPath);
    if(!socket.isSocket() || socket.uid!==process.getuid()) throw Error("Некорректный путь сокета");
    const alive=await new Promise((ok,fail)=>{
      const c=net.createConnection(socketPath);
      c.once("connect",()=>{c.end();ok(true);});
      c.once("error",e=>e.code==="ECONNREFUSED"?ok(false):fail(e));
    });
    if(alive) throw Error("Сокет исполнителя уже обслуживается");
    await unlink(socketPath);
  } catch(e){if(e.code!=="ENOENT") throw e;}
  // FEAT-20.3 (2.5): отказ шага PR сохраняется в запуск — текст виден на экране запуска.
  const invoke=modelBridge({...deps,lookupStart:runtime.lookupStart,adapters,results,prStep:options.prStep,commandStep,
    stepOutcome:({workflowId,stepId,error})=>runtime.setStepError?.(workflowId,stepId,error)});
  await listenModelBridge(socketPath,async (action,request,context)=>{
    if(action==="publish") {
      if(!request || Object.keys(request).sort().join(",")!=="receipt,stepId,workflowId" ||
        typeof request.receipt!=="string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(request.receipt))
        throw new DefinitionError(400,"Некорректная квитанция");
      context.signal.throwIfAborted();
      // The private worker publishes only after committing its fenced receipt in PostgreSQL.
      results.remember(request.workflowId,request.stepId,request.receipt);
      return {};
    }
    return invoke(action,request,context);
  },r=>{
    if(options.drain && r?.launchRef?.startsWith("schedule/") && !runtime.lookupStart(r.workflowId))
      throw new DefinitionError(503,"Новые запуски приостановлены");
    return prepareRun({...deps,db:runtime.db},r);
  });
  const resumePipeline=(params)=>runtime.resumePipeline({...params,inheritArtifacts:results.inheritFrom});
  return {...runtime,resumePipeline,schedules,draining:!!options.drain,results,commandMeta:commandStep.commandMeta,validatePipeline,listSubscriptionModels:()=>Object.fromEntries(Object.entries(adapters).filter(([key])=>key!=='codexText').map(([key,a])=>[key,a.models]))};
}
