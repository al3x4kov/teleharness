// FEAT-18.8: «Git проекта» — status / diff / commit / push of a chat or
// project folder, «Предложить сообщение» (a one-shot request to the chat's
// model) and the caller's own Настройки → Git. API contract:
// openspec/changes/diffs-and-git/design.md «API».
//
// Which folder (every /teleharness/api/git/* route):
//   ?sid=<chat>        — the chat's folder (a tenant chat: its own subfolder
//                        <root>\chats\<id> when it exists, FEAT-04.12) with the
//                        chat's own access rules: a tenant only its own chats
//                        (404 unknown, 403 foreign — like /session/:id);
//   ?directory=<abs>   — admin: any folder; tenant: only dirAllowed (403).
// The repository found there (`git rev-parse --show-toplevel`) must, for a
// tenant, stay inside its own folders — a tenant folder inside the owner's
// checkout is «not a repository» for the tenant, never the owner's repo.
// A folder that belongs to a tenant is UNTRUSTED for every caller (its agent
// writes .git/config): lib/git.js switches hooks/fsmonitor off and refuses a
// repo config that names a program.
//
// Rights: tenant — status, diff, commit in its own
// folders; push → 403. Admin — push when its Настройки → Git allow it
// (pushAllowed, default on). There is no branch API at all.
//
// deps: { sendJson, readJsonBody, apiError, errLog, dirAllowed,
//         chatDirOf(sid) → Promise<string|null>, tenantDir(dir) → bool,
//         existingChatFolder(root, sid), isUnderAny(dir, roots),
//         bindingOf(sid) → Promise<binding|null>, engineAllowed(user, engine),
//         tenantAgent() → Promise<string|null>,
//         getGitSettings, setGitSettings, cleanGitSettings,
//         suggest: {claudeBin, codexShim, token, oc, timeoutMs?} }
import path from "node:path";
import { GitError, diffForPrompt, gitCommit, gitDiff, gitPush, gitStatus, openRepo } from "../lib/git.js";
import { OneshotError, ONESHOT_DIFF_MAX, cleanCommitMessage, commitPrompt, runClaudeOneshot, runCodexOneshot, runOpencodeOneshot } from "../lib/oneshot.js";
import { realpathSync } from "node:fs";
const realOrSelf = (p) => { try { return realpathSync(p); } catch { return p; } };

const SID_RE = /^[A-Za-z0-9_.-]{1,200}$/;
const BODY_MAX = 512 * 1024; // a commit of thousands of selected paths

export function gitRoutes(deps) {
  const { sendJson } = deps;

  // GitError → its status and text (+ kind of a push error).
  const gitFail = (res, err) => {
    if (err instanceof GitError) return sendJson(res, err.status, { error: err.message, ...(err.extra ?? {}) });
    return deps.apiError(res, err);
  };

  // The folder of a chat the caller may open → {dir} | {status, error}.
  async function chatFolder(sid, user, admin) {
    if (typeof sid !== "string" || !SID_RE.test(sid)) return { status: 400, error: "bad sid" };
    const dir = await deps.chatDirOf(sid);
    if (dir == null) return { status: 404, error: "session not found" };
    if (!admin && !deps.dirAllowed(user, dir)) return { status: 403, error: "outside your scope" };
    const own = deps.tenantDir(dir) ? deps.existingChatFolder(dir, sid) : null;
    return { dir: own ?? dir };
  }

  // The folder of this request (?sid= | ?directory=) → {dir, untrusted} | {status, error}.
  async function target({ url, user, admin }) {
    const sid = url.searchParams.get("sid");
    const asked = url.searchParams.get("directory");
    let dir;
    if (sid) {
      const c = await chatFolder(sid, user, admin);
      if (!c.dir) return c;
      dir = c.dir;
    } else if (asked) {
      if (!path.isAbsolute(asked)) return { status: 400, error: "directory required" };
      if (!deps.dirAllowed(user, asked)) return { status: 403, error: "outside your scope" };
      dir = asked;
    } else return { status: 400, error: "sid or directory required" };
    return { dir, untrusted: !admin || deps.tenantDir(dir) };
  }

  // → {repo} | {repo: null} (not a repository for this caller) | {status, error}.
  async function repoOf(ctx) {
    const t = await target(ctx);
    if (!t.dir) return t;
    const repo = await openRepo(t.dir, { untrusted: t.untrusted });
    if (!repo) return { repo: null };
    // git names the root by its real path (macOS: /var → /private/var) — compare real paths too
    const dirs = ctx.user.directories ?? [];
    if (!ctx.admin && !deps.isUnderAny(repo.root, dirs) && !deps.isUnderAny(repo.root, dirs.map(realOrSelf))) return { repo: null };
    return { repo };
  }

  // Shared prologue: the repo or an answer already sent (null).
  async function withRepo(ctx) {
    const r = await repoOf(ctx);
    if (r.status) {
      sendJson(ctx.res, r.status, { error: r.error });
      return null;
    }
    if (!r.repo) {
      sendJson(ctx.res, 404, { error: "папка не под git" });
      return null;
    }
    return r.repo;
  }

  const pushAllowedFor = (user, admin) => Boolean(admin && deps.getGitSettings(user.id).pushAllowed);

  // The one-shot request to the model of chat `sid` → the message text.
  async function suggestFor(sid, user, admin, prompt) {
    const binding = await deps.bindingOf(sid);
    const engine = binding?.engine ?? "opencode";
    if (!deps.engineAllowed(user, engine)) throw Object.assign(new Error("engine not allowed"), { status: 403 });
    const s = deps.suggest;
    const opts = s.timeoutMs ? { timeoutMs: s.timeoutMs } : {};
    if (engine === "claude") return runClaudeOneshot({ binPath: s.claudeBin, model: binding.model.modelID, prompt, token: s.token, ...opts });
    if (engine === "codex") return runCodexOneshot({ shimPath: s.codexShim, model: binding.model.modelID, prompt, token: s.token, ...opts });
    const agent = binding?.agent ?? (admin ? null : await deps.tenantAgent());
    return runOpencodeOneshot({ oc: s.oc, model: binding?.model ?? null, agent, prompt, ...opts });
  }

  return [
    {
      method: "GET",
      path: "/teleharness/api/git/status",
      scope: "user",
      handler: async (ctx) => {
        const { res, user, admin } = ctx;
        try {
          const r = await repoOf(ctx);
          if (r.status) return sendJson(res, r.status, { error: r.error });
          if (!r.repo) return sendJson(res, 200, { repo: false });
          return sendJson(res, 200, { ...(await gitStatus(r.repo)), pushAllowed: pushAllowedFor(user, admin) });
        } catch (err) {
          return gitFail(res, err);
        }
      },
    },
    {
      method: "GET",
      path: "/teleharness/api/git/diff",
      scope: "user",
      handler: async (ctx) => {
        const { res, url } = ctx;
        const file = url.searchParams.get("file");
        if (!file) return sendJson(res, 400, { error: "file required" });
        try {
          const repo = await withRepo(ctx);
          if (!repo) return;
          return sendJson(res, 200, await gitDiff(repo, file, { full: url.searchParams.get("full") === "1" }));
        } catch (err) {
          return gitFail(res, err);
        }
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/git/commit",
      scope: "user",
      handler: async (ctx) => {
        const { req, res, user } = ctx;
        const body = await deps.readJsonBody(req, BODY_MAX);
        if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { error: "bad json body" });
        if (!Array.isArray(body.files)) return sendJson(res, 400, { error: "files required" });
        try {
          const repo = await withRepo(ctx);
          if (!repo) return;
          const s = deps.getGitSettings(user.id);
          return sendJson(res, 200, await gitCommit(repo, { files: body.files, message: body.message, author: { name: s.authorName, email: s.authorEmail } }));
        } catch (err) {
          return gitFail(res, err);
        }
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/git/push",
      scope: "user",
      handler: async (ctx) => {
        const { req, res, user, admin } = ctx;
        req.resume();
        if (!admin) return sendJson(res, 403, { error: "отправка доступна только администратору", kind: "forbidden" });
        if (!pushAllowedFor(user, admin)) return sendJson(res, 403, { error: "отправка выключена в Настройках → Git", kind: "forbidden" });
        try {
          const repo = await withRepo(ctx);
          if (!repo) return;
          return sendJson(res, 200, await gitPush(repo));
        } catch (err) {
          return gitFail(res, err);
        }
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/git/suggest-message",
      scope: "user",
      handler: async (ctx) => {
        const { req, res, url, user, admin } = ctx;
        const body = await deps.readJsonBody(req, BODY_MAX);
        if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { error: "bad json body" });
        if (!Array.isArray(body.files) || body.files.length === 0) return sendJson(res, 400, { error: "не выбраны файлы" });
        // the model is the one of this chat; the files are those of the folder
        // of the request (?sid= — the same chat, ?directory= — a project)
        const sid = typeof body.sid === "string" && body.sid ? body.sid : url.searchParams.get("sid");
        if (!sid) return sendJson(res, 400, { error: "sid required" });
        const chat = await chatFolder(sid, user, admin);
        if (!chat.dir) return sendJson(res, chat.status, { error: chat.error });
        let prompt;
        try {
          const repo = await withRepo(ctx);
          if (!repo) return;
          const diff = await diffForPrompt(repo, body.files, { maxChars: ONESHOT_DIFF_MAX });
          if (!diff.trim()) return sendJson(res, 400, { error: "в выбранных файлах нет изменений" });
          // messageLang "ui": the language of the caller's interface (body.lang), Russian when not sent
          const ui = body.lang === "en" ? "en" : "ru";
          const lang = deps.getGitSettings(user.id).messageLang === "en" ? "en" : ui;
          prompt = commitPrompt(diff, { lang });
        } catch (err) {
          return gitFail(res, err);
        }
        try {
          const message = cleanCommitMessage(await suggestFor(sid, user, admin, prompt));
          if (!message) return sendJson(res, 502, { error: "Модель не предложила сообщение — напишите его сами." });
          return sendJson(res, 200, { message });
        } catch (err) {
          if (err?.status === 403) return sendJson(res, 403, { error: err.message });
          if (!(err instanceof OneshotError)) deps.errLog("git.suggest", err);
          const why = err instanceof OneshotError ? err.message : "запрос не прошёл";
          return sendJson(res, 502, { error: `Не удалось получить сообщение от модели: ${why}.` });
        }
      },
    },
    // GET/PUT /teleharness/api/me/git — the caller's own Настройки → Git (any role;
    // only their own record). A tenant's pushAllowed is always false.
    {
      method: "*",
      path: "/teleharness/api/me/git",
      scope: "user",
      handler: async ({ req, res, user }) => {
        if (req.method === "GET") return sendJson(res, 200, deps.getGitSettings(user.id));
        if (req.method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
        const body = await deps.readJsonBody(req, 16 * 1024);
        if (body === null || typeof body !== "object") return sendJson(res, 400, { error: "bad json body" });
        let patch;
        try {
          patch = deps.cleanGitSettings(body);
        } catch (err) {
          return sendJson(res, err.status ?? 400, { error: err.message });
        }
        try {
          return sendJson(res, 200, deps.setGitSettings(user.id, patch));
        } catch (err) {
          return deps.apiError(res, err);
        }
      },
    },
  ];
}
