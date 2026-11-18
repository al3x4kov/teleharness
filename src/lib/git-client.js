// FEAT-18.8: client side of «Git проекта» — whether a chat folder is a repo
// (the chat menu «⋯ → Git», «Git проекта» in the turn sheet and the
// «Сейчас vs коммит» switch show only then), push error texts, small labels.
import { signal } from "@preact/signals";
import { api } from "./api.js";
import { locale, t as tr } from "./i18n.js";

// sid → true (repo) | false (not a repo / no access) ; missing = unknown.
export const gitRepo = signal({});
// sid → the repo root (to turn a chat file into the path the git API takes):
// the absolute root (admin) or {rel} — the root relative to the chat's
// directory (a tenant gets no server path, TASK-18.13 D4); resolveGitRoot().
export const gitRoot = signal({});

// A /git/status answer → what gitRoot keeps (null when nothing usable).
export function rootInfo(r) {
  if (typeof r?.root === "string" && r.root) return r.root;
  if (typeof r?.rootRel === "string") return { rel: r.rootRel };
  return null;
}

// gitRoot entry + the chat's directory → the absolute repo root (or null).
export function resolveGitRoot(info, base = "") {
  if (typeof info === "string") return info || null;
  if (!info || typeof info.rel !== "string" || !base) return null;
  const parts = String(base).replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  for (const seg of info.rel.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}
const inflight = new Map();

export function probeGitRepo(sid, { client = api, force = false } = {}) {
  if (!sid) return Promise.resolve(false);
  if (!force && typeof gitRepo.value[sid] === "boolean") return Promise.resolve(gitRepo.value[sid]);
  if (inflight.has(sid)) return inflight.get(sid);
  const p = client
    .gitStatus({ sid })
    .then((r) => {
      const info = r?.repo === true ? rootInfo(r) : null;
      if (info != null) gitRoot.value = { ...gitRoot.value, [sid]: info };
      return r?.repo === true;
    })
    .catch(() => false)
    .then((repo) => {
      inflight.delete(sid);
      gitRepo.value = { ...gitRepo.value, [sid]: repo };
      return repo;
    });
  inflight.set(sid, p);
  return p;
}

export function setGitRepo(sid, repo, root = null) {
  if (!sid) return;
  gitRepo.value = { ...gitRepo.value, [sid]: repo === true };
  if (repo === true && root != null) gitRoot.value = { ...gitRoot.value, [sid]: root };
}

const serverLang = () => locale() === "ru-RU";

// Push errors (frame 6): the server's kind → ONE title + ONE explanation
// (TASK-18.13 D5: the server's own sentence is not appended — it repeated the
// title and «commits are kept locally»). Only the unknown kind quotes git's
// line (body.detail, already free of server paths).
export function pushErrorView(err) {
  const body = err?.body ?? {};
  const kind = body.kind ?? (err?.status === 403 ? "forbidden" : !err?.status ? "offline" : "unknown");
  const title = tr("git.push.failed");
  if (kind === "auth") return { kind, title, text: tr("git.push.auth") };
  if (kind === "rejected") return { kind, title: tr("git.push.rejectedTitle"), text: tr("git.push.rejected") };
  if (kind === "forbidden") return { kind, title, text: tr("git.push.forbidden") };
  if (kind === "detached") return { kind, title, text: tr("git.push.detached") };
  if (kind === "no-upstream") return { kind, title, text: tr("git.push.noUpstream") };
  if (kind === "network") return { kind, title, text: tr("git.push.network") };
  if (kind === "offline") return { kind: "network", title, text: tr("git.push.offline") };
  const detail = typeof body.detail === "string" && body.detail.trim() ? body.detail.trim() : null;
  return { kind: "unknown", title, text: detail ? tr("git.push.unknownDetail", { detail }) : tr("git.push.unknown") };
}

// «Suggest message» failed → {text, detail}. A 502 from the model carries one
// ready Russian sentence and its kind (TASK-18.13 D6) — shown as is in a Russian
// UI (an English UI words the kind itself), no prefix; the provider's raw text
// (detail) only collapsed under it.
const SUGGEST_KINDS = { limit: "limit", timeout: "timeout", start: "start", "no-model": "noModel", model: "model" };
export function suggestErrorView(err) {
  const own = typeof err?.body?.error === "string" && err.body.error.trim() ? err.body.error.trim() : null;
  const detail = typeof err?.body?.detail === "string" && err.body.detail.trim() ? err.body.detail.trim() : null;
  if (err?.status === 502 && own) return { text: serverLang() ? own : tr(`git.suggestErr.${SUGGEST_KINDS[err.body.kind] ?? "model"}`), detail };
  return { text: gitErrorText(err, tr("git.view.suggestFailed")), detail: null };
}

// Any other git error → one line (the server's text when it has one).
export function gitErrorText(err, what) {
  const own = typeof err?.body?.error === "string" && err.body.error.trim() ? err.body.error.trim() : null;
  if (err?.status === 403) return tr("git.err.forbidden", { what });
  if (!err?.status) return tr("git.err.offline", { what });
  return own ? `${what}: ${own}` : tr("git.err.code", { what, status: err.status });
}

// «2 ч назад» / «5 мин назад» / «только что» / «3 дн назад» / date.
export function agoLabel(at, now = Date.now()) {
  const t = typeof at === "number" ? (at < 1e12 ? at * 1000 : at) : Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return tr("git.ago.now");
  if (s < 3600) return tr("git.ago.min", { n: Math.floor(s / 60) });
  if (s < 86400) return tr("git.ago.hour", { n: Math.floor(s / 3600) });
  if (s < 86400 * 30) return tr("git.ago.day", { n: Math.floor(s / 86400) });
  return new Date(t).toLocaleDateString(locale());
}

// Files ticked by default: «Отмечать изменённые» — tracked changes only (new
// files, not in git, stay unticked); "none" — nothing.
export function preselected(files, preselect = "modified") {
  if (preselect === "none") return [];
  return (Array.isArray(files) ? files : []).filter((f) => f.status !== "?").map((f) => f.path);
}

// «origin/main» → «origin»
export const remoteOf = (upstream) => (typeof upstream === "string" && upstream.includes("/") ? upstream.split("/")[0] : upstream || "origin");

export function gitHash({ sid = null, directory = null } = {}) {
  if (sid) return `/git/${encodeURIComponent(sid)}`;
  return `/git?${new URLSearchParams({ directory: directory ?? "" })}`;
}

// The ?directory= of the current #/git?directory=… address.
export function hashDirectory(hash = typeof location !== "undefined" ? location.hash : "") {
  const q = String(hash).split("?")[1];
  if (!q) return null;
  return new URLSearchParams(q).get("directory") || null;
}
