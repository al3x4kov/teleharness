// FEAT-20.3 (1.12): шаг «Открыть PR» — исполнение на портале (design §8).
// Рабочая копия запуска одна (FEAT-20.7): модельный шаг с worktree:true правил файлы
// в ней, этот шаг отбирает их, коммитит автором из Настройки → Git с трейлером
// Co-Authored-By движка, пушит с GIT_ASKPASS (токен в env процесса git — не в argv,
// не в URL и не в конфиге) и открывает/обновляет draft-PR. Повтор шага идемпотентен:
// ветка уже запушена и PR уже открыт — комментарий вместо второго PR.
// Ошибки: 401/сеть → {state:"github_wait"} (воркер спит 5 мин, до 24 ч);
// 403/422/ветка обновлена человеком → неповторяемая ошибка с текстом (HTTP 4xx).
import { stat, writeFile, rm, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGit, gitEnv, openRepo, gitCommit, parseStatus, classifyPushError, sanitize, GIT_LONG_TIMEOUT_MS } from "../git.js";
import { GhError } from "../github/client.js";
import { redact } from "../github/secrets.js";
import { renderTemplate } from "../../shared/temporal-template.js";

const SIZE_LIMIT = 5 * 1024 * 1024;
// Отбор файлов (design §8 п.2): без .env*, *.pem, id_*, *.key; больше 5 МБ — пропустить.
const SECRET_FILE = /(?:^|\/)(?:\.env[^/]*|[^/]*\.pem|[^/]*\.key|id_[^/]*)$/i;

// Отказ: status — HTTP-код моста (4xx неповторяем), code — вид отказа для экрана
// запуска (push_rejected | branch_moved | github_rejected | …), sha — коммит,
// который остался в рабочей копии (FEAT-20.3 2.5, T-16).
function fail(status, message, code = "step_failed", extra = {}) {
  throw Object.assign(new Error(message), { status, code, ...extra });
}
const firstLine = (s) => String(s ?? "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
const safeBranch = (s) => String(s ?? "").trim().replace(/[^\w./-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
const shortSha = (s) => String(s ?? "").trim().slice(0, 7);
// Текст отказа с стороны GitHub приходит строками «remote: …» (правило репозитория,
// защита ветки): до трёх строк — в текст ошибки, без путей и адресов с учётными данными.
const remoteNotes = (stderr) => String(stderr ?? "").split(/\r?\n/)
  .map((l) => /^remote:\s?(.*)$/.exec(l.trim())?.[1]?.trim() ?? "")
  .filter((l) => l && !/^(Enumerating|Counting|Compressing|Writing|Total|Delta|Receiving|Resolving)/.test(l))
  .slice(0, 3).map((l) => sanitize(l).replace(/\.$/, "")).join("; ");

// GIT_ASKPASS: git спрашивает логин/пароль у скрипта; токен живёт только в env
// процесса git и умерает вместе с ним.
async function writeAskpass() {
  if (process.platform === "win32") {
    const file = path.join(tmpdir(), `teleharness-askpass-${randomBytes(8).toString("hex")}.cmd`);
    await writeFile(file, '@echo off\r\necho %~1 | findstr /i "Username" >nul && (echo x-access-token) || (echo %TELEHARNESS_GIT_TOKEN%)\r\n');
    return file;
  }
  const file = path.join(tmpdir(), `teleharness-askpass-${randomBytes(8).toString("hex")}.sh`);
  await writeFile(file, '#!/bin/sh\ncase "$1" in *Username*) printf \'%s\\n\' "x-access-token" ;; *) printf \'%s\\n\' "$TELEHARNESS_GIT_TOKEN" ;; esac\n', { mode: 0o700 });
  await chmod(file, 0o700);
  return file;
}

export function prStepRunner({ prepareWorktree, gitAuthor, githubApi, githubToken, log = () => {} } = {}) {
  // githubApi(userId, method, path, body) → {status, data} | кидает GhError;
  // githubToken(userId) → токен подключения для push (GIT_ASKPASS).
  return async function openPullRequest({
    user, workflowId, project, workspace, pipeName, pipeSlug, inputs,
    description, branch: branchTpl, base, title: titleTpl, mode = "new",
    approved = false, sourceEngine = null, signal,
  }) {
    signal?.throwIfAborted();
    const repo = String(inputs?.repo ?? "").trim();
    if (!/^[^\s/]+\/[^\s/]+$/.test(repo)) fail(422, "Шаг PR работает в запуске по событию GitHub: во входах нет repo", "no_repo");
    const wt = await prepareWorktree({ user, project, workspace, workflowId, pipeName });
    if (!wt?.path || wt.state === "orphaned" || wt.state === "removed") fail(409, "Рабочая копия запуска недоступна", "worktree");
    // FEAT-20.3 1.18 (кр. 21): тенанту push разрешён только в свои ветки teleharness/…
    // (ответ на вопрос 3 карточки); same-branch — только владельцу.
    if (mode === "same-branch" && (wt.tenant || user?.role === "tenant")) fail(403, "Тенанту push разрешён только в ветки teleharness/… — используйте режим «новая ветка»", "forbidden");
    // untrusted-режим запрещает протоколы по умолчанию (lib/git.js); сетевой push
    // на github.com идёт по https — явно разрешаем только его.
    const net = wt.untrusted ? ["-c", "protocol.https.allow=always"] : [];
    const git = (args, opts = {}) => runGit([...net, ...args], { cwd: wt.path, untrusted: Boolean(wt.untrusted), timeoutMs: GIT_LONG_TIMEOUT_MS, ...opts });

    // GitHub-вызов: auth/network/rate_limited/server → github_wait, остальные — ошибка с текстом.
    // Вид — как в client.classify (403 без остатка лимита — «rate_limited»); 429 — тот же лимит (N-32).
    const gh = async (method, p, body) => {
      try {
        return await githubApi(user.id, method, p, body ?? null);
      } catch (e) {
        const kind = e?.status === 429 ? "rate_limited" : e?.kind;
        if (e instanceof GhError && ["auth", "network", "rate_limited", "server"].includes(kind)) return { wait: true, reason: `github_${kind}` };
        fail(e.status ?? 502, e.message || "GitHub ответил ошибкой", "github_rejected");
      }
    };

    // 1. git status → отбор файлов.
    const st = await git(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
    if (st.code !== 0) fail(500, `git status: ${firstLine(st.stderr)}`, "git");
    const selected = [];
    const workflowFiles = [];
    for (const f of parseStatus(st.stdout).files) {
      if (SECRET_FILE.test(f.path)) continue;
      if (f.path.replace(/\\/g, "/").startsWith(".github/workflows/")) { workflowFiles.push(f.path); continue; }
      try {
        const s = await stat(path.join(wt.path, f.path));
        if (s.size > SIZE_LIMIT) continue;
      } catch { continue; }
      selected.push(f.path);
    }
    const ahead = wt.base ? await git(["rev-list", "--count", `${wt.base}..HEAD`]) : null;
    const aheadCount = ahead?.code === 0 ? Number(String(ahead.stdout).trim() || "0") : 0;
    if (!selected.length && !workflowFiles.length && aheadCount === 0) return { state: "no_changes" };
    if (workflowFiles.length && !approved) return { state: "needs_approval", reason: "ci_files" };

    // 2. Коммит выбранных файлов: автор из Настройки → Git, трейлер движка.
    // Повтор шага после github_wait: изменения уже закоммичены — коммит не нужен.
    const scope = pipeSlug || safeBranch(pipeName) || "agent";
    // Заголовок PR — человекочитаемый (кириллица допустима); ascii-safe только ветка.
    const subject = String(titleTpl ? renderTemplate(titleTpl, { inputs }).replaceAll("{{slug}}", scope) : "").trim().slice(0, 200) || "Изменения агента";
    if (selected.length || workflowFiles.length) {
      const a = gitAuthor?.(user?.id) ?? {};
      const author = { name: a.name || "teleharness", email: a.email || "teleharness@localhost" };
      const message = [
        subject,
        String(description ?? "").trim().slice(0, 4000),
        `Co-Authored-By: ${sourceEngine || "teleharness"} <agents@teleharness.local>`,
      ].filter(Boolean).join("\n\n");
      try {
        const repoHandle = await openRepo(wt.path, { untrusted: Boolean(wt.untrusted) });
        await gitCommit(repoHandle, { files: [...selected, ...workflowFiles], message, author });
      } catch (e) {
        fail(e?.status ?? 500, `Коммит не состоялся: ${firstLine(e?.message) || "ошибка git"}`, "commit");
      }
    }
    // Коммит, который уходит на GitHub (или остаётся в копии при отказе) — для экрана запуска.
    const sha = shortSha((await git(["rev-parse", "HEAD"])).stdout);

    // 3. Push: в свою ветку teleharness/* — force-with-lease по снятому с удалённого sha,
    // в чужую (same-branch) — обычный fast-forward, отказ — «Ветка обновлена человеком».
    const [owner] = repo.split("/");
    const sameBranch = mode === "same-branch";
    const token = githubToken?.(user?.id);
    if (!token) fail(409, "Нет подключения GitHub — подключите токен в Настройки → GitHub", "no_token");
    let info = await gh("GET", `/repos/${repo}`);
    if (info.wait) return { state: "github_wait", reason: info.reason };
    const targetBranch = sameBranch
      ? (safeBranch(String(inputs?.branch ?? "")) || safeBranch(base) || String(info.data?.default_branch ?? "main"))
      : (safeBranch(branchTpl ? renderTemplate(branchTpl, { inputs }).replaceAll("{{slug}}", scope) : "") || wt.branch);
    const askpass = await writeAskpass();
    try {
      const env = { ...gitEnv(), TELEHARNESS_GIT_TOKEN: token };
      const authOpts = { env, gitVars: { GIT_ASKPASS: askpass } };
      let args;
      if (sameBranch) {
        args = ["-c", "credential.helper=", "push", "origin", `HEAD:${targetBranch}`];
      } else {
        const remote = await git(["-c", "credential.helper=", "ls-remote", "origin", `refs/heads/${targetBranch}`], authOpts);
        const expected = remote.code === 0 ? String(remote.stdout).trim().split("\t")[0] : "";
        // Коммит живёт в ветке копии запуска; PR-ветка формируется на удалённом (HEAD:refs/heads/…).
        args = expected
          ? ["-c", "credential.helper=", "push", `--force-with-lease=refs/heads/${targetBranch}=${expected}`, "origin", `HEAD:refs/heads/${targetBranch}`]
          : ["-c", "credential.helper=", "push", "origin", `HEAD:refs/heads/${targetBranch}`];
      }
      const pushed = await git(args, authOpts);
      if (pushed.code !== 0 || pushed.timedOut) {
        const safeStderr = redact(pushed.stderr, [token]);
        const kind = classifyPushError(safeStderr, { timedOut: pushed.timedOut }).kind;
        if (kind === "auth" || kind === "network") return { state: "github_wait", reason: `push_${kind}` };
        if (kind === "rejected" && sameBranch)
          fail(409, "Ветка обновлена человеком — правки агента не отправлены, перезапись не выполняется. Коммит остался в рабочей копии запуска.", "branch_moved", { sha });
        // Правило репозитория / защита ветки: текст GitHub — строками remote: в stderr.
        const classified = classifyPushError(safeStderr, { timedOut: pushed.timedOut });
        const notes = remoteNotes(safeStderr);
        fail(409, `GitHub отклонил отправку${notes ? `: ${notes}` : ""}. ${classified.error} Коммит ${sha} остался в рабочей копии — отправьте вручную или ослабьте правило для веток teleharness/*.`, "push_rejected", { sha });
      }
    } finally {
      await rm(askpass, { force: true }).catch(() => {});
    }

    // 4. PR: открытый с тем же head → комментарий, иначе draft-PR (повтор шага идемпотентен).
    // outcome — для экрана запуска (T-14, T-16, D-4): создан / обновлён / коммит в ветку PR.
    const search = await gh("GET", `/repos/${repo}/pulls?head=${encodeURIComponent(owner)}:${encodeURIComponent(targetBranch)}&state=open`);
    if (search.wait) return { state: "github_wait", reason: search.reason };
    const existing = Array.isArray(search.data) ? search.data.find((pr) => pr?.number) : null;
    if (existing) {
      const noted = await gh("POST", `/repos/${repo}/issues/${existing.number}/comments`, { body: "Агент обновил PR\n\n<!-- teleharness:agent -->" });
      if (noted.wait) return { state: "github_wait", reason: noted.reason };
      log(`pr-step: PR #${existing.number} обновлён (${repo})`);
      return { state: "done", url: existing.html_url ?? null, outcome: sameBranch ? "pushed" : "updated", branch: targetBranch, sha };
    }
    const prBase = safeBranch(base) || String(info.data?.default_branch ?? "main");
    const created = await gh("POST", `/repos/${repo}/pulls`, {
      title: subject,
      head: `${owner}:${targetBranch}`,
      base: prBase,
      body: String(description ?? "").trim().slice(0, 10_000),
      draft: true,
    });
    if (created.wait) return { state: "github_wait", reason: created.reason };
    log(`pr-step: PR открыт (${repo}, ветка ${targetBranch})`);
    return { state: "done", url: created.data?.html_url ?? null, outcome: "created", branch: targetBranch, base: prBase, sha };
  };
}
