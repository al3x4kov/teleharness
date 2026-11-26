// built-in "temporal-workflow" command executor.
// Triggers an external Temporal Schedule or starts a deterministic child workflow,
// polls `temporal workflow describe` every 15s (surviving portal restarts via
// persisted child_workflow_id), cancels on pipeline abort when cancelChild !== false,
// and formats COMPLETED output into Markdown with UI link and dirAllowed-checked files.
import { execFile } from "node:child_process";
import path from "node:path";
import { resolveTemporalCli } from "./cli.js";

const TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "TIMED_OUT",
  "TERMINATED",
  "CANCELED",
  "CONTINUED_AS_NEW",
]);

function normalizeStatus(raw) {
  if (!raw) return "UNKNOWN";
  const s = String(raw).toUpperCase().replace(/^WORKFLOW_EXECUTION_STATUS_/, "");
  if (s === "CANCELLED") return "CANCELED";
  return s;
}

export function buildTemporalUiUrl(uiBase, namespace, workflowId, runId = null) {
  if (!uiBase || !workflowId) return null;
  const base = String(uiBase).replace(/\/+$/, "");
  const ns = encodeURIComponent(namespace || "default");
  const wf = encodeURIComponent(workflowId);
  return runId ? `${base}/namespaces/${ns}/workflows/${wf}/${encodeURIComponent(runId)}` : `${base}/namespaces/${ns}/workflows/${wf}`;
}

function defaultExecute(bin, args, { timeoutMs = 30_000, signal } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      if (err) {
        const code = typeof err.code === "number" ? err.code : 1;
        return resolve({ ok: false, code, stdout: String(stdout ?? ""), stderr: String(stderr || err.message || "") });
      }
      resolve({ ok: true, code: 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
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

function extractRecentActions(desc) {
  const list = desc?.info?.recentActions ?? desc?.schedule?.info?.recentActions ?? desc?.recentActions ?? [];
  return Array.isArray(list) ? list : [];
}

function actionWorkflowInfo(action) {
  const wfId = action?.startWorkflowResult?.workflowId ?? action?.startWorkflowResult?.workflow_id ?? null;
  const runId = action?.startWorkflowResult?.runId ?? action?.startWorkflowResult?.run_id ?? null;
  const rawTime = action?.actualTime ?? action?.actual_time ?? action?.scheduleTime ?? action?.schedule_time ?? null;
  const ts = rawTime ? Date.parse(rawTime) : NaN;
  return { wfId, runId, ts };
}

function extractFailureText(obj) {
  if (!obj || typeof obj !== "object") return null;
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 8) return null;
    if (node.failure && typeof node.failure === "object") {
      const msg = node.failure.message || "";
      const cause = node.failure.cause?.message || "";
      if (msg || cause) return [msg, cause].filter(Boolean).join(" — ");
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

function extractFiles(parsed, user, dirAllowed) {
  if (!parsed || typeof parsed !== "object") return [];
  const rawPaths = [];
  if (typeof parsed.report_path === "string" && parsed.report_path.trim()) {
    rawPaths.push(parsed.report_path.trim());
  }
  if (Array.isArray(parsed.files)) {
    for (const f of parsed.files) {
      if (typeof f === "string" && f.trim()) rawPaths.push(f.trim());
      else if (f && typeof f === "object" && typeof f.path === "string" && f.path.trim()) rawPaths.push(f.path.trim());
    }
  }
  const unique = [...new Set(rawPaths)].slice(0, 50);
  return unique.map((p) => ({
    path: p,
    allowed: Boolean(path.isAbsolute(p) && typeof dirAllowed === "function" && dirAllowed(user, path.dirname(p))),
  }));
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m} мин ${rem} с` : `${m} мин`;
}

function formatCompletedMarkdown({ entry, childWorkflowId, status, uiUrl, durationMs, rawResult, parsedResult, files }) {
  const lines = [
    `# ${entry.name || entry.id}`,
    "",
    `- **Статус:** ${status}`,
    `- **Workflow ID:** \`${childWorkflowId}\``,
    `- **Длительность:** ${formatDuration(durationMs)}`,
  ];
  if (uiUrl) lines.push(`- **Temporal UI:** [Открыть в Temporal UI](${uiUrl})`);

  const summary =
    typeof parsedResult?.summary === "string" && parsedResult.summary.trim()
      ? parsedResult.summary.trim()
      : typeof parsedResult === "string" && parsedResult.trim()
        ? parsedResult.trim()
        : null;

  if (summary) {
    lines.push("", "## Итог", "", summary);
  } else if (parsedResult && typeof parsedResult === "object") {
    lines.push("", "## Итог", "", "```json", JSON.stringify(parsedResult, null, 2).slice(0, 64 * 1024), "```");
  } else if (rawResult && rawResult.trim()) {
    lines.push("", "## Итог", "", rawResult.trim().slice(0, 64 * 1024));
  }

  if (files.length) {
    lines.push("", "## Файлы", "");
    for (const f of files) {
      lines.push(`- \`${f.path}\`${f.allowed ? "" : " (вне разрешённых папок — только путь)"}`);
    }
  }

  return lines.join("\n") + "\n";
}

export async function runTemporalWorkflowCommand({
  entry,
  workflowId,
  stepId,
  params = {},
  user,
  resumeChildWorkflowId = null,
  resumeChildRunId = null,
  onChildStarted,
  dirAllowed,
  signal,
  cli,
  execute = defaultExecute,
  pollIntervalMs = 15_000,
  triggerLookupTimeoutMs = 30_000,
  triggerPollMs = 1_500,
  now = Date.now,
  sleep = defaultSleep,
}) {
  const t = entry.temporal;
  const bin = resolveTemporalCli(cli);
  const baseFlags = ["--address", t.address, "--namespace", t.namespace];
  const startedAt = now();

  let childWorkflowId = resumeChildWorkflowId || null;
  let childRunId = resumeChildRunId || null;
  let uiUrl = childWorkflowId ? buildTemporalUiUrl(t.uiBase, t.namespace, childWorkflowId, childRunId) : null;

  if (!childWorkflowId) {
    if (t.schedule) {
      // Snapshot recentActions BEFORE trigger to reliably pick the newly spawned workflow.
      const beforeIds = new Set();
      const preDesc = await execute(bin, ["schedule", "describe", "--schedule-id", t.schedule, ...baseFlags, "-o", "json"], { timeoutMs: 15_000, signal });
      if (preDesc.ok) {
        const parsed = safeJsonParse(preDesc.stdout);
        for (const a of extractRecentActions(parsed)) {
          const { wfId } = actionWorkflowInfo(a);
          if (wfId) beforeIds.add(wfId);
        }
      }

      const triggerAt = now();
      const trig = await execute(
        bin,
        ["schedule", "trigger", "--schedule-id", t.schedule, "--overlap-policy", "AllowAll", ...baseFlags],
        { timeoutMs: 20_000, signal },
      );
      if (!trig.ok) {
        const msg = (trig.stderr || trig.stdout || "не удалось запустить расписание").trim().slice(0, 300);
        return { state: "failed", exitCode: 1, error: `Ошибка запуска расписания ${t.schedule}: ${msg}`, stderr: msg, nonRetryable: false };
      }

      // Poll schedule describe until the new workflowId appears in recentActions (up to 30s).
      const lookupDeadline = now() + triggerLookupTimeoutMs;
      while (!childWorkflowId && now() <= lookupDeadline) {
        if (signal?.aborted) {
          return { state: "cancelled", childWorkflowId: null, childRunId: null, uiUrl: null };
        }
        const postDesc = await execute(bin, ["schedule", "describe", "--schedule-id", t.schedule, ...baseFlags, "-o", "json"], { timeoutMs: 15_000, signal });
        if (postDesc.ok) {
          const parsed = safeJsonParse(postDesc.stdout);
          const actions = extractRecentActions(parsed);
          // Inspect newest first
          for (let i = actions.length - 1; i >= 0; i--) {
            const { wfId, runId, ts } = actionWorkflowInfo(actions[i]);
            if (!wfId || beforeIds.has(wfId)) continue;
            if (!Number.isFinite(ts) || ts >= triggerAt - 2000) {
              childWorkflowId = wfId;
              childRunId = runId;
              break;
            }
          }
        }
        if (!childWorkflowId && now() < lookupDeadline) {
          await sleep(triggerPollMs, signal);
        }
      }

      if (!childWorkflowId) {
        return {
          state: "failed",
          exitCode: 1,
          error: `Расписание «${t.schedule}» запущено, но за ${Math.round(triggerLookupTimeoutMs / 1000)} с не удалось определить ID дочернего workflow`,
          stderr: "recentActions lookup timeout",
          nonRetryable: true,
        };
      }
      uiUrl = buildTemporalUiUrl(t.uiBase, t.namespace, childWorkflowId, childRunId);
      await onChildStarted?.({ childWorkflowId, childRunId, uiUrl });
    } else {
      // Direct workflow start with deterministic ID for idempotency.
      childWorkflowId = `teleharness-cmd-${workflowId}-${stepId}`;
      const args = [
        "workflow",
        "start",
        "-w",
        childWorkflowId,
        "--type",
        t.workflow,
        "--task-queue",
        t.taskQueue,
        ...baseFlags,
        "--id-reuse-policy",
        "AllowDuplicateFailedOnly",
      ];
      if (params && Object.keys(params).length > 0) {
        args.push("--input", JSON.stringify(params));
      }
      const startRes = await execute(bin, args, { timeoutMs: 25_000, signal });
      if (!startRes.ok && !/already\s+(started|running)|WorkflowExecutionAlreadyStarted/i.test(startRes.stderr + startRes.stdout)) {
        const msg = (startRes.stderr || startRes.stdout || "не удалось запустить workflow").trim().slice(0, 300);
        return { state: "failed", exitCode: 1, error: `Ошибка запуска workflow ${t.workflow}: ${msg}`, stderr: msg, nonRetryable: false };
      }
      const startJson = safeJsonParse(startRes.stdout);
      childRunId = startJson?.runId ?? startJson?.run_id ?? (startRes.stdout.match(/RunId\s+([a-f0-9-]{36})/i)?.[1] ?? null);
      uiUrl = buildTemporalUiUrl(t.uiBase, t.namespace, childWorkflowId, childRunId);
      await onChildStarted?.({ childWorkflowId, childRunId, uiUrl });
    }
  }

  // Poll `temporal workflow describe` until terminal status or abort signal.
  while (true) {
    if (signal?.aborted) {
      if (t.cancelChild !== false && childWorkflowId) {
        await execute(bin, ["workflow", "cancel", "-w", childWorkflowId, ...baseFlags], { timeoutMs: 10_000 }).catch(() => {});
      }
      return { state: "cancelled", childWorkflowId, childRunId, uiUrl };
    }

    const descRes = await execute(bin, ["workflow", "describe", "-w", childWorkflowId, ...baseFlags, "-o", "json"], { timeoutMs: 20_000, signal });
    if (signal?.aborted) {
      if (t.cancelChild !== false && childWorkflowId) {
        await execute(bin, ["workflow", "cancel", "-w", childWorkflowId, ...baseFlags], { timeoutMs: 10_000 }).catch(() => {});
      }
      return { state: "cancelled", childWorkflowId, childRunId, uiUrl };
    }

    if (descRes.ok) {
      const desc = safeJsonParse(descRes.stdout) ?? {};
      const info = desc.workflowExecutionInfo ?? desc;
      const status = normalizeStatus(info.status ?? desc.status);
      const runFromDesc = info.execution?.runId ?? info.execution?.run_id ?? desc.runId ?? null;
      if (runFromDesc && !childRunId) {
        childRunId = runFromDesc;
        uiUrl = buildTemporalUiUrl(t.uiBase, t.namespace, childWorkflowId, childRunId);
        await onChildStarted?.({ childWorkflowId, childRunId, uiUrl });
      }

      if (TERMINAL_STATUSES.has(status)) {
        const durationMs = Math.max(0, now() - startedAt);
        if (status === "COMPLETED" || status === "CONTINUED_AS_NEW") {
          let rawResult = "";
          let parsedResult = desc.result ?? null;
          if (parsedResult == null) {
            const resCmd = await execute(bin, ["workflow", "result", "-w", childWorkflowId, ...baseFlags, "-o", "json"], { timeoutMs: 20_000 });
            if (resCmd.ok) {
              rawResult = resCmd.stdout;
              const p = safeJsonParse(resCmd.stdout);
              parsedResult = p?.result !== undefined ? p.result : p;
            }
          }
          const files = extractFiles(parsedResult, user, dirAllowed);
          const markdown = formatCompletedMarkdown({
            entry,
            childWorkflowId,
            status,
            uiUrl,
            durationMs,
            rawResult,
            parsedResult,
            files,
          });
          return {
            state: "done",
            exitCode: 0,
            durationMs,
            stdout: markdown,
            stderr: "",
            childWorkflowId,
            childRunId,
            childStatus: status,
            uiUrl,
            files,
          };
        }

        // Non-success terminal state: extract failure message / cause.
        let failureDetail = extractFailureText(desc);
        if (!failureDetail) {
          const showRes = await execute(bin, ["workflow", "show", "-w", childWorkflowId, ...baseFlags, "--output", "json"], { timeoutMs: 20_000 });
          if (showRes.ok) {
            failureDetail = extractFailureText(safeJsonParse(showRes.stdout));
          }
        }
        const errMsg = `Внешний workflow завершился со статусом ${status}${failureDetail ? `: ${failureDetail}` : ""}`;
        return {
          state: "failed",
          exitCode: 1,
          durationMs,
          error: errMsg.slice(0, 500),
          stderr: errMsg.slice(0, 16 * 1024),
          childWorkflowId,
          childRunId,
          childStatus: status,
          uiUrl,
          files: [],
          nonRetryable: status === "TERMINATED" || status === "CANCELED",
        };
      }
    }

    await sleep(pollIntervalMs, signal);
  }
}
