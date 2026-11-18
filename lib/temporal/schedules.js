// FEAT-19.7. Temporal owns the clock and the state of existing workflow executions.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { DefinitionError } from './definitions.js';

const uuid=/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const fields=['definitionId','version','cron','timezone','overlap','catchupSeconds','requestId'];
const overlaps={'skip':'Skip','buffer-one':'BufferOne'};
const bounds=[[0,59],[0,23],[1,31],[1,12],[0,7]];
function validField(field,[min,max]) {
  return field.split(',').every(part=>{
    const m=/^(\*|\d{1,2})(?:-(\d{1,2}))?(?:\/(\d{1,2}))?$/.exec(part);
    if(!m)return false;
    if(m[3] && (+m[3]<1 || +m[3]>max-min+1))return false;
    if(m[1]==='*')return !m[2];
    return +m[1]>=min && +m[1]<=max && (!m[2] || (+m[2]>=+m[1] && +m[2]<=max));
  });
}
export function scheduleOptions(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!fields.includes(k)) ||
     typeof value.definitionId!=='string' || !value.definitionId || value.definitionId.length>128 ||
     !Number.isSafeInteger(value.version) || value.version<1 || (value.requestId!==undefined && (typeof value.requestId!=='string' || !uuid.test(value.requestId))))
    throw new DefinitionError(400,'Некорректные параметры расписания');
  const parts=typeof value.cron==='string' && value.cron.length<=200 && value.cron.trim().split(/\s+/);
  if(!parts || parts.length!==5 || !parts.every((field,i)=>validField(field,bounds[i])))
    throw new DefinitionError(400,'Cron должен содержать пять числовых полей');
  try {
    if(typeof value.timezone!=='string' || !/^[A-Za-z][A-Za-z0-9_+./-]{0,127}$/.test(value.timezone))throw Error();
    new Intl.DateTimeFormat('en',{timeZone:value.timezone});
  } catch {throw new DefinitionError(400,'Укажите часовой пояс IANA');}
  if(typeof value.overlap!=='string' || !Object.hasOwn(overlaps,value.overlap) || !Number.isSafeInteger(value.catchupSeconds) || value.catchupSeconds<10 || value.catchupSeconds>31536000)
    throw new DefinitionError(400,'Проверьте политику пересечений и окно догоняющего запуска (10–31536000 секунд)');
  return {...value,cron:parts.join(' ')};
}

export function scheduleService(databasePath,{address='127.0.0.1:17233',namespace='teleharness-stage',taskQueue='teleharness-stage-pipeline-v1',cli='/opt/temporal/temporal',execute=promisify(execFile)}={}) {
  const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
  const db=new DatabaseSync(databasePath);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS temporal_schedule_refs(
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_id TEXT NOT NULL, definition_id TEXT NOT NULL, version INTEGER NOT NULL,
      cron TEXT NOT NULL, timezone TEXT NOT NULL, overlap TEXT NOT NULL, catchup_seconds INTEGER NOT NULL,
      accepted INTEGER NOT NULL DEFAULT 0, UNIQUE(owner,request_id))`);
  const projection='SELECT id,definition_id AS definitionId,version,cron,timezone,overlap,catchup_seconds AS catchupSeconds FROM temporal_schedule_refs';
  function get(owner,id) {
    const row=db.prepare(projection+' WHERE owner=? AND id=?').get(owner,id);
    if(!row)throw new DefinitionError(404,'Расписание не найдено');
    return row;
  }
  function list(owner){return db.prepare(projection+' WHERE owner=? AND accepted=1 ORDER BY rowid DESC').all(owner);}
  function command(action,id,args=[]){
    return execute(cli,['schedule',action,'--schedule-id','teleharness-schedule-'+id,...args,'--address',address,'--namespace',namespace],{timeout:10000});
  }
  async function describe(row) {
    try {
      const {stdout}=await command('describe',row.id,['-o','json']);
      const {schedule,info}=JSON.parse(stdout);
      return {...row,paused:Boolean(schedule.state?.paused),nextTimes:info.futureActionTimes??[]};
    }catch{throw new DefinitionError(503,'Не удалось прочитать расписание из Temporal');}
  }
  async function create(owner,options) {
    const {definitionId,version,cron,timezone,overlap,catchupSeconds,requestId=randomUUID()}=scheduleOptions(options);
    db.prepare(`INSERT INTO temporal_schedule_refs(id,owner,request_id,definition_id,version,cron,timezone,overlap,catchup_seconds)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,request_id) DO NOTHING`).run(randomUUID(),owner,requestId,definitionId,version,cron,timezone,overlap,catchupSeconds);
    const {id,accepted}=db.prepare('SELECT id,accepted FROM temporal_schedule_refs WHERE owner=? AND request_id=?').get(owner,requestId);
    const row=get(owner,id);
    if(Object.entries({definitionId,version,cron,timezone,overlap,catchupSeconds}).some(([k,v])=>row[k]!==v))
      throw new DefinitionError(409,'Ключ запроса уже использован для другого расписания');
    if(!accepted) {
      try {
        await command('create',id,['--workflow-id','teleharness-scheduled-'+id,'--type','TeleharnessPipelineV1','--task-queue',taskQueue,
          '--input',JSON.stringify({launchRef:'schedule/'+id}),'--cron',cron,'--time-zone',timezone,
          '--catchup-window',catchupSeconds+'s','--overlap-policy',overlaps[overlap]]);
      } catch(error) {
        // Create can reach Temporal even when its acknowledgement is lost.
        if(!/already (exists|registered|running|started)/i.test(error.stderr??''))
          throw new DefinitionError(503,'Temporal не подтвердил создание расписания. Повторите с тем же ключом');
        await describe(row);
      }
      db.prepare('UPDATE temporal_schedule_refs SET accepted=1 WHERE id=?').run(id);
    }
    return describe(row);
  }
  async function setPaused(owner,id,paused) {
    const row=get(owner,id);
    try {await command('toggle',id,[paused?'--pause':'--unpause']);}
    catch{throw new DefinitionError(503,'Temporal не подтвердил смену состояния расписания');}
    return describe(row);
  }
  return {get,list,describe,create,setPaused};
}
