// @suite server
// TASK-19.9. Opt-in new chat routing must fail before provisioning or dispatch.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnPortal} from './helpers/spawn-server.mjs';
import {startFakeOpencode} from './helpers/fake-opencode.mjs';

test('новый Temporal-чат без подписочного chat-адаптера отклонён; старый обслуживается',async()=>{
  const up=await startFakeOpencode();
  const token=randomUUID().repeat(2);
  const srv=await spawnPortal({upstream:up.url,env:{TELEHARNESS_ENV:'stand',TELEHARNESS_ADMIN_TOKEN:token,TELEHARNESS_TEMPORAL_NEW_CHATS:'1'}});
  try {
    up.route('POST','/session',()=>({json:{id:'unexpected',directory:srv.tmp.home}}));
    up.state.sessions.push({id:'existing',directory:srv.tmp.home});
    const headers={authorization:'Bearer '+token,'content-type':'application/json'};
    const result=await fetch(srv.base+'/teleharness/api/session',{method:'POST',headers,body:'{}'});
    assert.equal(result.status,503);
    assert.equal((await result.json()).code,'temporal_chat_adapter_unavailable');
    assert.equal(up.requests.filter(x=>x.method==='POST' && x.path==='/session').length,0);
    const history=await fetch(srv.base+'/teleharness/api/session/existing/message',{headers});
    assert.equal(history.status,200);
    const turn=await fetch(srv.base+'/teleharness/api/session/existing/prompt',{method:'POST',headers,body:JSON.stringify({parts:[{type:'text',text:'test'}]})});
    assert.equal(turn.status,204);
    assert.ok(up.requests.some(x=>x.path==='/session/existing/prompt_async'));
  } finally {await srv.stop();await up.close();}
});

test('после отката создание legacy-сессии не зависит от записи в журнал; отправка требует проверки',async()=>{
  const up=await startFakeOpencode();
  const token=randomUUID().repeat(2);
  const srv=await spawnPortal({upstream:up.url,env:{TELEHARNESS_ENV:'stand',TELEHARNESS_ADMIN_TOKEN:token,
    TELEHARNESS_TEMPORAL_CHAT_PGSERVICE:'deliberately_absent_test_service',PGSERVICEFILE:'/dev/null'}});
  try {
    up.route('POST','/session',()=>({json:{id:'created_once',directory:srv.tmp.home}}));
    const headers={authorization:'Bearer '+token,'content-type':'application/json'};
    const created=await fetch(srv.base+'/teleharness/api/session',{method:'POST',headers,body:'{}'});
    assert.equal(created.status,200);
    assert.equal((await created.json()).id,'created_once');
    assert.equal(up.requests.filter(x=>x.method==='POST' && x.path==='/session').length,1);
    const turn=await fetch(srv.base+'/teleharness/api/session/created_once/prompt',{method:'POST',headers,body:'{}'});
    assert.equal(turn.status,503);
    assert.equal((await turn.json()).code,'temporal_chat_ledger_unavailable');
    assert.ok(!up.requests.some(x=>x.path==='/session/created_once/prompt_async'));
  } finally{await srv.stop();await up.close();}
});

test('opt-in v2: один ID для повтора нового хода; старый чат сохраняет контракт',async()=>{
  const {startFakeOpencodeV2}=await import('./helpers/fake-opencode-v2.mjs');
  const password=randomUUID(),token=randomUUID(),cutoff=new Date(Date.now()-1000).toISOString();
  const up=await startFakeOpencodeV2({password,sessions:[{id:'ses_old',location:{directory:'/tmp'},time:{created:1}}]});
  const srv=await spawnPortal({upstream:up.url,env:{TELEHARNESS_ENV:'stand',TELEHARNESS_ADMIN_TOKEN:token,TELEHARNESS_OC_API:'v2',TELEHARNESS_OC_PASSWORD:password,TELEHARNESS_TEMPORAL_TURN_IDS_FROM:cutoff}});
  try{
    const headers={authorization:'Bearer '+token,'content-type':'application/json','x-teleharness-turn-id':'a'.repeat(32)};
    const create=await fetch(srv.base+'/teleharness/api/session',{method:'POST',headers,body:'{}'});
    const rec=await create.json();assert.equal(rec.stableTurnIds,true);
    for(const id of [rec.id,rec.id,'ses_old']){
      const result=await fetch(srv.base+'/teleharness/api/session/'+id+'/prompt',{method:'POST',headers,body:JSON.stringify({parts:[{type:'text',text:'fixture'}]})});
      assert.equal(result.status,204);
    }
    const bodies=up.requests.filter(r=>r.method==='POST' && r.path.endsWith('/prompt')).map(r=>r.body);
    assert.match(bodies[0].id,/^msg_[a-f0-9]{32}$/);
    assert.equal(bodies[0].id,bodies[1].id);assert.equal(bodies[2].id,undefined);
  }finally{await srv.stop();await up.close();}
});
