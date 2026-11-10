// Hash router for /zai/: signal-driven, works under any base path.
// Routes: #/ -> home, #/projects, #/project/:dir, #/settings,
// #/settings/:section[/:sub] (FEAT-03.23), #/chat/:id. Unknown -> #/.
// FEAT-03.23 also needs to know the history around the current entry
// («‹» goes back when the parent is the previous entry; «›» only when there
// IS a forward entry) and a leave guard («Выйти без сохранения?», П32.Н4):
// every entry is stamped with its index in history.state (zaiIdx).
import { signal } from "@preact/signals";

const ROUTES = [
  { path: "/", view: "home" },
  { path: "/projects", view: "projects" },
  { path: "/project/:id", view: "project" },
  { path: "/settings", view: "settings" },
  { path: "/settings/:section", view: "settings" },
  { path: "/settings/:section/:sub", view: "settings" },
  { path: "/access", view: "access" }, // admin-only: tenant management
  { path: "/chat/:id", view: "chat" },
];

// replace: swap the current entry (no way «Назад» into it — a deleted chat,
// an unknown settings section).
let pendingReplace = false;
export function navigate(to, { replace = false } = {}) {
  const h = to.startsWith("#") ? to : "#" + to;
  if (typeof location === "undefined") return;
  if (location.hash === h || (h === "#/" && (location.hash === "" || location.hash === "#"))) return;
  if (replace) {
    pendingReplace = true;
    location.replace(h);
  } else location.hash = h;
}

function decode(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export function cleanPath(hash = location.hash) {
  let h = String(hash).replace(/^#/, "");
  if (!h.startsWith("/")) h = "/" + h;
  return ("/" + h.split("?")[0]).replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

export function match(path) {
  const segs = path.split("/").filter(Boolean);
  for (const route of ROUTES) {
    const pat = route.path.split("/").filter(Boolean);
    if (pat.length !== segs.length) continue;
    const params = {};
    let ok = true;
    pat.forEach((p, i) => {
      if (p.startsWith(":")) params[p.slice(1)] = decode(segs[i]);
      else if (p !== segs[i]) ok = false;
    });
    if (ok) return { view: route.view, path, params };
  }
  return null;
}

const HOME = { view: "home", path: "/", params: {} };
const route = signal(HOME);
// Last non-chat screen the user came from (R-23 / BUG-02.6: «Назад» returns to
// the source — a project chat goes back to its project, not to «Чаты»).
let lastSource = null;

function samePath(a, b) {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

// Pure: where «Назад» in a chat leads.
//   from      — the previous non-chat route {view, path, params} | null
//   directory — the chat's session directory
//   projects  — directories shown as projects (user-added list)
// Came from a list screen → back there; a deep link / reload → the chat's
// project when it lives in one, else «Чаты».
export function chatBackTarget({ from = null, directory = null, projects = [] } = {}) {
  if (from && (from.view === "home" || from.view === "projects" || from.view === "project")) return from.path;
  if (directory && (projects ?? []).some((p) => samePath(p, directory))) {
    return `/project/${encodeURIComponent(directory)}`;
  }
  return "/";
}

export function lastSourceRoute() {
  return lastSource;
}

let routed = false; // the initial HOME placeholder is not a real source

function setRoute(m) {
  const prev = route.value;
  if (routed && prev && prev.view !== "chat" && prev.path !== m.path) lastSource = prev;
  routed = true;
  route.value = m;
}

// ---- history position (FEAT-03.23) -----------------------------------------
// idx — this entry; top — the newest entry (idx < top ⇒ «Вперёд» exists);
// paths — idx → path, so «‹» knows whether the previous entry is the parent.
// sessionStorage keeps it across a reload of the same tab.
const NAV_KEY = "zai.nav";
function loadNav() {
  try {
    const v = JSON.parse(globalThis.sessionStorage?.getItem?.(NAV_KEY) ?? "null");
    if (Number.isInteger(v?.idx) && Number.isInteger(v?.top) && v.paths && typeof v.paths === "object") return v;
  } catch {}
  return { idx: 0, top: 0, paths: {} };
}
const nav = loadNav();
export const navPos = signal({ idx: nav.idx, top: nav.top });
let tracked = false;

function track(path) {
  if (typeof history === "undefined") return;
  const st = history.state;
  if (st && Number.isInteger(st.zaiIdx)) {
    nav.idx = st.zaiIdx; // back/forward/reload: a stamped entry
    if (nav.idx > nav.top) nav.top = nav.idx;
  } else {
    if (tracked && !pendingReplace) {
      nav.idx += 1; // a new entry: everything ahead of it is gone
      nav.top = nav.idx;
      for (const k of Object.keys(nav.paths)) if (Number(k) > nav.idx) delete nav.paths[k];
    } else if (!tracked) {
      nav.idx = 0; // a fresh tab / a typed address
      nav.top = 0;
      nav.paths = {};
    }
    try {
      history.replaceState({ ...(st && typeof st === "object" ? st : {}), zaiIdx: nav.idx }, "");
    } catch {}
  }
  pendingReplace = false;
  tracked = true;
  nav.paths[nav.idx] = path;
  try {
    globalThis.sessionStorage?.setItem?.(NAV_KEY, JSON.stringify(nav));
  } catch {}
  navPos.value = { idx: nav.idx, top: nav.top };
}

// Path of the previous / next history entry of this tab (null = unknown).
export function prevPath() {
  return nav.paths[nav.idx - 1] ?? null;
}
// FEAT-03.23 (П32.У2): the wide-screen ‹ of a settings section steps BACK in
// the tab history when the previous entry is a settings screen (so › can
// return); otherwise (deep link, came from a chat) it goes up to the parent.
export function backIsHistory(prev = prevPath()) {
  return typeof prev === "string" && (prev === "/settings" || prev.startsWith("/settings/"));
}
// FEAT-03.23 (П32.Н11): where the old #/access lands — only once the role is
// known (null = wait: the account is still loading; a guess sent admins to
// the root, ревью шагов 2026-11-05).
export function accessTarget(me) {
  if (!me || typeof me.role !== "string") return null;
  return me.role === "admin" ? "/settings/users" : "/settings";
}
export function canGoForward() {
  return navPos.value.idx < navPos.value.top;
}

// Leave guard (П32.Н4): fn(nextPath, proceed) → true lets the move happen;
// false keeps the screen — the router undoes the history step, and the
// guard calls proceed() later («Выйти») to redo it.
let leaveGuard = null;
let undoing = false;
export function setLeaveGuard(fn) {
  leaveGuard = typeof fn === "function" ? fn : null;
}
export function leaveAllowed(nextPath, proceed) {
  return !leaveGuard || leaveGuard(nextPath, proceed) !== false;
}

function refresh() {
  const m = match(cleanPath());
  const cur = route.value;
  if (undoing) {
    // the history step back to the guarded screen landed
    undoing = false;
    if (m && cur && m.path === cur.path) {
      track(m.path);
      return;
    }
  }
  if (m && leaveGuard && routed && cur && cur.path !== m.path) {
    const st = typeof history !== "undefined" ? history.state : null;
    const delta = st && Number.isInteger(st.zaiIdx) ? st.zaiIdx - nav.idx : 1;
    const ok = leaveGuard(m.path, () => {
      leaveGuard = null;
      history.go(delta);
    });
    if (ok === false && delta !== 0) {
      undoing = true;
      history.go(-delta);
      return;
    }
  }
  if (m) {
    track(m.path);
    setRoute(m);
    return;
  }
  pendingReplace = true;
  location.replace("#/"); // unknown route -> home without a history entry
  setRoute(HOME);
}

// DOM-guard: node --test imports this module without a location to test match/cleanPath.
if (typeof location !== "undefined" && typeof addEventListener === "function") {
  addEventListener("hashchange", refresh);
  refresh();
}

// Reading the signal inside a component subscribes it to route changes.
export function useRoute() {
  return route.value; // { view, path, params }
}
