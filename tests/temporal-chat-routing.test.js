import test from 'node:test';
import assert from 'node:assert/strict';
import {newChatRouting} from '../lib/temporal/chat-routing.js';

test('rollback changes only new assignments and never takes a pinned turn into legacy',async()=>{
  const calls=[];
  const routing=newChatRouting({enabled:false,ledger:{
    get:async(owner,chat)=>{calls.push([owner,chat]);return chat==='old'?'legacy':'temporal';},
    register:async()=>{throw Error('must not register on read');}
  }});
  assert.equal(await routing.checkTurn('alice','old'),null);
  assert.equal((await routing.checkTurn('alice','pinned')).code,'temporal_chat_adapter_unavailable');
  assert.deepEqual(calls,[['alice','old'],['alice','pinned']]);
});
test('an unreadable active ledger fails closed',async()=>{
  const routing=newChatRouting({ledger:{get:async()=>{throw Error('db unavailable');}}});
  assert.equal((await routing.checkTurn('alice','pinned')).code,'temporal_chat_ledger_unavailable');
});

test('новая группа v2: recovery проверяет последние подтвержденные права, теряет разрешение после revoke и рестарта',async()=>{
  const {chatRecoveryGuard}=await import('../lib/temporal/chat-routing.js');
  let enabled=true,assignment=null;
  const deps={checkTurn:async()=>assignment,lookup:async id=>id==='old'?{cohort:false}:{cohort:true,directory:'owner-dir'},
    authorize:(user,dir)=>enabled && user==='alice' && dir==='owner-dir'};
  const guard=chatRecoveryGuard(deps);
  assert.equal(await guard.allowed('new'),false);
  assert.equal(await guard.allowed('old'),true);
  guard.accepted('new','alice');
  assert.equal(await guard.allowed('new'),true);
  enabled=false;
  assert.equal(await guard.allowed('new'),false);
  enabled=true;
  assert.equal(await chatRecoveryGuard(deps).allowed('new'),false);
  assignment={code:'temporal_chat_ledger_unavailable'};
  assert.equal(await guard.allowed('old'),false);
});
