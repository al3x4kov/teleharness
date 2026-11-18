// FEAT-19.15: Codex text adapter — subscription only, no tools, limits → quota_wait.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {codexTextAdapter,CODEX_TEXT_ARGS,parseCodexEvents} from '../lib/temporal/codex-text.js';

const art=()=>mkdtempSync(path.join(os.tmpdir(),'codex-art-'));
const ok=JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Париж'}})+'\n'+JSON.stringify({type:'turn.completed'});
test('успех: текст из ответа сохраняется в артефакт, инструкция только в stdin, инструменты выключены',async()=>{
  const dir=art();let seen;
  const a=codexTextAdapter({models:['gpt-6-luna'],artifactDirectory:dir,run:async(bin,args,opt,stdin)=>{seen={args,opt,stdin};return {stdout:ok,stderr:''};}});
  const r=await a.execute({instruction:'Столица Франции?',model:'gpt-6-luna',timeoutSeconds:60});
  assert.equal(readFileSync(path.join(dir,r.receipt),'utf8'),'Париж');
  assert.equal(seen.stdin,'Столица Франции?');assert(!seen.args.join(' ').includes('Столица'));
  for(const f of ['shell_tool','unified_exec','apps','plugins','browser_use'])assert(seen.args.includes(f));
  assert(seen.args.includes('read-only'));assert(seen.args.includes('--ignore-user-config'));
  assert.equal(Object.keys(seen.opt.env).sort().join(','),'HOME,LANG,PATH');
  assert.equal(a.subscriptionOnly,true);assert.equal(a.textOnly,true);rmSync(dir,{recursive:true});
});
test('лимит подписки (в событиях или в ошибке процесса) → quota_wait, без артефакта',async()=>{
  const dir=art();
  const ev=codexTextAdapter({models:['m'],artifactDirectory:dir,run:async()=>({stdout:JSON.stringify({type:'turn.failed',error:{message:"You've hit your usage limit"}}),stderr:''})});
  assert.deepEqual(await ev.execute({instruction:'x',model:'m'}),{state:'quota_wait'});
  const proc=codexTextAdapter({models:['m'],artifactDirectory:dir,run:async()=>{throw Object.assign(new Error('exit 1'),{stderr:'rateLimitExceeded'});}});
  assert.deepEqual(await proc.execute({instruction:'x',model:'m'}),{state:'quota_wait'});rmSync(dir,{recursive:true});
});
test('негатив: неизвестная модель, пустой ответ, использованный инструмент, сбой — ошибка шага',async()=>{
  const dir=art();
  const a=m=>codexTextAdapter({models:['m'],artifactDirectory:dir,run:async()=>m});
  await assert.rejects(a({stdout:ok}).execute({instruction:'x',model:'gpt-x'}),/model unavailable/);
  await assert.rejects(a({stdout:JSON.stringify({type:'turn.completed'})}).execute({instruction:'x',model:'m'}),/no text/);
  await assert.rejects(a({stdout:JSON.stringify({type:'item.completed',item:{type:'command_execution'}})}).execute({instruction:'x',model:'m'}),/tool_used/);
  await assert.rejects(codexTextAdapter({models:['m'],artifactDirectory:dir,run:async()=>{throw new Error('ENOENT');}}).execute({instruction:'x',model:'m'}),/ENOENT/);
  rmSync(dir,{recursive:true});
});
test('модели читаются при каждом обращении (каталог обновляется без рестарта)',()=>{
  let list=['a'];const a=codexTextAdapter({models:()=>list,artifactDirectory:'/tmp'});assert.deepEqual(a.models,['a']);list=['a','b'];assert.deepEqual(a.models,['a','b']);
  assert.deepEqual(parseCodexEvents('мусор\n'+ok),{failed:null,message:'Париж'});
});
