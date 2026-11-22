// FEAT-20.7: /teleharness/api/worktrees/* — рабочие копии (git worktree) чата и
// запуска: план создания, заявка для пустого чата, состояние, подтягивание,
// слияние с тестами, журнал операции, отмена, удаление, восстановление, ветки
// без чата, команда тестов, настройки. Контракт: openspec/changes/worktrees/design.md «API».
//
//   GET    /teleharness/api/worktrees/plan?sid=|directory=        → план (лист нового чата)
//   POST   /teleharness/api/worktrees/pending?sid=  {on, base?, branch?, carryDirty?, deps?, copyEnv?, remember?}
//   GET    /teleharness/api/worktrees?sid=                         → {item|null, pending|null}
//   GET    /teleharness/api/worktrees?directory=                   → {items, branches, repo}
//   GET    /teleharness/api/worktrees/:id                          → состояние (+ пересечения)
//   POST   /teleharness/api/worktrees/:id/(sync|undo-merge|revert-merge|restore|detach|unlock|checkout-branch|review)
//   POST   /teleharness/api/worktrees/:id/merge {method, message, skipTests, reason, commitDirty, idemKey, testCmd}
//   POST   /teleharness/api/worktrees/:id/reset-branch {opId}
//   POST   /teleharness/api/worktrees/:id/dismiss {otherId, files}
//   GET    /teleharness/api/worktrees/:id/unsaved                  → {uncommitted, commits, merged}
//   DELETE /teleharness/api/worktrees/:id?mode=auto|keep-branch|all&confirm=1
//   GET    /teleharness/api/worktrees/ops/:opId[?log=1]
//   DELETE /teleharness/api/worktrees/branches?directory=&name=
//   PUT    /teleharness/api/worktrees/test-cmd?directory=  {cmd|null}
//   POST   /teleharness/api/worktrees/init?directory=              → git init + первый коммит («Создать репозиторий»)
//   GET|PUT /teleharness/api/me/worktrees                          → настройки пользователя
//
// Права (Q1 «а»): тенант — только копии репозиториев внутри своих папок,
// только свои копии (чужая — 404, как несуществующая), без отправки и PR;
// admin — все копии. Сервер без песочницы → тесты тенанта недоступны.
import path from "node:path";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
const realOrSelf = (p) => { try { return realpathSync(p); } catch { return p; } };
import { GitError, runGit, sanitize } from "../lib/git.js";
import { isOpId, isWtId } from "../lib/worktrees.js";

const SID_RE = /^[A-Za-z0-9_.-]{1,200}$/;
const NOT_FOUND = { error: "Рабочая копия не найдена", kind: "gone" };

// deps: { sendJson, readJsonBody, errLog, wt (Worktrees), dirAllowed, isUnderAny,
//   chatDirOf(sid) → Promise<dir|null>, chatFolderOf(dir, sid) → path|null (тенант),
//   tenantDir(dir) → bool, titleOf(sid) → string|null, tenantTestsOk() → bool,
//   review({user, item}) → Promise<{id}>, gitAuthor(userId) → {name,email}, sessionAlive(sid) → bool }
export function worktreeRoutes(deps) {
  const { sendJson, wt } = deps;
  const fail = (res, err) => {
    if (err instanceof GitError) return sendJson(res, err.status, { error: err.message, ...(err.extra ?? {}) });
    deps.errLog?.("worktrees", err);
    return sendJson(res, 500, { error: "Ошибка рабочих копий" });
  };
  const body = async (req) => {
    const b = await deps.readJsonBody(req, 64 * 1024);
    return b && typeof b === "object" && !Array.isArray(b) ? b : null;
  };
  const own = (item, user, admin) => item && (admin || item.owner === user.id);
  const untrustedFor = (admin, dir) => !admin || deps.tenantDir(dir);

  // Папка чата, которую вызывающий может открыть → {dir} | {status, error}.
  async function chatDir(sid, user, admin) {
    if (typeof sid !== "string" || !SID_RE.test(sid)) return { status: 400, error: "bad sid" };
    const dir = await deps.chatDirOf(sid);
    if (dir == null) return { status: 404, error: "session not found" };
    if (!admin && !deps.dirAllowed(user, dir)) return { status: 403, error: "outside your scope" };
    return { dir };
  }
  // ?directory= / ?sid= → папка репозитория для вызывающего.
  async function dirOf(ctx) {
    const { url, user, admin } = ctx;
    const sid = url.searchParams.get("sid");
    if (sid) return chatDir(sid, user, admin);
    const d = url.searchParams.get("directory");
    if (!d || !path.isAbsolute(d)) return { status: 400, error: "directory required" };
    if (!deps.dirAllowed(user, d)) return { status: 403, error: "outside your scope" };
    return { dir: d };
  }
  // Репозиторий тенанта обязан лежать внутри его папок.
  async function repoAllowed(dir, user, admin) {
    if (admin) return true;
    const r = await wt.repoKeyFor(dir, true);
    const dirs = user.directories ?? [];
    return Boolean(r && (deps.isUnderAny(r.root, dirs) || deps.isUnderAny(realOrSelf(r.root), dirs.map(realOrSelf))));
  }

  const idRoute = (suffix, method, fn) => ({
    method,
    path: new RegExp(`^/teleharness/api/worktrees/(wt_[a-z0-9]{12})${suffix}$`),
    scope: "user",
    handler: async (ctx) => {
      const id = ctx.match[1];
      const item = isWtId(id) ? wt.store.byId(id) : null;
      if (!own(item, ctx.user, ctx.admin)) {
        ctx.req.resume?.();
        return sendJson(ctx.res, 404, NOT_FOUND);
      }
      try {
        return await fn(ctx, item);
      } catch (err) {
        return fail(ctx.res, err);
      }
    },
  });
  const simple = (name, fn) => idRoute(`/${name}`, "POST", async (ctx, item) => {
    const b = (await body(ctx.req)) ?? {};
    return sendJson(ctx.res, 200, await fn(item, b, ctx));
  });

  return [
    {
      method: "GET",
      path: "/teleharness/api/worktrees/plan",
      scope: "user",
      handler: async (ctx) => {
        const { res, user, admin } = ctx;
        try {
          const t = await dirOf(ctx);
          if (!t.dir) return sendJson(res, t.status, { error: t.error });
          if (!(await repoAllowed(t.dir, user, admin))) return sendJson(res, 200, { repo: false, reason: "not-git" });
          const plan = await wt.plan({ dir: t.dir, untrusted: untrustedFor(admin, t.dir), tenant: !admin, owner: user.id });
          if (plan.repo && !admin) plan.testsAvailable = deps.tenantTestsOk();
          return sendJson(res, 200, { ...plan, admin });
        } catch (err) {
          return fail(res, err);
        }
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/worktrees/pending",
      scope: "user",
      handler: async (ctx) => {
        const { req, res, url, user, admin } = ctx;
        const b = await body(req);
        if (!b) return sendJson(res, 400, { error: "bad json body" });
        const sid = url.searchParams.get("sid");
        try {
          const c = await chatDir(sid, user, admin);
          if (!c.dir) return sendJson(res, c.status, { error: c.error });
          if (wt.forChat(sid)) return sendJson(res, 409, { error: "Копия уже создана — переключатель доступен только до первого сообщения", kind: "exists" });
          if (deps.sessionPrompted?.(sid)) return sendJson(res, 409, { error: "Перенос существующего чата в копию не поддерживается — создайте новый чат", kind: "prompted" });
          if (b.remember !== undefined) wt.setSettings(user.id, { project: { dir: c.dir, on: Boolean(b.on) } }, { admin });
          if (!b.on) {
            wt.cancelPending(sid);
            return sendJson(res, 200, { pending: null });
          }
          if (!(await repoAllowed(c.dir, user, admin))) return sendJson(res, 403, { error: "Папка не под git", kind: "not-git" });
          const plan = await wt.plan({ dir: c.dir, untrusted: untrustedFor(admin, c.dir), tenant: !admin, owner: user.id });
          if (!plan.repo) return sendJson(res, 409, { error: plan.reason === "no-commits" ? "В репозитории нет ни одного коммита" : plan.reason === "dirty-config" ? plan.error : "Папка не под git", kind: plan.reason });
          if (plan.detached && !b.base) return sendJson(res, 409, { error: "Основная копия не на ветке — выберите базовую ветку", kind: "detached", branches: plan.branches });
          if (b.base && !plan.branches.includes(b.base)) return sendJson(res, 400, { error: "Базовая ветка не найдена" });
          if (!admin && b.deps === "install") return sendJson(res, 403, { error: "Установка зависимостей с сетью доступна только администратору", kind: "forbidden" });
          wt.request(sid, { owner: user.id, tenant: !admin, dir: c.dir, untrusted: untrustedFor(admin, c.dir), base: b.base ?? null, branch: typeof b.branch === "string" ? b.branch : null, carryDirty: Boolean(b.carryDirty), deps: b.deps ?? null, copyEnv: typeof b.copyEnv === "boolean" ? b.copyEnv : null });
          return sendJson(res, 200, { pending: wt.pendingOf(sid) && publicPending(wt.pendingOf(sid)) });
        } catch (err) {
          return fail(res, err);
        }
      },
    },
    {
      method: "GET",
      path: "/teleharness/api/worktrees",
      scope: "user",
      handler: async (ctx) => {
        const { res, url, user, admin } = ctx;
        try {
          // FEAT-20.7: копия запуска пайпа (экран запуска)
          const run = url.searchParams.get("run");
          if (run) {
            const item = /^[A-Za-z0-9_.:-]{1,200}$/.test(run) ? wt.store.byRun(run) : null;
            if (!own(item, user, admin)) return sendJson(res, 200, { item: null, pending: null });
            return sendJson(res, 200, { item: await wt.status(item, { admin, titleOf: deps.titleOf, overlaps: url.searchParams.get("overlaps") !== "0" }), pending: null });
          }
          const sid = url.searchParams.get("sid");
          if (sid) {
            const c = await chatDir(sid, user, admin);
            if (!c.dir) return sendJson(res, c.status, { error: c.error });
            const item = wt.forChat(sid);
            const p = wt.pendingOf(sid);
            if (item && !own(item, user, admin)) return sendJson(res, 200, { item: null, pending: null });
            return sendJson(res, 200, {
              item: item ? await wt.status(item, { admin, titleOf: deps.titleOf, overlaps: url.searchParams.get("overlaps") !== "0" }) : null,
              pending: p && (admin || p.owner === user.id) ? publicPending(p) : null,
            });
          }
          const t = await dirOf(ctx);
          if (!t.dir) return sendJson(res, t.status, { error: t.error });
          if (!(await repoAllowed(t.dir, user, admin))) return sendJson(res, 200, { repo: false, items: [], branches: [] });
          const untrusted = untrustedFor(admin, t.dir);
          const r = await wt.repoKeyFor(t.dir, untrusted);
          if (!r) return sendJson(res, 200, { repo: false, items: [], branches: [] });
          const items = wt.listRepo(r.key).filter((x) => own(x, user, admin));
          const out = [];
          for (const it of items) out.push(await wt.status(it, { admin, titleOf: deps.titleOf }).catch(() => wt.face(it, { admin })));
          const branches = await wt.orphanBranches({ repoRoot: r.root, untrusted });
          return sendJson(res, 200, { repo: true, name: path.basename(r.root), items: out, branches, limits: { max: wt.limits.maxPerRepo } });
        } catch (err) {
          return fail(res, err);
        }
      },
    },
    {
      method: "GET",
      path: /^\/teleharness\/api\/worktrees\/ops\/(op_[a-z0-9]{12})$/,
      scope: "user",
      handler: async ({ res, url, user, admin, match }) => {
        const op = isOpId(match[1]) ? wt.op(match[1]) : null;
        const item = op ? wt.store.byId(op.wtId) : null;
        if (!op || !(admin || op.owner === user.id || (item && item.owner === user.id))) return sendJson(res, 404, NOT_FOUND);
        if (url.searchParams.get("log") === "1") {
          const f = wt.logPath(op);
          let text = "";
          try {
            if (f && existsSync(f)) {
              const st = statSync(f);
              text = readFileSync(f, "utf8").slice(-Math.min(st.size, 2 * 1024 * 1024));
            }
          } catch {}
          // тенанту — без серверных путей
          return sendJson(res, 200, { log: admin ? text : text.replace(/(^|[\s'"(])\/(?:[^\s'"/]+\/)+/g, "$1…/") });
        }
        return sendJson(res, 200, publicOp(op));
      },
    },
    {
      method: "DELETE",
      path: "/teleharness/api/worktrees/branches",
      scope: "user",
      handler: async (ctx) => {
        const { res, url, user, admin } = ctx;
        try {
          const t = await dirOf(ctx);
          if (!t.dir) return sendJson(res, t.status, { error: t.error });
          if (!(await repoAllowed(t.dir, user, admin))) return sendJson(res, 404, NOT_FOUND);
          const r = await wt.repoKeyFor(t.dir, untrustedFor(admin, t.dir));
          if (!r) return sendJson(res, 404, NOT_FOUND);
          return sendJson(res, 200, await wt.deleteBranch({ repoRoot: r.root, untrusted: untrustedFor(admin, t.dir), name: url.searchParams.get("name") }));
        } catch (err) {
          return fail(res, err);
        }
      },
    },
    {
      method: "PUT",
      path: "/teleharness/api/worktrees/test-cmd",
      scope: "user",
      handler: async (ctx) => {
        const { req, res, user, admin } = ctx;
        const b = await body(req);
        if (!b || !("cmd" in b)) return sendJson(res, 400, { error: "cmd required" });
        try {
          const t = await dirOf(ctx);
          if (!t.dir) return sendJson(res, t.status, { error: t.error });
          if (!(await repoAllowed(t.dir, user, admin))) return sendJson(res, 404, NOT_FOUND);
          const r = await wt.repoKeyFor(t.dir, untrustedFor(admin, t.dir));
          if (!r) return sendJson(res, 404, NOT_FOUND);
          wt.setTestCmd(r.key, b.cmd === null ? null : String(b.cmd));
          return sendJson(res, 200, { ok: true, cmd: b.cmd === null ? null : String(b.cmd).trim() });
        } catch (err) {
          return fail(res, err);
        }
      },
    },
    {
      method: "POST",
      path: "/teleharness/api/worktrees/init",
      scope: "user",
      handler: async (ctx) => {
        const { req, res, user, admin } = ctx;
        req.resume?.();
        try {
          const t = await dirOf(ctx);
          if (!t.dir) return sendJson(res, t.status, { error: t.error });
          const plan = await wt.plan({ dir: t.dir, untrusted: true, tenant: !admin, owner: user.id }).catch(() => ({ repo: false, reason: "not-git" }));
          if (plan.repo || plan.reason === "no-commits") return sendJson(res, 409, { error: "Папка уже под git", kind: "exists" });
          const a = deps.gitAuthor(user.id);
          const id = ["-c", `user.name=${a.name || "teleharness"}`, "-c", `user.email=${a.email || "teleharness@localhost"}`];
          const run = (args) => runGit(args, { cwd: t.dir, untrusted: true, timeoutMs: 60_000 });
          const i = await run(["init", "-q", "-b", "main"]);
          if (i.code !== 0) throw new GitError(500, `git init не выполнен: ${sanitize(i.stderr)}`);
          await run(["add", "-A"]);
          const c = await run([...id, "commit", "-q", "--allow-empty", "--no-verify", "-m", "Первый коммит (zai)"]);
          if (c.code !== 0) throw new GitError(500, `Первый коммит не создан: ${sanitize(c.stderr)}`);
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          return fail(res, err);
        }
      },
    },
    {
      method: "*",
      path: "/teleharness/api/me/worktrees",
      scope: "user",
      handler: async ({ req, res, user, admin }) => {
        if (req.method === "GET") return sendJson(res, 200, wt.settingsOf(user.id));
        if (req.method !== "PUT") return sendJson(res, 405, { error: "method not allowed" });
        const b = await body(req);
        if (!b) return sendJson(res, 400, { error: "bad json body" });
        try {
          return sendJson(res, 200, wt.setSettings(user.id, b, { admin }));
        } catch (err) {
          return fail(res, err);
        }
      },
    },
    idRoute("", "GET", async ({ res, admin }, item) => sendJson(res, 200, await wt.status(item, { admin, titleOf: deps.titleOf }))),
    idRoute("/unsaved", "GET", async ({ res }, item) => sendJson(res, 200, await wt.unsaved(item))),
    simple("sync", (item) => wt.sync(item)),
    idRoute("/merge", "POST", async ({ req, res }, item) => {
      const b = (await body(req)) ?? {};
      const op = await wt.merge(item, b, { tenantTestsOk: item.tenant ? deps.tenantTestsOk() : true });
      return sendJson(res, 202, publicOp(op));
    }),
    simple("undo-merge", (item) => wt.undoMerge(item)),
    simple("revert-merge", (item) => wt.revertMerge(item)),
    simple("reset-branch", (item, b) => wt.resetBranch(item, b.opId)),
    simple("restore", (item) => wt.restore(item)),
    simple("detach", (item) => (wt.detach(item), { ok: true })),
    simple("unlock", (item) => wt.unlock(item)),
    simple("checkout-branch", (item) => wt.checkoutBranch(item)),
    simple("dismiss", (item, b) => {
      if (typeof b.otherId !== "string" || !Array.isArray(b.files)) throw new GitError(400, "otherId и files обязательны");
      wt.dismiss(item, b.otherId.slice(0, 40), b.files.filter((f) => typeof f === "string").slice(0, 500));
      return { ok: true };
    }),
    simple("review", async (item, b, ctx) => deps.review({ user: ctx.user, admin: ctx.admin, item })),
    idRoute("", "DELETE", async ({ res, url }, item) => {
      const mode = ["auto", "keep-branch", "all"].includes(url.searchParams.get("mode")) ? url.searchParams.get("mode") : "auto";
      return sendJson(res, 200, await wt.remove(item, { mode, confirm: url.searchParams.get("confirm") === "1" }));
    }),
  ];
}

const publicPending = (p) => ({ base: p.base, branch: p.branch, carryDirty: p.carryDirty, deps: p.deps, copyEnv: p.copyEnv, at: p.at });
// Журнал операции без серверных путей.
export function publicOp(op) {
  if (!op) return null;
  const { owner: _o, ...rest } = op;
  return { ...rest, test: op.test ? { ...op.test, logFile: undefined } : null };
}
