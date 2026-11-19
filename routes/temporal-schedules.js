// FEAT-19.7. Owner and ACL checks use the immutable published version.
import {DefinitionError} from '../lib/temporal/definitions.js';
import {projectPlan} from '../lib/temporal/prepare-bridge.js';
import {scheduleOptions} from '../lib/temporal/schedules.js';
import {hasRequiredInputs} from '../lib/temporal/inputs.js';
import {pipeEngineAllowed} from '../lib/temporal/workspace.js';

export function scheduleRoutes(deps) {
  const base='/teleharness/api/temporal/schedules';
  function access(user,item) {
    const {versions}=deps.store.get(user.id,item.definitionId);
    const definition=versions.find(v=>v.version===item.version)?.definition;
    if(!definition)throw new DefinitionError(404,'Опубликованная версия не найдена');
    if(!deps.dirAllowed(user,definition.directory) || definition.steps.some(s=>s.type==='model' &&
        !pipeEngineAllowed(deps.engineAllowed,user,s.engine)))
      throw new DefinitionError(403,'Пайп недоступен');
    return definition;
  }
  function route(method,path,handler) {
    return {method,path,scope:'user',handler:async ctx=>{
      try {
        if(!ctx.user?.id)throw new DefinitionError(403,'Требуется авторизация');
        if(!deps.schedules)throw new DefinitionError(503,'Расписания Temporal не подключены');
        await handler(ctx);
      } catch(error){
        if(!(error instanceof DefinitionError))throw error;
        deps.sendJson(ctx.res,error.status,{error:error.message});
      }
    }};
  }
  return [
    route('POST',base,async({req,res,user})=>{
      const options=scheduleOptions(await deps.readJsonBody(req,8192));
      const definition=access(user,options);
      if(hasRequiredInputs(definition))throw new DefinitionError(422,'У версии есть обязательные входы — по расписанию их некому заполнить');
      (deps.validatePipeline ?? projectPlan)(definition);
      deps.sendJson(res,201,{...await deps.schedules.create(user.id,options),name:definition.name});
    }),
    route('GET',base,async({res,user})=>{
      const visible=[];
      for(const row of deps.schedules.list(user.id)){
        let definition;
        try{definition=access(user,row);}catch(error){
          if(!(error instanceof DefinitionError && [403,404].includes(error.status)))throw error;
          // FEAT-19.14: a schedule that lost project access is shown (its firings are skipped), not hidden.
          if(error.status===404){
            // BUG-264 п.6: a schedule of a deleted pipe (it was paused) stays visible with the reason.
            let tomb=null;try{tomb=deps.store.get(user.id,row.definitionId,{deleted:true});}catch{}
            const old=tomb?.deletedAt&&tomb.versions.find(v=>v.version===row.version)?.definition;
            const name=old&&deps.dirAllowed(user,old.directory)&&old.name;
            if(name)visible.push({...row,name,blocked:'Пайп удалён — расписание больше не срабатывает',pipeDeleted:true});
            continue;
          }
          let name='Пайп';
          try{name=deps.store.get(user.id,row.definitionId).versions.find(v=>v.version===row.version)?.definition.name??name;}catch{}
          visible.push({...row,name,blocked:'Нет доступа к проекту или движку пайпа — срабатывания пропускаются'});
          continue;
        }
        visible.push({...await deps.schedules.describe(row),name:definition.name});
      }
      deps.sendJson(res,200,visible);
    }),
    route('POST',/^\/teleharness\/api\/temporal\/schedules\/([a-f0-9-]{36})\/(pause|resume)$/,async({res,user,match})=>{
      if(deps.draining && match[2]==="resume")throw new DefinitionError(503,"Новые запуски приостановлены");
      const item=deps.schedules.get(user.id,match[1]);
      const definition=access(user,item);
      deps.sendJson(res,200,{...await deps.schedules.setPaused(user.id,item.id,match[2]==='pause'),name:definition.name});
    })
  ];
}
