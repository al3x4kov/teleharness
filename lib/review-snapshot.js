// FEAT-20.1: снимок ревизии ревью для папки под git (openspec phone-review,
// design «A. Где живёт дифф ревью», вариант 3).
//
// snapshotTree(repo) записывает дерево РАБОЧЕЙ папки (как `git add -A`) во
// временный индекс портала, а объекты — в ОТДЕЛЬНОЕ хранилище портала
// (GIT_OBJECT_DIRECTORY = data/review-objects/<user>/<repoKey>, объекты самого
// репозитория — как alternates). Репозиторий, его индекс и его объекты не
// меняются: `git status` до и после снимка совпадает.
//   - временный индекс — копия индекса пользователя: git пересчитывает хеши
//     только изменённых файлов (спайк 1.5: 60 000 файлов — доли секунды);
//   - в `add` идут только пути, которые status называет изменёнными, кроме
//     файлов > 5 МБ («слишком большой для снимка», список big);
//   - бюджет 10 с на весь снимок, дальше — GitError 504 (ревью «по ходам»);
//   - флаги недоверенного репозитория — те же, что у lib/git.js (repo.untrusted).
// treeChanges / treeDiff — дифф двух неизменных деревьев (база ↔ ревизия,
// «с прошлого ревью» — ревизия ↔ ревизия), с -M и лимитами 400 / 20 000 строк.
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { DIFF_LINES, DIFF_LINES_FULL, EMPTY_TREE, GitError, cleanRelPath, countPatch, failure, headInfo, parseNumstat, parseStatus, runGit } from "./git.js";

export const SNAPSHOT_BUDGET_MS = 10_000;
export const SNAPSHOT_BIG_BYTES = 5 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{40}$/;

export const isSha = (s) => typeof s === "string" && SHA_RE.test(s);
// Ключ хранилища объектов репозитория: короткий хеш корня (путь сервера наружу не уходит).
export const repoKey = (root) => createHash("sha256").update(String(root)).digest("hex").slice(0, 16);

const run = (repo, args, vars, opts = {}) => runGit(args, { cwd: repo.root, untrusted: repo.untrusted, env: repo.env, gitVars: vars, ...opts });

async function commonObjects(repo) {
  const r = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo.root, untrusted: repo.untrusted, env: repo.env });
  const dir = r.code === 0 ? r.stdout.trim() : repo.gitDir;
  return path.join(path.resolve(dir || repo.gitDir), "objects");
}

function ensureObjDir(objDir) {
  mkdirSync(path.join(objDir, "info"), { recursive: true });
  mkdirSync(path.join(objDir, "pack"), { recursive: true });
}

// → {tree, head, big:[path], ms}. Бросает GitError (504 — бюджет, 409 — индекс занят и т. п.).
export async function snapshotTree(repo, { objDir, tmpDir, budgetMs = SNAPSHOT_BUDGET_MS, bigBytes = SNAPSHOT_BIG_BYTES, now = Date.now } = {}) {
  if (!repo?.root || !objDir || !tmpDir) throw new GitError(500, "снимок: нет папок");
  const t0 = now();
  const left = () => {
    const ms = budgetMs - (now() - t0);
    if (ms <= 0) throw new GitError(504, "снимок не уложился в 10 с");
    return ms;
  };
  ensureObjDir(objDir);
  mkdirSync(tmpDir, { recursive: true });
  const index = path.join(tmpDir, `review-idx-${randomBytes(6).toString("hex")}`);
  try {
    const vars = { GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: objDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: await commonObjects(repo) };
    const own = repo.gitDir ? path.join(repo.gitDir, "index") : null;
    const head = await headInfo(repo);
    if (own && existsSync(own)) copyFileSync(own, index);
    else if (head) {
      const r = await run(repo, ["read-tree", "HEAD"], vars, { timeoutMs: left() });
      if (r.code !== 0) throw failure(r, "снимок (read-tree)");
    }
    const st = await run(repo, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all"], vars, { timeoutMs: left() });
    if (st.timedOut) throw new GitError(504, "снимок не уложился в 10 с");
    if (st.code !== 0) throw failure(st, "снимок (status)");
    const paths = new Set();
    const big = [];
    for (const f of parseStatus(st.stdout).files) {
      for (const p of [f.path, f.oldPath]) {
        if (!p) continue;
        let size = 0;
        try {
          const s = statSync(path.join(repo.root, ...p.split("/")));
          size = s.isFile() ? s.size : 0;
        } catch {}
        if (size > bigBytes) big.push(p);
        else paths.add(p);
      }
    }
    if (paths.size > 0) {
      const add = await run(repo, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], vars, { input: [...paths].join("\0"), timeoutMs: left() });
      if (add.timedOut) throw new GitError(504, "снимок не уложился в 10 с");
      if (add.code !== 0) throw failure(add, "снимок (add)");
    }
    const wt = await run(repo, ["write-tree"], vars, { timeoutMs: left() });
    if (wt.code !== 0) throw failure(wt, "снимок (write-tree)");
    const tree = wt.stdout.trim();
    if (!isSha(tree)) throw new GitError(500, "снимок: git не вернул дерево");
    return { tree, head: head?.hash ?? null, big, ms: now() - t0 };
  } finally {
    rmSync(index, { force: true });
    rmSync(index + ".lock", { force: true });
  }
}

// Дерево коммита HEAD (база ревью без принятий) или пустое дерево.
export async function headTree(repo) {
  const r = await runGit(["rev-parse", "HEAD^{tree}"], { cwd: repo.root, untrusted: repo.untrusted, env: repo.env });
  const t = r.code === 0 ? r.stdout.trim() : "";
  return isSha(t) ? t : EMPTY_TREE;
}

const treeVars = async (repo, objDir) => ({ GIT_OBJECT_DIRECTORY: objDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: await commonObjects(repo) });

// `diff-tree --name-status -z` → Map(path → {status, oldPath}). Pure.
export function parseNameStatus(out) {
  const map = new Map();
  const recs = String(out ?? "").split("\0");
  for (let i = 0; i < recs.length; i++) {
    const code = recs[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = recs[++i] ?? "";
      const p = recs[++i] ?? "";
      map.set(p, { status: "R", oldPath });
    } else {
      const p = recs[++i] ?? "";
      map.set(p, { status: letter === "A" ? "A" : letter === "D" ? "D" : "M", oldPath: null });
    }
  }
  return map;
}

// Файлы, которыми различаются два дерева: [{path, oldPath?, status, additions, deletions, binary}].
export async function treeChanges(repo, { objDir, from, to }) {
  if (!isSha(from) || !isSha(to)) throw new GitError(400, "некорректная ревизия");
  if (from === to) return [];
  const vars = await treeVars(repo, objDir);
  const flags = ["-r", "-M", "-z", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all"];
  const ns = await run(repo, ["diff-tree", "--name-status", ...flags, from, to], vars);
  if (ns.code !== 0) throw failure(ns, "дифф ревизий");
  const num = await run(repo, ["diff-tree", "--numstat", ...flags, from, to], vars);
  const stats = num.code === 0 ? parseNumstat(num.stdout) : new Map();
  const out = [];
  for (const [p, v] of parseNameStatus(ns.stdout)) {
    const s = stats.get(p);
    out.push({ path: p, ...(v.oldPath ? { oldPath: v.oldPath } : {}), status: v.status, additions: s?.additions ?? 0, deletions: s?.deletions ?? 0, binary: Boolean(s?.binary) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Дифф ОДНОГО файла между деревьями. huge — больше 20 000 строк: патч не
// отдаётся (только «Скачать патч» и комментарий к файлу).
export async function treeDiff(repo, { objDir, from, to, file, oldPath = null, full = false, raw = false }) {
  if (!isSha(from) || !isSha(to)) throw new GitError(400, "некорректная ревизия");
  const rel = cleanRelPath(repo.root, file);
  const old = oldPath ? cleanRelPath(repo.root, oldPath) : null;
  const vars = await treeVars(repo, objDir);
  const paths = old && old !== rel ? [old, rel] : [rel];
  const flags = ["-M", "--no-ext-diff", "--no-textconv", "--no-color", "--ignore-submodules=all"];
  const num = await run(repo, ["diff-tree", "-r", "--numstat", "-z", ...flags, from, to, "--", ...paths], vars);
  const stat = num.code === 0 ? [...parseNumstat(num.stdout).values()][0] : null;
  const total = (stat?.additions ?? 0) + (stat?.deletions ?? 0);
  if (stat?.binary) return { file: rel, patch: "", additions: 0, deletions: 0, binary: true, truncated: false, huge: false, ...(old ? { oldPath: old } : {}) };
  if (total > DIFF_LINES_FULL && !raw) return { file: rel, patch: "", additions: stat.additions, deletions: stat.deletions, binary: false, truncated: true, huge: true, ...(old ? { oldPath: old } : {}) };
  const r = await run(repo, ["diff-tree", "-p", ...flags, from, to, "--", ...paths], vars);
  if (r.code !== 0) throw failure(r, "дифф ревизий");
  const text = r.stdout.replace(/\r\n/g, "\n");
  if (raw) return { file: rel, patch: text, truncated: r.truncated };
  const binary = /^Binary files .* differ$/m.test(text) || /^GIT binary patch$/m.test(text);
  const { additions, deletions } = countPatch(text);
  const limit = full ? DIFF_LINES_FULL : DIFF_LINES;
  const lines = text.replace(/\n$/, "").split("\n");
  const truncated = r.truncated || lines.length > limit;
  const patch = text === "" ? "" : lines.slice(0, limit).join("\n") + "\n";
  return { file: rel, patch, additions, deletions, binary, truncated, huge: false, ...(old ? { oldPath: old } : {}) };
}

// Размер хранилища объектов (квота снимков 500 МБ на пользователя).
export function dirBytes(dir, { max = 200_000 } = {}) {
  let total = 0;
  let n = 0;
  const walk = (d) => {
    let list;
    try {
      list = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (++n > max) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          total += statSync(p).size;
        } catch {}
      }
    }
  };
  walk(dir);
  return total;
}

export function dropObjects(objDir) {
  rmSync(objDir, { recursive: true, force: true });
}
