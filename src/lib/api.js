// Thin async wrappers over the /zai/api/* opencode surface. Node-importable:
// fetch/EventSource are referenced lazily inside functions only.
// prompt treats 204 as success; abort/delete just need an ok status
// (the hub answers {data:true} or plain true — both fine, we return true).
import { t } from "./i18n.js";

const BASE = "/zai/api";

// Fired when the server answers 401 outside the login flow (an expired or
// overwritten device cookie). AppShell wires it to me.value=false so the UI
// falls to the login screen instead of silently failing every action.
let onUnauthorizedCb = null;
export function onUnauthorized(fn) {
  onUnauthorizedCb = fn;
}

// Server boot epoch (ADR-005): any response may carry `x-zai-epoch`; a change
// means the portal restarted and in-memory live state may have been lost —
// the store resyncs. Absent header (older server) = no-op.
let onEpochCb = null;
export function onEpoch(fn) {
  onEpochCb = fn;
}

// raw: send `body` as-is (a File/Blob upload) with `contentType`.
async function request(method, path, body, { signal, raw = false, contentType } = {}) {
  const res = await fetch(BASE + path, {
    method,
    signal,
    ...(body !== undefined
      ? raw
        ? { headers: { "content-type": contentType || "application/octet-stream" }, body }
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  try {
    const epoch = res.headers?.get?.("x-zai-epoch");
    if (epoch) onEpochCb?.(String(epoch), "http");
  } catch {}
  // Any answer from the portal itself proves the link is up (ISSUE-004) —
  // a 502/503/504 may be the edge talking while the portal is down.
  if (res.status < 502 || res.status > 504) {
    try {
      onReachableCb?.();
    } catch {}
  }
  if (!res.ok) {
    if (res.status === 401 && path !== "/auth/login") onUnauthorizedCb?.();
    const err = new Error(`zai api ${method} ${path} failed: ${res.status}`);
    err.status = res.status; // callers split «network down» (no status) from «server said no»
    // The server's own reason ({error, code}) — explainApiError() turns the
    // policy refusals into words (ISSUE-002).
    try {
      if (typeof res.json === "function") err.body = await res.json();
    } catch {}
    throw err;
  }
  return res;
}

// A successful exchange with the server (ISSUE-004): the store clears the
// «Нет связи» bar on it.
let onReachableCb = null;
export function onReachable(fn) {
  onReachableCb = fn;
}

// Server refusals in plain Russian (ISSUE-002): the policy 403s used to read
// «проверьте связь». `what` is the failed action («Не удалось создать чат»).
const POLICY_TEXT = {
  "engine not allowed": "api.policy.engineNotAllowed",
  "agent not allowed": "api.policy.agentNotAllowed",
  "outside your scope": "api.policy.outsideScope",
  "admin only": "api.policy.adminOnly",
  "session not found": "api.policy.sessionNotFound",
  // BUG-145: opencode revert in a git work tree touched foreign uncommitted edits
  "git-dir": "api.policy.gitDir",
  "upload quota exceeded": "api.policy.uploadQuota",
};

export function explainApiError(err, what = t("api.failed")) {
  const status = Number(err?.status) || 0;
  const reason = typeof err?.body?.error === "string" ? err.body.error : "";
  if (!status) return t("api.err.offline", { what });
  if (POLICY_TEXT[reason]) return t("api.err.policy", { what, reason: t(POLICY_TEXT[reason]) });
  if (status === 409 && /engine locked/.test(reason)) return t("api.err.engineLocked", { what });
  if (status === 429) return t("api.err.tooMany", { what });
  // 400s from the path policy already speak Russian (dirProblemText).
  if (status === 400 && reason && /[а-яё]/i.test(reason)) return t("api.err.reason", { what, reason });
  if (status === 404) return t("api.err.notFound", { what });
  if (status >= 500) return t("api.err.server", { what, status });
  return t("api.err.rejected", { what, status });
}

async function json(method, path, body) {
  const res = await request(method, path, body);
  return res.json();
}

function idPath(id) {
  return encodeURIComponent(id);
}

// Session-scoped upstream routes are directory-scoped: a session that lives
// outside the server's default directory silently answers EMPTY (live 1.19.5:
// GET /session/:id/message?directory=HOME for a Temp-dir session → 200 [])
// unless the call carries the session's own ?directory=. Callers pass the
// directory read from the session record; the server falls back to HOME.
function withDir(directory) {
  return directory ? `?${new URLSearchParams({ directory })}` : "";
}

export const api = {
  // ---- auth: the long token IS the credential; a match mints the year-long
  // HttpOnly cookie (the device-stays-logged-in part). All later calls ride
  // the cookie automatically (same-origin fetch + EventSource).
  login: async (token) => {
    const res = await json("POST", "/auth/login", { token });
    return res.user; // {id, name, role}
  },
  logout: async () => {
    await request("POST", "/auth/logout");
    return true;
  },
  // BUG-177: device keyboard trace (admin; lib/kb-trace.js on the server).
  kbTrace: (payload) => request("POST", "/diag/kb", payload),
  me: async () => {
    const res = await json("GET", "/auth/me");
    return res.user; // 401 throws (err.status = 401)
  },
  // Self-service token rotation (FEAT-03.11, TASK-12.21): every other session
  // of the caller is revoked; this device gets a fresh cookie from the server.
  rotateOwnToken: () => json("POST", "/auth/token", { confirm: true }), // → {token}

  // ---- admin: tenant management (role "admin" only; the server answers 403
  // for everyone else). The create/regenerate responses carry the plaintext
  // token EXACTLY once — the store keeps only its hash.
  adminUsers: () => json("GET", "/admin/users"),
  adminCreateUser: (body) => json("POST", "/admin/users", body), // → {user, token}
  adminUpdateUser: (id, body) => json("PATCH", `/admin/users/${idPath(id)}`, body),
  adminRegenerateToken: (id) => json("POST", `/admin/users/${idPath(id)}/token`), // → {token}
  // → {ok, removedSessions, removedDirs, warnings:[{kind, path?, sessionID?,
  // reason, retry?}]} (BUG-04.6: folders left behind are reported, not
  // swallowed). A body that is not that JSON still means «deleted».
  adminDeleteUser: async (id) => {
    const res = await request("DELETE", `/admin/users/${idPath(id)}`);
    let body = null;
    try {
      body = await res.json();
    } catch {}
    const out = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    return { ...out, ok: true, warnings: Array.isArray(out.warnings) ? out.warnings : [] };
  },

  listSessions: () => json("GET", "/session"),
  getMessages: (id, { limit, before, directory } = {}) => {
    const q = new URLSearchParams();
    if (limit != null) q.set("limit", String(limit));
    if (before != null) q.set("before", String(before));
    if (directory) q.set("directory", directory);
    const qs = q.size > 0 ? `?${q}` : "";
    return json("GET", `/session/${idPath(id)}/message${qs}`);
  },
  // BUG-08.8: one page of the history, newest `limit` messages (older than
  // `before` when given) → {list, hasMore, nextBefore}. The server answers
  // x-zai-has-more / x-zai-next-before (lib/proxy.js); without them (older
  // server, Claude history with no ids) a full page means «maybe more» and
  // the oldest id on it is the cursor.
  getMessagesPage: async (id, { limit, before, directory } = {}) => {
    const q = new URLSearchParams();
    if (limit != null) q.set("limit", String(limit));
    if (before != null) q.set("before", String(before));
    if (directory) q.set("directory", directory);
    const res = await request("GET", `/session/${idPath(id)}/message?${q}`);
    const body = await res.json();
    const list = Array.isArray(body) ? body : [];
    let more = null;
    let next = null;
    try {
      more = res.headers?.get?.("x-zai-has-more") ?? null;
      next = res.headers?.get?.("x-zai-next-before") ?? null;
    } catch {}
    const oldest = list[0]?.info?.id ?? list[0]?.id ?? null;
    const hasMore = more != null ? more === "1" : limit != null && list.length >= limit && oldest != null;
    return { list, hasMore: hasMore && Boolean(next || oldest), nextBefore: hasMore ? next || oldest : null };
  },
  // body {model?, agent?}: the new chat's binding (engine/model/agent) — the
  // server stores it and answers the session record with `zai` attached.
  createSession: (directory, body = {}) => json("POST", `/session${withDir(directory)}`, body ?? {}),
  // FEAT-13.17: the portal's Claude agents {agents: [{id, name, description}]} (admin).
  getClaudeAgents: () => json("GET", "/claude/agents"),
  // Change the chat's own model/agent. 409 = engine locked (chat has messages).
  patchBinding: (id, body, { directory } = {}) => json("PATCH", `/session/${idPath(id)}/binding${withDir(directory)}`, body),
  patchSession: (id, body, { directory } = {}) => json("PATCH", `/session/${idPath(id)}${withDir(directory)}`, body),
  deleteSession: async (id, { directory } = {}) => {
    await request("DELETE", `/session/${idPath(id)}${withDir(directory)}`);
    return true;
  },
  prompt: async (id, payload, { directory } = {}) => {
    const res = await request("POST", `/session/${idPath(id)}/prompt${withDir(directory)}`, payload);
    if (res.status === 204) return true;
    try {
      return await res.json();
    } catch {
      return true;
    }
  },
  // FEAT-01.57/01.58: the last turn — what «Отменить ход» rolls back
  // ({engine, files: [{path, action, skipped?}], shell}), revert (hide the
  // turn, roll its files back) and unrevert («Вернуть»).
  revertPreview: (id, messageID, { directory } = {}) => {
    const q = new URLSearchParams({ messageID });
    if (directory) q.set("directory", directory);
    return json("GET", `/session/${idPath(id)}/revert?${q}`);
  },
  revert: (id, messageID, { directory } = {}) => json("POST", `/session/${idPath(id)}/revert${withDir(directory)}`, { messageID }),
  unrevert: (id, { directory } = {}) => json("POST", `/session/${idPath(id)}/unrevert${withDir(directory)}`),
  abort: async (id, { directory } = {}) => {
    await request("POST", `/session/${idPath(id)}/abort${withDir(directory)}`);
    return true;
  },
  // Dialog replies (live-verified against opencode 1.19.5 on 2026-11-01):
  //   permission → POST /zai/api/permission/{per_id}/reply {reply:"once"|"always"|"reject"}
  //   question   → POST /zai/api/question/{que_id}/reply {answers: string[][]}
  //                QuestionAnswer = an ARRAY of selected labels (multi-select
  //                per question; single-choice = one-element array). A flat
  //                string[] 400s: «Expected QuestionAnswer, got "…"» — the old
  //                contract note here was wrong and cost a day of unanswerable
  //                question cards (2026-11-01).
  //   Directory-scoped like every session route: without ?directory= upstream
  //   looks up the request id in the instance of ITS OWN CWD (system32 after a
  //   watchdog restart) and answers 404.
  replyPermission: async (rid, body, { directory, signal } = {}) => {
    await request("POST", `/permission/${idPath(rid)}/reply${withDir(directory)}`, body, { signal });
    return true;
  },
  replyQuestion: async (rid, body, { directory, signal } = {}) => {
    await request("POST", `/question/${idPath(rid)}/reply${withDir(directory)}`, body, { signal });
    return true;
  },
  // Open permission/question requests across all directories (server merges
  // upstream listings with the hub snapshot): fresh page loads seed their
  // dialog modals from this, because a permission.asked that fired before the
  // page opened never re-fires over SSE.
  getDialogs: () => json("GET", "/dialogs"),
  getProvider: () => json("GET", "/provider"),
  getAgents: () => json("GET", "/agent"),
  getProjects: () => json("GET", "/project"),
  getMcp: () => json("GET", "/mcp"),
  // FEAT-03.22: the caller's own system prompt {text, max}.
  getSystemPrompt: () => json("GET", "/me/system-prompt"),
  setSystemPrompt: (text) => json("PUT", "/me/system-prompt", { text }),
  // FEAT-01.69: the caller's pinned chats (ids in pin order).
  getPins: () => json("GET", "/me/pins"),
  setPins: (ids) => json("PUT", "/me/pins", { ids }),
  // Authoritative per-session run status from upstream /session/status:
  // Record<sessionID, {type:"busy"|"idle"|"retry", ...}>.
  getSessionStatus: () => json("GET", "/status"),
  getHost: () => json("GET", "/host"),
  // Versions for «О приложении» — every role (ISSUE-008).
  getAbout: () => json("GET", "/about"),
  // «Новый проект»: the server's verdict on a folder (ISSUE-006).
  checkDir: (directory) => json("GET", `/dircheck${withDir(directory)}`),
  // A removed chip deletes its uploaded file (ISSUE-009).
  deleteUpload: async (directory, name) => {
    await request("DELETE", `/upload?${new URLSearchParams({ directory: directory ?? "", name: name ?? "" })}`);
    return true;
  },
  // z.ai Coding Plan usage (Settings «Подписка z.ai»): {ok, plan, windows}.
  // The server resolves it with the owner's key; 503 surfaces as a throw.
  getUsage: () => json("GET", "/usage"),
  // FEAT-11.18: расход подписок по подключённым провайдерам — {providers:[карточка]}; всем пользователям.
  getSubscriptions: () => json("GET", "/subscriptions"),
  // FEAT-06.2 voice mode: {enabled, ready, parked, voices:[{id,name}], stt,
  // defaultVoice}; tts → WAV bytes (ArrayBuffer); stt takes raw int16 LE mono
  // 16 kHz PCM → {text, seconds}. Errors carry err.body.code
  // ("unavailable"|"parked"|"failed" on 503, "quota" on 429).
  voiceInfo: () => json("GET", "/voice"),
  voiceTts: async (body, { signal } = {}) => {
    const res = await request("POST", "/voice/tts", body, { signal });
    return res.arrayBuffer();
  },
  voiceStt: async (pcm, { signal } = {}) => {
    const res = await request("POST", "/voice/stt", pcm, { signal, raw: true, contentType: "application/octet-stream" });
    return res.json();
  },
  // Binary upload straight to the session folder (the File is streamed — no
  // FileReader/base64, so 100MB files never inflate browser memory).
  // Answers {name, size} of the stored file.
  //   onProgress(0..1): real upload progress (XHR; fetch has none) — R-26;
  //   signal: AbortSignal; abort rejects with err.aborted = true and the
  //           request is really cancelled (no orphan file on the server).
  // Without XHR (node tests) the upload goes through request(): a 401 still
  // drops to the login screen (G7 finding 2 / BUG-007).
  uploadFile: async (file, directory, { onProgress, signal } = {}) => {
    const q = new URLSearchParams({ directory: directory ?? "", name: file.name ?? "file" });
    const path = `/upload?${q}`;
    if (typeof XMLHttpRequest !== "function") {
      const res = await request("POST", path, file, { raw: true, contentType: file.type, signal });
      return res.json();
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abortErr = () => Object.assign(new Error("upload aborted"), { aborted: true });
      if (signal?.aborted) return reject(abortErr());
      const onAbort = () => xhr.abort();
      signal?.addEventListener?.("abort", onAbort, { once: true });
      const done = () => signal?.removeEventListener?.("abort", onAbort);
      xhr.open("POST", BASE + path);
      xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = (e) => {
          if (e?.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
        };
      }
      xhr.onload = () => {
        done();
        try {
          const epoch = xhr.getResponseHeader?.("x-zai-epoch");
          if (epoch) onEpochCb?.(String(epoch), "http");
        } catch {}
        if (xhr.status < 200 || xhr.status >= 300) {
          if (xhr.status === 401) onUnauthorizedCb?.();
          const err = new Error(`zai api POST /upload failed: ${xhr.status}`);
          err.status = xhr.status;
          try {
            err.body = JSON.parse(xhr.responseText);
          } catch {}
          return reject(err);
        }
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(e);
        }
      };
      xhr.onerror = () => {
        done();
        reject(new Error("upload network error"));
      };
      xhr.onabort = () => {
        done();
        reject(abortErr());
      };
      xhr.send(file);
    });
  },
  // Workspace file (chat artifacts): inline for preview, download=1 forces
  // attachment disposition. The server re-checks containment inside directory.
  // BUG-092: files changed in the chat folder per turn window
  // (lib/turn-files.js) → { files: [[abs, …], …] }.
  turnFiles: (directory, windows) => {
    const q = new URLSearchParams({ directory: directory ?? "", w: windows.map(([a, b]) => `${Math.floor(a)}-${Math.ceil(b)}`).join(",") });
    return json("GET", `/turn-files?${q}`);
  },
  // BUG-090: which of these workspace files exist → { exists: [bool, …] }
  // (always 200 for an allowed folder: no 404 in the console).
  filesExist: (directory, paths) => {
    const q = new URLSearchParams({ directory: directory ?? "" });
    for (const p of paths) q.append("path", p);
    return json("GET", `/file/exists?${q}`);
  },
  fileUrl: (directory, path, download = false) => {
    const q = new URLSearchParams({ directory: directory ?? "", path });
    if (download) q.set("download", "1");
    return `${BASE}/file?${q}`;
  },

  // ---- FEAT-07.20 Web Push (own subscriptions only) ----
  pushKey: (endpoint) => json("GET", `/push/key${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ""}`), // → {enabled, publicKey, subscribed?}
  pushSubscribe: (sub) => json("POST", "/push/subscribe", sub),
  pushUnsubscribe: (endpoint) => json("DELETE", "/push/subscribe", { endpoint }),
  pushTest: () => json("POST", "/push/test", {}), // → {ok, sent}
  // «this device is looking at chat X right now» — the server skips it.
  pushPresence: (endpoint, chat) => json("POST", "/push/presence", { endpoint, chat }),
};

// Event id → server epoch. ADR-005 wire format is `<epoch>.<seq>`; a plain
// numeric id (pre-epoch server) has no epoch → null. The client never relies
// on the id otherwise (the browser replays Last-Event-ID by itself).
export function epochOfEventId(id) {
  const s = typeof id === "string" ? id : "";
  const dot = s.lastIndexOf(".");
  return dot > 0 ? s.slice(0, dot) : null;
}

// Live event stream with self-healing (BUG-07.11, ADR-005).
//   • A transient drop: the browser reconnects by itself (readyState
//     CONNECTING) with Last-Event-ID — we only report the state.
//   • A non-200 answer (edge 502 while the portal restarts, 401 after a token
//     change) puts EventSource into CLOSED for good: we recreate it with an
//     exponential backoff (1 s → 30 s), forever, until close().
//   • After any reopen that followed an error → onResync("reconnect"): a new
//     EventSource carries no Last-Event-ID, so missed events must be refetched.
//   • zai.resync frames → onResync("server"); malformed frames are ignored.
//   • `<epoch>.<seq>` ids → onEpoch(epoch) (the store compares epochs).
// onStatus("open" | "error" | "closed"): connection face for the shell.
// `factory` is injectable for tests (defaults to the global EventSource).
// Returns {close(), reconnectNow()}.
export function openEvents({ onEvent, onResync, onStatus, onEpoch: onEp, factory, minDelayMs = 1000, maxDelayMs = 30_000 } = {}) {
  const make = factory ?? ((url) => new EventSource(url));
  let es = null;
  let closed = false;
  let timer = null;
  let delay = minDelayMs;
  let hadError = false;

  const schedule = () => {
    if (closed || timer) return;
    const d = delay;
    delay = Math.min(maxDelayMs, delay * 2);
    timer = setTimeout(connect, d);
    timer?.unref?.();
  };

  function connect() {
    timer = null;
    if (closed) return;
    let cur;
    try {
      cur = make(`${BASE}/event`);
    } catch {
      hadError = true;
      onStatus?.("closed");
      schedule();
      return;
    }
    es = cur;
    cur.onopen = () => {
      if (es !== cur) return;
      delay = minDelayMs;
      onStatus?.("open");
      if (hadError) {
        hadError = false;
        onResync?.("reconnect");
      }
    };
    cur.onmessage = (e) => {
      if (es !== cur) return;
      const ep = epochOfEventId(e?.lastEventId);
      if (ep) onEp?.(ep, "sse");
      let evt;
      try {
        evt = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!evt || typeof evt.type !== "string") return;
      if (evt.type === "zai.resync") onResync?.("server");
      else onEvent?.(evt);
    };
    cur.onerror = () => {
      if (es !== cur) return;
      hadError = true;
      // 2 = EventSource.CLOSED: the browser gave up (non-200 / bad type).
      if (cur.readyState === 2) {
        try {
          cur.close();
        } catch {}
        onStatus?.("closed");
        schedule();
      } else {
        onStatus?.("error");
      }
    };
  }

  connect();
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      timer = null;
      try {
        es?.close();
      } catch {}
    },
    // Network came back (window «online»): skip the remaining backoff. With no
    // timer armed (ISSUE-004) a stream that is not OPEN is replaced now — the
    // browser's own retry may sit on a dead socket for minutes. An OPEN
    // stream is left alone.
    reconnectNow() {
      if (closed) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      } else if (es && es.readyState === 1) {
        return;
      } else {
        try {
          es?.close();
        } catch {}
        hadError = true; // the new stream must resync what the old one missed
      }
      delay = minDelayMs;
      connect();
    },
    // 0 connecting · 1 open · 2 closed (tests / diagnostics).
    get readyState() {
      return es?.readyState ?? 2;
    },
  };
}
