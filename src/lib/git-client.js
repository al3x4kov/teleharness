// FEAT-18.8: client side of «Git проекта» — whether a chat folder is a repo
// (the chat menu «⋯ → Git», «Git проекта» in the turn sheet and the
// «Сейчас vs коммит» switch show only then), push error texts, small labels.
import { signal } from "@preact/signals";
import { api } from "./api.js";
import { locale, t as tr } from "./i18n.js";

// sid → true (repo) | false (not a repo / no access) ; missing = unknown.
export const gitRepo = signal({});
// sid → the repo root (to turn a chat file into the path the git API takes).
export const gitRoot = signal({});
const inflight = new Map();

export function probeGitRepo(sid, { client = api, force = false } = {}) {
  if (!sid) return Promise.resolve(false);
  if (!force && typeof gitRepo.value[sid] === "boolean") return Promise.resolve(gitRepo.value[sid]);
  if (inflight.has(sid)) return inflight.get(sid);
  const p = client
    .gitStatus({ sid })
    .then((r) => {
      if (r?.repo === true && typeof r.root === "string") gitRoot.value = { ...gitRoot.value, [sid]: r.root };
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
  if (repo === true && typeof root === "string") gitRoot.value = { ...gitRoot.value, [sid]: root };
}

const serverLang = () => locale() === "ru-RU";

// Push errors (frame 6): the server's kind → title + what to do. The server's
// own text (no server paths) is used for the kinds without a fixed wording.
export function pushErrorView(err) {
  const body = err?.body ?? {};
  const kind = body.kind ?? (err?.status === 403 ? "forbidden" : !err?.status ? "network" : "unknown");
  if (kind === "auth") {
    return { kind, title: tr("git.push.failed"), text: tr("git.push.auth") };
  }
  if (kind === "rejected") {
    return { kind, title: tr("git.push.rejectedTitle"), text: tr("git.push.rejected") };
  }
  if (kind === "forbidden") return { kind, title: tr("git.push.failed"), text: tr("git.push.forbidden") };
  // The server explains in Russian; an English UI uses its own fixed wording.
  const own = typeof body.error === "string" && body.error.trim() && serverLang() ? body.error.trim() : null;
  if (kind === "no-upstream") return { kind, title: tr("git.push.failed"), text: (own ?? tr("git.push.noUpstream")) + tr("git.push.keptLocal") };
  if (kind === "network") return { kind, title: tr("git.push.failed"), text: (own ?? tr("git.push.network")) + tr("git.push.keptLocalLater") };
  return { kind: "unknown", title: tr("git.push.failed"), text: (own ?? tr("git.push.unknown")) + tr("git.push.keptLocal") };
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
