// TASK-19.8. Result contents stay outside Temporal history and the list endpoint.
import {open} from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import {DefinitionError} from "./definitions.js";

export function pipelineArtifacts(db,root) {
  db.exec(`CREATE TABLE IF NOT EXISTS model_results(workflow_id TEXT NOT NULL,step TEXT NOT NULL,
    receipt TEXT NOT NULL,PRIMARY KEY(workflow_id,step))`);
  // FEAT-19.16: the chat of a model step and the run folder (stable per run).
  db.exec(`CREATE TABLE IF NOT EXISTS step_chats(workflow_id TEXT NOT NULL,step TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(workflow_id,step));
    CREATE TABLE IF NOT EXISTS run_folders(workflow_id TEXT PRIMARY KEY,folder TEXT NOT NULL)`);
  const select=db.prepare("SELECT receipt FROM model_results WHERE workflow_id=? AND step=?");
  return {
    remember(id,step,receipt) {
      if(!/^[a-zA-Z0-9_-]{1,160}$/.test(receipt))throw Error("Invalid receipt");
      db.prepare("INSERT INTO model_results VALUES(?,?,?) ON CONFLICT DO NOTHING").run(id,step,receipt);
      if(select.get(id,step)?.receipt!==receipt)throw Error("Receipt conflict");
    },
    rememberChat(id,step,sid){db.prepare("INSERT INTO step_chats VALUES(?,?,?) ON CONFLICT(workflow_id,step) DO UPDATE SET session_id=excluded.session_id").run(id,step,sid);},
    chats:id=>Object.fromEntries(db.prepare("SELECT step,session_id FROM step_chats WHERE workflow_id=?").all(id).map(x=>[x.step,x.session_id])),
    runFolder(id,make){
      const row=db.prepare("SELECT folder FROM run_folders WHERE workflow_id=?").get(id);
      if(row)return row.folder;
      if(!make)return null;
      db.prepare("INSERT INTO run_folders VALUES(?,?) ON CONFLICT DO NOTHING").run(id,make());
      return db.prepare("SELECT folder FROM run_folders WHERE workflow_id=?").get(id).folder;
    },
    steps:id=>db.prepare("SELECT step FROM model_results WHERE workflow_id=? ORDER BY step").all(id).map(x=>x.step),
    // FEAT-19.32: copy reused step receipts/chats and inherit source run folder (idempotent).
    inheritFrom(sourceId, targetId, reusedSteps = []) {
      const folder = db.prepare("SELECT folder FROM run_folders WHERE workflow_id=?").get(sourceId)?.folder;
      if (folder) db.prepare("INSERT INTO run_folders VALUES(?,?) ON CONFLICT DO NOTHING").run(targetId, folder);
      const selResult = db.prepare("SELECT receipt FROM model_results WHERE workflow_id=? AND step=?");
      const insResult = db.prepare("INSERT INTO model_results VALUES(?,?,?) ON CONFLICT DO NOTHING");
      const selChat = db.prepare("SELECT session_id FROM step_chats WHERE workflow_id=? AND step=?");
      const insChat = db.prepare("INSERT INTO step_chats VALUES(?,?,?) ON CONFLICT DO NOTHING");
      for (const step of reusedSteps) {
        const res = selResult.get(sourceId, step);
        if (res?.receipt) insResult.run(targetId, step, res.receipt);
        const chat = selChat.get(sourceId, step);
        if (chat?.session_id) insChat.run(targetId, step, chat.session_id);
      }
      return folder ?? null;
    },
    async read(id,step) {
      const row=select.get(id,step);
      if(!row)throw new DefinitionError(404,"Результат не найден");
      const file=await open(path.join(root,row.receipt),constants.O_RDONLY|constants.O_NOFOLLOW);
      try {
        const meta=await file.stat();
        if(!meta.isFile() || meta.size>1024*1024)throw new DefinitionError(503,"Результат недоступен");
        return await file.readFile("utf8");
      } finally {await file.close();}
    }
  };
}
