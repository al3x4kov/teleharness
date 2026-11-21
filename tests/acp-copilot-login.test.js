// FEAT-20.4
import test from "node:test";
import assert from "node:assert/strict";
import {PassThrough} from "node:stream";
import {EventEmitter} from "node:events";
import {CopilotLoginSessions} from "../lib/acp-copilot-login.js";
test("код устройства видит только владелец и только до завершения процесса",()=>{
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill(){}});
  const sessions=new CopilotLoginSessions(()=>child);
  sessions.start("a");
  child.stderr.write("To authenticate, visit https://github.com/login/device and enter code ABCD-");
  child.stderr.write("EFGH\n");
  assert.deepEqual(sessions.get("a"),{status:"awaiting-device",code:"ABCD-EFGH",url:"https://github.com/login/device"});
  assert.deepEqual(sessions.get("b"),{status:"idle"});
  child.emit("close",0);
  assert.deepEqual(sessions.get("a"),{status:"ready"});
});
