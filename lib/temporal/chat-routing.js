// TASK-19.9. New-chat enrollment and pinned routing use independent switches.
import {execFile} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {promisify} from 'node:util';
import {setCapped} from '../capped-map.js';

const run=promisify(execFile);
const unavailable={code:'temporal_chat_adapter_unavailable',error:'Подписочный исполнитель Temporal для интерактивного чата пока недоступен'};
const journalError={code:'temporal_chat_ledger_unavailable',error:'Не удалось проверить исполнителя чата'};

export function newChatRouting({enabled=false,ledger=null}) {
  return {
    // The text-only model Activity cannot own an interactive chat.
    checkCreate(){return enabled?unavailable:null;},
    async checkTurn(owner,chat){
      if(!ledger)return null;
      try {
        const assigned=await ledger.get(owner,chat);
        if(assigned==='legacy')return null;
        if(assigned==='temporal')return unavailable;
        if(assigned==='foreign')return {status:404,code:'session_not_found',error:'session not found'};
      } catch {}
      return journalError;
    },
  };
}

export function chatRoutingForPortal({directory,stage,enabled,service}) {
  // Keep checking the same journal after disabling new-chat enrollment.
  const marker=path.join(directory,'temporal-chat-ledger-service');
  let recorded;
  try{recorded=readFileSync(marker,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(service && stage){
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(service) || (recorded && recorded!==service))
      throw Error('Invalid Temporal chat ownership service');
    if(!recorded){writeFileSync(marker,service,{flag:'wx',mode:0o600});recorded=service;}
  }
  let ledger=null;
  if(recorded){
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(recorded))throw Error('Invalid Temporal chat ownership service');
    const file=fileURLToPath(new URL('./chat-route.sql',import.meta.url));
    async function get(owner,chat){
      const result=await run('psql',['-XqAt','-v','ON_ERROR_STOP=1','-v','owner='+owner,'-v','chat='+chat,
        '-f',file],{timeout:3000,env:{...process.env,PGSERVICE:recorded}});
      return result.stdout.trim();
    }
    ledger={get};
  }
  return newChatRouting({enabled:stage && enabled,ledger});
}

// The authenticated sender of a pilot turn authorizes legacy recovery while its rights hold.
// A restart or cache eviction leaves the hub without that evidence.
export function chatRecoveryGuard({checkTurn,lookup,authorize}) {
  const senders=new Map();
  return {
    accepted(chat,user){setCapped(senders,chat,user);},
    async allowed(chat,caller){
      try {
        if(await checkTurn(caller ?? '',chat))return false;
        if(!lookup)return true;
        const record=await lookup(chat);
        if(!record)return false;
        if(!record.cohort)return true;
        const user=senders.get(chat);
        return Boolean(user && (!caller || caller===user) && await authorize(user,record.directory));
      } catch {return false;}
    },
  };
}
