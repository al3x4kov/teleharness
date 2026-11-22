// FEAT-20.7: рабочие копии (git worktree) на чат и на запуск пайпа — создание
// при первом сообщении, состояние, пересечения правок, слияние с тестами до
// сдвига базовой ветки, отмена, удаление без потери работы, восстановление
// после перезапуска, уборка. Контракт: openspec/changes/worktrees/design.md.
//
// Безопасность:
//   - git — только через runGit (lib/git.js): без shell, без запросов, с
//     недоверенным режимом (хуки/fsmonitor/gpg выкл.) для репозиториев тенанта;
//     тенанту дополнительно выключены фильтры LFS и протоколы (подмодули/LFS
//     не качаются);
//   - опасный конфиг репозитория тенанта (DANGEROUS_KEYS) → 409 (openRepo);
//   - базовая ветка сдвигается только после зелёных тестов: объекты коммита
//     пишутся `commit-tree` (рабочие файлы не трогаются), ref — CAS
//     `update-ref <new> <old>` или `merge --ff-only` в копии, где база выбрана;
//   - незакоммиченная работа без явного «Удалить всё» не теряется: перед
//     удалением копии — WIP-коммит в ветку;
//   - журнал операции слияния (data/worktrees/ops/<id>.json) — восстановление
//     по нему при старте (recover).
//
// Расположение копий (решения владельца 2026-11-20, Q4 «а»):
//   admin  — <родитель проекта>/.teleharness-worktrees/<проект>/<ветка без teleharness/>;
//   тенант — папка чата <папка чата>/chats/<id> (FEAT-04.12): она внутри папки
//            тенанта (песочница монтирует её по тому же пути — ссылки .git
//            работают), и плагин песочницы opencode, хук Claude и раннер уже
//            ведут ход там (спайк 0.3, карточка «Решения»).
import { spawn } from "node:child_process";
import {
  appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, statfsSync, symlinkSync, unlinkSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { GitError, openRepo, parseStatus, runGit, sanitize } from "./git.js";
import { readJsonStore, writeJsonAtomic } from "./json-store.js";
import { groupSpawnOpts, killChildTree } from "./proc.js";
import { branchName, freeBranchName, isPortalBranch, unsavedText , WT_BRANCH_PREFIX } from "../shared/worktree.js";

export const WT = Object.freeze({
  maxPerRepo: 20,
  tenantMax: 5,
  tenantQuotaBytes: 2 * 1024 ** 3,
  reserveBytes: 1024 ** 3,
  portFrom: 43000,
  portTo: 43999,
  portBlock: 10,
  createTimeoutMs: 5 * 60_000,
  testTimeoutMin: 10,
  overlapThrottleMs: 10_000,
  overlapBudgetMs: 20_000,
  runKeepMs: 14 * 24 * 3600_000,
  envMaxBytes: 64 * 1024,
  carryMaxFiles: 500,
  carryMaxBytes: 64 * 1024 ** 2,
  lockStaleMs: 10 * 60_000,
  tailLines: 200,
});
const ID_RE = /^wt_[a-z0-9]{12}$/;
const OP_RE = /^op_[a-z0-9]{12}$/;
const SHA_RE = /^[0-9a-f]{40,64}$/;
const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|requirements[^/]*\.txt|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|go\.sum)$/;
export const isWtId = (s) => typeof s === "string" && ID_RE.test(s);
export const isOpId = (s) => typeof s === "string" && OP_RE.test(s);
const newId = (p) => `${p}_${randomBytes(9).toString("base64").replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(12, "0").slice(0, 12)}`;
export const repoKeyOf = (commonDir) => createHash("sha256").update(String(commonDir)).digest("hex").slice(0, 16);

export function wtError(status, kind, message, extra = {}) {
  return new GitError(status, message, { kind, ...extra });
}

// ---- чистые функции ------------------------------------------------------------

// Команда тестов по файлам репозитория (кр. 11). → {cmd, source} | null.
export function detectTestCmd(dir, { exists = existsSync, read = (f) => readFileSync(f, "utf8") } = {}) {
  const p = (f) => path.join(dir, f);
  if (exists(p("package.json"))) {
    try {
      const pkg = JSON.parse(read(p("package.json")));
      const t = pkg?.scripts?.test;
      if (typeof t === "string" && t.trim() && !/no test specified/i.test(t)) return { cmd: "npm test", source: "package.json" };
    } catch {}
  }
  if (exists(p("pytest.ini")) || exists(p("conftest.py")) || (exists(p("pyproject.toml")) && /\[tool\.pytest/.test(safeRead(read, p("pyproject.toml")))) || (exists(p("tests")) && exists(p("setup.cfg"))))
    return { cmd: "pytest -q", source: "pytest" };
  if (exists(p("Cargo.toml"))) return { cmd: "cargo test", source: "Cargo.toml" };
  if (exists(p("go.mod"))) return { cmd: "go test ./...", source: "go.mod" };
  if (exists(p("Makefile")) && /^test\s*:/m.test(safeRead(read, p("Makefile")))) return { cmd: "make test", source: "Makefile" };
  return null;
}
const safeRead = (read, f) => {
  try {
    return read(f);
  } catch {
    return "";
  }
};

// npm в песочнице тенанта нет (спайк 0.3: в образе только node) — `npm test` /
// `npm run x` → сам скрипт из package.json с node_modules/.bin в PATH.
export function tenantTestCommand(cmd, pkgJson) {
  const m = /^npm\s+(?:run\s+|run-script\s+)?([A-Za-z0-9:_-]+)\s*$/.exec(String(cmd ?? "").trim());
  if (!m) return cmd;
  const name = m[1] === "t" ? "test" : m[1];
  let script = null;
  try {
    script = JSON.parse(pkgJson)?.scripts?.[name] ?? null;
  } catch {}
  if (typeof script !== "string" || !script.trim()) return cmd;
  return `PATH="$PWD/node_modules/.bin:$PATH"; ${script}`;
}

// Пересечение двух множеств путей → отсортированный список.
export function intersect(a, b) {
  const out = [];
  for (const x of a) if (b.has(x)) out.push(x);
  return out.sort();
}

// Вывод `git merge-tree --write-tree --name-only --no-messages` → файлы с конфликтом.
export function parseMergeTree(code, stdout) {
  if (code === 0) return { conflict: false, files: [] };
  if (code !== 1) return null;
  const lines = String(stdout ?? "").split(/\r?\n/);
  const files = [];
  for (const l of lines.slice(1)) {
    if (!l) break;
    files.push(l);
  }
  return { conflict: true, files: [...new Set(files)] };
}

// Восстановление операции после перезапуска (кр. 17). Чистое решение по фазе
// журнала и текущему значению базы. → {phase, outcome}.
export function recoverDecision(op, baseNow) {
  if (!op || ["done", "failed", "interrupted"].includes(op.phase)) return null;
  if (op.phase === "advance" && op.newSha) {
    if (baseNow === op.newSha) return { phase: "done", outcome: "completed" };
    if (baseNow === op.mainOld) return { phase: "interrupted", outcome: "main-unchanged" };
    return { phase: "failed", outcome: "main-moved-outside" };
  }
  return { phase: "interrupted", outcome: "main-unchanged" };
}

// Хвост вывода: последние n строк.
export function tailOf(text, n = WT.tailLines) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

// Первый свободный блок портов.
export function freePortBlock(used, { from = WT.portFrom, to = WT.portTo, block = WT.portBlock } = {}) {
  const taken = new Set(used);
  for (let p = from; p + block - 1 <= to; p += block) if (!taken.has(p)) return p;
  return null;
}

// ---- хранилище ---------------------------------------------------------------

const emptyIndex = () => ({ schema: 1, items: [], pending: {}, repos: {}, settings: {} });

export class WorktreeStore {
  #file;
  #data;
  #log;
  constructor({ dir, log = console.error }) {
    this.dir = dir;
    this.#file = path.join(dir, "index.json");
    this.#log = log;
    this.#data = readJsonStore(this.#file, { fallback: emptyIndex, validate: (d) => d && Array.isArray(d.items), log });
    for (const k of ["pending", "repos", "settings"]) if (!this.#data[k] || typeof this.#data[k] !== "object") this.#data[k] = {};
  }
  get data() {
    return this.#data;
  }
  save() {
    mkdirSync(this.dir, { recursive: true });
    writeJsonAtomic(this.#file, this.#data, { log: this.#log });
  }
  get items() {
    return this.#data.items;
  }
  byId(id) {
    return isWtId(id) ? this.#data.items.find((x) => x.id === id) ?? null : null;
  }
  bySid(sid) {
    return this.#data.items.find((x) => x.sid === sid && x.state !== "removed") ?? null;
  }
  byRun(runId) {
    return this.#data.items.find((x) => x.runId === runId && x.state !== "removed") ?? null;
  }
  live() {
    return this.#data.items.filter((x) => x.state !== "removed");
  }
  drop(id) {
    this.#data.items = this.#data.items.filter((x) => x.id !== id);
  }
}

// ---- сервис ------------------------------------------------------------------

export class Worktrees {
  constructor({
    store, dataDir, log = console.error, now = Date.now, emit = () => {}, busy = () => false, author = () => ({ name: "teleharness", email: "teleharness@localhost" }),
    tenantJail = () => null, jailLine = null, platform = process.platform, statfs = statfsSync, runTests = null, limits = {},
  }) {
    this.store = store;
    this.dataDir = dataDir;
    this.log = log;
    this.now = now;
    this.emit = emit;
    this.busy = busy;
    this.author = author;
    this.tenantJail = tenantJail; // dir → {name, home} | null
    this.jailLine = jailLine; // linuxJailLine
    this.platform = platform;
    this.statfs = statfs;
    this.limits = { ...WT, ...limits };
    this.runTestsImpl = runTests ?? ((o) => this.#spawnTests(o));
    this.queues = new Map(); // repoKey → Promise (очередь операций репозитория)
    this.running = new Map(); // repoKey → {opId, wtId, title}
    this.ops = new Map(); // opId → op (в памяти; на диске — журнал)
    this.overlapCache = new Map(); // repoKey → {at, data}
    this.creating = new Map(); // sid → Promise
    mkdirSync(this.#opsDir, { recursive: true });
  }

  get #opsDir() {
    return path.join(this.dataDir, "ops");
  }
  get #logsDir() {
    return path.join(this.dataDir, "logs");
  }

  // git в репозитории копии: недоверенный режим и для тенанта — без LFS/протоколов.
  #git(item, args, opts = {}) {
    const extra = item?.tenant || item?.untrusted ? ["-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.clean=", "-c", "filter.lfs.required=false", "-c", "submodule.recurse=false"] : [];
    return runGit([...extra, ...args], { cwd: opts.cwd ?? item.path, untrusted: Boolean(item?.untrusted), timeoutMs: opts.timeoutMs, input: opts.input ?? null, maxOut: opts.maxOut });
  }
  #ident(owner) {
    const a = this.author(owner) ?? {};
    return ["-c", `user.name=${a.name || "teleharness"}`, "-c", `user.email=${a.email || "teleharness@localhost"}`];
  }

  // Очередь операций одного репозитория (кр. 11, 18): создание, слияние,
  // удаление и тесты идут по очереди.
  async #queue(key, label, fn) {
    const prev = this.queues.get(key) ?? Promise.resolve();
    let release;
    const mine = new Promise((r) => (release = r));
    const chain = prev.then(() => mine);
    this.queues.set(key, chain);
    try {
      await prev;
    } catch {}
    this.running.set(key, label);
    try {
      return await fn();
    } finally {
      if (this.running.get(key) === label) this.running.delete(key);
      release();
      if (this.queues.get(key) === chain) this.queues.delete(key);
    }
  }
  waitingFor(key) {
    return this.running.get(key) ?? null;
  }

  // ---- настройки пользователя -------------------------------------------------
  settingsOf(owner) {
    const s = this.store.data.settings[owner] ?? {};
    return {
      mergeMethod: ["squash", "merge", "ff"].includes(s.mergeMethod) ? s.mergeMethod : "squash", // Q2 «а»
      testTimeoutMin: Number.isInteger(s.testTimeoutMin) && s.testTimeoutMin >= 1 && s.testTimeoutMin <= 60 ? s.testTimeoutMin : this.limits.testTimeoutMin,
      deps: ["link", "install", "none"].includes(s.deps) ? s.deps : "link",
      copyEnv: typeof s.copyEnv === "boolean" ? s.copyEnv : true,
      defaultByProject: s.defaultByProject && typeof s.defaultByProject === "object" ? s.defaultByProject : {},
    };
  }
  setSettings(owner, patch, { admin = false } = {}) {
    const cur = { ...(this.store.data.settings[owner] ?? {}) };
    if (patch.mergeMethod !== undefined) {
      if (!["squash", "merge", "ff"].includes(patch.mergeMethod)) throw wtError(400, "bad", "Способ слияния: выберите один из вариантов");
      cur.mergeMethod = patch.mergeMethod;
    }
    if (patch.testTimeoutMin !== undefined) {
      const n = Number(patch.testTimeoutMin);
      if (!Number.isInteger(n) || n < 1 || n > 60) throw wtError(400, "bad", "Тайм-аут тестов: от 1 до 60 минут");
      cur.testTimeoutMin = n;
    }
    if (patch.deps !== undefined) {
      if (!["link", "install", "none"].includes(patch.deps) || (!admin && patch.deps === "install")) throw wtError(400, "bad", "Зависимости: выберите один из вариантов");
      cur.deps = patch.deps;
    }
    if (patch.copyEnv !== undefined) cur.copyEnv = Boolean(patch.copyEnv);
    if (patch.project && typeof patch.project === "object" && typeof patch.project.dir === "string") {
      const d = { ...(cur.defaultByProject ?? {}) };
      d[patch.project.dir] = Boolean(patch.project.on);
      const keys = Object.keys(d);
      if (keys.length > 200) delete d[keys[0]];
      cur.defaultByProject = d;
    }
    this.store.data.settings[owner] = cur;
    this.store.save();
    return this.settingsOf(owner);
  }
  testCmdOf(item) {
    const r = this.store.data.repos[item.repoKey] ?? {};
    if (Object.prototype.hasOwnProperty.call(r, "testCmd")) return { cmd: r.testCmd, source: r.testCmd ? "user" : "none" };
    const d = detectTestCmd(item.path) ?? detectTestCmd(item.repoRoot);
    return d ?? { cmd: undefined, source: "not-found" };
  }
  setTestCmd(repoKey, cmd) {
    if (cmd !== null && (typeof cmd !== "string" || !cmd.trim() || cmd.length > 500 || /[\0\r\n]/.test(cmd))) throw wtError(400, "bad", "Команда тестов: одна строка до 500 символов");
    this.store.data.repos[repoKey] = { ...(this.store.data.repos[repoKey] ?? {}), testCmd: cmd === null ? null : cmd.trim() };
    this.store.save();
  }

  // ---- план создания (лист нового чата) ----------------------------------------
  // → {repo:false, reason} | {repo:true, base, branches, detached, dirty, estimateBytes, freeBytes, ...}
  async plan({ dir, untrusted, tenant, owner }) {
    let repo;
    try {
      repo = await openRepo(dir, { untrusted });
    } catch (err) {
      if (err instanceof GitError && err.status === 409) return { repo: false, reason: "dirty-config", error: err.message };
      throw err;
    }
    if (!repo) return { repo: false, reason: "not-git" };
    const g = (args, o) => runGit(args, { cwd: repo.root, untrusted, ...o });
    const head = await g(["rev-parse", "--verify", "-q", "HEAD"]);
    if (head.code !== 0) return { repo: false, reason: "no-commits" };
    const cur = await g(["symbolic-ref", "-q", "--short", "HEAD"]);
    const br = await g(["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", "--count=200", "refs/heads/"]);
    const branches = br.stdout.split(/\r?\n/).filter((b) => b && !b.startsWith("teleharness/"));
    const st = await g(["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
    const dirty = st.code === 0 ? parseStatus(st.stdout).files.map((f) => f.path) : [];
    const estimateBytes = await this.#estimate(repo.root, untrusted);
    const freeBytes = this.#free(repo.root);
    const commonDir = await this.#commonDir(repo.root, untrusted);
    const key = repoKeyOf(commonDir);
    const mine = this.store.live().filter((x) => x.owner === owner);
    const inRepo = this.store.live().filter((x) => x.repoKey === key);
    const s = this.settingsOf(owner);
    const subs = countSubmodules(repo.root);
    const lfs = await this.#lfsCount(repo.root, untrusted);
    const envFiles = await this.#envFiles(repo.root, untrusted);
    const test = detectTestCmd(repo.root);
    const stored = this.store.data.repos[key];
    return {
      repo: true,
      name: path.basename(repo.root),
      base: cur.code === 0 ? cur.stdout.trim() : null,
      detached: cur.code !== 0,
      branches,
      dirty: dirty.slice(0, 200),
      dirtyCount: dirty.length,
      estimateBytes,
      freeBytes,
      reserveBytes: this.limits.reserveBytes,
      limits: tenant
        ? { max: this.limits.tenantMax, used: mine.length, quotaBytes: this.limits.tenantQuotaBytes, usedBytes: mine.reduce((n, x) => n + (x.size || 0), 0) }
        : { max: this.limits.maxPerRepo, used: inRepo.length },
      submodules: subs,
      lfs,
      deps: { node_modules: existsSync(path.join(repo.root, "node_modules")), venv: existsSync(path.join(repo.root, ".venv")) },
      envFiles,
      testCmd: stored && Object.prototype.hasOwnProperty.call(stored, "testCmd") ? stored.testCmd : test?.cmd ?? null,
      testSource: stored && Object.prototype.hasOwnProperty.call(stored, "testCmd") ? "user" : test?.source ?? "not-found",
      settings: s,
      remember: s.defaultByProject[dir] ?? null,
    };
  }

  async #commonDir(root, untrusted) {
    const r = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, untrusted });
    return r.code === 0 ? path.resolve(r.stdout.trim()) : path.join(root, ".git");
  }
  async #estimate(root, untrusted) {
    const r = await runGit(["ls-tree", "-r", "--format=%(objectsize)", "HEAD"], { cwd: root, untrusted, maxOut: 16 * 1024 * 1024, timeoutMs: 30_000 });
    if (r.code !== 0) return 0;
    let n = 0;
    for (const l of r.stdout.split("\n")) {
      const v = Number(l);
      if (Number.isFinite(v)) n += v;
    }
    return n;
  }
  #free(p) {
    try {
      const s = this.statfs(p);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  }
  async #lfsCount(root, untrusted) {
    let attrs = "";
    try {
      attrs = readFileSync(path.join(root, ".gitattributes"), "utf8");
    } catch {}
    if (!/filter=lfs/.test(attrs)) return 0;
    const ls = await runGit(["ls-files", "-z"], { cwd: root, untrusted, maxOut: 16 * 1024 * 1024 });
    if (ls.code !== 0) return 0;
    const ca = await runGit(["check-attr", "--stdin", "-z", "filter"], { cwd: root, untrusted, input: ls.stdout, maxOut: 16 * 1024 * 1024 });
    if (ca.code !== 0) return 0;
    const f = ca.stdout.split("\0");
    let n = 0;
    for (let i = 0; i + 2 < f.length; i += 3) if (f[i + 2] === "lfs") n++;
    return n;
  }
  // Неотслеживаемые и игнорируемые .env* до 64 КБ (копировать безопасно: в
  // копии они тоже игнорируются и не попадут в коммит агента).
  async #envFiles(root, untrusted) {
    let names = [];
    try {
      names = readdirSync(root).filter((n) => /^\.env(\..+)?$/.test(n));
    } catch {}
    const out = [];
    for (const n of names) {
      try {
        const st = lstatSync(path.join(root, n));
        if (!st.isFile() || st.size > this.limits.envMaxBytes) continue;
      } catch {
        continue;
      }
      const ig = await runGit(["--no-literal-pathspecs", "check-ignore", "-q", "--", n], { cwd: root, untrusted });
      if (ig.code === 0) out.push(n);
    }
    return out;
  }

  // ---- заявка и создание --------------------------------------------------------

  // Чат создан с включённой копией: копия появится при первом сообщении.
  request(sid, { owner, tenant, dir, untrusted, base = null, branch = null, carryDirty = false, deps = null, copyEnv = null }) {
    this.store.data.pending[sid] = {
      owner, tenant: Boolean(tenant), dir, untrusted: Boolean(untrusted), base: typeof base === "string" && base ? base : null,
      branch: typeof branch === "string" && branch ? branch.slice(0, 80) : null, carryDirty: Boolean(carryDirty),
      deps: ["link", "install", "none"].includes(deps) ? deps : null, copyEnv: typeof copyEnv === "boolean" ? copyEnv : null, at: this.now(),
    };
    this.store.save();
  }
  pendingOf(sid) {
    return this.store.data.pending[sid] ?? null;
  }
  cancelPending(sid) {
    if (this.store.data.pending[sid]) {
      delete this.store.data.pending[sid];
      this.store.save();
    }
  }
  forChat(sid) {
    return this.store.bySid(sid);
  }
  // Папка хода чата: путь копии (готовой) или null.
  workDirOf(sid) {
    const it = this.store.bySid(sid);
    return it && it.state !== "orphaned" && it.state !== "failed" && existsSync(it.path) ? it.path : null;
  }

  // Ход чата: заявка → копия (ход ждёт создания, кр. 2). → item | null.
  async ensureForTurn({ sid, text, chatFolder = null }) {
    const ready = this.store.bySid(sid);
    if (ready) {
      if (!existsSync(ready.path)) throw wtError(409, "gone", "Папка рабочей копии не найдена — восстановите её из ветки или отвяжите чат", { wtId: ready.id });
      return ready;
    }
    const req = this.store.data.pending[sid];
    if (!req) return null;
    if (this.creating.has(sid)) return this.creating.get(sid);
    const p = this.create({ ...req, sid, kind: "chat", text, chatFolder }).finally(() => this.creating.delete(sid));
    this.creating.set(sid, p);
    const item = await p;
    delete this.store.data.pending[sid];
    this.store.save();
    return item;
  }

  // Создание копии (кр. 2–5, 16, 20, 21, 23).
  async create({ sid = null, runId = null, pipeId = null, kind = "chat", owner, tenant, dir, untrusted, base, branch, carryDirty, deps, copyEnv, text = "", chatFolder = null, title = null }) {
    let repo;
    try {
      repo = await openRepo(dir, { untrusted });
    } catch (err) {
      if (err instanceof GitError && err.status === 409) throw wtError(409, "dirty-config", err.message);
      throw err;
    }
    if (!repo) throw wtError(409, "not-git", "Папка не под git");
    const g = (args, o = {}) => runGit(args, { cwd: repo.root, untrusted, ...o });
    if ((await g(["rev-parse", "--verify", "-q", "HEAD"])).code !== 0) throw wtError(409, "no-commits", "В репозитории нет ни одного коммита — сделайте первый коммит в Git");
    const commonDir = await this.#commonDir(repo.root, untrusted);
    const key = repoKeyOf(commonDir);
    return this.#queue(key, { kind: "create", sid, title }, async () => {
      // база
      let baseName = base;
      if (!baseName) {
        const cur = await g(["symbolic-ref", "-q", "--short", "HEAD"]);
        if (cur.code !== 0) throw wtError(409, "detached", "Основная копия не на ветке (detached HEAD) — выберите базовую ветку");
        baseName = cur.stdout.trim();
      }
      const baseSha = await revParse(g, `refs/heads/${baseName}`);
      if (!baseSha) throw wtError(400, "bad", "Базовая ветка не найдена");
      // лимиты (кр. 16)
      const live = this.store.live();
      if (live.filter((x) => x.repoKey === key).length >= this.limits.maxPerRepo) throw wtError(409, "limit", `Достигнут лимит: ${this.limits.maxPerRepo} рабочих копий этого репозитория. Удалите ненужные`);
      const mine = live.filter((x) => x.owner === owner);
      if (tenant && mine.length >= this.limits.tenantMax) throw wtError(409, "limit", `Достигнут лимит: ${this.limits.tenantMax} рабочих копий. Удалите ненужные`);
      const estimate = await this.#estimate(repo.root, untrusted);
      if (tenant) {
        const used = mine.reduce((n, x) => n + (x.size || 0), 0);
        if (used + estimate > this.limits.tenantQuotaBytes) throw wtError(409, "quota", "Достигнут лимит места для рабочих копий. Удалите ненужные", { estimateBytes: estimate, usedBytes: used });
      }
      // имя ветки (кр. 3)
      const id = newId("wt");
      const refs = await g(["for-each-ref", "--format=%(refname:short)", "refs/heads/teleharness/"]);
      const taken = new Set(refs.stdout.split(/\r?\n/).filter(Boolean));
      let name = branchName(text, id.slice(3, 7), { custom: branch });
      if (kind === "run") name = branchName(title || "run", id.slice(3, 7), { custom: null }).replace(/^teleharness\//, "teleharness/run-");
      name = freeBranchName(name, taken);
      const fmt = await g(["check-ref-format", "--branch", name]);
      if (fmt.code !== 0 || !isPortalBranch(name)) throw wtError(400, "bad", "Недопустимое имя ветки");
      // путь
      let wtPath;
      if (tenant) {
        if (!chatFolder) throw wtError(409, "forbidden", "Для копии нужна папка чата");
        wtPath = chatFolder;
      } else {
        const parent = path.join(path.dirname(repo.root), ".teleharness-worktrees", path.basename(repo.root));
        const leaf = name.slice(WT_BRANCH_PREFIX.length).replace(/\//g, "-");
        wtPath = path.join(parent, leaf);
        for (let i = 2; existsSync(wtPath) && i < 100; i++) wtPath = path.join(parent, `${leaf}-${i}`);
      }
      const free = this.#free(existsSync(wtPath) ? wtPath : path.dirname(repo.root));
      if (free != null && free < estimate + this.limits.reserveBytes)
        throw wtError(409, "space", "Не хватает места", { estimateBytes: estimate, freeBytes: free, reserveBytes: this.limits.reserveBytes });
      // папка чата тенанта: допускается только служебная ссылка .teleharness-uploads
      let restoreUploads = null;
      if (existsSync(wtPath)) {
        const rest = readdirSync(wtPath);
        const other = rest.filter((n) => n !== ".teleharness-uploads");
        if (other.length) throw wtError(409, "not-empty", "Папка чата уже содержит файлы — копию создать нельзя");
        if (rest.includes(".teleharness-uploads")) {
          const lp = path.join(wtPath, ".teleharness-uploads");
          try {
            const st = lstatSync(lp);
            if (st.isSymbolicLink()) {
              restoreUploads = path.resolve(path.dirname(lp), readlinkSync(lp));
              unlinkSync(lp);
            } else if (st.isDirectory() && readdirSync(lp).length === 0) rmSync(lp, { recursive: true, force: true });
            else throw wtError(409, "not-empty", "Папка чата уже содержит файлы — копию создать нельзя");
          } catch (err) {
            if (err instanceof GitError) throw err;
          }
        }
      } else mkdirSync(path.dirname(wtPath), { recursive: true });
      const port = freePortBlock(live.map((x) => x.port).filter(Number.isInteger), this.limits);
      const item = {
        id, owner, tenant: Boolean(tenant), untrusted: Boolean(untrusted), kind, sid, runId, pipeId, title,
        repoRoot: repo.root, commonDir, repoKey: key, path: wtPath, branch: name, base: baseName, baseAtFork: baseSha, port,
        deps: deps ?? this.settingsOf(owner).deps, envCopied: [], artifacts: [], state: "creating", createdAt: this.now(), size: estimate,
        submodules: 0, lfs: 0, carried: 0,
      };
      if (tenant && item.deps === "install") item.deps = "link";
      this.store.items.push(item);
      this.store.save();
      const started = this.now();
      const add = await this.#git(item, ["worktree", "add", "--no-track", "-b", name, wtPath, baseSha], { cwd: repo.root, timeoutMs: this.limits.createTimeoutMs, maxOut: 1024 * 1024 });
      if (add.code !== 0 || add.timedOut) {
        await this.#cleanupFailed(item, repo.root);
        if (restoreUploads) tryLink(restoreUploads, path.join(wtPath, ".teleharness-uploads"));
        const why = add.timedOut ? "создание заняло больше 5 минут" : sanitize(firstLine(add.stderr));
        throw wtError(500, "create-failed", `Не удалось создать рабочую копию: ${why}. Частичная копия и ветка удалены`);
      }
      await this.#git(item, ["worktree", "lock", "--reason", `teleharness ${kind} ${sid ?? runId ?? id}`, wtPath], { cwd: repo.root });
      if (restoreUploads) {
        tryLink(restoreUploads, path.join(wtPath, ".teleharness-uploads"));
        item.artifacts.push(".teleharness-uploads");
      }
      // артефакты портала в копии не должны попадать в коммиты агента
      this.#exclude(item, repo.root);
      // перенос незакоммиченного (кр. 4): stash create не меняет основную копию
      if (carryDirty) item.carried = await this.#carry(item, repo.root);
      // окружение (кр. 5)
      const s = this.settingsOf(owner);
      if (item.deps === "link") {
        for (const d of ["node_modules", ".venv"]) {
          const src = path.join(repo.root, d);
          const dst = path.join(wtPath, d);
          if (!existsSync(src) || existsSync(dst)) continue;
          const ig = await this.#git(item, ["--no-literal-pathspecs", "check-ignore", "-q", "--", `${d}/`], { cwd: repo.root });
          if (ig.code !== 0) continue; // не игнорируется в основной — ссылка попала бы в коммит
          // правило «node_modules/» не скрывает ссылку (это не каталог) — /node_modules в exclude
          if (tryLink(src, dst)) {
            item.artifacts.push(d);
            this.#exclude(item, repo.root, [`/${d}`]);
          }
        }
      }
      if (copyEnv ?? s.copyEnv) {
        for (const f of await this.#envFiles(repo.root, untrusted)) {
          try {
            copyFileSync(path.join(repo.root, f), path.join(wtPath, f));
            item.envCopied.push(f);
          } catch {}
        }
      }
      item.submodules = countSubmodules(wtPath);
      item.lfs = await this.#lfsCount(wtPath, untrusted);
      item.state = "ready";
      item.readyAt = this.now();
      item.createMs = item.readyAt - started;
      this.store.save();
      this.#changed(item, "created");
      return item;
    });
  }

  async #cleanupFailed(item, root) {
    try {
      await this.#git(item, ["worktree", "remove", "--force", "--force", item.path], { cwd: root });
    } catch {}
    try {
      if (item.tenant) {
        // папка чата остаётся (FEAT-04.12), очищается только содержимое копии
        for (const n of existsSync(item.path) ? readdirSync(item.path) : []) rmSync(path.join(item.path, n), { recursive: true, force: true });
      } else rmSync(item.path, { recursive: true, force: true });
    } catch {}
    await this.#git(item, ["worktree", "prune"], { cwd: root }).catch(() => {});
    await this.#git(item, ["branch", "-D", item.branch], { cwd: root }).catch(() => {});
    this.store.drop(item.id);
    this.store.save();
  }

  #exclude(item, root, only = null) {
    // копия внутри основной (тенант: chats/<id>) — основная её не видит
    const lines = only ? [...only] : [];
    const rel = path.relative(realOrSelf(root), realOrSelf(item.path));
    if (!only && rel && !rel.startsWith("..") && !path.isAbsolute(rel)) lines.push(`/${rel.split(path.sep).join("/")}/`);
    if (!only) lines.push("/.teleharness-uploads");
    try {
      const f = path.join(item.commonDir, "info", "exclude");
      mkdirSync(path.dirname(f), { recursive: true });
      const cur = existsSync(f) ? readFileSync(f, "utf8") : "";
      const add = lines.filter((l) => !cur.split(/\r?\n/).includes(l));
      if (add.length) appendFileSync(f, `${cur && !cur.endsWith("\n") ? "\n" : ""}# teleharness worktrees (FEAT-20.7)\n${add.join("\n")}\n`);
    } catch (err) {
      this.log(`[teleharness-wt] exclude: ${err?.message ?? err}`);
    }
  }

  async #carry(item, root) {
    let n = 0;
    const st = await this.#git(item, ["stash", "create"], { cwd: root });
    const sha = st.stdout.trim();
    if (st.code === 0 && SHA_RE.test(sha)) {
      const ap = await this.#git(item, ["stash", "apply", sha]);
      if (ap.code === 0) n += 1;
    }
    // неотслеживаемые файлы stash create не берёт — копируются (с лимитом)
    const ls = await this.#git(item, ["ls-files", "-z", "--others", "--exclude-standard"], { cwd: root, maxOut: 4 * 1024 * 1024 });
    let bytes = 0;
    let files = 0;
    for (const rel of ls.stdout.split("\0").filter(Boolean)) {
      if (files >= this.limits.carryMaxFiles) break;
      const src = path.join(root, rel);
      const dst = path.join(item.path, rel);
      try {
        const s = lstatSync(src);
        if (!s.isFile() || bytes + s.size > this.limits.carryMaxBytes) continue;
        if (!isInside(dst, item.path)) continue;
        mkdirSync(path.dirname(dst), { recursive: true });
        copyFileSync(src, dst);
        bytes += s.size;
        files++;
      } catch {}
    }
    return n + files;
  }

  // ---- состояние ----------------------------------------------------------------

  async status(item, { admin = false, titleOf = () => null, overlaps = true } = {}) {
    const face = this.face(item, { admin });
    if (item.state === "removed") return face;
    if (!existsSync(item.path)) return { ...face, gone: true, op: this.lastOp(item.id) };
    const head = await this.#git(item, ["symbolic-ref", "-q", "--short", "HEAD"]);
    const onBranch = head.code === 0 ? head.stdout.trim() : null;
    const headSha = await revParse((a) => this.#git(item, a), "HEAD");
    const baseSha = await revParse((a) => this.#git(item, a), `refs/heads/${item.base}`);
    const ab = baseSha ? await this.#git(item, ["rev-list", "--left-right", "--count", `${baseSha}...HEAD`]) : null;
    const [behind, ahead] = ab && ab.code === 0 ? ab.stdout.trim().split(/\s+/).map(Number) : [0, 0];
    const mb = baseSha ? (await this.#git(item, ["merge-base", baseSha, "HEAD"])).stdout.trim() : "";
    const ns = SHA_RE.test(mb) ? await this.#git(item, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", mb, "HEAD"]) : null;
    const committed = ns && ns.code === 0 ? numstatFiles(ns.stdout) : [];
    const st = await this.#git(item, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
    const unc = st.code === 0 ? parseStatus(st.stdout).files.filter((f) => !item.artifacts.includes(f.path)) : [];
    // BUG-274: числа незакоммиченного — рабочее дерево против merge-base (без базы — против HEAD);
    // неотслеживаемые файлы git diff не видит — число строк файла
    let live = null;
    if (unc.length) {
      const from = SHA_RE.test(mb) ? mb : headSha;
      const wn = from ? await this.#git(item, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", from]) : null;
      live = new Map(wn && wn.code === 0 ? numstatFiles(wn.stdout).map((f) => [f.path, f]) : []);
      for (const f of unc) if (f.status === "?" && !live.has(f.path)) live.set(f.path, { additions: untrackedLines(path.join(item.path, f.path)), deletions: 0 });
    }
    const files = mergeFileLists(committed, unc, live);
    const lockfile = files.some((f) => LOCKFILES.test(f.path));
    const test = this.testCmdOf(item);
    const op = this.lastOp(item.id);
    const lockAge = indexLockAge(item);
    const q = this.waitingFor(item.repoKey);
    const other = q?.wtId ? this.store.byId(q.wtId) : null;
    return {
      ...face,
      // название чата (dogfood 2026-11-20: в списке копий было просто «Чат»)
      title: face.title ?? (item.sid ? titleOf(item.sid) : null) ?? null,
      branchOk: onBranch === item.branch,
      onBranch,
      head: headSha,
      baseHead: baseSha,
      ahead: ahead || 0,
      behind: behind || 0,
      files: files.slice(0, 500),
      filesCount: files.length,
      uncommitted: unc.length,
      additions: files.reduce((n, f) => n + (f.additions || 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions || 0), 0),
      depsChanged: lockfile && item.deps === "link",
      testCmd: test.cmd ?? null,
      testSource: test.source,
      busy: Boolean(item.sid && this.busy(item.sid)),
      op,
      queue: q ? { ...q, title: (other?.sid ? titleOf(other.sid) : null) ?? q.title ?? null } : null,
      canUndoMerge: item.state === "merged" && item.mergedSha && baseSha === item.mergedSha,
      lock: lockAge != null ? { ageMs: lockAge, stale: lockAge >= this.limits.lockStaleMs && !this.busy(item.sid) && !this.waitingFor(item.repoKey) } : null,
      turnCommit: item.turnHead && headSha && item.turnHead !== headSha ? { before: item.turnHead, after: headSha } : null,
      overlaps: overlaps ? await this.overlapsFor(item, { titleOf }).catch((err) => (this.log(`[teleharness-wt] overlaps: ${err?.message ?? err}`), [])) : [],
    };
  }

  face(item, { admin = false } = {}) {
    return {
      id: item.id, kind: item.kind, sid: item.sid ?? null, runId: item.runId ?? null, title: item.title ?? null, branch: item.branch, base: item.base, state: item.state,
      name: path.basename(item.repoRoot), port: item.port ?? null, deps: item.deps, envCopied: item.envCopied ?? [], submodules: item.submodules ?? 0, lfs: item.lfs ?? 0,
      carried: item.carried ?? 0, createdAt: item.createdAt, createMs: item.createMs ?? null, tenant: item.tenant, size: item.size ?? 0,
      mergedAt: item.mergedAt ?? null, mergedSha: item.mergedSha ?? null, mergedFiles: item.mergedFiles ?? null, mergedTests: item.mergedTests ?? null, savedAt: item.savedAt ?? null,
      ...(admin ? { path: item.path, repoRoot: item.repoRoot } : {}),
    };
  }

  // Множество изменённых копией файлов: закоммиченное от merge-base + незакоммиченное.
  async #fileSet(item, baseSha) {
    const set = new Set();
    const mb = (await this.#git(item, ["merge-base", baseSha, "HEAD"])).stdout.trim();
    if (SHA_RE.test(mb)) {
      const d = await this.#git(item, ["diff", "--name-only", "-z", "--no-ext-diff", mb, "HEAD"]);
      for (const f of d.stdout.split("\0").filter(Boolean)) set.add(f);
    }
    const st = await this.#git(item, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
    if (st.code === 0) for (const f of parseStatus(st.stdout).files) if (!item.artifacts.includes(f.path)) set.add(f.path);
    return { set, mb };
  }

  // Пересечения правок копии (кр. 7). Кэш на репозиторий — не чаще раза в 10 с.
  async overlapsFor(item, { titleOf = () => null, force = false } = {}) {
    const data = await this.#overlapData(item.repoKey, { force });
    const mine = data.sets.get(item.id);
    if (!mine) return [];
    const out = [];
    const dismissed = item.dismissed ?? {};
    const keep = (other, files) => {
      const d = new Set(dismissed[other] ?? []);
      return files.some((f) => !d.has(f.path));
    };
    for (const [otherId, other] of data.sets) {
      if (otherId === item.id) continue;
      const files = intersect(mine.set, other.set);
      if (!files.length) continue;
      const c = data.conflicts.get(pairKey(item.id, otherId));
      const conflictFiles = new Set(c?.files ?? []);
      const list = files.map((p) => ({ path: p, conflict: c == null ? null : conflictFiles.has(p) }));
      const o = this.store.byId(otherId);
      if (keep(otherId, list)) out.push({ kind: "chat", otherId, sid: o?.sid ?? null, runId: o?.runId ?? null, title: (o?.sid ? titleOf(o.sid) : null) ?? o?.title ?? o?.branch ?? null, branch: o?.branch ?? null, files: list, conflict: list.some((f) => f.conflict) });
    }
    const main = intersect(mine.set, data.main);
    if (main.length && keep("main", main.map((p) => ({ path: p })))) out.push({ kind: "main", otherId: "main", title: null, files: main.map((p) => ({ path: p, conflict: null })), conflict: false });
    const baseFiles = intersect(mine.set, mine.baseChanged);
    if (baseFiles.length) {
      const c = data.conflicts.get(pairKey(item.id, "base"));
      const cf = new Set(c?.files ?? []);
      const list = baseFiles.map((p) => ({ path: p, conflict: c == null ? null : cf.has(p) }));
      if (keep("base", list)) out.push({ kind: "base", otherId: "base", title: item.base, files: list, conflict: list.some((f) => f.conflict) });
    }
    return out;
  }

  async #overlapData(key, { force = false } = {}) {
    const hit = this.overlapCache.get(key);
    if (!force && hit && this.now() - hit.at < this.limits.overlapThrottleMs) return hit.data;
    if (hit?.pending) return hit.pending;
    const pending = this.#computeOverlaps(key);
    this.overlapCache.set(key, { ...(hit ?? { at: 0, data: null }), pending });
    try {
      const data = await pending;
      this.overlapCache.set(key, { at: this.now(), data });
      return data;
    } catch (err) {
      this.overlapCache.delete(key);
      throw err;
    }
  }

  async #computeOverlaps(key) {
    const items = this.store.live().filter((x) => x.repoKey === key && ["ready", "merging", "merged"].includes(x.state) && existsSync(x.path));
    const sets = new Map();
    const conflicts = new Map();
    const started = this.now();
    const any = items[0];
    if (!any) return { sets, main: new Set(), conflicts };
    for (const it of items) {
      const baseSha = await revParse((a) => this.#git(it, a), `refs/heads/${it.base}`);
      if (!baseSha) continue;
      const { set, mb } = await this.#fileSet(it, baseSha);
      const baseChanged = new Set();
      if (SHA_RE.test(mb) && mb !== baseSha) {
        const d = await this.#git(it, ["diff", "--name-only", "-z", "--no-ext-diff", mb, baseSha]);
        for (const f of d.stdout.split("\0").filter(Boolean)) baseChanged.add(f);
      }
      const head = await revParse((a) => this.#git(it, a), "HEAD");
      sets.set(it.id, { set, baseChanged, head, baseSha });
    }
    // основная копия: незакоммиченное в корне репозитория
    const main = new Set();
    const st = await this.#git(any, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"], { cwd: any.repoRoot });
    if (st.code === 0) for (const f of parseStatus(st.stdout).files) main.add(f.path);
    // пробное слияние без касания файлов (merge-tree) — попарно, в бюджете времени
    const ids = [...sets.keys()];
    for (let i = 0; i < ids.length; i++) {
      const a = sets.get(ids[i]);
      if (a.baseChanged.size && intersect(a.set, a.baseChanged).length) {
        const r = await this.#git(any, ["merge-tree", "--write-tree", "--name-only", "--no-messages", a.baseSha, a.head], { cwd: any.repoRoot, timeoutMs: 5000 });
        const m = parseMergeTree(r.code, r.stdout);
        if (m) conflicts.set(pairKey(ids[i], "base"), m);
      }
      for (let j = i + 1; j < ids.length; j++) {
        if (this.now() - started > this.limits.overlapBudgetMs) break;
        const b = sets.get(ids[j]);
        if (!intersect(a.set, b.set).length || !a.head || !b.head) continue;
        const r = await this.#git(any, ["merge-tree", "--write-tree", "--name-only", "--no-messages", a.head, b.head], { cwd: any.repoRoot, timeoutMs: 5000 });
        const m = parseMergeTree(r.code, r.stdout);
        if (m) conflicts.set(pairKey(ids[i], ids[j]), m);
      }
    }
    return { sets, main, conflicts };
  }

  // Конец хода / правка файла — пересчитать пересечения репозитория и
  // сообщить затронутым владельцам (событие teleharness.worktree.updated).
  async touchRepoOf(sidOrItem, { titleOf = () => null } = {}) {
    const it = typeof sidOrItem === "string" ? this.store.bySid(sidOrItem) : sidOrItem;
    const keys = new Set();
    if (it) keys.add(it.repoKey);
    for (const key of keys) {
      const before = this.overlapCache.get(key)?.data ?? null;
      const data = await this.#overlapData(key, { force: true });
      const sig = (d) => (d ? JSON.stringify([...d.sets].map(([id, s]) => [id, [...s.set].sort()])) + JSON.stringify([...d.main].sort()) : "");
      if (sig(before) !== sig(data)) for (const x of this.store.live().filter((y) => y.repoKey === key)) this.#changed(x, "overlap");
    }
  }
  // Чат без копии правит основную копию: пересчитать копии репозитория этой папки.
  async touchDir(dir) {
    for (const x of this.store.live()) {
      if (isInside(dir, x.repoRoot)) {
        await this.touchRepoOf(x).catch(() => {});
        break;
      }
    }
  }
  dismiss(item, otherId, files) {
    item.dismissed = { ...(item.dismissed ?? {}), [otherId]: [...new Set([...(item.dismissed?.[otherId] ?? []), ...files])].slice(0, 500) };
    this.store.save();
  }

  noteTurnStart(sid, head) {
    const it = this.store.bySid(sid);
    if (!it) return;
    it.turnHead = head;
    it.lastTurnAt = this.now();
    this.store.save();
  }
  async headOf(item) {
    return revParse((a) => this.#git(item, a), "HEAD");
  }

  // ---- подтянуть базу (кр. 6, P-7) ------------------------------------------------
  async sync(item) {
    this.#assertUsable(item);
    if (item.sid && this.busy(item.sid)) throw wtError(409, "turn-running", "Дождитесь конца хода");
    return this.#queue(item.repoKey, { kind: "sync", wtId: item.id, title: item.title }, async () => {
      await this.#assertBranch(item);
      const r = await this.#git(item, [...this.#ident(item.owner), "merge", "--no-edit", "--no-ff", `refs/heads/${item.base}`], { timeoutMs: 120_000 });
      if (r.code !== 0) {
        const files = await this.#conflictFiles(item);
        await this.#git(item, ["merge", "--abort"]).catch(() => {});
        if (files.length || /CONFLICT/.test(r.stdout + r.stderr)) throw wtError(409, "conflict", "Конфликт — подтягивание не выполнено", { files });
        if (/local changes|would be overwritten/i.test(r.stderr)) throw wtError(409, "dirty", "В копии есть незакоммиченные файлы, которые изменит подтягивание — закоммитьте их", {});
        throw wtError(500, "git", `git: подтягивание не выполнено — ${sanitize(firstLine(r.stderr))}`);
      }
      this.overlapCache.delete(item.repoKey);
      this.#changed(item, "synced");
      return { ok: true, upToDate: /Already up to date/i.test(r.stdout) };
    });
  }

  async #conflictFiles(item) {
    const r = await this.#git(item, ["diff", "--name-only", "-z", "--diff-filter=U"]);
    return r.stdout.split("\0").filter(Boolean);
  }
  #assertUsable(item) {
    if (!item || item.state === "removed") throw wtError(409, "gone", "Копия удалена в другом окне");
    if (!existsSync(item.path)) throw wtError(409, "gone", "Папка рабочей копии не найдена");
  }
  async #assertBranch(item) {
    const head = await this.#git(item, ["symbolic-ref", "-q", "--short", "HEAD"]);
    const on = head.code === 0 ? head.stdout.trim() : null;
    if (on !== item.branch) throw wtError(409, "branch-switched", `В копии выбрана другая ветка (${on ?? "detached"}) — слияние недоступно`, { onBranch: on });
  }

  // ---- слияние (кр. 8–13) ----------------------------------------------------------
  // opts: {method, message, skipTests, reason, commitDirty, idemKey, testCmd}
  async merge(item, opts = {}, { tenantTestsOk = true } = {}) {
    this.#assertUsable(item);
    const idem = typeof opts.idemKey === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(opts.idemKey) ? opts.idemKey : null;
    if (idem) {
      const same = [...this.ops.values()].find((o) => o.wtId === item.id && o.idemKey === idem);
      if (same) return same;
    }
    const running = [...this.ops.values()].find((o) => o.wtId === item.id && !["done", "failed", "interrupted"].includes(o.phase));
    if (running) return running;
    if (item.sid && this.busy(item.sid)) throw wtError(409, "turn-running", "Дождитесь конца хода");
    await this.#assertBranch(item);
    const method = ["squash", "merge", "ff"].includes(opts.method) ? opts.method : this.settingsOf(item.owner).mergeMethod;
    // незакоммиченное в копии
    const st = await this.#git(item, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
    const dirty = st.code === 0 ? parseStatus(st.stdout).files.filter((f) => !item.artifacts.includes(f.path)).map((f) => f.path) : [];
    if (dirty.length && !opts.commitDirty) throw wtError(409, "dirty", `В копии ${dirty.length} файл(ов) не закоммичены`, { files: dirty.slice(0, 100), count: dirty.length });
    // тесты
    const test = this.testCmdOf(item);
    let cmd = typeof opts.testCmd === "string" && opts.testCmd.trim() ? opts.testCmd.trim() : test.cmd;
    const skip = Boolean(opts.skipTests);
    if (skip) {
      const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";
      if (!reason) throw wtError(400, "bad", "Укажите причину слияния без тестов");
    } else if (!cmd) {
      throw wtError(409, cmd === null ? "no-tests-chosen" : "no-tests", cmd === null ? "Для репозитория выбрано «Нет тестов» — подтвердите слияние без тестов" : "Команда тестов не найдена — задайте её или слейте без тестов");
    } else if (item.tenant && !tenantTestsOk) {
      throw wtError(409, "tests-unavailable", "Тесты для пользователей недоступны на этом сервере — слейте без тестов с подтверждением");
    }
    if (opts.testCmd && typeof opts.testCmd === "string" && opts.testCmd.trim() && opts.testCmd.trim() !== test.cmd) this.setTestCmd(item.repoKey, opts.testCmd.trim());
    const message = typeof opts.message === "string" && opts.message.trim() ? opts.message.trim().slice(0, 10_000) : `${item.title || item.branch}`;
    const op = {
      opId: newId("op"), wtId: item.id, idemKey: idem, method, message, skipTests: skip, reason: skip ? String(opts.reason).trim().slice(0, 500) : null,
      commitDirty: dirty.length > 0, phase: "queued", steps: { precheck: "wait", update: "wait", test: skip ? "skip" : "wait", advance: "wait" },
      test: { cmd: skip ? null : cmd, startedAt: null, finishedAt: null, exit: null, tail: "", passed: null }, retries: 0, createdAt: this.now(), updatedAt: this.now(),
      owner: item.owner,
    };
    this.#saveOp(op);
    void this.#queue(item.repoKey, { kind: "merge", wtId: item.id, opId: op.opId, title: item.title || item.branch }, () => this.#runMerge(item, op)).catch((err) => {
      this.log(`[teleharness-wt] merge ${op.opId}: ${err?.stack ?? err}`);
      this.#fail(item, op, "git", sanitize(err?.message ?? String(err)));
    });
    return op;
  }

  async #runMerge(item, op) {
    if (!this.store.byId(item.id) || item.state === "removed") return this.#fail(item, op, "gone", "Копия удалена в другом окне");
    item.state = "merging";
    this.store.save();
    // precheck
    this.#phase(item, op, "precheck");
    try {
      await this.#assertBranch(item);
    } catch (err) {
      return this.#fail(item, op, err.extra?.kind ?? "branch-switched", err.message);
    }
    if (item.sid && this.busy(item.sid)) return this.#fail(item, op, "turn-running", "Дождитесь конца хода");
    if (op.commitDirty) {
      await this.#git(item, ["add", "-A"]);
      const c = await this.#git(item, [...this.#ident(item.owner), "commit", "-q", "--no-verify", `--message=${op.message}`], { timeoutMs: 60_000 });
      if (c.code !== 0 && !/nothing to commit/i.test(c.stdout + c.stderr)) return this.#fail(item, op, "git", `Коммит не выполнен: ${sanitize(firstLine(c.stderr))}`);
    }
    op.branchBefore = await revParse((a) => this.#git(item, a), "HEAD");
    op.steps.precheck = "ok";
    for (;;) {
      op.mainOld = await revParse((a) => this.#git(item, a), `refs/heads/${item.base}`);
      if (!op.mainOld) return this.#fail(item, op, "git", "Базовая ветка не найдена");
      // update: подтянуть базу в ветку внутри копии
      this.#phase(item, op, "update");
      const anc = await this.#git(item, ["merge-base", "--is-ancestor", op.mainOld, "HEAD"]);
      if (anc.code !== 0) {
        const r = await this.#git(item, [...this.#ident(item.owner), "merge", "--no-edit", "--no-ff", op.mainOld], { timeoutMs: 120_000 });
        if (r.code !== 0) {
          const files = await this.#conflictFiles(item);
          await this.#git(item, ["merge", "--abort"]).catch(() => {});
          if (files.length || /CONFLICT/.test(r.stdout + r.stderr)) return this.#fail(item, op, "conflict", "Конфликт — слияние не выполнено, main не изменена", { files });
          return this.#fail(item, op, "git", `Подтягивание не выполнено: ${sanitize(firstLine(r.stderr))}`);
        }
      }
      op.steps.update = "ok";
      op.head = await revParse((a) => this.#git(item, a), "HEAD");
      // test
      if (!op.skipTests) {
        this.#phase(item, op, "test");
        op.test.startedAt = this.now();
        this.#saveOp(op);
        const r = await this.#runTestsFor(item, op);
        op.test.finishedAt = this.now();
        op.test.exit = r.code;
        op.test.tail = tailOf(r.output);
        op.test.timedOut = Boolean(r.timedOut);
        op.test.passed = r.code === 0 && !r.timedOut;
        op.test.summary = testSummary(r.output);
        if (r.unavailable) return this.#fail(item, op, "tests-unavailable", r.error ?? "Тесты для пользователей недоступны на этом сервере");
        if (r.timedOut) return this.#fail(item, op, "tests-timeout", `Тесты не уложились в ${this.settingsOf(item.owner).testTimeoutMin} мин — main не изменена`);
        if (!op.test.passed) return this.#fail(item, op, "tests-failed", "Тесты не прошли — main не изменена");
        op.steps.test = "ok";
      }
      // advance
      this.#phase(item, op, "advance");
      const tree = (await this.#git(item, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
      let newSha;
      if (op.method === "ff") newSha = op.head;
      else {
        const parents = op.method === "merge" ? ["-p", op.mainOld, "-p", op.head] : ["-p", op.mainOld];
        const ct = await this.#git(item, [...this.#ident(item.owner), "commit-tree", tree, ...parents, "-F", "-"], { input: op.message + "\n" });
        newSha = ct.stdout.trim();
        if (ct.code !== 0 || !SHA_RE.test(newSha)) return this.#fail(item, op, "git", `Коммит слияния не создан: ${sanitize(firstLine(ct.stderr))}`);
      }
      op.newSha = newSha;
      this.#saveOp(op);
      const changed = (await this.#git(item, ["diff", "--name-only", "-z", "--no-ext-diff", op.mainOld, newSha])).stdout.split("\0").filter(Boolean);
      const checkedOut = await this.#checkedOutAt(item, item.base);
      let moved = false;
      if (checkedOut) {
        // база выбрана в основной копии: её незакоммиченное в файлах слияния — стоп (кр. 13)
        const st = await this.#git(item, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"], { cwd: checkedOut });
        const dirty = st.code === 0 ? parseStatus(st.stdout).files.map((f) => f.path) : [];
        const hit = intersect(new Set(changed), new Set(dirty));
        if (hit.length) return this.#fail(item, op, "main-dirty", `Основная копия: ${hit.length} файл(ов) не закоммичены и будут перезаписаны — main не изменена`, { files: hit.slice(0, 100) });
        const now = await revParse((a) => this.#git(item, a, { cwd: checkedOut }), `refs/heads/${item.base}`);
        if (now !== op.mainOld) moved = true;
        else {
          const ff = await this.#git(item, ["merge", "--ff-only", "--no-edit", newSha], { cwd: checkedOut, timeoutMs: 120_000 });
          if (ff.code !== 0) {
            if (/would be overwritten|untracked working tree files/i.test(ff.stderr)) return this.#fail(item, op, "main-dirty", "Основная копия: файлы будут перезаписаны — main не изменена", { files: [] });
            return this.#fail(item, op, "git", `Перенос в main не выполнен: ${sanitize(firstLine(ff.stderr))}`);
          }
        }
      } else {
        const u = await this.#git(item, ["update-ref", "-m", `teleharness merge ${item.branch}`, `refs/heads/${item.base}`, newSha, op.mainOld]);
        if (u.code !== 0) moved = true;
      }
      if (moved) {
        if (op.retries >= 1) return this.#fail(item, op, "main-moved", "main изменилась во время проверки — повторите слияние");
        op.retries += 1;
        op.note = "main изменилась во время проверки — подтягиваю ещё раз и повторяю тесты (1 из 1)";
        op.steps = { ...op.steps, update: "wait", test: op.skipTests ? "skip" : "wait", advance: "wait" };
        this.#saveOp(op);
        continue;
      }
      op.steps.advance = "ok";
      // cleanup: ветка копии = новое значение базы (файлы не меняются: дерево то же)
      this.#phase(item, op, "cleanup");
      if (op.method !== "ff") await this.#git(item, ["reset", "-q", "--keep", newSha]).catch(() => {});
      item.state = "merged";
      item.mergedAt = this.now();
      item.mergedSha = newSha;
      item.mainBefore = op.mainOld;
      item.mergedFiles = changed.length;
      item.mergedTests = op.skipTests ? { skipped: true, reason: op.reason } : { passed: true, summary: op.test.summary ?? null };
      this.store.save();
      op.phase = "done";
      op.files = changed.length;
      op.updatedAt = this.now();
      this.#saveOp(op);
      this.overlapCache.delete(item.repoKey);
      this.#changed(item, "merged");
      // вторая копия того же репозитория узнаёт, что база ушла вперёд
      for (const x of this.store.live().filter((y) => y.repoKey === item.repoKey && y.id !== item.id)) this.#changed(x, "base-moved");
      return op;
    }
  }

  async #checkedOutAt(item, branch) {
    const r = await this.#git(item, ["worktree", "list", "--porcelain"]);
    let cur = null;
    for (const l of r.stdout.split(/\r?\n/)) {
      if (l.startsWith("worktree ")) cur = l.slice(9);
      else if (l === `branch refs/heads/${branch}` && cur) return path.resolve(cur);
    }
    return null;
  }

  async #runTestsFor(item, op) {
    const s = this.settingsOf(item.owner);
    const timeoutMs = s.testTimeoutMin * 60_000;
    mkdirSync(this.#logsDir, { recursive: true });
    const logFile = path.join(this.#logsDir, `${op.opId}.log`);
    op.test.logFile = path.basename(logFile);
    let cmd = op.test.cmd;
    let jail = null;
    if (item.tenant) {
      jail = this.tenantJail(item.path);
      if (this.platform !== "linux" || !this.jailLine || !jail) return { unavailable: true, error: "Тесты для пользователей недоступны на этом сервере" };
      cmd = tenantTestCommand(cmd, safeRead((f) => readFileSync(f, "utf8"), path.join(item.path, "package.json")));
    }
    return this.runTestsImpl({ cmd, cwd: item.path, port: item.port, timeoutMs, logFile, jail, opId: op.opId });
  }

  // Прогон команды тестов: admin — процесс сервера; тенант — песочница
  // (teleharness-tenant-run, без сети, 512 МБ). Дерево процессов убивается по тайм-ауту.
  #spawnTests({ cmd, cwd, port, timeoutMs, logFile, jail }) {
    return new Promise((resolve) => {
      let line = cmd;
      if (jail) {
        const j = this.jailLine(`export TELEHARNESS_WORKTREE_PORT=${Number(port) || 0} CI=1; ${cmd}`, { name: jail.name, home: jail.home, cwd });
        if (j.error) return resolve({ unavailable: true, error: `Тесты недоступны: ${j.error}` });
        line = j.command;
      }
      let out = "";
      let child;
      try {
        const [shBin, shArgs] = process.platform === "win32" ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line]] : ["/bin/sh", ["-c", line]];
        child = spawn(shBin, shArgs, groupSpawnOpts({ cwd, env: { ...process.env, CI: "1", TELEHARNESS_WORKTREE_PORT: String(port ?? ""), FORCE_COLOR: "0", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] }));
      } catch (err) {
        return resolve({ code: -1, output: String(err?.message ?? err) });
      }
      const write = (c) => {
        const s = c.toString("utf8");
        out = (out + s).slice(-512 * 1024);
        try {
          appendFileSync(logFile, s);
        } catch {}
      };
      child.stdout.on("data", write);
      child.stderr.on("data", write);
      let timedOut = false;
      const t = setTimeout(() => {
        timedOut = true;
        killChildTree(child);
      }, timeoutMs);
      child.on("error", (e) => write(Buffer.from(String(e?.message ?? e))));
      child.on("close", (code) => {
        clearTimeout(t);
        resolve({ code: code ?? -1, output: out, timedOut });
      });
    });
  }

  #phase(item, op, phase) {
    op.phase = phase;
    if (op.steps[phase] === "wait") op.steps[phase] = "run";
    op.updatedAt = this.now();
    this.#saveOp(op);
    this.#changed(item, "op");
  }
  #fail(item, op, kind, error, extra = {}) {
    op.phase = "failed";
    op.kind = kind;
    op.error = error;
    Object.assign(op, extra);
    for (const k of Object.keys(op.steps)) if (op.steps[k] === "run") op.steps[k] = "fail";
    op.updatedAt = this.now();
    this.#saveOp(op);
    const live = this.store.byId(item.id);
    if (live && live.state === "merging") {
      live.state = "ready";
      this.store.save();
    }
    this.#changed(item, "op");
    return op;
  }
  #saveOp(op) {
    this.ops.set(op.opId, op);
    writeJsonAtomic(path.join(this.#opsDir, `${op.opId}.json`), op, { log: this.log });
  }
  op(opId) {
    if (!isOpId(opId)) return null;
    if (this.ops.has(opId)) return this.ops.get(opId);
    const f = path.join(this.#opsDir, `${opId}.json`);
    const o = readJsonStore(f, { fallback: () => null, log: this.log });
    if (o) this.ops.set(opId, o);
    return o;
  }
  lastOp(wtId) {
    let best = null;
    for (const o of this.ops.values()) if (o.wtId === wtId && (!best || o.createdAt > best.createdAt)) best = o;
    return best;
  }
  logPath(op) {
    return op?.test?.logFile ? path.join(this.#logsDir, path.basename(op.test.logFile)) : null;
  }

  // ---- отмена слияния / вернуть ветку --------------------------------------------
  // FEAT-20.7 кр. 12 / TASK-20.34 п.4: «Продолжить в этой копии» после слияния.
  async continueAfterMerge(item) {
    this.#assertUsable(item);
    if (item.sid && this.busy(item.sid)) throw wtError(409, "turn-running", "Дождитесь конца хода");
    if (item.state !== "merged") throw wtError(409, "bad", "Копия не в состоянии «слито»");
    item.state = "ready";
    delete item.mergedSha;
    delete item.mainBefore;
    delete item.mergedAt;
    this.store.save();
    this.overlapCache.delete(item.repoKey);
    this.#changed(item, "continued");
    return { ok: true, state: item.state };
  }
  async undoMerge(item) {
    this.#assertUsable(item);
    if (item.state !== "merged" || !item.mergedSha || !item.mainBefore) throw wtError(409, "bad", "Отменять нечего");
    return this.#queue(item.repoKey, { kind: "undo", wtId: item.id, title: item.title }, async () => {
      const now = await revParse((a) => this.#git(item, a), `refs/heads/${item.base}`);
      if (now !== item.mergedSha) throw wtError(409, "main-moved", "Отменить слияние уже нельзя: main ушла дальше — можно создать отменяющий коммит", { revertSuggested: true });
      const at = await this.#checkedOutAt(item, item.base);
      if (at) {
        const r = await this.#git(item, ["reset", "-q", "--keep", item.mainBefore], { cwd: at });
        if (r.code !== 0) throw wtError(409, "main-dirty", "Основная копия: незакоммиченные файлы мешают отмене — закоммитьте или уберите их");
      } else {
        const u = await this.#git(item, ["update-ref", `refs/heads/${item.base}`, item.mainBefore, item.mergedSha]);
        if (u.code !== 0) throw wtError(409, "main-moved", "main изменилась — повторите", { revertSuggested: true });
      }
      item.state = "ready";
      item.undoneAt = this.now();
      delete item.mergedSha;
      this.store.save();
      this.overlapCache.delete(item.repoKey);
      this.#changed(item, "undone");
      return { ok: true };
    });
  }
  // «Создать отменяющий коммит» (N-35): revert в копии, где выбрана база (чистой).
  async revertMerge(item) {
    this.#assertUsable(item);
    const sha = item.mergedSha;
    if (!sha) throw wtError(409, "bad", "Отменять нечего");
    return this.#queue(item.repoKey, { kind: "revert", wtId: item.id, title: item.title }, async () => {
      const at = await this.#checkedOutAt(item, item.base);
      if (!at) throw wtError(409, "bad", "База не выбрана ни в одной копии — сделайте revert в терминале");
      const st = await this.#git(item, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=no"], { cwd: at });
      if (parseStatus(st.stdout).files.length) throw wtError(409, "main-dirty", "Основная копия не чистая — закоммитьте изменения");
      const parents = (await this.#git(item, ["rev-list", "--parents", "-n", "1", sha], { cwd: at })).stdout.trim().split(/\s+/).length - 1;
      const r = await this.#git(item, [...this.#ident(item.owner), "revert", "--no-edit", ...(parents > 1 ? ["-m", "1"] : []), sha], { cwd: at, timeoutMs: 60_000 });
      if (r.code !== 0) {
        await this.#git(item, ["revert", "--abort"], { cwd: at }).catch(() => {});
        throw wtError(409, "conflict", "Отменяющий коммит не создан: конфликт");
      }
      item.state = "ready";
      delete item.mergedSha;
      this.store.save();
      this.#changed(item, "reverted");
      return { ok: true };
    });
  }
  async resetBranch(item, opId) {
    this.#assertUsable(item);
    const op = this.op(opId);
    if (!op || op.wtId !== item.id || !op.branchBefore) throw wtError(404, "bad", "Операция не найдена");
    if (item.sid && this.busy(item.sid)) throw wtError(409, "turn-running", "Дождитесь конца хода");
    return this.#queue(item.repoKey, { kind: "reset", wtId: item.id, title: item.title }, async () => {
      const r = await this.#git(item, ["reset", "-q", "--keep", op.branchBefore]);
      if (r.code !== 0) throw wtError(409, "dirty", "Незакоммиченные файлы мешают вернуть ветку");
      this.#changed(item, "reset");
      return { ok: true };
    });
  }

  // ---- удаление (кр. 14) -----------------------------------------------------------
  // Что пропадёт при удалении: незакоммиченные файлы и коммиты не в базе.
  async unsaved(item) {
    if (!existsSync(item.path)) {
      // BUG-276: папки копии нет — незакоммиченного нет, а коммиты ветки считаются в основном репозитории (если он есть)
      let commits = 0;
      if (existsSync(item.repoRoot)) {
        const r = await this.#git(item, ["rev-list", "--count", `refs/heads/${item.base}..refs/heads/${item.branch}`], { cwd: item.repoRoot }).catch(() => null);
        commits = r?.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
      }
      return { uncommitted: 0, commits, merged: item.state === "merged" };
    }
    const st = await this.#git(item, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
    const unc = st.code === 0 ? parseStatus(st.stdout).files.filter((f) => !item.artifacts.includes(f.path)).length : 0;
    const base = await revParse((a) => this.#git(item, a), `refs/heads/${item.base}`);
    let commits = 0;
    if (base) {
      // коммиты, чьё содержимое не в базе: после «Один коммит» ветка = база (reset), значит 0
      const r = await this.#git(item, ["rev-list", "--count", `${base}..HEAD`]);
      commits = Number(r.stdout.trim()) || 0;
      if (commits) {
        const same = await this.#git(item, ["diff", "--quiet", base, "HEAD"]);
        const anc = await this.#git(item, ["merge-base", "--is-ancestor", "HEAD", base]);
        if (anc.code === 0 || (same.code === 0 && item.state === "merged")) commits = 0;
      }
    }
    return { uncommitted: unc, commits, merged: item.state === "merged" };
  }

  // mode: "auto" (чистая — удалить с веткой, иначе 409 с числами),
  //       "keep-branch" (WIP-коммит, ветка остаётся), "all" (всё, с подтверждением).
  async remove(item, { mode = "auto", confirm = false } = {}) {
    if (!item || item.state === "removed") throw wtError(409, "gone", "Копия удалена в другом окне");
    if (item.sid && this.busy(item.sid)) throw wtError(409, "turn-running", "Дождитесь конца хода");
    const running = [...this.ops.values()].find((o) => o.wtId === item.id && !["done", "failed", "interrupted"].includes(o.phase));
    if (running) throw wtError(409, "busy", "Идёт слияние — удалить копию можно после него");
    return this.#queue(item.repoKey, { kind: "remove", wtId: item.id, title: item.title }, async () => {
      const u = await this.unsaved(item);
      const clean = u.uncommitted === 0 && u.commits === 0;
      if (mode === "auto" && !clean) throw wtError(409, "unsaved", unsavedText(u, item.base), u); // BUG-273: формы числа
      if (mode === "all" && !clean && !confirm) throw wtError(400, "confirm", "Подтвердите, что несохранённая работа пропадёт");
      let deleteBranch = mode === "all" || clean;
      if (mode === "keep-branch" && u.uncommitted > 0) {
        await this.#saveWip(item, "WIP: сохранено при удалении чата");
        deleteBranch = false;
      }
      if (mode === "keep-branch") deleteBranch = false;
      await this.#dropWorktree(item);
      if (deleteBranch) await this.#git(item, ["branch", "-D", item.branch], { cwd: item.repoRoot }).catch(() => {});
      item.state = "removed";
      item.removedAt = this.now();
      item.branchKept = !deleteBranch;
      this.store.drop(item.id);
      this.store.save();
      this.overlapCache.delete(item.repoKey);
      this.#changed(item, "removed");
      return { ok: true, branchKept: !deleteBranch, branch: item.branch };
    });
  }

  async #saveWip(item, msg) {
    if (!existsSync(item.path)) return false;
    for (const a of item.artifacts ?? []) {
      // ссылки и копии портала не коммитятся
      try {
        const p = path.join(item.path, a);
        if (lstatSync(p).isSymbolicLink()) unlinkSync(p);
      } catch {}
    }
    await this.#git(item, ["add", "-A"]);
    const c = await this.#git(item, [...this.#ident(item.owner), "commit", "-q", "--no-verify", `--message=${msg}`], { timeoutMs: 60_000 });
    item.savedAt = this.now();
    return c.code === 0;
  }

  // BUG-276: удаление аккаунта — все его копии снимаются из реестра (работа не
  // сохраняется: папки аккаунта удаляются вместе с ним). Не удалось штатно (ход,
  // слияние) — копия всё равно убирается без git-проверок. → [id]
  async dropOwner(owner) {
    const out = [];
    if (typeof owner !== "string" || !owner) return out;
    for (const it of this.store.items.filter((x) => x.owner === owner && x.state !== "removed")) {
      try {
        await this.remove(it, { mode: "all", confirm: true });
      } catch (err) {
        this.log(`[teleharness-wt] dropOwner ${it.id}: ${err?.message ?? err}`);
        await this.#dropWorktree(it).catch(() => {});
        it.state = "removed";
        this.store.drop(it.id);
        this.#changed(it, "removed");
      }
      out.push(it.id);
    }
    for (const [sid, p] of Object.entries(this.store.data.pending)) if (p?.owner === owner) delete this.store.data.pending[sid];
    delete this.store.data.settings[owner];
    this.store.save();
    return out;
  }
  async #dropWorktree(item) {
    const root = item.repoRoot;
    if (!existsSync(root)) {
      // BUG-276: репозитория больше нет (аккаунт тенанта удалён, папку стёрли руками) —
      // git звать не с чем; остаток папки копии убирается, папка чата заново не создаётся
      try {
        if (existsSync(item.path)) rmSync(item.path, { recursive: true, force: true });
      } catch (err) {
        this.log(`[teleharness-wt] remove ${item.id}: ${err?.message ?? err}`);
      }
      return;
    }
    for (const a of item.artifacts ?? []) {
      try {
        const p = path.join(item.path, a);
        if (lstatSync(p).isSymbolicLink()) unlinkSync(p);
      } catch {}
    }
    await this.#git(item, ["worktree", "unlock", item.path], { cwd: root }).catch(() => {});
    const r = await this.#git(item, ["worktree", "remove", "--force", item.path], { cwd: root }).catch(() => ({ code: -1 }));
    if (r.code !== 0 && existsSync(item.path)) {
      try {
        rmSync(item.path, { recursive: true, force: true });
      } catch (err) {
        this.log(`[teleharness-wt] remove ${item.id}: ${err?.message ?? err}`);
      }
    }
    if (item.tenant && item.sid) {
      // папка чата тенанта остаётся (FEAT-04.12)
      try {
        mkdirSync(item.path, { recursive: true });
      } catch {}
    }
    await this.#git(item, ["worktree", "prune"], { cwd: root }).catch(() => {});
  }

  // «Восстановить из ветки» (N-22): новая копия на той же ветке.
  async restore(item) {
    if (existsSync(item.path) && readdirSync(item.path).some((n) => n !== ".teleharness-uploads")) throw wtError(409, "bad", "Папка копии на месте");
    return this.#queue(item.repoKey, { kind: "restore", wtId: item.id, title: item.title }, async () => {
      await this.#git(item, ["worktree", "unlock", item.path], { cwd: item.repoRoot }).catch(() => {});
      await this.#git(item, ["worktree", "prune"], { cwd: item.repoRoot });
      if (existsSync(item.path)) rmSync(item.path, { recursive: true, force: true });
      const r = await this.#git(item, ["worktree", "add", item.path, item.branch], { cwd: item.repoRoot, timeoutMs: this.limits.createTimeoutMs });
      if (r.code !== 0) throw wtError(500, "create-failed", `Не удалось восстановить копию: ${sanitize(firstLine(r.stderr))}`);
      await this.#git(item, ["worktree", "lock", "--reason", `teleharness ${item.kind} ${item.sid ?? item.runId}`, item.path], { cwd: item.repoRoot });
      item.state = "ready";
      this.store.save();
      this.#changed(item, "restored");
      return { ok: true };
    });
  }
  // «Отвязать чат»: запись убирается, ветка остаётся.
  detach(item) {
    item.state = "removed";
    this.store.drop(item.id);
    this.store.save();
    this.#changed(item, "removed");
  }
  // «Вернуть ветку teleharness/…» (N-23).
  async checkoutBranch(item) {
    const r = await this.#git(item, ["checkout", "-q", item.branch]);
    if (r.code !== 0) throw wtError(409, "dirty", `Не удалось вернуть ветку: ${sanitize(firstLine(r.stderr))}`);
    this.#changed(item, "branch");
    return { ok: true };
  }

  // «Снять зависшую блокировку» (кр. 18): index.lock старше 10 мин без хода и операции.
  unlock(item) {
    const age = indexLockAge(item);
    if (age == null) return { ok: true, none: true };
    if (age < this.limits.lockStaleMs || (item.sid && this.busy(item.sid)) || this.waitingFor(item.repoKey)) throw wtError(409, "busy", "git занят другой операцией — повторите");
    for (const f of lockFiles(item)) {
      try {
        unlinkSync(f);
      } catch {}
    }
    return { ok: true };
  }

  // Ветки teleharness/… без копии (кр. 15).
  async orphanBranches({ repoRoot, untrusted }) {
    const r = await runGit(["for-each-ref", "--format=%(refname:short)%00%(committerdate:unix)%00%(subject)", "refs/heads/teleharness/"], { cwd: repoRoot, untrusted });
    const commonDir = await this.#commonDir(repoRoot, untrusted);
    const key = repoKeyOf(commonDir);
    const used = new Set(this.store.live().filter((x) => x.repoKey === key).map((x) => x.branch));
    return r.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [name, at, subject] = l.split("\0");
        return { name, at: Number(at) * 1000 || null, subject: subject ?? "" };
      })
      .filter((b) => !used.has(b.name));
  }
  async deleteBranch({ repoRoot, untrusted, name }) {
    if (!isPortalBranch(name)) throw wtError(400, "bad", "Удалять можно только ветки teleharness/…");
    const commonDir = await this.#commonDir(repoRoot, untrusted);
    if (this.store.live().some((x) => x.repoKey === repoKeyOf(commonDir) && x.branch === name)) throw wtError(409, "bad", "Ветка занята рабочей копией");
    const r = await runGit(["branch", "-D", name], { cwd: repoRoot, untrusted });
    if (r.code !== 0) throw wtError(409, "git", `Ветка не удалена: ${sanitize(firstLine(r.stderr))}`);
    return { ok: true };
  }
  listRepo(repoKey) {
    return this.store.live().filter((x) => x.repoKey === repoKey);
  }
  async repoKeyFor(dir, untrusted) {
    const repo = await openRepo(dir, { untrusted }).catch(() => null);
    if (!repo) return null;
    return { key: repoKeyOf(await this.#commonDir(repo.root, untrusted)), root: repo.root };
  }

  // ---- восстановление и уборка (кр. 15, 17, 22) ---------------------------------------
  async recover() {
    let names = [];
    try {
      names = readdirSync(this.#opsDir).filter((f) => /^op_[a-z0-9]{12}\.json$/.test(f));
    } catch {}
    const out = [];
    for (const f of names) {
      const op = readJsonStore(path.join(this.#opsDir, f), { fallback: () => null, log: this.log });
      if (!op) continue;
      this.ops.set(op.opId, op);
      if (["done", "failed", "interrupted"].includes(op.phase)) continue;
      const item = this.store.byId(op.wtId);
      if (!item) {
        op.phase = "interrupted";
        this.#saveOp(op);
        continue;
      }
      if (existsSync(item.path) && existsSync(path.join(item.commonDir, "worktrees"))) {
        // незавершённое подтягивание: MERGE_HEAD в копии → merge --abort
        const mh = await this.#git(item, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
        if (mh.code === 0) await this.#git(item, ["merge", "--abort"]).catch(() => {});
      }
      const baseNow = await revParse((a) => this.#git(item, a, { cwd: item.repoRoot }), `refs/heads/${item.base}`);
      const d = recoverDecision(op, baseNow);
      op.phase = d.phase;
      op.recovered = d.outcome;
      op.kind = d.phase === "interrupted" ? "interrupted" : d.phase === "failed" ? "main-moved" : undefined;
      op.error = d.phase === "interrupted" ? "Слияние прервано перезапуском сервера — main не изменена" : d.phase === "failed" ? "main изменена вне портала во время слияния" : null;
      if (op.test && op.test.startedAt && !op.test.finishedAt) op.test.interrupted = true;
      for (const k of Object.keys(op.steps ?? {})) if (op.steps[k] === "run") op.steps[k] = d.phase === "done" ? "ok" : "fail";
      if (d.phase === "done") {
        op.steps.advance = "ok";
        item.state = "merged";
        item.mergedAt = this.now();
        item.mergedSha = op.newSha;
        item.mainBefore = op.mainOld;
        if (op.method !== "ff") await this.#git(item, ["reset", "-q", "--keep", op.newSha]).catch(() => {});
      } else if (item.state === "merging") item.state = "ready";
      op.updatedAt = this.now();
      this.#saveOp(op);
      this.store.save();
      out.push(op);
    }
    // копии в состоянии creating после перезапуска: недоделанные — убрать
    for (const it of this.store.live().filter((x) => x.state === "creating")) await this.#cleanupFailed(it, it.repoRoot).catch(() => {});
    return out;
  }

  // isLive(item) → чат/запуск ещё существует. → {saved:[], pruned:[]}
  async gc({ isLive = () => true } = {}) {
    const saved = [];
    const pruned = [];
    for (const it of [...this.store.live()]) {
      if (["creating", "merging"].includes(it.state)) continue;
      if (!existsSync(it.path)) {
        if (!isLive(it)) {
          // папки нет и чата нет: метаданные worktree убираются, ветка остаётся
          await this.#git(it, ["worktree", "unlock", it.path], { cwd: it.repoRoot }).catch(() => {});
          await this.#git(it, ["worktree", "prune"], { cwd: it.repoRoot }).catch(() => {});
          this.store.drop(it.id);
          pruned.push(it.id);
        }
        continue;
      }
      const stale = it.kind === "run" && it.state !== "merged" && this.now() - (it.createdAt ?? 0) > this.limits.runKeepMs;
      if (isLive(it) && !stale) continue;
      try {
        const u = await this.unsaved(it);
        if (u.uncommitted) await this.#saveWip(it, it.kind === "run" ? "WIP: копия запуска убрана через 14 дней" : "WIP: сохранено уборкой (чат удалён)");
        await this.#dropWorktree(it);
        if (u.uncommitted === 0 && u.commits === 0) await this.#git(it, ["branch", "-D", it.branch], { cwd: it.repoRoot }).catch(() => {});
        if (stale && isLive(it)) {
          it.state = "orphaned";
          it.savedAt = this.now();
        } else this.store.drop(it.id);
        saved.push(it.id);
      } catch (err) {
        this.log(`[teleharness-wt] gc ${it.id}: ${err?.message ?? err}`);
      }
    }
    // заявки пустых чатов, которых больше нет
    for (const sid of Object.keys(this.store.data.pending)) if (!isLive({ sid, kind: "chat" })) delete this.store.data.pending[sid];
    // журналы операций старше 30 дней
    try {
      for (const f of readdirSync(this.#opsDir)) {
        const p = path.join(this.#opsDir, f);
        if (this.now() - statSync(p).mtimeMs > 30 * 24 * 3600_000) rmSync(p, { force: true });
      }
    } catch {}
    this.store.save();
    return { saved, pruned };
  }

  #changed(item, what) {
    try {
      this.emit(item, what);
    } catch (err) {
      this.log(`[teleharness-wt] emit: ${err?.message ?? err}`);
    }
  }
}

// ---- помощники -------------------------------------------------------------------

async function revParse(g, ref) {
  const r = await g(["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
  const s = r.stdout.trim();
  return r.code === 0 && SHA_RE.test(s) ? s : null;
}
const firstLine = (s) =>
  String(s ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^(fatal|error|hint):\s*/i, "").trim())
    .find((l) => l && !/^warning:/i.test(l)) ?? "";
const pairKey = (a, b) => [a, b].sort().join("|");
function realOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
function isInside(child, base) {
  const r = path.relative(realOrSelf(base), realOrSelf(child));
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
}
function tryLink(src, dst) {
  try {
    symlinkSync(src, dst, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}
export function countSubmodules(dir) {
  try {
    const t = readFileSync(path.join(dir, ".gitmodules"), "utf8");
    return (t.match(/^\s*\[submodule\s/gm) ?? []).length;
  } catch {
    return 0;
  }
}
function numstatFiles(out) {
  const recs = String(out ?? "").split("\0");
  const files = [];
  for (let i = 0; i < recs.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(recs[i]);
    if (!m) continue;
    let p = m[3];
    if (p === "") {
      i += 2;
      p = recs[i] ?? "";
    }
    files.push({ path: p, additions: m[1] === "-" ? 0 : Number(m[1]), deletions: m[2] === "-" ? 0 : Number(m[2]), committed: true });
  }
  return files;
}
// live (BUG-274): path → {additions, deletions} рабочего дерева против базы для
// незакоммиченных файлов (закоммиченное + правки поверх); нет записи — 0/0
// (правка вернула файл к базе, двоичный файл).
function mergeFileLists(committed, unc, live = null) {
  const map = new Map(committed.map((f) => [f.path, { ...f }]));
  for (const f of unc) {
    const n = live?.get(f.path);
    const nums = { additions: n?.additions ?? 0, deletions: n?.deletions ?? 0 };
    const cur = map.get(f.path);
    if (cur) Object.assign(cur, live ? nums : {}, { uncommitted: true });
    else map.set(f.path, { path: f.path, status: f.status, ...nums, uncommitted: true });
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}
// Строк в неотслеживаемом файле (BUG-274): до 2 МБ, двоичный (NUL) и ссылка — 0.
const UNTRACKED_MAX = 2 * 1024 * 1024;
function untrackedLines(file) {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size === 0 || st.size > UNTRACKED_MAX) return 0;
    const buf = readFileSync(file);
    if (buf.includes(0)) return 0;
    let n = 0;
    for (const b of buf) if (b === 10) n += 1;
    return buf[buf.length - 1] === 10 ? n : n + 1;
  } catch {
    return 0;
  }
}
function lockFiles(item) {
  const out = [path.join(item.commonDir, "index.lock")];
  // index.lock копии лежит в <common>/worktrees/<имя>/
  try {
    for (const d of readdirSync(path.join(item.commonDir, "worktrees"))) {
      const gd = path.join(item.commonDir, "worktrees", d);
      try {
        if (path.resolve(readFileSync(path.join(gd, "gitdir"), "utf8").trim()) === path.resolve(item.path, ".git")) out.push(path.join(gd, "index.lock"));
      } catch {}
    }
  } catch {}
  return out;
}
function indexLockAge(item) {
  let oldest = null;
  for (const f of lockFiles(item)) {
    try {
      const age = Date.now() - statSync(f).mtimeMs;
      oldest = oldest == null ? age : Math.max(oldest, age);
    } catch {}
  }
  return oldest;
}
// «212 passed», «Tests: 3 failed, 209 passed», «# pass 212» → короткая сводка.
export function testSummary(output) {
  const t = String(output ?? "");
  const pick = (re) => {
    const all = [...t.matchAll(re)];
    return all.length ? Number(all.at(-1)[1]) : null;
  };
  // node --test: «# pass 2» (TAP) и «ℹ pass 2» (spec, Node 24 — dogfood 2026-11-20)
  const pass = pick(/[#ℹ]\s*pass\s+(\d+)/gi) ?? pick(/(\d+)\s+pass(?:ed|ing)?\b/gi);
  const fail = pick(/[#ℹ]\s*fail\s+(\d+)/gi) ?? pick(/(\d+)\s+fail(?:ed|ing|ures?)?\b/gi);
  if (pass == null && fail == null) return null;
  return { pass: pass ?? 0, fail: fail ?? 0 };
}
