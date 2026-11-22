// FEAT-19.16 (U013 п.2): a model step is a portal chat turn in the pipe folder —
// the same engine runner, tenant isolation (jail), permission profile and
// subscription limits as the owner's chats. The step's conversation stays in
// the portal («Открыть разговор»); its text answer becomes the step result.
// Everything server-specific is injected (create/dispatch/messages/abort).
// FEAT-20.7: prepareWorktree({user, project, workspace, workflowId, pipeName}) → путь
// рабочей копии запуска (одна на запуск); шаг с worktree:true правит файлы в ней,
// файлы-результаты — по-прежнему в папке запуска.
// FEAT-20.6: registerStep({sid, runId, stepId, userId}) — попытка шага в журнале расхода ДО хода
// (step_chats хранит только последнюю попытку; повтор шага — новая строка «попытка N»).
export function chatStepRunner({ createSession, dispatchTurn, messagesOf, abort, setTitle, isLimit, prepareWorktree = null, registerStep = null, now = Date.now }) {
  const waiters = new Map(); // sid → {resolve}
  const mine = new Map(); // sid → { engine, directory, admin } — step chats: no auto-relay, no push «Готово»
  function onTurnEnd(e) {
    const w = waiters.get(e?.sid);
    if (w) { waiters.delete(e.sid); w.resolve(e); }
  }
  async function answerOf(sid, meta = mine.get(sid) ?? null) {
    const list = (await messagesOf(sid, meta)) ?? [];
    const last = [...list].reverse().find((m) => m?.info?.role === "assistant");
    return (last?.parts ?? []).filter((p) => p?.type === "text" && typeof p.text === "string" && !p.synthetic).map((p) => p.text).join("\n").trim();
  }
  async function run({ user, engine, model, directory, project = null, runFolder, title, instruction, timeoutMs, signal, onSession, worktree = false, workflowId = null, pipeName = null, stepId = null }) {
    signal?.throwIfAborted();
    const wt = worktree && prepareWorktree ? await prepareWorktree({ user, project: project ?? directory, workspace: directory, workflowId, pipeName }) : null;
    const admin = user?.role === "admin";
    const meta = { engine, directory: admin ? (wt?.path ?? directory) : (project || directory), admin };
    const sid = await createSession({ user, directory, project, engine, model, worktree: wt });
    mine.set(sid, meta);
    try { if (workflowId && stepId) registerStep?.({ sid, runId: workflowId, stepId, userId: user?.id ?? null }); } catch {}
    try { setTitle?.(sid, title, meta); } catch {}
    try { onSession?.(sid); } catch {}
    const ended = new Promise((resolve) => waiters.set(sid, { resolve }));
    const preamble = (runFolder
      ? `Это шаг пайпа портала. Рабочая папка этого запуска: ${runFolder}. Файлы-результаты сохраняй в неё. Отвечай по делу: твой последний ответ станет результатом шага.\n\n`
      : "") + (wt ? `Код правь в рабочей копии git ${wt.path} на ветке ${wt.branch} (от ${wt.base}); коммить в эту ветку, ветки не переключай.\n\n` : "");
    const res = { status: 0, body: null, writeHead(s) { this.status = s; return this; }, end(b) { this.body = b; } };
    await dispatchTurn({ res, sid, directory, project, user, text: preamble + instruction, engine, model, worktree: wt });
    if (res.status !== 204) { waiters.delete(sid); throw new Error(`chat turn refused: ${res.status} ${res.body ?? ""}`); }
    let timer, onAbort;
    const stop = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("step timeout")), Math.max(1000, timeoutMs ?? 600000));
      onAbort = () => reject(new Error("step aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    let e;
    try { e = await Promise.race([ended, stop]); }
    catch (err) { waiters.delete(sid); try { abort(sid, meta); } catch {} throw err; }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
    if (e.error && isLimit(e.error, engine)) return { state: "quota_wait", sessionId: sid };
    if (e.error) throw new Error("model step failed: " + String(e.error?.message ?? e.error).slice(0, 300));
    if (e.reason) throw new Error("model step stopped: " + e.reason);
    const text = await answerOf(sid, meta);
    if (!text) throw new Error("model step returned no text");
    return { text, sessionId: sid };
  }
  return { run, onTurnEnd, answerOf, owns: (sid) => mine.has(sid), meta: (sid) => mine.get(sid) ?? null };
}
