// просмотр и управление сторонними workflow Temporal на портале
// (list, describe+history, start, signal, query, reset, cancel, terminate).
// Все вызовы Temporal CLI идут через execFile с массивом аргументов `--flag=value`
// (без shell и без flag-инъекции). Zero-dep.
import { execFile } from "node:child_process";
import { resolveTemporalCli } from "./cli.js";
import { buildTemporalUiUrl } from "./command-temporal.js";

export const PORTAL_WORKFLOW_TYPE = "TeleharnessPipelineV1";
const VALID_STATUSES = new Set([
  "Running",
  "Completed",
  "Failed",
  "Canceled",
  "Terminated",
  "ContinuedAsNew",
  "TimedOut",
]);
const VALID_RESET_TYPES = new Set([
  "FirstWorkflowTask",
  "LastWorkflowTask",
  "LastContinuedAsNew",
]);
const VALID_REAPPLY_EXCLUDE = new Set(["All", "Signal", "Update"]);
const ADDR_RE = /^[a-zA-Z0-9._:\[\]-]{1,200}$/;
const NS_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const CTRL_RE = /[\x00-\x1f\x7f]/;
const DURATION_RE = /^(\d+(ms|s|m|h))+$/;
const MAX_JSON_INPUT_BYTES = 64 * 1024;
const MAX_PAYLOAD_DISPLAY_CHARS = 64 * 1024;

function httpErr(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function normalizeExecutionStatus(raw) {
  if (!raw) return "UNKNOWN";
  const s = String(raw).toUpperCase().replace(/^WORKFLOW_EXECUTION_STATUS_/, "");
  if (s === "CANCELLED") return "CANCELED";
  return s;
}

function escapeVisibilityString(val) {
  return String(val).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function validateTarget({ address, namespace, defaultAddress, defaultNamespace }) {
  const addr = String(address ?? "").trim() || String(defaultAddress ?? "127.0.0.1:7233").trim();
  const ns = String(namespace ?? "").trim() || String(defaultNamespace ?? "default").trim();
  if (!ADDR_RE.test(addr)) throw httpErr(400, "Некорректный адрес Temporal (ожидается host:port)");
  if (!NS_RE.test(ns)) throw httpErr(400, "Некорректное имя namespace Temporal");
  return { address: addr, namespace: ns };
}

export function validateSafeString(raw, label, { required = true, max = 256, allowNewlines = false } = {}) {
  const s = raw == null ? "" : String(raw).trim();
  if (!s) {
    if (required) throw httpErr(400, `Поле «${label}» обязательно`);
    return "";
  }
  if (s.length > max) throw httpErr(400, `Поле «${label}» слишком длинное (макс. ${max})`);
  const re = allowNewlines ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : CTRL_RE;
  if (re.test(s)) throw httpErr(400, `Поле «${label}» содержит недопустимые управляющие символы`);
  return s;
}

export function validateJsonInput(raw, label = "input") {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (Buffer.byteLength(trimmed, "utf8") > MAX_JSON_INPUT_BYTES) {
      throw httpErr(400, `Поле «${label}» превышает лимит ${MAX_JSON_INPUT_BYTES} байт`);
    }
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      throw httpErr(400, `Некорректный JSON в поле «${label}»`);
    }
  }
  const serialized = JSON.stringify(raw);
  if (Buffer.byteLength(serialized, "utf8") > MAX_JSON_INPUT_BYTES) {
    throw httpErr(400, `Поле «${label}» превышает лимит ${MAX_JSON_INPUT_BYTES} байт`);
  }
  return serialized;
}

export function validateDuration(raw, label) {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw <= 365 * 86400) {
    return `${raw}s`;
  }
  const s = String(raw).trim();
  if (!s) return "";
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n > 0 && n <= 365 * 86400) return `${n}s`;
  }
  if (!DURATION_RE.test(s) || s.length > 32) {
    throw httpErr(400, `Некорректная длительность в поле «${label}» (например, 30s, 5m, 1h)`);
  }
  return s;
}

export function buildVisibilityQuery({ status, workflowType, taskQueue, excludePortal = false, query } = {}) {
  const custom = validateSafeString(query, "query", { required: false, max: 1000 });
  if (custom) return custom;
  const clauses = [];
  if (status) {
    const st = String(status).trim();
    const mapped =
      VALID_STATUSES.has(st)
        ? st
        : [...VALID_STATUSES].find((v) => v.toUpperCase() === st.toUpperCase()) || null;
    if (!mapped) throw httpErr(400, `Неизвестный статус фильтра: ${st}`);
    clauses.push(`ExecutionStatus = "${mapped}"`);
  }
  if (workflowType) {
    const wt = validateSafeString(workflowType, "workflowType", { required: false, max: 200 });
    if (wt) clauses.push(`WorkflowType = "${escapeVisibilityString(wt)}"`);
  }
  if (taskQueue) {
    const tq = validateSafeString(taskQueue, "taskQueue", { required: false, max: 200 });
    if (tq) clauses.push(`TaskQueue = "${escapeVisibilityString(tq)}"`);
  }
  if (excludePortal) {
    clauses.push(`WorkflowType != "${PORTAL_WORKFLOW_TYPE}"`);
  }
  return clauses.join(" AND ");
}

function defaultExecute(bin, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const code = typeof err.code === "number" ? err.code : 1;
        return resolve({ ok: false, code, stdout: String(stdout ?? ""), stderr: String(stderr || err.message || "") });
      }
      resolve({ ok: true, code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function safeJsonParse(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function decodePayloads(payloadObj) {
  const list = Array.isArray(payloadObj)
    ? payloadObj
    : Array.isArray(payloadObj?.payloads)
      ? payloadObj.payloads
      : null;
  if (!list || !list.length) return null;
  const decoded = list.map((item) => {
    if (!item || typeof item !== "object" || typeof item.data !== "string") return item;
    let text;
    try {
      text = Buffer.from(item.data, "base64").toString("utf8");
    } catch {
      return item.data;
    }
    let encoding = "";
    if (typeof item.metadata?.encoding === "string") {
      try {
        encoding = Buffer.from(item.metadata.encoding, "base64").toString("utf8");
      } catch {
        encoding = item.metadata.encoding;
      }
    }
    if (encoding.includes("json") || /^[\s]*[\[{"]/.test(text) || /^(true|false|null|-?\d)/.test(text)) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  });
  return decoded.length === 1 ? decoded[0] : decoded;
}

function clampDisplayValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    return value.length > MAX_PAYLOAD_DISPLAY_CHARS
      ? value.slice(0, MAX_PAYLOAD_DISPLAY_CHARS) + "\n…[усечено]"
      : value;
  }
  const s = JSON.stringify(value);
  if (s && s.length > MAX_PAYLOAD_DISPLAY_CHARS) {
    return s.slice(0, MAX_PAYLOAD_DISPLAY_CHARS) + "\n…[усечено]";
  }
  return value;
}

function extractFailure(obj) {
  if (!obj || typeof obj !== "object") return null;
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 8) return null;
    if (node.failure && typeof node.failure === "object") {
      const message = String(node.failure.message ?? "").trim();
      const cause = String(node.failure.cause?.message ?? "").trim() || null;
      const stackTrace = String(node.failure.stackTrace ?? "").trim().slice(0, 4096) || null;
      if (message || cause) return { message: message || cause, cause: message && cause ? cause : null, stackTrace };
    }
    for (const val of Object.values(node)) {
      if (Array.isArray(val)) {
        for (let i = val.length - 1; i >= 0; i--) {
          const hit = walk(val[i], depth + 1);
          if (hit) return hit;
        }
      } else if (val && typeof val === "object") {
        const hit = walk(val, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(obj);
}

function shortEventType(raw) {
  return String(raw ?? "")
    .replace(/^EVENT_TYPE_/, "")
    .split("_")
    .filter(Boolean)
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join("");
}

function summarizeEvent(ev) {
  const t = String(ev?.eventType ?? "");
  if (t === "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED") {
    const a = ev.workflowExecutionStartedEventAttributes;
    return [a?.workflowType?.name, a?.taskQueue?.name ? `очередь ${a.taskQueue.name}` : ""].filter(Boolean).join(" · ");
  }
  if (t === "EVENT_TYPE_ACTIVITY_TASK_SCHEDULED") {
    const a = ev.activityTaskScheduledEventAttributes;
    return [a?.activityType?.name, a?.activityId ? `#${a.activityId}` : ""].filter(Boolean).join(" ");
  }
  if (t === "EVENT_TYPE_ACTIVITY_TASK_FAILED") {
    return ev.activityTaskFailedEventAttributes?.failure?.message || "Ошибка активности";
  }
  if (t === "EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED") {
    const a = ev.workflowExecutionSignaledEventAttributes;
    return a?.signalName ? `сигнал «${a.signalName}»` : "Сигнал";
  }
  if (t === "EVENT_TYPE_WORKFLOW_EXECUTION_FAILED") {
    return ev.workflowExecutionFailedEventAttributes?.failure?.message || "Workflow завершился с ошибкой";
  }
  if (t === "EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED") {
    return ev.workflowExecutionTerminatedEventAttributes?.reason || "Принудительно остановлен";
  }
  if (t === "EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED") {
    return "Отменён";
  }
  if (t === "EVENT_TYPE_TIMER_STARTED") {
    const d = ev.timerStartedEventAttributes?.startToFireTimeout;
    return d ? `таймер ${d}` : "Таймер";
  }
  if (t === "EVENT_TYPE_WORKFLOW_TASK_COMPLETED") {
    const id = ev.workflowTaskCompletedEventAttributes?.identity;
    return id ? `воркер ${id}` : "Задача workflow завершена";
  }
  return "";
}

function normalizeListItem(raw, { uiBase, namespace }) {
  const wfId = raw?.execution?.workflowId ?? raw?.workflowId ?? "";
  const runId = raw?.execution?.runId ?? raw?.runId ?? "";
  const workflowType = raw?.type?.name ?? raw?.workflowType ?? "";
  const status = normalizeExecutionStatus(raw?.status);
  const taskQueue = typeof raw?.taskQueue === "string" ? raw.taskQueue : raw?.taskQueue?.name ?? "";
  return {
    workflowId: wfId,
    runId,
    workflowType,
    status,
    taskQueue,
    startTime: raw?.startTime ?? null,
    closeTime: raw?.closeTime ?? null,
    executionDuration: raw?.executionDuration ?? null,
    historyLength: raw?.historyLength != null ? Number(raw.historyLength) : null,
    isPortal: workflowType === PORTAL_WORKFLOW_TYPE,
    uiUrl: uiBase ? buildTemporalUiUrl(uiBase, namespace, wfId, runId) : null,
  };
}

function cliErrorToHttp(res, fallback) {
  const msg = String(res?.stderr || res?.stdout || fallback || "Ошибка Temporal CLI").trim();
  if (/not found|unknown workflow|workflow execution already completed|already completed/i.test(msg)) {
    const status = /not found|unknown workflow/i.test(msg) ? 404 : 409;
    return httpErr(status, msg.slice(0, 600));
  }
  if (/connection refused|context deadline|unavailable|dial tcp/i.test(msg)) {
    return httpErr(503, `Temporal недоступен: ${msg.slice(0, 400)}`);
  }
  return httpErr(502, msg.slice(0, 600));
}

export class ExternalWorkflowsClient {
  constructor({
    cli = "",
    address = "127.0.0.1:7233",
    namespace = "default",
    uiBase = "",
    execute = defaultExecute,
  } = {}) {
    this.cli = cli;
    this.address = address;
    this.namespace = namespace;
    this.uiBase = String(uiBase ?? "").trim();
    this.execute = execute;
  }

  _bin() {
    return resolveTemporalCli(this.cli);
  }

  _connArgs({ address, namespace }) {
    const t = validateTarget({
      address,
      namespace,
      defaultAddress: this.address,
      defaultNamespace: this.namespace,
    });
    return {
      ...t,
      args: [`--address=${t.address}`, `--namespace=${t.namespace}`],
    };
  }

  async listWorkflows({ address, namespace, status, workflowType, taskQueue, excludePortal = false, query, limit = 50 } = {}) {
    const conn = this._connArgs({ address, namespace });
    const lim = Math.max(1, Math.min(200, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 50));
    const queryUsed = buildVisibilityQuery({ status, workflowType, taskQueue, excludePortal, query });
    const args = ["workflow", "list", ...conn.args, `--limit=${lim}`, "--output=json"];
    if (queryUsed) args.push(`--query=${queryUsed}`);
    const res = await this.execute(this._bin(), args);
    if (!res.ok) throw cliErrorToHttp(res, "Не удалось получить список workflow Temporal");
    const parsed = safeJsonParse(res.stdout);
    const rawList = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.executions) ? parsed.executions : [];
    const items = rawList
      .map((item) => normalizeListItem(item, { uiBase: this.uiBase, namespace: conn.namespace }))
      .filter((x) => x.workflowId);
    return {
      items,
      address: conn.address,
      namespace: conn.namespace,
      uiBase: this.uiBase || null,
      queryUsed: queryUsed || null,
    };
  }

  async describeWorkflow({ address, namespace, workflowId, runId, includeHistory = true, historyLimit = 200 } = {}) {
    const conn = this._connArgs({ address, namespace });
    const wfId = validateSafeString(workflowId, "workflowId", { required: true, max: 256 });
    const rId = validateSafeString(runId, "runId", { required: false, max: 128 });
    const descArgs = ["workflow", "describe", ...conn.args, `--workflow-id=${wfId}`, "--output=json"];
    if (rId) descArgs.push(`--run-id=${rId}`);
    const descRes = await this.execute(this._bin(), descArgs);
    if (!descRes.ok) throw cliErrorToHttp(descRes, "Не удалось получить описание workflow");
    const desc = safeJsonParse(descRes.stdout);
    if (!desc || typeof desc !== "object") throw httpErr(502, "Некорректный JSON-ответ от temporal workflow describe");

    const info = desc.workflowExecutionInfo ?? desc;
    const actualRunId = info?.execution?.runId ?? rId ?? "";
    const workflow = normalizeListItem(
      {
        ...info,
        taskQueue: info?.taskQueue ?? desc.executionConfig?.taskQueue?.name ?? "",
      },
      { uiBase: this.uiBase, namespace: conn.namespace },
    );
    if (!workflow.workflowId) workflow.workflowId = wfId;
    if (!workflow.runId) workflow.runId = actualRunId;

    const pendingActivities = Array.isArray(desc.pendingActivities)
      ? desc.pendingActivities.map((a) => ({
          activityId: a.activityId ?? "",
          activityType: a.activityType?.name ?? a.activityType ?? "",
          state: String(a.state ?? "").replace(/^PENDING_ACTIVITY_STATE_/, ""),
          attempt: a.attempt ?? 1,
          lastFailure: a.lastFailure?.message ?? null,
        }))
      : [];

    let input = null;
    let result = desc.result !== undefined ? clampDisplayValue(desc.result) : null;
    if (result === null && desc.closeEvent?.workflowExecutionCompletedEventAttributes?.result) {
      result = clampDisplayValue(decodePayloads(desc.closeEvent.workflowExecutionCompletedEventAttributes.result));
    }
    let failure = extractFailure(desc.closeEvent) ?? extractFailure(desc);
    let events = [];
    let totalEvents = workflow.historyLength ?? 0;
    const resetPoints = [];

    if (includeHistory) {
      const showArgs = ["workflow", "show", ...conn.args, `--workflow-id=${wfId}`, "--output=json"];
      if (actualRunId) showArgs.push(`--run-id=${actualRunId}`);
      const showRes = await this.execute(this._bin(), showArgs);
      if (showRes.ok) {
        const showJson = safeJsonParse(showRes.stdout);
        const rawEvents = Array.isArray(showJson?.events) ? showJson.events : Array.isArray(showJson) ? showJson : [];
        totalEvents = rawEvents.length;
        const started = rawEvents.find((e) => e.eventType === "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED");
        if (started?.workflowExecutionStartedEventAttributes?.input) {
          input = clampDisplayValue(decodePayloads(started.workflowExecutionStartedEventAttributes.input));
        }
        if (result === null) {
          const completed = rawEvents.find((e) => e.eventType === "EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED");
          if (completed?.workflowExecutionCompletedEventAttributes?.result) {
            result = clampDisplayValue(decodePayloads(completed.workflowExecutionCompletedEventAttributes.result));
          }
        }
        if (!failure) {
          for (let i = rawEvents.length - 1; i >= 0; i--) {
            const f = extractFailure(rawEvents[i]);
            if (f) {
              failure = f;
              break;
            }
          }
        }
        for (const ev of rawEvents) {
          if (ev.eventType === "EVENT_TYPE_WORKFLOW_TASK_COMPLETED") {
            const idNum = Number(ev.eventId);
            if (Number.isInteger(idNum) && idNum > 0) {
              resetPoints.push({
                eventId: idNum,
                eventTime: ev.eventTime ?? null,
                label: `#${idNum} · WorkflowTaskCompleted`,
              });
            }
          }
        }
        const lim = Math.max(10, Math.min(500, Number(historyLimit) || 200));
        const sliced = rawEvents.length > lim ? rawEvents.slice(-lim) : rawEvents;
        events = sliced.map((ev) => ({
          eventId: Number(ev.eventId) || 0,
          eventTime: ev.eventTime ?? null,
          eventType: ev.eventType ?? "",
          shortType: shortEventType(ev.eventType),
          summary: summarizeEvent(ev),
          resettable: ev.eventType === "EVENT_TYPE_WORKFLOW_TASK_COMPLETED",
        }));
      }
    }

    resetPoints.reverse();
    return {
      workflow,
      input,
      result,
      failure,
      pendingActivities,
      events,
      totalEvents,
      resetPoints,
      address: conn.address,
      namespace: conn.namespace,
    };
  }

  async startWorkflow({ address, namespace, workflowType, taskQueue, workflowId, input, executionTimeout, runTimeout } = {}) {
    const conn = this._connArgs({ address, namespace });
    const type = validateSafeString(workflowType, "workflowType", { required: true, max: 200 });
    const tq = validateSafeString(taskQueue, "taskQueue", { required: true, max: 200 });
    const wfId = validateSafeString(workflowId, "workflowId", { required: false, max: 256 });
    const jsonInput = validateJsonInput(input, "input");
    const execT = validateDuration(executionTimeout, "executionTimeout");
    const runT = validateDuration(runTimeout, "runTimeout");

    const args = ["workflow", "start", ...conn.args, `--type=${type}`, `--task-queue=${tq}`, "--output=json"];
    if (wfId) args.push(`--workflow-id=${wfId}`);
    if (jsonInput !== null) args.push(`--input=${jsonInput}`);
    if (execT) args.push(`--execution-timeout=${execT}`);
    if (runT) args.push(`--run-timeout=${runT}`);

    const res = await this.execute(this._bin(), args);
    if (!res.ok) throw cliErrorToHttp(res, "Не удалось запустить workflow");
    const parsed = safeJsonParse(res.stdout);
    const outWfId =
      parsed?.workflowId ??
      parsed?.workflow_id ??
      parsed?.execution?.workflowId ??
      res.stdout.match(/WorkflowId\s+([^\s]+)/i)?.[1] ??
      wfId;
    const outRunId =
      parsed?.runId ??
      parsed?.run_id ??
      parsed?.execution?.runId ??
      res.stdout.match(/RunId\s+([^\s]+)/i)?.[1] ??
      "";
    return {
      workflowId: outWfId,
      runId: outRunId,
      workflowType: type,
      taskQueue: tq,
      address: conn.address,
      namespace: conn.namespace,
      uiUrl: this.uiBase && outWfId ? buildTemporalUiUrl(this.uiBase, conn.namespace, outWfId, outRunId) : null,
    };
  }

  async signalWorkflow({ address, namespace, workflowId, runId, name, input } = {}) {
    const conn = this._connArgs({ address, namespace });
    const wfId = validateSafeString(workflowId, "workflowId", { required: true, max: 256 });
    const rId = validateSafeString(runId, "runId", { required: false, max: 128 });
    const sigName = validateSafeString(name, "name", { required: true, max: 200 });
    const jsonInput = validateJsonInput(input, "input");

    const args = ["workflow", "signal", ...conn.args, `--workflow-id=${wfId}`, `--name=${sigName}`];
    if (rId) args.push(`--run-id=${rId}`);
    if (jsonInput !== null) args.push(`--input=${jsonInput}`);

    const res = await this.execute(this._bin(), args);
    if (!res.ok) throw cliErrorToHttp(res, "Не удалось отправить Signal");
    return { ok: true, workflowId: wfId, runId: rId || null, name: sigName, address: conn.address, namespace: conn.namespace };
  }

  async queryWorkflow({ address, namespace, workflowId, runId, type, input } = {}) {
    const conn = this._connArgs({ address, namespace });
    const wfId = validateSafeString(workflowId, "workflowId", { required: true, max: 256 });
    const rId = validateSafeString(runId, "runId", { required: false, max: 128 });
    const qType = validateSafeString(type, "type", { required: true, max: 200 });
    const jsonInput = validateJsonInput(input, "input");

    const args = ["workflow", "query", ...conn.args, `--workflow-id=${wfId}`, `--type=${qType}`, "--output=json"];
    if (rId) args.push(`--run-id=${rId}`);
    if (jsonInput !== null) args.push(`--input=${jsonInput}`);

    const res = await this.execute(this._bin(), args);
    if (!res.ok) throw cliErrorToHttp(res, "Не удалось выполнить Query");
    const parsed = safeJsonParse(res.stdout);
    let result;
    if (parsed && typeof parsed === "object" && "queryResult" in parsed) {
      result = clampDisplayValue(parsed.queryResult);
    } else if (parsed !== null) {
      result = clampDisplayValue(parsed);
    } else {
      result = clampDisplayValue(res.stdout.trim());
    }
    return {
      ok: true,
      workflowId: wfId,
      runId: rId || null,
      type: qType,
      result,
      raw: res.stdout.trim().slice(0, MAX_PAYLOAD_DISPLAY_CHARS),
      address: conn.address,
      namespace: conn.namespace,
    };
  }

  async resetWorkflow({ address, namespace, workflowId, runId, eventId, resetType, reason, reapplyExclude } = {}) {
    const conn = this._connArgs({ address, namespace });
    const wfId = validateSafeString(workflowId, "workflowId", { required: true, max: 256 });
    const rId = validateSafeString(runId, "runId", { required: false, max: 128 });
    const why = validateSafeString(reason, "reason", { required: true, max: 500 });

    const hasEventId = eventId !== undefined && eventId !== null && eventId !== "";
    const hasResetType = Boolean(resetType && String(resetType).trim());
    if (!hasEventId && !hasResetType) {
      throw httpErr(400, "Укажите точку сброса: eventId (WorkflowTaskCompleted) или resetType");
    }
    const args = ["workflow", "reset", ...conn.args, `--workflow-id=${wfId}`, `--reason=${why}`, "--output=json"];
    if (rId) args.push(`--run-id=${rId}`);

    let chosenEventId = null;
    let chosenType = null;
    if (hasEventId) {
      const n = Number(eventId);
      if (!Number.isInteger(n) || n < 1) throw httpErr(400, "eventId должен быть целым числом ≥ 1");
      chosenEventId = n;
      args.push(`--event-id=${n}`);
    } else {
      const t = String(resetType).trim();
      if (!VALID_RESET_TYPES.has(t)) {
        throw httpErr(400, `Некорректный resetType (допустимы: ${[...VALID_RESET_TYPES].join(", ")})`);
      }
      chosenType = t;
      args.push(`--type=${t}`);
    }
    if (reapplyExclude) {
      const ex = String(reapplyExclude).trim();
      if (!VALID_REAPPLY_EXCLUDE.has(ex)) {
        throw httpErr(400, `Некорректный reapplyExclude (допустимы: ${[...VALID_REAPPLY_EXCLUDE].join(", ")})`);
      }
      args.push(`--reapply-exclude=${ex}`);
    }

    const res = await this.execute(this._bin(), args);
    if (!res.ok) throw cliErrorToHttp(res, "Не удалось выполнить Reset workflow");
    const parsed = safeJsonParse(res.stdout);
    const newRunId =
      parsed?.runId ??
      parsed?.run_id ??
      res.stdout.match(/RunId[:\s]+([a-zA-Z0-9-]+)/i)?.[1] ??
      "";
    return {
      ok: true,
      workflowId: wfId,
      runId: newRunId || null,
      eventId: chosenEventId,
      resetType: chosenType,
      reason: why,
      address: conn.address,
      namespace: conn.namespace,
    };
  }

  async cancelWorkflow({ address, namespace, workflowId, runId, reason } = {}) {
    const conn = this._connArgs({ address, namespace });
    const wfId = validateSafeString(workflowId, "workflowId", { required: true, max: 256 });
    const rId = validateSafeString(runId, "runId", { required: false, max: 128 });
    const why = validateSafeString(reason, "reason", { required: false, max: 500 });

    const args = ["workflow", "cancel", ...conn.args, `--workflow-id=${wfId}`];
    if (rId) args.push(`--run-id=${rId}`);

    const res = await this.execute(this._bin(), args);
    if (!res.ok) throw cliErrorToHttp(res, "Не удалось отменить workflow");
    return { ok: true, workflowId: wfId, runId: rId || null, action: "cancel", reason: why || null, address: conn.address, namespace: conn.namespace };
  }

  async terminateWorkflow({ address, namespace, workflowId, runId, reason } = {}) {
    const conn = this._connArgs({ address, namespace });
    const wfId = validateSafeString(workflowId, "workflowId", { required: true, max: 256 });
    const rId = validateSafeString(runId, "runId", { required: false, max: 128 });
    const why = validateSafeString(reason, "reason", { required: true, max: 500 });

    const args = ["workflow", "terminate", ...conn.args, `--workflow-id=${wfId}`, `--reason=${why}`];
    if (rId) args.push(`--run-id=${rId}`);

    const res = await this.execute(this._bin(), args);
    if (!res.ok) throw cliErrorToHttp(res, "Не удалось принудительно остановить workflow");
    return { ok: true, workflowId: wfId, runId: rId || null, action: "terminate", reason: why, address: conn.address, namespace: conn.namespace };
  }
}
