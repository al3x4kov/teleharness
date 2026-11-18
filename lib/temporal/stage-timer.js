// FEAT-19.6. Opt-in adapter for the isolated Linux staging namespace.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { DefinitionError } from "./definitions.js";

const execute = promisify(execFile);
export function stageTimerStarter(databasePath) {
  let db;
  async function open() {
    if (!db) {
      const {DatabaseSync} = await import("node:sqlite");
      if (!db) {
        const connection = new DatabaseSync(databasePath);
        connection.exec(`CREATE TABLE IF NOT EXISTS starts (
          owner TEXT NOT NULL, request_id TEXT NOT NULL, definition_id TEXT NOT NULL,
          version INTEGER NOT NULL, workflow_id TEXT NOT NULL UNIQUE, accepted INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(owner, request_id))`);
        db = connection;
      }
    }
    return db;
  }
  async function start({owner, requestId, definitionId, version, seconds}) {
    await open();
    const inserted = db.prepare("INSERT INTO starts(owner,request_id,definition_id,version,workflow_id) VALUES(?,?,?,?,?) ON CONFLICT(owner,request_id) DO NOTHING")
      .run(owner, requestId, definitionId, version, randomUUID()).changes;
    const row = db.prepare("SELECT * FROM starts WHERE owner=? AND request_id=?").get(owner, requestId);
    if (row.definition_id !== definitionId || row.version !== version)
      throw new DefinitionError(409, "Этот ключ уже использован для другой версии");
    const workflowId = row.workflow_id;
    if (!row.accepted) {
      const args = inserted
        ? ["start","--type","TeleharnessTimerStepV1","--task-queue","teleharness-stage-timers-v1","--input",String(seconds),"--id-reuse-policy","RejectDuplicate"]
        : ["describe"];
      try {
        await execute("/opt/temporal/temporal", ["workflow", ...args, "--workflow-id",workflowId,
          "--address","127.0.0.1:17233","--namespace","teleharness-stage"], {timeout:10000});
      } catch {
        throw new DefinitionError(503, "Статус запуска уточняется. Повторите запрос с прежним ключом");
      }
      db.prepare("UPDATE starts SET accepted=1 WHERE workflow_id=?").run(workflowId);
    }
    return {workflowId, definitionId, version};
  }
  async function list(owner) {
    await open();
    return db.prepare(`SELECT workflow_id AS workflowId, definition_id AS definitionId,
      version, accepted FROM starts WHERE owner=? ORDER BY rowid DESC`).all(owner);
  }
  async function lookup(owner, workflowId) {
    await open();
    return db.prepare("SELECT definition_id AS definitionId,version FROM starts WHERE owner=? AND workflow_id=?").get(owner,workflowId);
  }
  async function describe(workflowId) {
    try {
      const {stdout}=await execute("/opt/temporal/temporal",["workflow","describe","--workflow-id",workflowId,
        "--address","127.0.0.1:17233","--namespace","teleharness-stage","-o","json"],{timeout:10000});
      const info=JSON.parse(stdout).workflowExecutionInfo;
      return {workflowId,status:info.status.replace(/^WORKFLOW_EXECUTION_STATUS_/,""),startTime:info.startTime,closeTime:info.closeTime};
    } catch {
      throw new DefinitionError(503,"Не удалось получить состояние из Temporal");
    }
  }
  return {startTimer:start,listRuns:list,lookupRun:lookup,describeRun:describe};
}
