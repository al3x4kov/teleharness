// FEAT-19.15. Text-only Codex step over the owner's ChatGPT subscription
// (codex exec, auth_mode chatgpt, no API key). Tools are switched off and the
// sandbox is read-only in an empty temp folder; the prompt goes via stdin,
// never argv. A usage/rate limit returns quota_wait — the workflow sleeps and
// retries, it never falls back to a paid path.
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

export const CODEX_TEXT_ARGS=['exec','--ignore-user-config','--ignore-rules','--ephemeral','--skip-git-repo-check',
  '--sandbox','read-only','--disable','shell_tool','--disable','unified_exec','--disable','apps','--disable','plugins',
  '--disable','browser_use','--disable','in_app_browser','--disable','sleep_tool','--json'];
const LIMIT=/usage limit|rate limit|usageLimitExceeded|rateLimitExceeded|quota/i;

function executeFile(command,args,options,instruction){
  const promise=promisify(execFile)(command,args,options);
  promise.child.stdin.on('error',()=>{});
  promise.child.stdin.end(instruction);
  return promise;
}
export function parseCodexEvents(stdout){
  let failed=null,message='';
  for(const line of String(stdout).split('\n')){
    let e;try{e=JSON.parse(line);}catch{continue;}
    if(e.type==='turn.failed'||e.type==='error')failed=e.error?.message??e.message??'error';
    if(e.type==='item.completed'&&e.item?.type==='agent_message'&&typeof e.item.text==='string')message=e.item.text;
    if(e.type==='item.completed'&&['command_execution','file_change','mcp_tool_call','web_search'].includes(e.item?.type))failed='tool_used';
  }
  return {failed,message};
}
export function codexTextAdapter({models,artifactDirectory,bin=process.env.TELEHARNESS_CODEX_BIN||'codex',home=os.homedir(),run=executeFile}){
  const list=()=>typeof models==='function'?models():models;
  async function check(){return 'ready';}
  async function execute({instruction,model,timeoutSeconds,signal}){
    if(!list().includes(model))throw new Error('Codex model unavailable');
    const directory=await mkdtemp(path.join(os.tmpdir(),'teleharness-codex-'));
    const out=path.join(directory,'last-message.txt');
    try{
      signal?.throwIfAborted();
      let stdout='',stderr='';
      try{
        ({stdout,stderr}=await run(bin,[...CODEX_TEXT_ARGS,'-C',directory,'-m',model,'-o',out,'-'],
          {env:{HOME:home,PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},cwd:directory,signal,
           timeout:Math.min(Math.max(timeoutSeconds||120,1),600)*1000,maxBuffer:4*1024*1024},instruction));
      }catch(error){
        if(LIMIT.test(String(error.stdout??'')+String(error.stderr??'')+String(error.message??'')))return {state:'quota_wait'};
        throw error;
      }
      const {failed,message}=parseCodexEvents(stdout);
      if(failed&&LIMIT.test(failed+stderr))return {state:'quota_wait'};
      if(failed)throw new Error('Codex step failed: '+failed);
      let text=message;
      try{text=(await readFile(out,'utf8'))||message;}catch{}
      if(!text.trim())throw new Error('Codex returned no text');
      await mkdir(artifactDirectory,{recursive:true,mode:0o700});
      const receipt=randomUUID();
      await writeFile(path.join(artifactDirectory,receipt),text,{flag:'wx',mode:0o600});
      return {receipt};
    }finally{await rm(directory,{recursive:true,force:true});}
  }
  return {get models(){return list();},subscriptionOnly:true,textOnly:true,check,execute};
}
