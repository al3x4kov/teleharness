// FEAT-19.5. A workflow receives only safe fields from its pinned version.
import {DefinitionError} from './definitions.js';
import {pipeEngineAllowed} from './workspace.js';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const scheduledTime=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export function projectPlan(definition) {
  // FEAT-19.16: inputs are resolved by the portal (never sent to Temporal); condition,
  // artifact and PR (FEAT-20.3) run as portal steps. Legacy `when` and `mapping`
  // stay unsupported.
  if (definition.steps.some(step =>
    !['model','approval','parallel','timer','condition','artifact','pull_request'].includes(step.type) || step.when ||
    (step.type==='condition' && !step.check) ||
    Object.keys(step.mapping ?? {}).length || (step.type==='parallel' && step.join!=='all-success')))
    throw new DefinitionError(422,'Версия содержит шаги или входы, недоступные для исполнения');
  return {steps:definition.steps.map(step=>{
    // Поля PR-шага портал читает сам из закреплённой версии (мост получает definition).
    const safe={id:step.id,type:step.type,dependsOn:step.dependsOn};
    if(step.type==='timer')safe.seconds=step.seconds;
    if(step.type==='model'){
      safe.timeoutSeconds=step.timeoutSeconds;
      safe.maxAttempts=step.maxAttempts;
    }
    if(step.type==='approval' && step.reworkTarget){
      safe.reworkTarget=step.reworkTarget;
      safe.maxReworks=step.maxReworks ?? 3;
    }
    return safe;
  })};
}

export async function prepareRun({db,getUser,store,dirAllowed,engineAllowed},request) {
  if (!request || Object.keys(request).sort().join(',')!=='launchRef,runId,workflowId' ||
      !uuid.test(request.runId) || typeof request.launchRef!=='string' || typeof request.workflowId!=='string')
    throw new DefinitionError(400,'Некорректная ссылка запуска');
  const {launchRef,workflowId}=request;
  const schedule=launchRef.startsWith('schedule/');
  let row;
  if(schedule){
    const id=launchRef.slice('schedule/'.length);
    const prefix='teleharness-scheduled-'+id+'-';
    if(!uuid.test(id) || !workflowId.startsWith(prefix) || !scheduledTime.test(workflowId.slice(prefix.length)))
      throw new DefinitionError(403,'Ссылка не соответствует расписанию');
    row=db.prepare('SELECT owner,definition_id AS definitionId,version FROM temporal_schedule_refs WHERE id=? AND accepted=1').get(id);
  } else {
    if(!uuid.test(workflowId) || launchRef!==workflowId)throw new DefinitionError(403,'Ссылка не соответствует запуску');
    row=db.prepare('SELECT owner,definition_id AS definitionId,version FROM starts WHERE workflow_id=?').get(workflowId);
  }
  if(!row)throw new DefinitionError(404,'Запуск не найден');
  const user=await getUser(row.owner);
  if(!user || user.disabled || user.id!==row.owner)throw new DefinitionError(403,'Доступ пользователя отозван');
  // BUG-264 п.6: a manual run accepted before the pipe was deleted still runs its version; a schedule of a deleted pipe does not fire.
  const {versions}=store.get(user.id,row.definitionId,{deleted:!schedule});
  const definition=versions.find(item=>item.version===row.version)?.definition;
  if(!definition)throw new DefinitionError(404,'Версия не найдена');
  if(!dirAllowed(user,definition.directory) || definition.steps.some(s=>s.type==='model' &&
     !pipeEngineAllowed(engineAllowed,user,s.engine)))
    throw new DefinitionError(403,'Доступ к версии отозван');
  const plan=projectPlan(definition);
  if(schedule){
    db.prepare('INSERT INTO starts(owner,request_id,definition_id,version,workflow_id,accepted) VALUES(?,?,?,?,?,1) ON CONFLICT(workflow_id) DO NOTHING')
      .run(row.owner,workflowId,row.definitionId,row.version,workflowId);
    const binding=db.prepare('SELECT 1 FROM starts WHERE workflow_id=? AND owner=? AND definition_id=? AND version=?').get(workflowId,row.owner,row.definitionId,row.version);
    if(!binding)throw new DefinitionError(409,'Запуск уже связан с другой версией');
  }
  return plan;
}
