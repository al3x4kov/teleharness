// FEAT-18.8: git of a chat / project folder for the portal UI — status, the
// diff of one file against HEAD, a commit of the selected files only, a push
// to the upstream with a readable error.
//
// Safety rules (design.md «Сервер — git»):
//   - git runs only through spawn("git", [...args]) — never a shell, so no
//     argument is ever parsed by cmd/sh; paths and the message ride stdin or
//     a single argv element;
//   - every file path from the client is relative, normalized and must stay
//     inside the repository root (`git rev-parse --show-toplevel`), else 400;
//     GIT_LITERAL_PATHSPECS=1 so a path like ":(top)*" is a file name, not
//     pathspec magic;
//   - no prompts: GIT_TERMINAL_PROMPT=0, GIT_ASKPASS=echo, GCM_INTERACTIVE=never
//     (a credential window under a service account would hang push);
//   - LC_ALL=C — the push error classifier reads English git messages;
//   - core.quotepath=off — non-ASCII names come back as UTF-8, not "\320\237…";
//   - timeouts 20 s (commit and push 60 s: hooks / network), the whole process
//     tree is killed on timeout; stdout is capped at 2 MB.
//
// Untrusted repositories (a tenant's folder — its agent writes .git/config):
// git would run programs named in the repository config (core.fsmonitor,
// hooks, filter drivers, textconv …) as the SERVER account, outside the
// tenant's sandbox. For them: hooks / fsmonitor / gpg are switched off on the
// command line, diff runs with --no-ext-diff --no-textconv, and a repository
// whose own config names any program (DANGEROUS_KEYS) is refused (409).
//
// Zero runtime dependencies — node stdlib only.
import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { groupSpawnOpts, killChildTree } from "./proc.js";

export const GIT_TIMEOUT_MS = 20_000;
export const GIT_LONG_TIMEOUT_MS = 60_000; // commit (hooks) and push (network)
export const GIT_OUT_MAX = 2 * 1024 * 1024;
export const DIFF_LINES = 400;
export const DIFF_LINES_FULL = 20_000;
export const STATUS_FILES_MAX = 2000; // a forgotten node_modules must not flood the screen
export const COMMIT_FILES_MAX = 5000;
export const MESSAGE_MAX = 10_000;
const UNTRACKED_COUNT_MAX = 500; // untracked files whose lines are counted
const UNTRACKED_BYTES_MAX = 2 * 1024 * 1024;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// A hooks directory that never exists: hooks of an untrusted repo never run.
const NO_HOOKS = path.join(os.tmpdir(), "teleharness-git-no-hooks-dir");

// Error with the HTTP status and a client-facing (Russian, path-free) text.
export class GitError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Environment of every git call: the server's own minus every GIT_* (a stray
// GIT_DIR / GIT_WORK_TREE of the service would point git elsewhere), plus the
// no-prompt switches.
export function gitEnv(src = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(src ?? {})) {
    if (typeof v !== "string") continue;
    if (/^GIT_/i.test(k)) continue;
    out[k] = v;
  }
  return {
    ...out,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    SSH_ASKPASS: "echo",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
    LANG: "C",
    GIT_LITERAL_PATHSPECS: "1",
  };
}

// -c switches before the git subcommand.
export function gitConfigArgs({ untrusted = false } = {}) {
  const base = ["-c", "core.quotepath=off", "-c", "color.ui=false"];
  if (!untrusted) return base;
  return [
    ...base,
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${NO_HOOKS}`,
    "-c", "commit.gpgsign=false",
    "-c", "gc.auto=0",
    "-c", "protocol.allow=never",
  ];
}

// → Promise<{code, stdout, stderr, truncated, timedOut}>. Never rejects on a
// non-zero exit (callers classify); rejects with GitError 503 when git is
// missing. opts: {cwd, input, timeoutMs, untrusted, env, gitBin, maxOut}.
export function runGit(args, { cwd, input = null, timeoutMs = GIT_TIMEOUT_MS, untrusted = false, env = process.env, gitBin = "git", maxOut = GIT_OUT_MAX } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(gitBin, [...gitConfigArgs({ untrusted }), ...args], groupSpawnOpts({ cwd, env: gitEnv(env), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }));
    } catch (err) {
      reject(spawnError(err));
      return;
    }
    const out = [];
    let outLen = 0;
    let err = "";
    let truncated = false;
    let timedOut = false;
    let done = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(child);
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      if (outLen >= maxOut) {
        truncated = true;
        return;
      }
      const room = maxOut - outLen;
      if (c.length > room) {
        out.push(c.subarray(0, room));
        outLen = maxOut;
        truncated = true;
        killChildTree(child); // the rest is never shown — stop the work
        return;
      }
      out.push(c);
      outLen += c.length;
    });
    child.stderr.on("data", (c) => {
      if (err.length < 64 * 1024) err += c.toString("utf8");
    });
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(spawnError(e));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out).toString("utf8"), stderr: err, truncated, timedOut });
    });
    child.stdin.on("error", () => {});
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function spawnError(err) {
  if (err?.code === "ENOENT") return new GitError(503, "git не установлен на сервере");
  return new GitError(500, "git не запустился");
}

// git refused a call: one place for the texts the user may see.
function failure(r, what) {
  if (r.timedOut) return new GitError(504, `git не ответил вовремя (${what})`);
  const e = r.stderr || "";
  if (/dubious ownership|safe\.directory/i.test(e)) return new GitError(409, "git не доверяет владельцу этой папки (safe.directory) — настройте в терминале сервера");
  if (/index\.lock|Unable to create .*\.lock/i.test(e)) return new GitError(409, "git занят другой операцией (index.lock) — повторите позже");
  return new GitError(500, `git: ${what} не выполнен${firstLine(e) ? ` — ${sanitize(firstLine(e))}` : ""}`);
}

const firstLine = (s) =>
  String(s ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^(fatal|error|hint|remote):\s*/i, "").trim())
    .find((l) => l && !/^warning:/i.test(l)) ?? "";

// Strips server paths and credentials from a git message (no paths of the
// server in an answer).
export function sanitize(text) {
  return String(text ?? "")
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]*/gi, (u) => {
      try {
        const x = new URL(u);
        return `${x.protocol}//${x.host}`;
      } catch {
        return "…";
      }
    })
    .replace(/(?<![A-Za-z])[A-Za-z]:[\\/](?![\\/])[^\s'"]*/g, "…")
    .replace(/(^|[\s'"(])\/(?:[^\s'"/]+\/)+[^\s'"]*/g, "$1…")
    .slice(0, 300);
}

// Lexical key for «inside»: case-folded on Windows.
const keyOf = (p, platform = process.platform) => {
  const r = platform === "win32" ? path.win32.resolve(p).replace(/[\\/]+$/, "").toLowerCase() : path.posix.resolve(p).replace(/\/+$/, "");
  return r || "/";
};
function inside(child, base, platform = process.platform) {
  const c = keyOf(child, platform);
  const b = keyOf(base, platform);
  const sep = platform === "win32" ? "\\" : "/";
  return c === b || c.startsWith(b.endsWith(sep) ? b : b + sep);
}

// A client file path → the repo-relative POSIX form, or throws GitError 400.
// Backslashes become "/", "a/./b" and "a/x/../b" collapse; absolute paths,
// drive letters, "..", NUL / newlines and anything resolving outside the
// root are refused.
export function cleanRelPath(root, p, { platform = process.platform } = {}) {
  if (typeof p !== "string" || !p || p.length > 4096) throw new GitError(400, "некорректный путь файла");
  if (/[\0\r\n]/.test(p)) throw new GitError(400, "некорректный путь файла");
  const slashed = p.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed) || path.win32.isAbsolute(p)) throw new GitError(400, "путь файла должен быть относительным");
  if (platform === "win32" && slashed.includes(":")) throw new GitError(400, "некорректный путь файла");
  const norm = path.posix.normalize(slashed).replace(/\/+$/, "");
  if (!norm || norm === "." || norm === ".." || norm.startsWith("../")) throw new GitError(400, "файл вне репозитория");
  if (norm.split("/").some((seg) => seg.toLowerCase() === ".git")) throw new GitError(400, "файл вне репозитория");
  const abs = platform === "win32" ? path.win32.resolve(root, ...norm.split("/")) : path.posix.resolve(root, norm);
  if (!inside(abs, root, platform) || keyOf(abs, platform) === keyOf(root, platform)) throw new GitError(400, "файл вне репозитория");
  return norm;
}

// git prints POSIX-style roots on Windows too ("D:/Apps/teleharness").
const fsPath = (p) => path.resolve(String(p ?? "").trim());

// Keys of the repository config that make git run a program. A tenant repo
// naming any of them is refused (see the header).
const DANGEROUS_KEYS = [
  /^filter\./,
  /^core\.(fsmonitor|hookspath|sshcommand|editor|pager|askpass|gitproxy|alternaterefscommand|worktree)$/,
  /^diff\.external$/,
  /^diff\..+\.(textconv|command)$/,
  /^merge\..+\.driver$/,
  /^credential\./,
  /^gpg\./,
  /^include(if)?\./,
  /^(uploadpack|receive)\./,
  /^remote\..+\.(uploadpack|receivepack|vcs)$/,
  /^sequence\.editor$/,
  /^trailer\..+\.(command|cmd)$/,
  /^url\./,
];
export function dangerousKey(key) {
  const k = String(key ?? "").toLowerCase();
  return DANGEROUS_KEYS.some((re) => re.test(k));
}

// The repository of a folder: {root, gitDir} or null (not a repository).
// opts.untrusted: refuse a repository whose own config names a program.
export async function openRepo(dir, { untrusted = false, env } = {}) {
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const r = await runGit(["rev-parse", "--show-toplevel", "--absolute-git-dir"], { cwd: dir, untrusted, env });
  if (r.code !== 0) {
    if (/not a git repository|must be run in a work tree|this operation must be run in a work tree/i.test(r.stderr)) return null;
    throw failure(r, "поиск репозитория");
  }
  const [top, gitDir] = r.stdout.split(/\r?\n/).filter(Boolean);
  if (!top) return null;
  const repo = { root: fsPath(top), gitDir: gitDir ? fsPath(gitDir) : null, untrusted, env };
  if (untrusted) {
    const c = await runGit(["config", "--list", "--show-scope", "--name-only"], { cwd: repo.root, untrusted, env });
    if (c.code !== 0) throw failure(c, "чтение настроек");
    for (const line of c.stdout.split(/\r?\n/)) {
      const [scope, key] = line.split("\t");
      if (!key || !["local", "worktree"].includes(scope)) continue;
      if (dangerousKey(key)) throw new GitError(409, "в настройках этого репозитория есть команды, которые портал не выполняет (git config) — уберите их");
    }
  }
  return repo;
}

const git = (repo, args, opts = {}) => runGit(args, { cwd: repo.root, untrusted: repo.untrusted, env: repo.env, ...opts });

async function headInfo(repo) {
  const r = await git(repo, ["log", "-1", "--format=%H%x00%s%x00%ct"]);
  if (r.code !== 0) return null; // no commits yet
  const [hash, subject, ct] = r.stdout.replace(/\r?\n$/, "").split("\0");
  if (!hash) return null;
  return { hash, subject: subject ?? "", at: Number(ct) * 1000 || null };
}

// Parses `git status --porcelain=v2 --branch -z`. Pure.
export function parseStatus(out) {
  const recs = String(out ?? "").split("\0");
  const branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 };
  const files = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    if (r.startsWith("# ")) {
      const [, key, ...rest] = r.split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid") branch.oid = val === "(initial)" ? null : val;
      else if (key === "branch.head") branch.head = val;
      else if (key === "branch.upstream") branch.upstream = val;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) [branch.ahead, branch.behind] = [Number(m[1]), Number(m[2])];
      }
      continue;
    }
    const kind = r[0];
    if (kind === "?") {
      // "dir/" = a nested repository (another chat's folder, a clone): not a
      // file of this one — committing it would add a gitlink
      if (!r.endsWith("/")) files.push({ path: r.slice(2), status: "?", staged: false });
    } else if (kind === "1") {
      // 1 XY sub mH mI mW hH hI path
      const f = r.split(" ");
      files.push({ path: f.slice(8).join(" "), ...letter(f[1]) });
    } else if (kind === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const f = r.split(" ");
      const oldPath = recs[++i] ?? "";
      files.push({ path: f.slice(9).join(" "), status: "R", staged: f[1][0] !== ".", oldPath });
    } else if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = r.split(" ");
      files.push({ path: f.slice(10).join(" "), status: "U", staged: false });
    }
  }
  return { branch, files };
}

// XY of porcelain v2 → the state against HEAD (the diff the screen shows).
function letter(xy) {
  const [x, y] = [xy?.[0] ?? ".", xy?.[1] ?? "."];
  const staged = x !== ".";
  if (x === "A") return { status: "A", staged };
  if (x === "D" || y === "D") return { status: "D", staged };
  if (x === "R" || x === "C") return { status: "R", staged };
  return { status: "M", staged };
}

// `git diff --numstat -z -M` → Map(path → {additions, deletions, binary}). Pure.
export function parseNumstat(out) {
  const map = new Map();
  const recs = String(out ?? "").split("\0");
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(r);
    if (!m) continue;
    let p = m[3];
    if (p === "") {
      // rename: "a\td\t\0old\0new"
      i += 2;
      p = recs[i] ?? "";
    }
    const binary = m[1] === "-";
    map.set(p, { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }
  return map;
}

// Lines of an untracked file (binary / too big / unreadable → 0). The real
// path must stay inside the root: an untracked symlink to C:\ is not read.
function countLines(root, rel) {
  try {
    const abs = path.join(root, ...rel.split("/"));
    const real = realpathSync(abs);
    if (!inside(real, realpathSync(root))) return { additions: 0, binary: false };
    const st = statSync(real);
    if (!st.isFile() || st.size > UNTRACKED_BYTES_MAX) return { additions: 0, binary: false };
    const buf = readHead(real, st.size);
    if (buf.subarray(0, 8000).includes(0)) return { additions: 0, binary: true };
    if (buf.length === 0) return { additions: 0, binary: false };
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    if (buf[buf.length - 1] !== 10) n++;
    return { additions: n, binary: false };
  } catch {
    return { additions: 0, binary: false };
  }
}

function readHead(file, size) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size);
    const n = readSync(fd, buf, 0, size, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

// → {repo:true, root, branch, detached, upstream, ahead, behind, lastCommit,
//    files:[{path, status, staged, additions, deletions, oldPath?, binary?}],
//    filesTruncated}
export async function gitStatus(repo) {
  const st = await git(repo, ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
  if (st.code !== 0) throw failure(st, "status");
  const { branch, files } = parseStatus(st.stdout);
  const lastCommit = await headInfo(repo);
  const base = lastCommit ? "HEAD" : EMPTY_TREE;
  const ns = await git(repo, ["--no-optional-locks", "diff", base, "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"]);
  const stats = ns.code === 0 ? parseNumstat(ns.stdout) : new Map();
  const filesTruncated = files.length > STATUS_FILES_MAX || st.truncated;
  const list = files.slice(0, STATUS_FILES_MAX);
  let counted = 0;
  for (const f of list) {
    if (f.status === "?") {
      const c = counted++ < UNTRACKED_COUNT_MAX ? countLines(repo.root, f.path) : { additions: 0, binary: false };
      f.additions = c.additions;
      f.deletions = 0;
      if (c.binary) f.binary = true;
      continue;
    }
    const s = stats.get(f.path);
    f.additions = s?.additions ?? 0;
    f.deletions = s?.deletions ?? 0;
    if (s?.binary) f.binary = true;
  }
  const detached = branch.head === "(detached)";
  return {
    repo: true,
    root: repo.root,
    branch: detached ? null : branch.head,
    detached,
    upstream: branch.upstream,
    ahead: branch.ahead,
    behind: branch.behind,
    lastCommit,
    files: list,
    filesTruncated,
  };
}

// Counts +/− of a unified diff (headers excluded). Pure.
export function countPatch(patch) {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const l of String(patch ?? "").split("\n")) {
    if (l.startsWith("diff --git ")) inHunk = false;
    else if (l.startsWith("@@")) inHunk = true;
    else if (inHunk && l.startsWith("+")) additions++;
    else if (inHunk && l.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

// The diff of ONE file: working tree against HEAD (staged + unstaged),
// a new file — whole. → {file, patch, additions, deletions, binary, truncated}
export async function gitDiff(repo, file, { full = false } = {}) {
  const rel = cleanRelPath(repo.root, file);
  // no pathspec: limited to `rel`, status never sees the old path of a rename
  // and reports the new one as a whole added file
  const st = await git(repo, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
  if (st.code !== 0) throw failure(st, "status");
  const entry = parseStatus(st.stdout).files.find((f) => f.path === rel);
  const flags = ["--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all"];
  let r;
  if (entry?.status === "?") {
    // untracked: the whole file as added (exit 1 = «there are differences»)
    r = await git(repo, ["diff", "--no-index", ...flags, "--", "/dev/null", rel]);
    if (r.code !== 0 && r.code !== 1) throw failure(r, "diff");
  } else {
    const head = (await headInfo(repo)) ? "HEAD" : EMPTY_TREE;
    const paths = entry?.status === "R" && entry.oldPath ? [entry.oldPath, rel] : [rel];
    r = await git(repo, ["diff", head, "-M", ...flags, "--", ...paths]);
    if (r.code !== 0) throw failure(r, "diff");
  }
  const raw = r.stdout.replace(/\r\n/g, "\n");
  const binary = /^Binary files .* differ$/m.test(raw) || /^GIT binary patch$/m.test(raw);
  const { additions, deletions } = countPatch(raw);
  const limit = full ? DIFF_LINES_FULL : DIFF_LINES;
  const lines = raw.replace(/\n$/, "").split("\n");
  const truncated = r.truncated || lines.length > limit;
  const patch = raw === "" ? "" : lines.slice(0, limit).join("\n") + "\n";
  const oldPath = entry?.status === "R" && entry.oldPath ? entry.oldPath : null;
  return { file: rel, patch, additions, deletions, binary, truncated, ...(oldPath ? { oldPath } : {}) };
}

// The text sent to the model for «Предложить сообщение»: the diffs of the
// selected files, capped at maxChars (a cut file is marked).
export async function diffForPrompt(repo, files, { maxChars = 30_000 } = {}) {
  let out = "";
  for (const f of files) {
    if (out.length >= maxChars) {
      out += `\n[… остальные файлы не показаны]\n`;
      break;
    }
    let d;
    try {
      d = await gitDiff(repo, f, { full: true });
    } catch (err) {
      if (err instanceof GitError && err.status === 400) throw err;
      continue;
    }
    const body = d.binary ? `Binary file ${d.file} changed\n` : d.patch;
    const room = maxChars - out.length;
    out += body.length > room ? body.slice(0, room) + "\n[… дифф обрезан]\n" : body;
  }
  return out;
}

// Per-root serialization of writes: two commits from two tabs must not race
// for index.lock.
const locks = new Map();
async function withRepoLock(root, fn) {
  const key = keyOf(root);
  const prev = locks.get(key) ?? Promise.resolve();
  let release;
  const mine = new Promise((r) => (release = r));
  const chain = prev.then(() => mine);
  locks.set(key, chain);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
}

// Commit exactly the selected files (`git commit --only -- <files>`): their
// working-tree state, untracked ones the user ticked included; everything else
// staged or not stays as it was. author: {name, email}.
// → {hash, subject, files}
export async function gitCommit(repo, { files, message, author }) {
  if (!Array.isArray(files) || files.length === 0) throw new GitError(400, "не выбраны файлы");
  if (files.length > COMMIT_FILES_MAX) throw new GitError(400, `слишком много файлов (не больше ${COMMIT_FILES_MAX})`);
  const msg = typeof message === "string" ? message.replace(/\r\n/g, "\n").trim() : "";
  if (!msg) throw new GitError(400, "пустое сообщение коммита");
  if (msg.length > MESSAGE_MAX || msg.includes("\0")) throw new GitError(400, "некорректное сообщение коммита");
  const rels = [...new Set(files.map((f) => cleanRelPath(repo.root, f)))];
  return withRepoLock(repo.root, async () => {
    const st = await git(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"]);
    if (st.code !== 0) throw failure(st, "status");
    const changed = new Map(parseStatus(st.stdout).files.map((f) => [f.path, f]));
    const missing = rels.filter((p) => !changed.has(p));
    if (missing.length) throw new GitError(400, `файл не изменён: ${missing[0]}`);
    if (rels.some((p) => changed.get(p).status === "U")) throw new GitError(409, "в выбранных файлах есть конфликт слияния — решите его в терминале или попросите агента");
    const untracked = rels.filter((p) => changed.get(p).status === "?");
    // a rename commits its old path too, or the old file would stay in HEAD
    const paths = [...new Set(rels.flatMap((p) => (changed.get(p).oldPath ? [p, changed.get(p).oldPath] : [p])))];
    if (untracked.length) {
      const a = await git(repo, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: untracked.join("\0") + "\0" });
      if (a.code !== 0) throw failure(a, "add");
    }
    const ident = ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`];
    const c = await git(repo, [...ident, "commit", "--only", "--quiet", "--pathspec-from-file=-", "--pathspec-file-nul", `--message=${msg}`], {
      input: paths.join("\0") + "\0",
      timeoutMs: GIT_LONG_TIMEOUT_MS,
    });
    if (c.code !== 0) {
      if (/hook/i.test(c.stderr)) throw new GitError(409, `коммит отклонён хуком репозитория${firstLine(c.stderr) ? ` — ${sanitize(firstLine(c.stderr))}` : ""}`);
      throw failure(c, "commit");
    }
    const h = await headInfo(repo);
    return { hash: h?.hash ?? null, subject: h?.subject ?? msg.split("\n")[0], files: rels };
  });
}

// Push error → {kind, error}. kind: auth | rejected | no-upstream | network |
// unknown; the text says what happened without server paths. Pure.
export function classifyPushError(stderr, { timedOut = false } = {}) {
  const e = String(stderr ?? "");
  const kept = " Коммиты остались локально.";
  if (/does not point to a branch|detached HEAD/i.test(e))
    return { kind: "detached", error: "Не выбрана ветка (detached HEAD) — отправлять нечего; переключитесь на ветку через агента." };
  if (/has no upstream branch|no configured push destination|no upstream configured/i.test(e))
    return { kind: "no-upstream", error: "У ветки нет upstream — отправлять некуда. Настройте его в терминале (git push -u) или попросите агента." };
  if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|Invalid username or password|HTTP Basic: Access denied|returned error: 40[13]|The requested URL returned error: 40[13]|denied to |403 Forbidden|401 Unauthorized|access denied/i.test(e))
    return { kind: "auth", error: `Отправка не прошла: у сервера нет доступа к удалённому репозиторию (нужен вход или ключ).${kept}` };
  if (/\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|rejected because|pre-receive hook declined|protected branch/i.test(e))
    return { kind: "rejected", error: `Отправка не прошла: удалённый репозиторий отклонил изменения — в ветке есть коммиты, которых здесь нет (сначала нужно их получить) или ветка защищена.${kept}` };
  if (timedOut || /Could not resolve host|unable to access|Failed to connect|Connection (refused|timed out|reset)|Network is unreachable|Operation timed out|Could not read from remote repository|early EOF|unexpected disconnect|SSL|TLS|proxy/i.test(e))
    return { kind: "network", error: `Отправка не прошла: удалённый репозиторий недоступен (сеть).${kept}` };
  const line = sanitize(firstLine(e));
  return { kind: "unknown", error: `Отправка не прошла${line ? ` (git: ${line})` : ""}.${kept}`, ...(line ? { detail: line } : {}) };
}

// Push the current branch to ITS upstream (remote + merge ref from the branch
// config). → {ok:true, pushed} or throws GitError 409/502 with extra.kind.
export async function gitPush(repo) {
  return withRepoLock(repo.root, async () => {
    const st = await gitStatus(repo);
    const fail = (status, c) => new GitError(status, c.error, { kind: c.kind, ...(c.detail ? { detail: c.detail } : {}) });
    if (st.detached || !st.branch) throw fail(409, classifyPushError("does not point to a branch"));
    const cfg = async (key) => {
      const r = await git(repo, ["config", "--get", key]);
      return r.code === 0 ? r.stdout.trim() : null;
    };
    const remote = (await cfg(`branch.${st.branch}.pushRemote`)) ?? (await cfg("remote.pushDefault")) ?? (await cfg(`branch.${st.branch}.remote`));
    const merge = await cfg(`branch.${st.branch}.merge`);
    if (!st.upstream || !remote || !merge || remote === ".") throw fail(409, classifyPushError("has no upstream branch"));
    const r = await git(repo, ["push", "--porcelain", "--end-of-options", remote, `HEAD:${merge}`], { timeoutMs: GIT_LONG_TIMEOUT_MS });
    if (r.code !== 0 || r.timedOut) {
      const c = classifyPushError(`${r.stderr}\n${r.stdout}`, { timedOut: r.timedOut });
      throw fail(c.kind === "rejected" || c.kind === "no-upstream" || c.kind === "detached" ? 409 : 502, c);
    }
    return { ok: true, pushed: st.ahead };
  });
}
