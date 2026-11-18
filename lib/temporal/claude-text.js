// FEAT-19.5. Text-only Claude subscription transport; credentials never enter Temporal.
import {binDefaults} from "../paths.js";
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

function executeFile(command,args,options,instruction) {
  const promise=promisify(execFile)(command,args,options);
  // The process has already been spawned. A prompt must never appear in argv.
  promise.child.stdin.on('error',()=>{});
  promise.child.stdin.end(instruction);
  return promise;
}
// The installed official CLI reports login method and provider, but no live
// spending policy. No policy reader is configured unless the deployment has
// an authoritative supported source for this same subscription.
// FEAT-19.15: the server's long-lived subscription token has no user:profile
// scope, so the usage endpoint answers 403. `attested` = the owner confirmed in
// writing that Claude runs on the subscription only (U-2026-11-18 «по Claude и
// Codex используются подписки»). It is used ONLY when no usage reader exists;
// a reader that shows extra usage still blocks. Limits are then read from the
// CLI answer itself and turn into quota_wait (no retry on a paid path).
const LIMIT=/usage limit|limit reached|rate limit|rate_limit|overloaded_error|5-hour limit|weekly limit/i;
// bin: TELEHARNESS_CLAUDE_BIN or the CLI's default install path (~/.local/bin/claude).
export function claudeTextAdapter({token,artifactDirectory,usage,attested=false,run=executeFile,bin=process.env.TELEHARNESS_CLAUDE_BIN||binDefaults({platform:process.platform}).claudeBin}) {
  const models=['haiku','sonnet','opus'];
  async function check() {
    if (!usage) return attested && token ? 'ready' : 'subscription_policy_unverified';
    let policy;
    try { if(token && usage) policy=await usage(); } catch {}
    if (policy?.extra_usage?.is_enabled!==false || !Number.isFinite(policy.five_hour?.utilization) ||
        !Number.isFinite(policy.seven_day?.utilization))
      return 'subscription_policy_unverified';
    const windows=Object.values(policy).filter(w=>Number.isFinite(w?.utilization));
    return windows.some(w=>w.utilization>=100) ? 'quota_wait' : 'ready';
  }
  async function execute({instruction,model,timeoutSeconds,signal}) {
    if (!models.includes(model) || await check()!=='ready') throw new Error('Claude unavailable');
    const directory=await mkdtemp(path.join(os.tmpdir(),'teleharness-model-'));
    try {
      const env={HOME:directory,PATH:'/usr/bin:/bin',LANG:'C.UTF-8',CLAUDE_CODE_OAUTH_TOKEN:token,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
      const args=['--safe-mode','--restricted','-p','--tools','','--strict-mcp-config',
        '--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--no-session-persistence',
        '--settings','{"disableAllHooks":true}','--model',model,'--output-format','json'];
      signal?.throwIfAborted();
      let stdout;
      try {
        ({stdout}=await run(bin,args,{env,cwd:directory,signal,
          timeout:Math.min(Math.max(timeoutSeconds || 120,1),600)*1000,maxBuffer:1024*1024},instruction));
      } catch(error) {
        if(LIMIT.test(String(error.stdout??'')+String(error.stderr??''))) return {state:'quota_wait'};
        throw error;
      }
      let result;
      try {result=JSON.parse(stdout);} catch {if(LIMIT.test(String(stdout))) return {state:'quota_wait'};throw new Error('Claude answer is not JSON');}
      if(result.is_error && LIMIT.test(String(result.result??'')+String(result.subtype??''))) return {state:'quota_wait'};
      if(result.is_error || typeof result.result!=='string' || !result.result.length)
        throw new Error('Claude returned no text');
      await mkdir(artifactDirectory,{recursive:true,mode:0o700});
      const receipt=randomUUID();
      await writeFile(path.join(artifactDirectory,receipt),result.result,{flag:'wx',mode:0o600});
      return {receipt};
    } finally {await rm(directory,{recursive:true,force:true});}
  }
  return {models,subscriptionOnly:true,textOnly:true,check,execute};
}
