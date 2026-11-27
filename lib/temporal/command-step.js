// portal executor for pipeline "command" steps.
// - SQLite `command_runs` table for idempotency and post-restart `uncertain` / resume
// - Concurrency slot semaphore (`TELEHARNESS_TEMPORAL_COMMAND_SLOTS`) -> `slot_wait`
// - Parameter template substitution + strict regex `pattern` validation
// - `exec` kind: `spawn` without shell, clean env without portal secrets,
//   tenant jail (fail-closed if unavailable and !tenantSafe), process-group kill
//   on signal, 1 MB stdout tail -> artifacts (`results.remember`), 16 KB stderr tail
// - `temporal-workflow` kind: delegates to `command-temporal.js`
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderTemplate, templateRefs } from "../../shared/temporal-template.js";
import { commandAllowed } from "./command-catalog.js";
import { runTemporalWorkflowCommand } from "./command-temporal.js";
import { tenantJailFor } from "../claude-tenant.js";

const MAX_STDOUT_BYTES = 1024 * 1024; // 1 MiB (matches artifacts.js read limit)
const MAX_STDERR_BYTES = 16 * 1024;   // 16 KiB
const TRUNC_PREFIX = "[… усечено до последних 1 МБ …]\n";

const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "NO_PROXY", "no_proxy"];
const FORBIDDEN_ENV_PREFIXES = ["TELEHARNESS_", "CLAUDE_", "OPENCODE_", "GITHUB_", "PG", "ANTHROPIC_", "OPENAI_"];

export function buildCleanEnv(entryEnv = {}, baseEnv = process.env) {
  const out = {};
  for (const k of ENV_ALLOWLIST) {
    if (typeof baseEnv?.[k] === "string") out[k] = baseEnv[k];
  }
  for (const [k, v] of Object.entries(entryEnv ?? {})) {
    if (typeof v === "string") out[k] = v;
  }
  // Defense in depth: never leak portal/provider secrets from process.env
  for (const k of Object.keys(out)) {
    if (!Object.hasOwn(entryEnv ?? {}, k) && FORBIDDEN_ENV_PREFIXES.some((p) => k.startsWith(p))) {
      delete out[k];
    }
  }
  return out;
}

function shellQuote(arg) {
  return "'" + String(arg).replace(/'/g, "'\"'\"'") + "'";
}

function appendTail(bufList, chunk, maxBytes) {
  const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
  bufList.bytes += b.length;
  bufList.chunks.push(b);
  if (bufList.bytes > maxBytes * 2) {
    const merged = Buffer.concat(bufList.chunks);
    const tail = merged.subarray(merged.length - maxBytes);
    bufList.chunks = [tail];
    bufList.bytes = tail.length;
    bufList.truncated = true;
  } else if (bufList.bytes > maxBytes) {
    bufList.truncated = true;
  }
}

function finalizeTail(bufList, maxBytes, prefix = "") {
  const merged = bufList.chunks.length ? Buffer.concat(bufList.chunks) : Buffer.alloc(0);
  if (!bufList.truncated && merged.length <= maxBytes) return merged.toString("utf8");
  const prefixBuf = Buffer.from(prefix, "utf8");
  const keep = Math.max(0, maxBytes - prefixBuf.length);
  const tail = merged.subarray(Math.max(0, merged.length - keep));
  return prefix + tail.toString("utf8");
}

function resolveCommandParams(entry, step, { inputs, answers }) {
  const declared = new Map((entry.params ?? []).map((p) => [p.name, p]));
  const rawArgs = step.args && typeof step.args === "object" ? step.args : {};
  for (const k of Object.keys(rawArgs)) {
    if (!declared.has(k)) {
      return { error: `Неизвестный параметр команды: «${k}»` };
    }
  }
  const resolved = {};
  for (const [name, spec] of declared) {
    const raw = rawArgs[name];
    const value = typeof raw === "string" ? renderTemplate(raw, { inputs, steps: answers }) : "";
    if (spec.required && !value.trim()) {
      return { error: `Не задан обязательный параметр «${name}»` };
    }
    if (value.length > 500) {
      return { error: `Значение параметра «${name}» превышает 500 символов` };
    }
    if (value && spec.pattern) {
      let re;
      try {
        re = new RegExp(spec.pattern);
      } catch {
        return { error: `Некорректный шаблон проверки параметра «${name}»` };
      }
      if (!re.test(value)) {
        return { error: `Значение параметра «${name}» не соответствует шаблону` };
      }
    }
    if (value !== "" || raw !== undefined) resolved[name] = value;
  }
  return { params: resolved };
}

function substituteArgv(templateArgv, params) {
  return (templateArgv ?? []).map((arg) =>
    String(arg).replace(/\{\{param\.([a-zA-Z][a-zA-Z0-9_-]{0,63})\}\}/g, (_, name) =>
      Object.hasOwn(params, name) ? String(params[name]) : "",
    ),
  );
}

function defaultExecRunner({ file, argv, cwd, env, signal, platform, jail }) {
  return new Promise((resolve) => {
    let spawnBin = file;
    let spawnArgs = argv;
    if (jail) {
      const cmdLine = [file, ...argv].map(shellQuote).join(" ");
      const payload = Buffer.from(JSON.stringify({ name: jail.name, home: jail.home, cwd: jail.cwd, command: cmdLine })).toString("base64url");
      spawnBin = "/usr/bin/sudo";
      spawnArgs = ["-n", jail.bin, "--b64", payload];
    }

    const outBuf = { chunks: [], bytes: 0, truncated: false };
    const errBuf = { chunks: [], bytes: 0, truncated: false };
    let settled = false;
    let killTimer = null;

    let child;
    try {
      child = spawn(spawnBin, spawnArgs, {
        cwd,
        env,
        detached: platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return resolve({ code: 1, stdout: "", stderr: String(err?.message ?? err), cancelled: false });
    }

    const killGroup = (sig) => {
      if (!child?.pid) return;
      try {
        if (platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };

    const onAbort = () => {
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), 3000);
      killTimer.unref?.();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (c) => appendTail(outBuf, c, MAX_STDOUT_BYTES));
    child.stderr?.on("data", (c) => appendTail(errBuf, c, MAX_STDERR_BYTES));

    const finish = (code, errMsg = "") => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      const stdout = finalizeTail(outBuf, MAX_STDOUT_BYTES, TRUNC_PREFIX);
      const stderr = errMsg ? errMsg.slice(0, MAX_STDERR_BYTES) : finalizeTail(errBuf, MAX_STDERR_BYTES, "");
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout,
        stderr,
        cancelled: Boolean(signal?.aborted),
      });
    };

    child.once("error", (err) => finish(1, String(err?.message ?? err)));
    child.once("close", (code) => finish(code === null ? 1 : code));
  });
}

export function createCommandStepRunner({
  db,
  catalog,
  results,
  artifactDirectory,
  dirAllowed,
  slotsLimit = 2,
  tenantHome = null,
  auditCommand = null,
  cli,
  platform = process.platform,
  jailBin = "/usr/local/libexec/teleharness-tenant-run",
  execRunner = defaultExecRunner,
  temporalRunner = runTemporalWorkflowCommand,
  now = Date.now,
} = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS command_runs (
    workflow_id TEXT NOT NULL,
    step TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL,
    command_id TEXT NOT NULL,
    state TEXT NOT NULL,
    exit_code INTEGER,
    receipt TEXT,
    stderr_tail TEXT,
    child_workflow_id TEXT,
    child_run_id TEXT,
    ui_url TEXT,
    result_files TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    PRIMARY KEY (workflow_id, step)
  )`);

  const selectRun = db.prepare("SELECT * FROM command_runs WHERE workflow_id=? AND step=?");
  const selectByWorkflow = db.prepare("SELECT * FROM command_runs WHERE workflow_id=?");
  const upsertRunning = db.prepare(`INSERT INTO command_runs
    (workflow_id, step, attempt, kind, command_id, state, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, 'running', ?, NULL)
    ON CONFLICT(workflow_id, step) DO UPDATE SET
      attempt=excluded.attempt,
      kind=excluded.kind,
      command_id=excluded.command_id,
      state='running',
      exit_code=NULL,
      stderr_tail=NULL,
      started_at=excluded.started_at,
      finished_at=NULL`);
  const updateChild = db.prepare(
    "UPDATE command_runs SET child_workflow_id=?, child_run_id=?, ui_url=? WHERE workflow_id=? AND step=?",
  );
  const updateFinish = db.prepare(
    "UPDATE command_runs SET state=?, exit_code=?, receipt=?, stderr_tail=?, child_workflow_id=COALESCE(?, child_workflow_id), child_run_id=COALESCE(?, child_run_id), ui_url=COALESCE(?, ui_url), result_files=?, finished_at=? WHERE workflow_id=? AND step=?",
  );

  const activeRuns = new Set();
  const activeByUser = new Map();
  let activeTotal = 0;

  function acquireSlot(userId) {
    const userCount = activeByUser.get(userId) ?? 0;
    if (activeTotal >= slotsLimit || userCount >= slotsLimit) return false;
    activeTotal += 1;
    activeByUser.set(userId, userCount + 1);
    return true;
  }

  function releaseSlot(userId) {
    activeTotal = Math.max(0, activeTotal - 1);
    const next = Math.max(0, (activeByUser.get(userId) ?? 1) - 1);
    if (next === 0) activeByUser.delete(userId);
    else activeByUser.set(userId, next);
  }

  async function saveArtifactText(text) {
    const receipt = randomUUID();
    await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(artifactDirectory, receipt), text, { encoding: "utf8", mode: 0o600 });
    return receipt;
  }

  function parseFilesJson(raw) {
    if (typeof raw !== "string" || !raw) return [];
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }

  function commandMeta(workflowId) {
    const rows = selectByWorkflow.all(workflowId);
    const out = {};
    for (const r of rows) {
      const files = parseFilesJson(r.result_files);
      const durationMs =
        Number.isFinite(r.started_at) && Number.isFinite(r.finished_at)
          ? Math.max(0, r.finished_at - r.started_at)
          : null;
      out[r.step] = {
        commandId: r.command_id,
        kind: r.kind,
        state: r.state,
        attempt: r.attempt,
        exitCode: r.exit_code ?? null,
        stderrTail: r.stderr_tail || null,
        childWorkflowId: r.child_workflow_id || null,
        childRunId: r.child_run_id || null,
        uiUrl: r.ui_url || null,
        files,
        startedAt: r.started_at,
        finishedAt: r.finished_at ?? null,
        durationMs,
      };
    }
    return out;
  }

  async function runStep({ user, workflowId, stepId, definition, step, inputs = {}, signal }) {
    if (!catalog) {
      return { state: "failed", error: "Каталог команд недоступен", nonRetryable: true };
    }
    let entry;
    try {
      entry = catalog.get(step.command);
    } catch (err) {
      return { state: "failed", error: err?.message || "Каталог команд повреждён", nonRetryable: true };
    }
    if (!entry || !commandAllowed(entry, user)) {
      return { state: "failed", error: "Команда недоступна", nonRetryable: true };
    }

    const runKey = `${workflowId}:${stepId}`;
    const existing = selectRun.get(workflowId, stepId);

    // 1. Idempotency: already completed with a receipt -> return stored summary without re-running.
    if (existing?.state === "done" && existing.receipt) {
      const files = parseFilesJson(existing.result_files);
      return {
        state: "done",
        exitCode: existing.exit_code ?? 0,
        durationMs: Math.max(0, (existing.finished_at ?? now()) - existing.started_at),
        kind: existing.kind,
        ...(existing.child_workflow_id ? { childWorkflowId: existing.child_workflow_id } : {}),
        ...(existing.ui_url ? { uiUrl: existing.ui_url } : {}),
        filesCount: files.length,
      };
    }

    // 2. Post-restart reconciliation: `running` in DB with no active handle in this process.
    let resumeChildWorkflowId = null;
    let resumeChildRunId = null;
    if (existing?.state === "running" && !activeRuns.has(runKey)) {
      if (existing.kind === "temporal-workflow" && existing.child_workflow_id) {
        resumeChildWorkflowId = existing.child_workflow_id;
        resumeChildRunId = existing.child_run_id || null;
      } else {
        const msg =
          existing.kind === "temporal-workflow"
            ? "Запуск внешнего workflow прерван до получения ID — проверьте в Temporal и запустите повторно"
            : "Команда прервана, результат неизвестен — проверьте и запустите повторно";
        updateFinish.run("uncertain", null, null, msg, null, null, null, null, now(), workflowId, stepId);
        auditCommand?.({
          event: "temporal.command",
          action: "uncertain",
          user: user.id,
          role: user.role,
          workflowId,
          stepId,
          commandId: entry.id,
          kind: entry.kind,
          state: "uncertain",
        });
        return { state: "failed", error: msg, nonRetryable: true };
      }
    }

    if (existing?.state === "uncertain") {
      return {
        state: "failed",
        error: existing.stderr_tail || "Команда прервана, результат неизвестен — проверьте и запустите повторно",
        nonRetryable: true,
      };
    }

    // 3. Read prior step answers referenced in step.args, then resolve & validate params.
    const answers = {};
    for (const val of Object.values(step.args ?? {})) {
      if (typeof val !== "string") continue;
      for (const ref of templateRefs(val)) {
        if (ref.kind === "steps" && !(ref.name in answers)) {
          try {
            answers[ref.name] = await results.read(workflowId, ref.name);
          } catch {
            answers[ref.name] = "";
          }
        }
      }
    }
    const paramRes = resolveCommandParams(entry, step, { inputs, answers });
    if (paramRes.error) {
      return { state: "failed", error: paramRes.error, nonRetryable: true };
    }
    const params = paramRes.params;

    // 4. Re-validate exec.file right before launch (realpath + executable).
    let jail = null;
    if (entry.kind === "exec") {
      const fileErr = catalog.validateExecNow?.(entry);
      if (fileErr) return { state: "failed", error: fileErr, nonRetryable: true };
      if (user.role !== "admin" && entry.tenantSafe !== true) {
        const j = tenantJailFor(definition.directory, tenantHome);
        if (platform !== "linux" || !j || !existsSync(jailBin)) {
          return {
            state: "failed",
            error: "Команда для тенанта требует изоляции песочницы (tenantSafe=false)",
            nonRetryable: true,
          };
        }
        jail = { ...j, cwd: entry.exec.cwd || definition.directory, bin: jailBin };
      }
    }

    // 5. Slot semaphore check (global + per-user).
    if (!acquireSlot(user.id)) {
      return { state: "slot_wait", reason: "command_slots_busy" };
    }

    const startedAt = resumeChildWorkflowId && existing?.started_at ? existing.started_at : now();
    const attempt = resumeChildWorkflowId ? (existing?.attempt || 1) : existing ? (existing.attempt || 1) + 1 : 1;
    if (!resumeChildWorkflowId) {
      upsertRunning.run(workflowId, stepId, attempt, entry.kind, entry.id, startedAt);
    }
    activeRuns.add(runKey);

    auditCommand?.({
      event: "temporal.command",
      action: resumeChildWorkflowId ? "resume_poll" : "start",
      user: user.id,
      role: user.role,
      workflowId,
      stepId,
      commandId: entry.id,
      kind: entry.kind,
      paramKeys: Object.keys(params),
      ...(resumeChildWorkflowId ? { childWorkflowId: resumeChildWorkflowId } : {}),
    });

    try {
      if (entry.kind === "exec") {
        const argv = substituteArgv(entry.exec.argv, params);
        const env = buildCleanEnv(entry.exec.env, process.env);
        const cwd = entry.exec.cwd || definition.directory;
        const res = await execRunner({ file: entry.exec.file, argv, cwd, env, signal, platform, jail });
        const finishedAt = now();
        const durationMs = Math.max(0, finishedAt - startedAt);

        if (res.cancelled) {
          updateFinish.run("cancelled", res.code, null, res.stderr || "Отменено", null, null, null, null, finishedAt, workflowId, stepId);
          auditCommand?.({
            event: "temporal.command",
            action: "finish",
            user: user.id,
            role: user.role,
            workflowId,
            stepId,
            commandId: entry.id,
            kind: "exec",
            exitCode: res.code,
            state: "cancelled",
            durationMs,
          });
          return { state: "failed", error: "Команда отменена", nonRetryable: true };
        }

        const ok = res.code === 0 || step.successWhen === "always";
        let receipt = null;
        if (ok) {
          receipt = await saveArtifactText(res.stdout ?? "");
          results.remember(workflowId, stepId, receipt);
        }
        updateFinish.run(
          ok ? "done" : "failed",
          res.code,
          receipt,
          res.stderr || null,
          null,
          null,
          null,
          null,
          finishedAt,
          workflowId,
          stepId,
        );
        auditCommand?.({
          event: "temporal.command",
          action: "finish",
          user: user.id,
          role: user.role,
          workflowId,
          stepId,
          commandId: entry.id,
          kind: "exec",
          exitCode: res.code,
          state: ok ? "done" : "failed",
          durationMs,
        });
        if (!ok) {
          const tail = (res.stderr || "").trim().slice(0, 300);
          return {
            state: "failed",
            exitCode: res.code,
            error: `Команда завершилась с кодом ${res.code}${tail ? `: ${tail}` : ""}`,
            nonRetryable: false,
          };
        }
        return { state: "done", exitCode: res.code, durationMs, kind: "exec", filesCount: 0 };
      }

      // kind === "temporal-workflow"
      const wfRes = await temporalRunner({
        entry,
        workflowId,
        stepId,
        params,
        user,
        resumeChildWorkflowId,
        resumeChildRunId,
        dirAllowed,
        signal,
        cli,
        onChildStarted: ({ childWorkflowId, childRunId, uiUrl }) => {
          updateChild.run(childWorkflowId, childRunId ?? null, uiUrl ?? null, workflowId, stepId);
        },
      });
      const finishedAt = now();
      const durationMs = wfRes.durationMs ?? Math.max(0, finishedAt - startedAt);
      const filesJson = wfRes.files?.length ? JSON.stringify(wfRes.files) : null;

      if (wfRes.state === "cancelled") {
        updateFinish.run(
          "cancelled",
          null,
          null,
          "Отменено",
          wfRes.childWorkflowId ?? null,
          wfRes.childRunId ?? null,
          wfRes.uiUrl ?? null,
          null,
          finishedAt,
          workflowId,
          stepId,
        );
        auditCommand?.({
          event: "temporal.command",
          action: "finish",
          user: user.id,
          role: user.role,
          workflowId,
          stepId,
          commandId: entry.id,
          kind: "temporal-workflow",
          childWorkflowId: wfRes.childWorkflowId,
          state: "cancelled",
          durationMs,
        });
        return { state: "failed", error: "Команда отменена", nonRetryable: true };
      }

      if (wfRes.state === "done") {
        const receipt = await saveArtifactText(wfRes.stdout ?? "");
        results.remember(workflowId, stepId, receipt);
        updateFinish.run(
          "done",
          0,
          receipt,
          null,
          wfRes.childWorkflowId ?? null,
          wfRes.childRunId ?? null,
          wfRes.uiUrl ?? null,
          filesJson,
          finishedAt,
          workflowId,
          stepId,
        );
        auditCommand?.({
          event: "temporal.command",
          action: "finish",
          user: user.id,
          role: user.role,
          workflowId,
          stepId,
          commandId: entry.id,
          kind: "temporal-workflow",
          childWorkflowId: wfRes.childWorkflowId,
          exitCode: 0,
          state: "done",
          durationMs,
        });
        return {
          state: "done",
          exitCode: 0,
          durationMs,
          kind: "temporal-workflow",
          ...(wfRes.childWorkflowId ? { childWorkflowId: wfRes.childWorkflowId } : {}),
          ...(wfRes.childStatus ? { childStatus: wfRes.childStatus } : {}),
          ...(wfRes.uiUrl ? { uiUrl: wfRes.uiUrl } : {}),
          filesCount: wfRes.files?.length ?? 0,
        };
      }

      updateFinish.run(
        "failed",
        wfRes.exitCode ?? 1,
        null,
        wfRes.stderr || wfRes.error || null,
        wfRes.childWorkflowId ?? null,
        wfRes.childRunId ?? null,
        wfRes.uiUrl ?? null,
        filesJson,
        finishedAt,
        workflowId,
        stepId,
      );
      auditCommand?.({
        event: "temporal.command",
        action: "finish",
        user: user.id,
        role: user.role,
        workflowId,
        stepId,
        commandId: entry.id,
        kind: "temporal-workflow",
        childWorkflowId: wfRes.childWorkflowId,
        exitCode: wfRes.exitCode ?? 1,
        state: "failed",
        durationMs,
      });
      return {
        state: "failed",
        exitCode: wfRes.exitCode ?? 1,
        error: wfRes.error || "Ошибка внешнего workflow",
        nonRetryable: Boolean(wfRes.nonRetryable),
      };
    } finally {
      activeRuns.delete(runKey);
      releaseSlot(user.id);
    }
  }

  return { runStep, commandMeta };
}
