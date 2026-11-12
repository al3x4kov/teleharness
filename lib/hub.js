// SSE fan-out hub. The browser pool never talks to the opencode /event stream
// directly: this hub holds the upstream subscriptions, assigns its own
// monotonic sequence numbers, keeps a ring buffer of recent events for
// Last-Event-ID replay, and broadcasts to every connected client. Because the
// upstream has no replay facility, any reconnect means events may have been
// lost - every client is then told to resync.
//
// Upstream filters /event frames per-directory (verified live 2026-10-31: a
// session in D:\... streams ONLY on /event?directory=D:\...). One connection
// per directory is therefore kept alive; every connection feeds the same
// ring/broadcast pipeline. The directory set self-heals from GET /session.
//
// Wire ids carry a server EPOCH (ADR-005): `id: <epoch>.<seq>`. The epoch is
// fixed per process, so a browser reconnecting after a portal restart sends
// a Last-Event-ID from a foreign epoch and gets zai.resync instead of a
// silent empty replay (the old numeric ids restarted at 1 and a client at
// 5000 was told nothing — BUG-07.11 / code-correctness #3).
//
// FEAT-16.3 (tasks 3.3): опция oc — клиент lib/oc-client.js. С ним все
// обращения к opencode (события, /session, статусы, permission/question,
// abort, replay-prompt) идут через адаптер: v2 — одно глобальное соединение
// /api/event и глобальная карта занятости, подписки папок — фильтр; v1 —
// per-directory как раньше. Без oc — прежние прямые fetch/http (существующие
// тесты хаба идут без изменения ожиданий).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { EMPTY_TURN_ERROR, isContentPart } from "./empty-turn.js";

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000]; // capped at 30s
const RESYNC = JSON.stringify({ type: "zai.resync", properties: {} });
// How long a replay POST «owns» the next new user message of its session:
// that message is the replay itself and inherits the counter (BUG-07.12).
const REPLAY_EXPECT_MS = 60_000;
// Per-session cap of the message index (role/parent per message id).
const MSG_INDEX_CAP = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

// JSON.stringify with sorted object keys: tool inputs are compared by value,
// and key order of the same input is not guaranteed across steps.
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
    .join(",")}}`;
}

// Live shapes (captured 2026-10-31 on 1.19.5):
//   session.status → {sessionID, status:{type:"busy"|"idle"|"retry",...}}
//   session.idle   → {sessionID}
//   session.error  → {sessionID, error}
//   permission/question asked/replied → {sessionID, id|requestID}
//   message.updated → {sessionID, info:{id, role, parts?, time?}}
//   message.part.updated → {sessionID, part:{id, messageID, ...}}
//   message.part.delta → {sessionID, messageID, partID, field, delta}
export class EventHub {
  // ringSize is injectable so tests can exercise the overflow path cheaply.
  // stallAbortMs: auto-POST /session/:id/abort for sessions that stay busy
  // with ZERO events for that long (a hung turn is silent forever, and there
  // is no watchdog in opencode itself). 0 disables; stallTickMs is the check
  // cadence (injectable for tests).
  //
  // stallReplayMs (2026-11-01, «у меня в чате вообще ничего не происходит»):
  // the busy killer above cannot see the SECOND kind of hang — a run whose
  // fiber died (or was aborted) leaves the session idle with user prompts
  // persisted but never answered (opencode 1.19.5 never replays its prompt
  // queue). The hub tracks the last unanswered user message per session
  // (#pending) and, once that message has sat unanswered this long while the
  // session is idle and dialog-free, re-POSTs it upstream (prompt_async),
  // copying model/agent from the latest assistant message. maxPromptReplays
  // caps the chain so a dead provider cannot loop forever; 0 disables.
  //
  // dialogTimeoutMs (FEAT-07.15): 0 = an open dialog waits for the human
  // forever (the default). The auto-reject is an opt-in env knob only.
  //
  // pendingStatePath (BUG-07.12): JSON file where replay counters survive a
  // restart; without it a restart reset the cap and one prompt replayed 2×N.
  //
  // epoch (ADR-005): wire-id prefix; injectable for tests, else boot time.
  //
  // loopAbortCount (BUG-07.7): N identical tool calls in a row → abort the
  // turn + a zai.loop service event. 0 disables.
  //
  // maxClientBufferBytes / maxStreamsPerKey (BUG-12.17): a slow SSE client
  // whose unsent buffer exceeds the cap is disconnected (it reconnects with
  // Last-Event-ID); one key (user) holds at most N streams, oldest evicted.
  //
  // promptUnstickMs / unstickSettleMs (BUG-07.10): prepareForPrompt() aborts
  // a busy-but-silent turn (silent ≥ promptUnstickMs) before a new prompt is
  // posted, so «Продолжай» into a hung chat starts a fresh run.
  //
  // unindexedSweepMs (BUG-186 / BUG-07.23): a chat deleted while its folder's
  // SSE stream is not subscribed never delivers session.deleted, and its busy
  // entry lives forever (prod 2026-11-07: healthz hub.busy lied for 4 hours
  // and every deploy script missed its quiet window). syncDirectories() pulls
  // the general /session index on every tick; a busy entry absent from it this
  // long becomes a CANDIDATE — but absence alone is not proof of deletion
  // (opencode 1.19.5: the unpinned index lists only the `global` project,
  // ≤100 rows; git-repo chats live in their own projects and never appear
  // there, even alive). The candidate is verified against its own folder
  // (GET /session/:id?directory=…): ONLY a 404 sweeps the entry. Managed
  // (claude) sessions are exempt — the index never lists them while alive.
  // 0 disables.
  constructor({
    ringSize = 1000,
    keepaliveMs = 15_000,
    directoryPollMs = 20_000,
    stallAbortMs = 0,
    stallTickMs = 60_000,
    dialogTimeoutMs = 0,
    stallReplayMs = 0,
    maxPromptReplays = 2,
    pendingStatePath = null,
    epoch = null,
    loopAbortCount = 0,
    maxClientBufferBytes = 16 * 1024 * 1024,
    maxStreamsPerKey = 8,
    promptUnstickMs = 120_000,
    unstickSettleMs = 1500,
    unindexedSweepMs = 10 * 60_000,
    oc = null,
  } = {}) {
    this.#ringSize = ringSize;
    this.#keepaliveMs = keepaliveMs;
    this.#directoryPollMs = directoryPollMs;
    this.#stallAbortMs = stallAbortMs;
    this.#stallTickMs = stallTickMs;
    this.#dialogTimeoutMs = dialogTimeoutMs;
    this.#stallReplayMs = stallReplayMs;
    this.#maxPromptReplays = maxPromptReplays;
    this.#pendingStatePath = pendingStatePath;
    this.#epoch = typeof epoch === "string" && epoch && !epoch.includes(".") ? epoch : Date.now().toString(36);
    this.#loopAbortCount = loopAbortCount;
    this.#maxClientBufferBytes = maxClientBufferBytes;
    this.#maxStreamsPerKey = maxStreamsPerKey;
    this.#promptUnstickMs = promptUnstickMs;
    this.#unstickSettleMs = unstickSettleMs;
    this.#unindexedSweepMs = unindexedSweepMs;
    this.#savedReplays = this.#loadPendingState();
    // Active SSE clients as {res, visible}: visible(dir) is the tenant scope
    // filter (null dir → only unrestricted admins see the event). The hub
    // still subscribes to every directory globally; visibility is applied at
    // fan-out, so one upstream connection pool serves every tenant.
    this.#clients = new Set();
    this.#ring = []; // [{ seq, data }] newest last, capped at ringSize
    this.#seq = 0;
    this.#base = null;
    // FEAT-16.3 (3.3): клиент lib/oc-client.js. Есть — ВСЕ обращения к
    // opencode идут через него (события, /session, статусы, диалоги, abort,
    // replay-prompt); нет — прежние прямые fetch/http (бит в бит как было).
    // v2-клиент (oc.api === "v2"): одно глобальное соединение /api/event,
    // подписки папок — только фильтр; v1 — per-directory как раньше.
    this.#oc = oc;
    this.#ocHandle = null;
    this.#conns = new Map(); // directory -> conn (see #ensure)
    this.#pinned = new Set(); // dirs from start() options: never auto-dropped
    this.#stopped = false;
    // sessionID -> {since, lastEvent, dir}; dir = the upstream connection the
    // session was seen on (abort calls are directory-scoped, 1.19.5).
    this.#busy = new Map();
    // sessionID -> Map<requestID, {kind, askedAt, dir, props}>: open
    // permission/question dialogs with full ask payloads. A turn parked on a
    // dialog is busy-but-legit (the stall killer skips it), but a dialog that
    // sits unanswered past dialogTimeoutMs is auto-denied — the tool call
    // fails and the agent continues (it explains the denial), so a chat can
    // never park forever just because nobody saw the modal (2026-11-01: five
    // sessions were found parked 15-40 minutes on unseen permission dialogs).
    this.#dialogs = new Map();
  // sessionID -> {messageID, at, dir, replays}: the last user message that
  // has not been answered by any assistant part yet (see field notes below).
  this.#pending = new Map();
  this.#answeredUser = new Map();
  this.#pendingSeeded = false;
  // SessionIDs owned by a MANAGED runner (claude CLI): its turns always emit
  // their own terminal event, so the recovery machinery (pending tracking,
  // stall-abort, prompt replay) must never act on them - a replay would POST
  // to upstream where these turns do not exist.
  this.#managed = new Set();
  }

  #ringSize;
  #keepaliveMs;
  #directoryPollMs;
  #stallAbortMs;
  #stallTickMs;
  #dialogTimeoutMs;
  #stallReplayMs;
  #maxPromptReplays;
  #clients;
  #ring;
  #seq;
  #base;
  #oc;
  #ocHandle; // v2: единственная глобальная подписка oc.events()
  #sessionDir = new Map(); // BUG-196: sessionID → папка (из syncDirectories) для событий v2 без location
  #conns;
  #pinned;
  #stopped;
  #busy;
  #dialogs;
  // sessionID -> {messageID, at, dir, replays}: the last user message that
  // has not been answered by any assistant part yet. Survives session.idle
  // ON PURPOSE — idle + pending is exactly the poisoned-queue state.
  #pending;
  // sessionID -> messageID of the last user message an assistant answered.
  // opencode re-emits message.updated for that SAME user message after the
  // turn (summary/title update); without this memory the tracker re-armed
  // pending for an answered prompt and the «ход завис» banner lied after a
  // successful answer (dogfood 2026-11-02, BUG-016).
  #answeredUser;
  // SessionIDs owned by a MANAGED runner (claude CLI): its turns always emit
  // their own terminal event, so the recovery machinery (pending tracking,
  // stall-abort, prompt replay) must never act on them - a replay would POST
  // to upstream where these turns do not exist.
  #managed;
  // The one-shot boot seed flag: unanswered prompts that predate the hub
  // (restart) never fire message events again, so the first syncDirectories
  // reads tails from upstream once to rebuild #pending.
  #pendingSeeded;
  #pendingStatePath;
  // sessionID -> {messageID, replays, at}: counters restored from disk; the
  // boot seed / live arming apply them when the same prompt shows up again.
  #savedReplays;
  // sessionID -> {replays, until}: a replay POST in flight «owns» the next
  // new user message of the session (it IS the replay) — only that message
  // inherits the counter. A human prompt starts a fresh episode (CC-20).
  #expectReplay = new Map();
  // sessionID -> Map<messageID, {role, parent, seen}>: who answers whom.
  // `seen` is the event tick the message was first observed at. Lets the
  // tracker tell the PREVIOUS turn's traffic from the answer to a queued
  // prompt (code-correctness #1, regression of 1.6.1).
  #msgIndex = new Map();
  #tick = 0;
  #epoch;
  #loopAbortCount;
  // sessionID -> {sig, tool, count, counted:Set<partID>, input}
  #loops = new Map();
  // sessionID -> {open, total}: latest todo.updated summary (BUG-07.8)
  #todos = new Map();
  // sessionIDs whose current turn was seen busy / ended in an error
  #turnBusy = new Set();
  #turnError = new Set();
  // BUG-11.13: sessionID -> {asst: Map<messageID, {completed, error}>,
  // content: Set<messageID>} for the current turn — an answer that finished
  // without content and without an error becomes a turn error at idle.
  #turnAsst = new Map();
  // Plain listeners (data, dir) for every event the hub fans out — server.js
  // hangs the auto-titler on it (BUG-01.27). Errors are swallowed.
  #listeners = new Set();
  // sessionID -> ms: last «stopped with open todos» mark (FEAT-07.16 stats)
  #incomplete = new Map();
  #maxClientBufferBytes;
  #maxStreamsPerKey;
  #promptUnstickMs;
  #unstickSettleMs;
  #unindexedSweepMs;
  // single-flight guard for the BUG-186 phantom verification pass
  #verifying = false;
  #keepaliveTimer;
  #pollTimer;
  #stallTimer;
  // single-flight guard for the replay sweep: the pre-retry unstick pauses
  // inside the loop, and overlapping setInterval ticks would otherwise run
  // concurrent sweeps that gang-replay the same prompt before the cap lands.
  #sweeping = false;

  // Watchdog options are accepted HERE as well as in the constructor, and
  // non-undefined values win over the constructor's. Reason: server.js used
  // to construct `new EventHub()` bare and pass stallAbortMs/dialogTimeoutMs
  // to start() — an earlier signature silently dropped them, and the whole
  // auto-unstick layer ran disabled in production (live 2026-11-01). Accepting
  // both spellings turns that wiring bug class into a no-op.
  start(upstreamBase, { directory = null, directories = null, stallAbortMs, dialogTimeoutMs, stallReplayMs, stallTickMs, maxPromptReplays } = {}) {
    this.#stopped = false;
    this.#base = String(upstreamBase).replace(/\/+$/, "");
    if (stallAbortMs !== undefined) this.#stallAbortMs = stallAbortMs;
    if (dialogTimeoutMs !== undefined) this.#dialogTimeoutMs = dialogTimeoutMs;
    if (stallReplayMs !== undefined) this.#stallReplayMs = stallReplayMs;
    if (stallTickMs !== undefined) this.#stallTickMs = stallTickMs;
    if (maxPromptReplays !== undefined) this.#maxPromptReplays = maxPromptReplays;
    const initial = directories ?? (directory ? [directory] : []);
    // /event frames are filtered per-directory upstream; pin the home dir so
    // zai receives events for its sessions regardless of the server cwd.
    for (const d of initial) this.#pinned.add(d);
    // v2 (FEAT-16.3): ОДНО глобальное соединение на все папки — переписыватель
    // адаптера кладёт в событие directory, раскладку делает #onUpstreamEvent.
    if (this.#oc && this.#oc.api === "v2") {
      this.#ocHandle = this.#oc.events({ onEvent: (evt) => this.#onUpstreamEvent(evt), dirOf: (sid) => this.#sessionDir.get(sid) ?? null });
    }
    this.#keepaliveTimer = setInterval(() => this.#ping(), this.#keepaliveMs);
    // Directory discovery talks to /session — only in real deployments (a
    // bare start(), as in tests, keeps the single-connection behavior).
    if (initial.length > 0) {
      this.#pollTimer = setInterval(() => this.syncDirectories(), this.#directoryPollMs);
      this.#pollTimer.unref?.();
      for (const d of this.#pinned) this.#ensure(d);
    } else {
      this.#ensure(null); // single unpinned upstream, the classic behavior
    }
    if (this.#stallAbortMs > 0 || this.#dialogTimeoutMs > 0 || this.#stallReplayMs > 0) {
      this.#stallTimer = setInterval(() => this.#watchdogTick(), this.#stallTickMs);
      this.#stallTimer.unref?.();
    }
  }

  stop() {
    this.#stopped = true;
    clearInterval(this.#keepaliveTimer);
    clearInterval(this.#pollTimer);
    clearInterval(this.#stallTimer);
    this.#ocHandle?.close();
    this.#ocHandle = null;
    for (const dir of [...this.#conns.keys()]) this.#drop(dir);
    for (const c of this.#clients) c.res.destroy();
    this.#clients.clear();
  }

  // Add subscriptions for directories that appeared in GET /session and drop
  // the stale ones. Called by the internal poll and by server.js after every
  // POST /session (a brand-new project's first chat needs its subscription
  // within seconds, not on the next poll).
  // Directories this hub currently subscribes to (null single-conn excluded).
  // server.js fans the merged /zai/api/status out over exactly this set.
  // Process epoch (ADR-005): server.js exposes it as `x-zai-epoch` on
  // /zai/api/status so a polling client notices a restart too.
  get epoch() {
    return this.#epoch;
  }

  directories() {
    return [...this.#conns.keys()].filter((d) => typeof d === "string" && d);
  }

  async syncDirectories() {
    if (this.#stopped || !this.#base) return;
    let list;
    try {
      if (this.#oc) {
        list = await this.#oc.listSessions({}); // v2: развёрнутый список с directory; v1: как было
      } else {
        const res = await fetch(`${this.#base}/session`);
        if (!res.ok) return;
        list = await res.json();
      }
    } catch {
      return; // upstream down: keep current subscriptions
    }
    if (!Array.isArray(list)) return;
    this.#sweepUnindexedBusy(list); // BUG-186: stamp unindexed busy entries, queue stale ones for per-folder verification
    const dirs = new Set(this.#pinned);
    for (const s of list) {
      if (typeof s?.directory === "string" && s.directory) {
        dirs.add(s.directory);
        if (s.id) this.#sessionDir.set(s.id, s.directory);
      }
    }
    for (const d of dirs) this.#ensure(d);
    for (const d of [...this.#conns.keys()]) {
      if (!dirs.has(d)) this.#drop(d);
    }
    // Seed busy knowledge from upstream: /session/status is directory-scoped
    // (silently EMPTY without ?directory=, like every session-scoped route),
    // so ask per directory. This covers turns that hung BEFORE this hub
    // started — they are silent forever and would never enter the watchlist
    // via events. Open dialogs seed the same way: a hub restart must not
    // blind the timeout/visibility layer to pre-existing asks.
    // v2 — одна ГЛОБАЛЬНАЯ карта /api/session/active (api-map №9): отдельные
    // вопросы на папку не нужны. С клиентом — вызовы адаптера (OcError → null).
    const statusMaps = this.#oc && this.#oc.api === "v2"
      ? await (async () => {
          try {
            const map = await this.#oc.busyMap();
            return [map];
          } catch {
            return [null];
          }
        })()
      : await Promise.all(
          [...dirs].map(async (d) => {
            try {
              if (this.#oc) return await this.#oc.busyMap({ directory: d });
              const u = new URL("/session/status", this.#base);
              u.searchParams.set("directory", d);
              const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
              if (!res.ok) return null;
              return await res.json();
            } catch {
              return null;
            }
          }),
        );
    for (const sm of statusMaps) if (sm) this.#seedBusy(sm, list);
    // BUG-195: в v2 любой запрос с location поднимает экземпляр opencode папки
    // (+ её MCP-процессы). Опрос вопросов/разрешений КАЖДОЙ папки с чатами раз в
    // directoryPollMs держал экземпляры всех когда-либо использованных папок
    // (прод 2026-11-08: ~200 MCP-процессов). Вопросы и разрешения живут только
    // внутри идущего хода, а занятость в v2 глобальна — опрашиваем только папки
    // занятых сессий; новые запросы и так приходят событиями.
    let dialogDirs = [...dirs];
    if (this.#oc && this.#oc.api === "v2") {
      const busyIds = new Set(Object.entries(statusMaps[0] ?? {}).filter(([, s]) => s && s.type && s.type !== "idle").map(([id]) => id));
      dialogDirs = [...new Set(list.filter((s) => busyIds.has(s?.id) && typeof s?.directory === "string" && s.directory).map((s) => s.directory))];
    }
    await this.#seedDialogsFromUpstream(dialogDirs);
    // One-shot boot seed: rebuild #pending for prompts that died before this
    // hub existed. Restart blindness here would leave a poisoned chat
    // unrecovered until someone typed into it again.
    if (!this.#pendingSeeded) {
      this.#pendingSeeded = true;
      await this.#seedPending(list);
    }
  }

  #seedBusy(statusMap, sessionList) {
    if (!statusMap || typeof statusMap !== "object") return;
    const byId = new Map(
      (Array.isArray(sessionList) ? sessionList : []).filter((s) => s?.id).map((s) => [s.id, s]),
    );
    for (const [sid, st] of Object.entries(statusMap)) {
      const type = typeof st === "string" ? st : st?.type;
      if (!type || type === "idle" || this.#busy.has(sid)) continue;
      const s = byId.get(sid);
      this.#busy.set(sid, { since: Date.now(), lastEvent: Date.now(), dir: s?.directory ?? null });
    }
  }

  // BUG-186 / BUG-07.23: upstream's session.deleted never reaches the hub for
  // chats whose folder has no /event subscription (probe/temp dirs) — the busy
  // entry then outlives the chat forever. The `list` above is the GENERAL
  // upstream index (GET /session): absence from it only makes a busy entry a
  // candidate (first absence arms a per-entry clock; past unindexedSweepMs it
  // is queued for verification). It is NOT proof of deletion — see
  // #verifyPhantoms. A failed/short fetch never gets here (early returns), so
  // a stale index cannot sweep anything. Managed (claude) sessions never
  // appear in this index while alive — exempt. A session that reappears
  // (recreated, upstream hiccup) resets its clock; #seedBusy below re-arms
  // busy for anything genuinely still running upstream.
  #sweepUnindexedBusy(list) {
    if (this.#unindexedSweepMs <= 0) return;
    const now = Date.now();
    const listed = new Set((Array.isArray(list) ? list : []).map((s) => s?.id).filter((id) => typeof id === "string" && id));
    const candidates = [];
    for (const [sid, v] of this.#busy) {
      if (listed.has(sid) || this.#managed.has(sid)) {
        if (v.unindexedAt != null) v.unindexedAt = null;
        continue;
      }
      if (v.unindexedAt == null) {
        v.unindexedAt = now; // first sync that cannot find it: the grace window starts
        continue;
      }
      if (now - v.unindexedAt >= this.#unindexedSweepMs) candidates.push(sid);
    }
    if (candidates.length > 0) void this.#verifyPhantoms(candidates); // fire-and-forget: never delays syncDirectories
  }

  // Verify busy candidates against their own folder — the general index is
  // not deletion proof (opencode 1.19.5: unpinned GET /session returns only
  // the `global` project, capped at 100; git-repo chats have their own
  // projectID and are absent even while alive). Only upstream 404 on
  // GET /session/:id?directory=<the busy entry's dir> proves the chat is
  // gone → the entry is dropped. 200 resets the clock; a network error,
  // timeout or 5xx leaves the entry as is — the next tick re-checks.
  // Single-flight (an in-flight pass makes overlapping ticks no-op: the
  // candidates stay armed and are re-collected next tick), sequential.
  async #verifyPhantoms(sids) {
    if (this.#verifying || !this.#base) return;
    this.#verifying = true;
    try {
      for (const sid of sids) {
        if (this.#stopped) return;
        const v = this.#busy.get(sid);
        if (!v) continue; // already gone (idle/error/deleted event arrived meanwhile)
        if (!v.dir) continue; // no folder to ask: leave the entry alone
        let gone = null; // true — upstream 404 (чата нет); false — жив; null — нет доказательства
        try {
          if (this.#oc) {
            await this.#oc.getSession(sid, { directory: v.dir });
            gone = false; // 2xx: жив
          } else {
            const u = new URL(`/session/${encodeURIComponent(sid)}`, this.#base);
            u.searchParams.set("directory", v.dir);
            const res = await fetch(u, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
            if (res.status === 404) gone = true;
            else if (res.ok) gone = false;
          }
        } catch (err) {
          if (this.#oc && err?.status === 404) gone = true;
          // сеть/таймаут/5xx: доказательства нет — запись остаётся до следующего тика
        }
        if (gone === true) {
          this.#busy.delete(sid);
          console.log(`[zai-hub] busy phantom ${sid} dropped: upstream 404 in ${v.dir} (absent from the general index for ${Math.round((Date.now() - v.unindexedAt) / 1000)}s)`);
          continue;
        }
        if (gone === false) {
          v.unindexedAt = null; // alive (e.g. a git-project chat absent from the general index)
          continue;
        }
        // 5xx and anything else: no proof either way — keep for the next tick.
      }
    } finally {
      this.#verifying = false;
    }
  }

  // --- unanswered-prompt recovery (the idle-poison case) -----------------------

  // REST face for /zai/api/status: { "<sessionID>": { at, replays, max } }.
  // The client renders the «ход завис» banner from this — an unanswered
  // prompt produces NO busy flag and NO spinner, which is exactly how the
  // chat used to look silently dead to the user.
  // The prompt got its answer: drop the pending entry and remember which
  // user message it was, so upstream's post-turn re-emit of that message
  // cannot re-arm it. `parentID` (assistant info → the user message it
  // answers) wins when present.
  //
  // The caller has already decided that the message answers THE pending
  // prompt (see #answersPending) — settling on foreign traffic is what made a
  // queued prompt vanish under the previous turn's deltas (code-correctness
  // #1). Without a pending entry only the answered-memory is updated.
  #settlePending(sid, parentID = null) {
    const cur = this.#pending.get(sid);
    const answered = cur?.messageID ?? ((typeof parentID === "string" && parentID) || null);
    if (answered) this.#answeredUser.set(sid, answered);
    if (!cur) return;
    this.#pending.delete(sid);
    this.#expectReplay.delete(sid);
    const persisted = cur.replays > 0 || this.#savedReplays.has(sid);
    this.#savedReplays.delete(sid);
    if (persisted) this.#persistPending();
  }

  // Message index: role/parent of every message id seen on the wire, with the
  // tick it was first seen at. Capped per session (oldest dropped).
  #indexMessage(sid, id, role, parent) {
    if (typeof id !== "string" || !id) return null;
    let map = this.#msgIndex.get(sid);
    if (!map) {
      map = new Map();
      this.#msgIndex.set(sid, map);
    }
    let m = map.get(id);
    if (!m) {
      m = { role: null, parent: null, seen: this.#tick };
      map.set(id, m);
      if (map.size > MSG_INDEX_CAP) map.delete(map.keys().next().value);
    }
    if (role && !m.role) m.role = role;
    if (typeof parent === "string" && parent && !m.parent) m.parent = parent;
    return m;
  }

  // Does traffic on message `msgID` answer the pending prompt `cur`?
  //  - a user message never answers;
  //  - a known parentID decides exactly (opencode assistant info.parentID is
  //    the user message it answers);
  //  - no parentID yet: only a message first seen AFTER the prompt was armed
  //    can be its answer — the previous turn's assistant was already on the
  //    wire before the queued prompt arrived.
  #answersPending(sid, msgID, cur) {
    if (!cur || !msgID || msgID === cur.messageID) return false;
    const m = this.#msgIndex.get(sid)?.get(msgID);
    if (!m) return true; // unindexed (cannot happen on the live path): legacy behavior
    if (m.role === "user") return false;
    if (m.parent) return m.parent === cur.messageID;
    return m.seen > (cur.armTick ?? -1);
  }

  // The replay/banner clock: time since the prompt was armed, or since the
  // session last went idle, whichever is later. A prompt queued behind a long
  // turn is not «stalled» while that turn runs (FEAT-07.15 / CC-1 follow-up).
  static #clock(v) {
    return Math.max(v.at ?? 0, v.idleAt ?? 0);
  }

  pendingSnapshot() {
    const out = {};
    for (const [sid, v] of this.#pending) out[sid] = { at: v.at, replays: v.replays, max: this.#maxPromptReplays };
    return out;
  }

  // --- replay counter persistence (BUG-07.12) ---------------------------------

  #loadPendingState() {
    const out = new Map();
    if (!this.#pendingStatePath) return out;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.#pendingStatePath, "utf8"));
    } catch (err) {
      if (err?.code !== "ENOENT") console.log(`[zai-hub] pending state unreadable, starting empty: ${err?.message ?? err}`);
      return out;
    }
    const entries = raw && typeof raw === "object" ? raw.entries : null;
    if (!entries || typeof entries !== "object") return out;
    const now = Date.now();
    for (const [sid, e] of Object.entries(entries)) {
      if (typeof e?.messageID !== "string" || !Number.isInteger(e.replays) || e.replays <= 0) continue;
      if (typeof e.at === "number" && now - e.at > DAY_MS) continue;
      out.set(sid, { messageID: e.messageID, replays: e.replays, at: e.at ?? now });
    }
    return out;
  }

  // tmp + rename: a crash mid-write never leaves a torn file (ADR-002).
  #persistPending() {
    if (!this.#pendingStatePath) return;
    const entries = {};
    const now = Date.now();
    for (const [sid, e] of this.#savedReplays) {
      if (now - e.at <= DAY_MS) entries[sid] = e;
    }
    for (const [sid, v] of this.#pending) {
      if (v.replays > 0 && v.messageID) entries[sid] = { messageID: v.messageID, replays: v.replays, at: v.at };
    }
    const tmp = `${this.#pendingStatePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.#pendingStatePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
      fs.renameSync(tmp, this.#pendingStatePath);
    } catch (err) {
      console.log(`[zai-hub] pending state write failed: ${err?.message ?? err}`);
    }
  }

  // Counter a freshly armed prompt starts with: the replay's own message
  // inherits the in-flight counter; a prompt known from disk keeps its saved
  // count; anything else (a human prompt) starts a fresh episode at 0.
  #inheritedReplays(sid, messageID) {
    const exp = this.#expectReplay.get(sid);
    if (exp) {
      this.#expectReplay.delete(sid);
      if (Date.now() <= exp.until) return exp.replays;
    }
    const saved = this.#savedReplays.get(sid);
    if (saved && saved.messageID === messageID) return saved.replays;
    return 0;
  }

  // The WIRE face for the «ход завис» banner: only prompts that have actually
  // sat past the replay window — or exhausted their replays. A freshly armed
  // entry is a queued/starting turn, not a hang: reporting it made the banner
  // fire on every between-turns gap and lie to the user (live 2026-11-01:
  // «Ход завис — попытка 1/2» while the queued prompt was about to run).
  // Exhausted entries (replays >= max) stay visible for good: that is the
  // manual «Отправить снова» state, the client's only exit door. Raw
  // pendingSnapshot() remains the tracker introspection (tests, debug).
  stalledSnapshot() {
    const out = {};
    if (this.#stallReplayMs <= 0) return out; // replay disabled: nothing ever stalls
    const now = Date.now();
    for (const [sid, v] of this.#pending) {
      // A running turn (the prompt is queued behind it) or a turn parked on a
      // dialog is not a hang: the human may simply not have answered yet
      // (FEAT-07.15), and a long turn legitimately holds the queue.
      if (this.#busy.has(sid)) continue;
      if ((this.#dialogs.get(sid)?.size ?? 0) > 0) continue;
      // max = 0 means «no auto-replay», not «exhausted at birth»: such entries
      // still wait out the window before the banner (BUG-016).
      const exhausted = this.#maxPromptReplays > 0 && v.replays >= this.#maxPromptReplays;
      if (!exhausted && now - EventHub.#clock(v) < this.#stallReplayMs) continue;
      out[sid] = { at: v.at, replays: v.replays, max: this.#maxPromptReplays };
    }
    return out;
  }

  // Event shapes carry role under info (message.updated) or messageID on the
  // part itself (part.updated/delta/removed). Tolerant readers: the flat
  // legacy shape is accepted the same way the client store tolerates it.
  static #roleOf(entry) {
    return entry?.info?.role ?? entry?.role ?? null;
  }

  static #partsOf(entry) {
    return entry?.info?.parts ?? entry?.parts ?? [];
  }

  // A persisted prompt replays as {type:"text"}/{type:"file"} parts only —
  // ids/timestamps and provider-internal fields must not leak into the new
  // prompt payload (the client's send path builds exactly this shape too).
  static #replayableParts(parts) {
    const out = [];
    for (const part of parts ?? []) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        out.push({ type: "text", text: part.text });
      } else if (part?.type === "file" && typeof part.url === "string" && part.url) {
        out.push({ type: "file", mime: part.mime, filename: part.filename, url: part.url });
      }
    }
    return out;
  }

  // Is `entry` an assistant message that actually consumed the prompt? A 0-part
  // assistant is the dead shell of a hung turn ONLY while it is still running —
  // once time.completed is set the turn finished (provider failure, abort,
  // empty answer), and the prompt is no longer orphaned: replaying it would
  // re-run finished work. Live 2026-11-01: message.updated events carry info
  // ONLY (no parts anywhere), so on the event wire the completed stamp is the
  // only completion signal there is.
  static #answered(entry) {
    if (EventHub.#roleOf(entry) !== "assistant") return false;
    if (EventHub.#partsOf(entry).length > 0) return true;
    return (entry?.info?.time?.completed ?? entry?.time?.completed) != null;
  }

  // Shared by the live tracker, the boot seed and the sweep: read a message
  // list and decide whether the session ends with an unanswered prompt. If
  // yes, return {messageID, at, parts, model, agent}.
  static #tailPrompt(list) {
    if (!Array.isArray(list) || list.length === 0) return null;
    // Answered tail check: only messages AFTER the last real answer can be
    // pending — anything earlier is history.
    let start = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (EventHub.#answered(list[i])) {
        start = i + 1;
        break;
      }
    }
    const tail = list.slice(start);
    if (tail.length === 0) return null;
    // The LAST user message is the one that gets replayed (earlier queued
    // siblings stay — replaying the freshest intent is the honest, minimal
    // intervention).
    let user = null;
    for (let i = tail.length - 1; i >= 0; i--) {
      if (EventHub.#roleOf(tail[i]) === "user") {
        user = tail[i];
        break;
      }
    }
    if (!user) return null;
    const info = user.info ?? user;
    const parts = EventHub.#replayableParts(EventHub.#partsOf(user));
    if (parts.length === 0) return null;
    // model/agent come from the newest assistant message that carries them —
    // scanned over the FULL list, not just the tail: the model-bearing
    // message may sit before the last answer. Replaying with a silently
    // substituted default would resurrect the dead-model-prefs incident
    // class (2026-10-31).
    let model = null;
    let agent;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (EventHub.#roleOf(e) !== "assistant") continue;
      const a = e.info ?? e;
      if (a.modelID && a.providerID) {
        model = { providerID: a.providerID, modelID: a.modelID };
        agent = typeof a.agent === "string" && a.agent ? a.agent : undefined;
        break;
      }
    }
    // BUG-180: the replay keeps the effort of the original turn (opencode stores it on the user message).
    const variant = typeof info.variant === "string" && info.variant ? info.variant : undefined;
    return { messageID: info.id ?? null, at: info.time?.created ?? null, parts, model, agent, variant };
  }

  async #fetchMessages(sid, dir) {
    if (this.#oc) {
      // 500 новейших хватает и на хвост с unanswered-промптом, и на поиск
      // модели последнего ответа (лимит пагинации портала, PAGE_MAX).
      const out = await this.#oc.listMessages(sid, { directory: dir ?? null, limit: 500 });
      return Array.isArray(out?.messages) ? out.messages : null;
    }
    const u = new URL(`/session/${encodeURIComponent(sid)}/message`, this.#base);
    if (dir) u.searchParams.set("directory", dir);
    const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const list = await res.json();
    return Array.isArray(list) ? list : null;
  }

  // Boot seed: scan every known session once; a tail that ends unanswered
  // enters #pending with the ORIGINAL message timestamp. Prompts older than
  // a day are stale history, not a live hang — the user's "why is it silent"
  // clock starts recently; replaying a three-day-old message would surprise.
  // Cap the scan at the 50 NEWEST sessions: GET /session is sorted
  // newest-first upstream, so a naive tail slice would keep exactly the
  // oldest half and miss every freshly poisoned chat (live 2026-11-01).
  async #seedPending(sessionList) {
    if (this.#stallReplayMs <= 0 || !this.#base) return;
    const sessions = (Array.isArray(sessionList) ? sessionList : [])
      .filter((s) => typeof s?.id === "string")
      .sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))
      .slice(0, 50);
    for (const s of sessions) {
      if (this.#busy.has(s.id) || this.#pending.has(s.id)) continue;
      let list;
      try {
        list = await this.#fetchMessages(s.id, s.directory ?? null);
      } catch {
        continue;
      }
      if (!list) continue;
      const tail = EventHub.#tailPrompt(list);
      if (!tail) continue;
      const at = tail.at ?? Date.now();
      if (Date.now() - at > DAY_MS) continue;
      // The counter survives the restart (BUG-07.12): a prompt the previous
      // process already replayed keeps its count instead of a fresh 0.
      const saved = this.#savedReplays.get(s.id);
      const replays = saved && saved.messageID === tail.messageID ? saved.replays : 0;
      this.#pending.set(s.id, { messageID: tail.messageID, at, dir: s.directory ?? null, replays, armTick: this.#tick });
    }
  }

  // The sweep: idle + dialog-free + unanswered past the window → replay.
  // Busy sessions are skipped (their hang is the abort sweep's job; the
  // queued prompt replays here after that abort lands).
  async #replayStalled() {
    if (this.#sweeping || this.#stopped || !this.#base || this.#stallReplayMs <= 0) return;
    this.#sweeping = true;
    try {
      await this.#replaySweep();
    } finally {
      this.#sweeping = false;
    }
  }

  async #replaySweep() {
    const now = Date.now();
    for (const [sid, pd] of [...this.#pending]) {
      if (this.#managed.has(sid)) continue; // the runner owns recovery for these
      if (now - EventHub.#clock(pd) < this.#stallReplayMs) continue;
      if (this.#busy.has(sid)) continue;
      if ((this.#dialogs.get(sid)?.size ?? 0) > 0) continue;
      if (pd.replays >= this.#maxPromptReplays) continue;
      // Re-read the tail right before acting: the guard window is minutes, and
      // a replay must never fire on an already-answered prompt.
      let tail;
      try {
        tail = EventHub.#tailPrompt(await this.#fetchMessages(sid, pd.dir));
      } catch {
        continue; // upstream hiccup: keep the entry, try on the next tick
      }
      if (!tail) {
        this.#settlePending(sid);
        continue;
      }
      if (this.#busy.has(sid)) continue;
      // A retry means the first replay was accepted upstream yet the answer
      // still never came — per the field playbook (2026-10-31 hung turns) a
      // queue that swallows prompt_async without running it unsticks only
      // after an ABORT; the retry then plays into a live executor instead of
      // the void.
      if (pd.replays > 0) await this.#unstick(sid, pd.dir);
      await this.#replayPrompt(sid, pd, tail);
    }
  }

  // Best-effort abort (directory-scoped) followed by a settle pause so
  // opencode processes it before the next POST. Used before a replay RETRY
  // (see #replayStalled) and by prepareForPrompt.
  async #unstick(sid, dir, why = "pre-retry") {
    try {
      let ok;
      if (this.#oc) {
        await this.#oc.abort(sid, { directory: dir ?? null });
        ok = true;
        console.log(`[zai-hub] ${why} abort for ${sid} -> ok`);
      } else {
        const u = new URL(`/session/${encodeURIComponent(sid)}/abort`, this.#base);
        if (dir) u.searchParams.set("directory", dir);
        const res = await fetch(u, { method: "POST", signal: AbortSignal.timeout(10_000) });
        console.log(`[zai-hub] ${why} abort for ${sid} -> ${res.status}`);
        ok = res.ok;
      }
      if (this.#unstickSettleMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#unstickSettleMs));
      return ok;
    } catch (err) {
      console.log(`[zai-hub] ${why} abort ${sid} failed: ${err?.message ?? err}`);
      return false;
    }
  }

  // BUG-07.12 / code-correctness #2: the counter is bumped on the LIVE Map
  // entry BEFORE the POST, and the in-flight replay «owns» the next new user
  // message (#expectReplay) — so the replay's own message.updated may arrive
  // before or after the HTTP answer and the count still lands. Only a
  // definite upstream rejection (non-2xx) rolls the attempt back; a network
  // error/timeout keeps it (the POST may have landed — erring towards the
  // cap is the safe side of an uncapped loop).
  async #replayPrompt(sid, pd, tail) {
    const live = this.#pending.get(sid) ?? pd;
    const attempt = live.replays + 1;
    live.replays = attempt;
    live.at = Date.now(); // one attempt per window regardless of the outcome
    live.idleAt = undefined;
    if (!live.messageID) live.messageID = tail.messageID;
    if (!this.#pending.has(sid)) this.#pending.set(sid, live);
    this.#expectReplay.set(sid, { replays: attempt, until: Date.now() + REPLAY_EXPECT_MS });
    this.#persistPending();
    // С клиентом — prompt адаптера. В v2 model/agent/variant живут НА СЕССИИ
    // (model-switched в истории) — повтор не перепривязывает и не шлёт их;
    // в v1 — тот же payload, что и раньше. Определённый отказ upstream
    // (OcError.status ≥ 400) откатывает попытку, сеть/таймаут — оставляет.
    const viaOc = !!this.#oc;
    const ocBody = viaOc
      ? {
          directory: pd.dir ?? null,
          sessionID: sid,
          parts: tail.parts,
          ...(this.#oc.api !== "v2" && tail.model ? { model: tail.model } : {}),
          ...(this.#oc.api !== "v2" && tail.agent ? { agent: tail.agent } : {}),
          ...(this.#oc.api !== "v2" && tail.variant ? { variant: tail.variant } : {}),
        }
      : null;
    try {
      if (viaOc) {
        await this.#oc.prompt(ocBody);
        const waitedMin = Math.round((Date.now() - (tail.at ?? live.at)) / 60_000);
        console.log(`[zai-hub] replayed unanswered prompt in ${sid} (sat ${waitedMin}m, attempt ${attempt}/${this.#maxPromptReplays})`);
      } else {
        const u = new URL(`/session/${encodeURIComponent(sid)}/prompt_async`, this.#base);
        if (pd.dir) u.searchParams.set("directory", pd.dir);
        const body = {
          parts: tail.parts,
          ...(tail.model ? { model: tail.model } : {}),
          ...(tail.agent ? { agent: tail.agent } : {}),
          ...(tail.variant ? { variant: tail.variant } : {}),
        };
        const res = await fetch(u, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const waitedMin = Math.round((Date.now() - (tail.at ?? live.at)) / 60_000);
          console.log(`[zai-hub] replayed unanswered prompt in ${sid} (sat ${waitedMin}m, attempt ${attempt}/${this.#maxPromptReplays}) -> ${res.status}`);
        } else {
          console.log(`[zai-hub] replay ${sid} failed: upstream ${res.status}`);
          this.#expectReplay.delete(sid);
          const cur = this.#pending.get(sid);
          if (cur && cur.replays === attempt) cur.replays = attempt - 1;
          this.#persistPending();
        }
      }
    } catch (err) {
      if (viaOc && (err?.status ?? 0) >= 400) {
        console.log(`[zai-hub] replay ${sid} failed: upstream ${err.status}`);
        this.#expectReplay.delete(sid);
        const cur = this.#pending.get(sid);
        if (cur && cur.replays === attempt) cur.replays = attempt - 1;
        this.#persistPending();
      } else {
        console.log(`[zai-hub] replay ${sid} failed (attempt kept): ${err?.message ?? err}`);
      }
    }
  }

  // BUG-07.10: called by server.js right before it posts a user prompt to an
  // opencode session. A turn that is busy but has been silent for
  // promptUnstickMs (and is not parked on a dialog) is a hung run: opencode
  // would only queue the new prompt behind it and never run it. Abort it
  // first so «Продолжай» starts a fresh run. Never touches managed (claude)
  // sessions — their runner owns the lifecycle (see BUG-07.10 in the report).
  async prepareForPrompt(sid, dir = null) {
    if (!this.#base || typeof sid !== "string" || !sid) return { aborted: false, reason: "no-upstream" };
    if (this.#managed.has(sid)) return { aborted: false, reason: "managed" };
    if (this.#promptUnstickMs <= 0) return { aborted: false, reason: "disabled" };
    const b = this.#busy.get(sid);
    if (!b) return { aborted: false, reason: "idle" };
    if ((this.#dialogs.get(sid)?.size ?? 0) > 0) return { aborted: false, reason: "dialog" };
    if (Date.now() - b.lastEvent < this.#promptUnstickMs) return { aborted: false, reason: "live" };
    this.#busy.delete(sid);
    const ok = await this.#unstick(sid, dir ?? b.dir ?? null, "pre-prompt");
    // BUG-213: abort не прошёл — ход жив, запись занятости возвращается
    // (если её уже не переоткрыло свежее событие хода)
    if (!ok && !this.#busy.has(sid)) this.#busy.set(sid, b);
    return { aborted: ok, reason: ok ? "silent" : "abort-failed" };
  }

  // --- stall watchdog (auto-unstick) ------------------------------------------

  busySnapshot() {
    // Test/introspection face: { "<sessionID>": sinceMs }
    const out = {};
    for (const [sid, v] of this.#busy) out[sid] = v.since;
    return out;
  }

  // FEAT-07.16: admin monitoring face — every session the hub currently
  // considers live (busy / parked on a dialog / holding an unanswered
  // prompt), with ages, oldest first. server.js serves it on an admin-only
  // route; the «Остановить» button reuses the regular abort route.
  sessionsReport() {
    const now = Date.now();
    const ids = new Set([...this.#busy.keys(), ...this.#dialogs.keys(), ...this.#pending.keys()]);
    const out = [];
    for (const sid of ids) {
      const b = this.#busy.get(sid) ?? null;
      const dmap = this.#dialogs.get(sid);
      const pd = this.#pending.get(sid) ?? null;
      const dialogs = dmap ? [...dmap.values()] : [];
      const oldestDialogAt = dialogs.length ? Math.min(...dialogs.map((d) => d.askedAt)) : null;
      const exhausted = !!pd && this.#maxPromptReplays > 0 && pd.replays >= this.#maxPromptReplays;
      const state = dialogs.length ? "dialog" : b ? "busy" : "pending";
      const since = b?.since ?? oldestDialogAt ?? pd?.at ?? now;
      out.push({
        sessionID: sid,
        dir: b?.dir ?? dialogs[0]?.dir ?? pd?.dir ?? null,
        state,
        managed: this.#managed.has(sid),
        since,
        ageMs: now - since,
        lastEventAt: b?.lastEvent ?? null,
        silentMs: b ? now - b.lastEvent : null,
        dialogs: dialogs.length,
        oldestDialogAt,
        pending: pd ? { at: pd.at, replays: pd.replays, max: this.#maxPromptReplays, exhausted } : null,
        // a turn silent past the stall window, or an exhausted replay chain
        stalled: (!!b && !dialogs.length && this.#stallAbortMs > 0 && now - b.lastEvent >= this.#stallAbortMs) || exhausted,
        incompleteAt: this.#incomplete.get(sid) ?? null,
      });
    }
    out.sort((a, b) => a.since - b.since);
    return out;
  }

  // --- managed (non-upstream) sessions ----------------------------------------

  // A managed session (the claude runner) owns its own turn lifecycle: its
  // terminal event always arrives from the runner itself, so the recovery
  // machinery below must stay hands-off (see the field note above).
  markManaged(sessionID) {
    if (typeof sessionID === "string" && sessionID) this.#managed.add(sessionID);
  }

  // FEAT-11.18: чат передан с Claude на opencode — защита от зависшего хода снова за хабом.
  unmarkManaged(sessionID) {
    this.#managed.delete(sessionID);
  }

  // Injection point for non-upstream event sources: the same wire format as
  // upstream frames ({type, properties}), the same ring/replay/broadcast and
  // tenant-filtering pipeline, the same busy bookkeeping (#noteEvent).
  emit(event, dir = null) {
    this.#emitEvent(JSON.stringify(event), typeof dir === "string" ? dir : null);
  }

  // Observe every fanned-out event as (rawData, dir). Returns an unsubscribe.
  onEvent(fn) {
    if (typeof fn !== "function") return () => {};
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  // Sessions parked on an open permission/question dialog (gc input).
  dialogSessions() {
    return new Set(this.#dialogs.keys());
  }

  // --- open dialogs (permission/question) -------------------------------------
  // Live ask events vanish for freshly loaded clients (SSE has no replay for
  // state, only for the ring via Last-Event-ID), so server.js exposes
  // GET /zai/api/dialogs built from this snapshot MERGED with the upstream
  // GET /permission and /question listings (which survive hub restarts).

  dialogsSnapshot() {
    const out = [];
    for (const [sessionID, map] of this.#dialogs) {
      for (const [id, e] of map) {
        out.push({ id, sessionID, kind: e.kind, askedAt: e.askedAt, dir: e.dir ?? null, props: e.props });
      }
    }
    return out;
  }

  // Upstream GET /permission and /question per directory (both are
  // directory-scoped like every session route — silently EMPTY without
  // ?directory=). Records carry {kind, directory, ...upstream entry}.
  async #fetchUpstreamDialogs(dirs) {
    const grab = async (route, dir) => {
      try {
        if (this.#oc) {
          const list = route === "/permission"
            ? await this.#oc.listPermissions({ directory: dir ?? undefined })
            : await this.#oc.listQuestions({ directory: dir ?? undefined });
          return Array.isArray(list) ? list : [];
        }
        const u = new URL(route, this.#base);
        if (dir) u.searchParams.set("directory", dir);
        const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return [];
        const list = await res.json();
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    };
    const list = dirs.length > 0 ? dirs : [null]; // single-connection hub: unpinned query
    const perDir = await Promise.all(
      list.map(async (dir) => {
        const [perms, ques] = await Promise.all([grab("/permission", dir), grab("/question", dir)]);
        return [
          ...perms.map((e) => ({ kind: "permission", directory: dir ?? null, ...e })),
          ...ques.map((e) => ({ kind: "question", directory: dir ?? null, ...e })),
        ];
      }),
    );
    return perDir.flat().filter((e) => typeof e?.id === "string");
  }

  // REST face for GET /zai/api/dialogs: upstream truth + locally known ask
  // times. Oldest first (matches the client queue order); unknown ages last.
  async collectDialogs() {
    if (!this.#base) return [];
    const askedAtById = new Map(this.dialogsSnapshot().map((d) => [d.id, d.askedAt]));
    const merged = (await this.#fetchUpstreamDialogs(this.directories())).map((e) => ({
      ...e,
      askedAt: askedAtById.get(e.id) ?? null,
    }));
    merged.sort((a, b) => (a.askedAt ?? Infinity) - (b.askedAt ?? Infinity));
    return merged;
  }

  // Cover asks that happened while the hub was down: anything upstream lists
  // but this snapshot lacks enters with askedAt=now — a full timeout window
  // of grace (a visitor may be mid-decision), after which #expireDialogs
  // resolves it like any other unanswered dialog.
  async #seedDialogsFromUpstream(dirs) {
    const known = new Set(this.dialogsSnapshot().map((d) => d.id));
    const now = Date.now();
    for (const rec of await this.#fetchUpstreamDialogs(dirs)) {
      if (known.has(rec.id)) continue;
      const sid = rec.sessionID;
      if (typeof sid !== "string" || !sid) continue;
      if (!this.#dialogs.has(sid)) this.#dialogs.set(sid, new Map());
      this.#dialogs.get(sid).set(rec.id, { kind: rec.kind, askedAt: now, dir: rec.directory ?? null, props: rec });
    }
  }

  // An unanswered dialog past dialogTimeoutMs resolves itself: permission →
  // {reply:"reject"} (the tool call errors, the agent continues and can say
  // it lacked permission), question → POST reject. This is the hard floor of
  // the «ничего не висит вечно» guarantee — the stall killer skips
  // dialog-parked sessions, so without this they would park forever.
  async #expireDialogs() {
    if (this.#stopped || !this.#base || this.#dialogTimeoutMs <= 0) return;
    const now = Date.now();
    for (const [sid, map] of [...this.#dialogs]) {
      for (const [id, rec] of [...map]) {
        if (now - rec.askedAt < this.#dialogTimeoutMs) continue;
        const route = rec.kind === "permission" ? `/permission/${encodeURIComponent(id)}/reply` : `/question/${encodeURIComponent(id)}/reject`;
        const u = new URL(route, this.#base);
        if (rec.dir) u.searchParams.set("directory", rec.dir);
        const opts = { method: "POST", signal: AbortSignal.timeout(10_000) };
        if (rec.kind === "permission") {
          opts.headers = { "content-type": "application/json" };
          opts.body = JSON.stringify({ reply: "reject" });
        }
        const waitedMin = Math.round((now - rec.askedAt) / 60_000);
        const drop = () => {
          map.delete(id);
          if (map.size === 0) this.#dialogs.delete(sid);
        };
        try {
          if (this.#oc) {
            if (rec.kind === "permission") {
              await this.#oc.replyPermission({ directory: rec.dir ?? undefined, sessionID: sid, requestID: id, reply: "reject" });
            } else {
              await this.#oc.rejectQuestion({ directory: rec.dir ?? undefined, sessionID: sid, requestID: id });
            }
          } else {
            const res = await fetch(u, opts);
            // BUG-213: не-2xx — неудача (кроме «диалога уже нет»), запись остаётся
            if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`upstream ${res.status}`);
          }
          console.log(`[zai-hub] auto-${rec.kind === "permission" ? "reject" : "dismiss"} ${id} (unanswered ${waitedMin}m) -> ok`);
          drop(); // BUG-213: запись снимается только по успешной отправке
        } catch (err) {
          if (err?.status === 404 || err?.status === 410) {
            // BUG-213: движок говорит, что диалога уже нет — исход достигнут
            console.log(`[zai-hub] auto-dismiss ${id} -> upstream ${err.status} (already gone), dropped`);
            drop();
            continue;
          }
          // BUG-213: повтор на следующем проходе; 5 неудач подряд — сдаёмся
          rec.fails = (rec.fails ?? 0) + 1;
          console.log(`[zai-hub] auto-dismiss ${id} failed (${rec.fails}): ${err?.message ?? err}`);
          if (rec.fails >= 5) {
            console.log(`[zai-hub] auto-dismiss ${id}: giving up after ${rec.fails} failed attempts in a row`);
            drop();
          }
        }
      }
    }
  }

  #watchdogTick() {
    this.#abortStalled();
    this.#expireDialogs();
    this.#replayStalled();
  }

  async #abortStalled() {
    if (this.#stopped || !this.#base || this.#stallAbortMs <= 0) return;
    const now = Date.now();
    for (const [sid, v] of [...this.#busy]) {
      if (this.#managed.has(sid)) continue; // the runner kills its own hung turns
      if (now - v.lastEvent < this.#stallAbortMs) continue;
      if ((this.#dialogs.get(sid)?.size ?? 0) > 0) continue; // parked on a dialog: legit silence
      const silentFor = Math.round((now - v.lastEvent) / 1000);
      let ok = false;
      try {
        if (this.#oc) {
          await this.#oc.abort(sid, { directory: v.dir ?? null });
          ok = true;
          console.log(`[zai-hub] auto-abort stuck session ${sid} (silent ${silentFor}s) -> ok`);
        } else {
          const u = new URL(`/session/${encodeURIComponent(sid)}/abort`, this.#base);
          if (v.dir) u.searchParams.set("directory", v.dir);
          const res = await fetch(u, { method: "POST", signal: AbortSignal.timeout(10_000) });
          console.log(`[zai-hub] auto-abort stuck session ${sid} (silent ${silentFor}s) -> ${res.status}`);
          ok = res.ok;
        }
      } catch (err) {
        console.log(`[zai-hub] auto-abort ${sid} failed: ${err?.message ?? err}`);
      }
      if (!ok) {
        // BUG-213: abort не прошёл — ход жив, запись занятости остаётся; часы
        // тишины заводятся заново (следующая попытка через тот же порог)
        const cur = this.#busy.get(sid);
        if (cur) cur.lastEvent = Date.now();
        continue;
      }
      this.#busy.delete(sid); // single shot per stall; fresh busy events re-arm it
    }
  }

  // --- busy/dialog bookkeeping from the event wire ----------------------------

  // Returns follow-up events ({event, dir}) the hub synthesizes from this
  // one (zai.loop, zai.turn.incomplete); #emitEvent broadcasts them AFTER
  // the triggering event so the wire order stays causal.
  #noteEvent(data, dir) {
    const follow = [];
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      return follow;
    }
    const p = evt?.properties;
    const sid = p?.sessionID;
    if (typeof sid !== "string" || !sid) return follow;
    this.#tick += 1;
    const now = Date.now();
    const type = evt.type;
    if (type === "session.status") {
      const st = typeof p.status === "string" ? p.status : p.status?.type;
      if (st === "idle" || st == null) {
        this.#wentIdle(sid, now, follow);
      } else {
        const cur = this.#busy.get(sid);
        // `since` must survive repeated busy frames: a hung turn is silent, so
        // lastEvent is the real stall clock, but a turn that keeps streaming
        // steps refreshes lastEvent (and must not look stuck).
        this.#busy.set(sid, { since: cur?.since ?? now, lastEvent: now, dir: dir ?? cur?.dir ?? null });
        if (!this.#turnBusy.has(sid)) {
          this.#turnBusy.add(sid);
          this.#turnError.delete(sid);
          // A new turn: forget the previous turn's late post-idle updates.
          this.#turnAsst.delete(sid);
        }
      }
      return follow;
    }
    if (type === "session.idle" || type === "session.error" || type === "session.deleted") {
      if (type === "session.error") this.#turnError.add(sid);
      this.#wentIdle(sid, now, follow);
      // A finished/dead session cannot have live asks; stale entries would
      // wrongly keep the stall killer away from the session forever.
      this.#dialogs.delete(sid);
      // idle and error intentionally KEEP #pending: idle + unanswered prompt
      // is the poisoned-queue state the replay sweep exists for. Only a
      // deleted session can never be answered.
      if (type === "session.deleted") {
        const had = this.#pending.get(sid)?.replays > 0 || this.#savedReplays.has(sid);
        this.#pending.delete(sid);
        this.#savedReplays.delete(sid);
        this.#expectReplay.delete(sid);
        this.#answeredUser.delete(sid);
        this.#msgIndex.delete(sid);
        this.#loops.delete(sid);
        this.#todos.delete(sid);
        this.#incomplete.delete(sid);
        this.#turnBusy.delete(sid);
        this.#turnError.delete(sid);
        this.#turnAsst.delete(sid);
        if (had) this.#persistPending();
      }
      return follow;
    }
    if (type === "todo.updated") {
      const todos = Array.isArray(p.todos) ? p.todos : [];
      const open = todos.filter((t) => t?.status === "pending" || t?.status === "in_progress").length;
      this.#todos.set(sid, { open, total: todos.length });
    }
    if (type === "message.updated") {
      const info = p.info ?? p;
      this.#indexMessage(sid, info?.id, info?.role ?? null, info?.parentID ?? null);
      if (info?.role === "assistant" && typeof info.id === "string" && !this.#managed.has(sid)) {
        const ta = this.#turnAsstOf(sid);
        const prev = ta.asst.get(info.id);
        ta.asst.set(info.id, { completed: prev?.completed || info.time?.completed != null, error: prev?.error || Boolean(info.error) });
        if (Array.isArray(p.parts) && p.parts.some(isContentPart)) ta.content.add(info.id);
      }
      if (this.#managed.has(sid)) {
        // Managed runner: pending/recovery tracking does not apply (see the
        // field note); the busy-clock refresh below still runs.
      } else if (info?.role === "user" && typeof info.id === "string") {
        const cur = this.#pending.get(sid);
        if (this.#answeredUser.get(sid) === info.id) {
          // Post-turn update of an already answered prompt: not a new ask.
        } else if (cur && cur.messageID === info.id) {
          // Same still-unanswered prompt updated again: keep its original
          // clock — refreshing `at` would push the stall window forever.
          if (dir && !cur.dir) cur.dir = dir;
        } else {
          // A new prompt. The counter is inherited ONLY by the message the
          // replay itself created (or a prompt restored from disk); a human
          // prompt starts a fresh episode (BUG-07.12 / CC-20).
          const replays = this.#inheritedReplays(sid, info.id);
          this.#pending.set(sid, {
            messageID: info.id,
            at: now,
            dir: dir ?? cur?.dir ?? null,
            replays,
            armTick: this.#tick,
          });
          this.#loops.delete(sid); // a new ask resets the loop streak
          if (replays > 0 || cur?.replays > 0 || this.#savedReplays.has(sid)) {
            if (this.#savedReplays.get(sid)?.messageID !== info.id) this.#savedReplays.delete(sid);
            this.#persistPending();
          }
        }
      } else if (EventHub.#answered({ info, parts: p.parts })) {
        // parts ride top-level on list payloads; events carry info only, but
        // pass them through anyway so any future shape keeps working.
        const cur = this.#pending.get(sid);
        if (!cur) this.#settlePending(sid, info?.parentID);
        else if (this.#answersPending(sid, info?.id, cur)) this.#settlePending(sid);
      }
    } else if (type === "message.part.updated" || type === "message.part.delta" || type === "message.part.removed") {
      const msgID = p.part?.messageID ?? p.messageID ?? null;
      this.#indexMessage(sid, msgID, null, null);
      if (msgID && !this.#managed.has(sid)) {
        const content = type === "message.part.updated" ? isContentPart(p.part) : type === "message.part.delta" && typeof p.delta === "string" && p.delta.trim().length > 0;
        if (content) this.#turnAsstOf(sid).content.add(msgID);
      }
      const cur = this.#pending.get(sid);
      // Part traffic answers the pending prompt only when it belongs to ITS
      // assistant — the previous turn's deltas must not swallow a prompt
      // queued behind it (code-correctness #1).
      if (cur && msgID && this.#answersPending(sid, msgID, cur)) this.#settlePending(sid);
      if (type === "message.part.updated") this.#noteToolCall(sid, p.part, dir, follow);
    }
    if (type === "permission.asked" || type === "question.asked") {
      const id = p.id ?? p.requestID;
      if (typeof id === "string") {
        if (!this.#dialogs.has(sid)) this.#dialogs.set(sid, new Map());
        this.#dialogs.get(sid).set(id, {
          kind: type === "permission.asked" ? "permission" : "question",
          askedAt: now,
          dir,
          props: p,
        });
      }
    } else if (type === "permission.replied" || type === "permission.updated" || type === "question.replied" || type === "question.updated") {
      const map = this.#dialogs.get(sid);
      const id = p.id ?? p.requestID;
      if (map && typeof id === "string") {
        map.delete(id);
        if (map.size === 0) this.#dialogs.delete(sid);
      }
    }
    const cur = this.#busy.get(sid);
    if (cur) cur.lastEvent = now; // any session event is a progress signal
    return follow;
  }

  // busy → idle transition (session.idle / status idle / error / deleted).
  #wentIdle(sid, now, follow) {
    const wasBusy = this.#busy.delete(sid);
    // The pending clock restarts at idle: a prompt queued behind a long turn
    // gets a full window AFTER that turn ends before it counts as stalled.
    const pd = this.#pending.get(sid);
    if (pd && wasBusy) pd.idleAt = now;
    this.#loops.delete(sid);
    const ta = this.#turnAsst.get(sid);
    this.#turnAsst.delete(sid);
    if (!this.#turnBusy.delete(sid)) return; // already handled this turn's end
    const errored = this.#turnError.delete(sid);
    // BUG-11.13: every answer of the turn finished with no content and no
    // error — «тишина в чате». Reported as a turn error the client renders
    // with its regular error card (session.error → describeTurnError).
    if (!errored && ta && !this.#managed.has(sid) && EventHub.#emptyTurn(ta)) {
      const last = [...ta.asst.keys()].at(-1) ?? null;
      console.log(`[zai-hub] empty turn in ${sid} (message ${last}): reported as a turn error`);
      follow.push({
        event: {
          type: "session.error",
          properties: { sessionID: sid, error: { name: EMPTY_TURN_ERROR.name, data: { ...EMPTY_TURN_ERROR.data } }, zai: { emptyTurn: true, messageID: last } },
        },
      });
    }
    // BUG-07.8: the turn ended without an error, nothing is queued, yet the
    // agent's own todo list still has open items — it stopped mid-task.
    const todos = this.#todos.get(sid);
    if (!errored && !pd && !this.#managed.has(sid) && todos && todos.open > 0) {
      this.#incomplete.set(sid, now);
      follow.push({
        event: { type: "zai.turn.incomplete", properties: { sessionID: sid, reason: "open-todos", todosOpen: todos.open, todosTotal: todos.total } },
      });
    }
  }

  #turnAsstOf(sid) {
    let ta = this.#turnAsst.get(sid);
    if (!ta) this.#turnAsst.set(sid, (ta = { asst: new Map(), content: new Set() }));
    return ta;
  }

  static #emptyTurn(ta) {
    if (ta.asst.size === 0) return false;
    let completed = false;
    for (const [id, st] of ta.asst) {
      if (st.error || ta.content.has(id)) return false;
      if (st.completed) completed = true;
    }
    return completed;
  }

  // BUG-07.7: server-side loop detector. Counts consecutive tool calls with
  // the same tool + input (each tool part counted once, once its input is
  // final: status running/completed/error). At loopAbortCount in a row the
  // turn is aborted and a zai.loop service event is emitted for the chat card
  // («Агент зациклился — ход остановлен»). Managed (claude) turns are skipped:
  // upstream abort does not reach them.
  #noteToolCall(sid, part, dir, follow) {
    if (this.#loopAbortCount <= 0 || this.#managed.has(sid)) return;
    if (part?.type !== "tool" || typeof part.id !== "string") return;
    const status = part.state?.status;
    if (status !== "running" && status !== "completed" && status !== "error") return;
    let lp = this.#loops.get(sid);
    if (lp?.counted.has(part.id)) return;
    const sig = `${part.tool ?? ""}\u0000${stableStringify(part.state?.input ?? {})}`;
    if (!lp || lp.sig !== sig) {
      lp = { sig, tool: part.tool ?? null, count: 0, counted: new Set(), input: part.state?.input ?? null };
      this.#loops.set(sid, lp);
    }
    lp.counted.add(part.id);
    lp.count += 1;
    if (lp.count < this.#loopAbortCount) return;
    this.#loops.delete(sid); // one abort per streak
    const inputText = stableStringify(lp.input ?? {});
    follow.push({
      event: {
        type: "zai.loop",
        properties: { sessionID: sid, tool: lp.tool, count: lp.count, input: inputText.length > 300 ? `${inputText.slice(0, 300)}…` : inputText },
      },
      dir,
    });
    if (this.#base) {
      const adir = dir ?? this.#busy.get(sid)?.dir ?? null;
      console.log(`[zai-hub] loop detected in ${sid}: ${lp.tool} ×${lp.count} — aborting the turn`);
      this.#unstick(sid, adir, "loop").catch(() => {});
    }
  }

  // --- upstream subscriptions (one per directory) ----------------------------

  #ensure(dir) {
    if (this.#stopped || this.#conns.has(dir)) return;
    // FEAT-16.3: с адаптером v2 подписка ОДНА глобальная (#ocHandle, создана
    // в start()) — запись в #conns только отмечает папку известной (фильтр
    // для resync/directories()); с адаптером v1 — per-directory подписка
    // events({directory}); без клиента — прежний http-цикл, бит в бит.
    if (this.#oc && this.#oc.api === "v2") {
      this.#conns.set(dir, { dir, oc: true });
      return;
    }
    if (this.#oc) {
      const conn = { dir, oc: true, handle: this.#oc.events({ directory: dir, onEvent: (evt) => this.#onUpstreamEvent(evt) }) };
      this.#conns.set(dir, conn);
      return;
    }
    const conn = { dir, buf: "", frameData: [], backoffIdx: 0, reconnectTimer: null, connects: 0, req: null };
    this.#conns.set(dir, conn);
    this.#connect(dir, conn);
  }

  #drop(dir) {
    const conn = this.#conns.get(dir);
    if (!conn) return;
    this.#conns.delete(dir);
    if (conn.handle) conn.handle.close(); // подписка адаптера v1
    clearTimeout(conn.reconnectTimer);
    conn.req?.destroy();
  }

  // Кадры адаптера (уже в языке портала): {type, properties, directory}.
  // #emitEvent ждёт СТРОКУ кадра и dir отдельно — directory из поля события
  // (переписыватель v2 кладёт его из location; v1 — из подписки).
  #onUpstreamEvent(evt) {
    if (this.#stopped) return;
    const dir = typeof evt?.directory === "string" && evt.directory ? evt.directory : null;
    if (evt?.type === "zai.resync") {
      // Реконнект upstream (gap адаптера). В v1 resync уходит в папку
      // реконнекта; v2 держит один глобальный поток — развешиваем resync по
      // всем известным папкам (tenant-фильтр остаётся честным: клиент видит
      // только свой scope; без известных папок — безадресный), затем
      // перечитываем состояние (статусы/вопросы), как это делал бы опрос
      // после реконнекта в v1.
      const dirs = [...this.#conns.keys()].filter((d) => typeof d === "string" && d);
      if (dirs.length === 0) this.#emitEvent(RESYNC, null);
      else for (const d of dirs) this.#emitEvent(RESYNC, d);
      void this.syncDirectories().catch(() => {});
      return;
    }
    this.#emitEvent(JSON.stringify({ type: evt?.type, properties: evt?.properties ?? {} }), dir);
  }

  #connect(dir, conn) {
    const target = new URL("/event", this.#base);
    if (dir) target.searchParams.set("directory", dir);
    const req = http.request(target, {
      method: "GET",
      headers: { accept: "text/event-stream" },
    });
    conn.req = req;
    req.on("response", (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        req.destroy();
        this.#scheduleReconnect(dir, conn);
        return;
      }
      conn.backoffIdx = 0; // connection established: backoff resets
      conn.connects += 1;
      conn.buf = "";
      conn.frameData = [];
      if (conn.connects > 1) {
        // This is a REconnect: upstream has no replay, so events emitted
        // between drop and now are gone. Tell every client to refetch state.
        // Routed through #emitEvent so the resync lands in the ring too and
        // later reconnecting clients replay it instead of missing it. Tagged
        // with the reconnecting directory so tenant filtering stays honest
        // (a user only resyncs scopes they can see).
        this.#emitEvent(RESYNC, dir ?? null);
      }
      res.setEncoding("utf8");
      res.on("data", (chunk) => this.#feed(conn, chunk));
      const gone = () => this.#scheduleReconnect(dir, conn);
      res.on("aborted", gone);
      res.on("error", gone);
      res.on("end", gone);
      res.on("close", gone);
    });
    req.on("error", () => this.#scheduleReconnect(dir, conn));
    req.end();
  }

  #scheduleReconnect(dir, conn) {
    if (this.#stopped || !this.#conns.has(dir) || conn.reconnectTimer) return;
    const delay = BACKOFF_MS[Math.min(conn.backoffIdx, BACKOFF_MS.length - 1)];
    conn.backoffIdx += 1;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      if (this.#stopped || !this.#conns.has(dir)) return;
      this.#connect(dir, conn);
    }, delay);
  }

  // Incremental SSE parser per the WHATWG spec's line semantics, tolerant of
  // CRLF endings and multi-line data fields. Lines are processed one \n at a
  // time (with a trailing \r stripped); ':'-prefixed comments are ignored; a
  // blank line dispatches the accumulated frame. Per-connection buffer: two
  // upstream streams must not interleave partial lines.
  #feed(conn, chunk) {
    conn.buf += chunk;
    let nl;
    while ((nl = conn.buf.indexOf("\n")) >= 0) {
      let line = conn.buf.slice(0, nl);
      conn.buf = conn.buf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        this.#dispatchFrame(conn);
        continue;
      }
      if (line.startsWith(":")) continue; // comment / heartbeat
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      // Only 'data' matters: the hub owns sequencing, so upstream id/event/
      // retry fields are deliberately dropped.
      if (field === "data") conn.frameData.push(value);
    }
  }

  #dispatchFrame(conn) {
    if (conn.frameData.length === 0) return;
    const data = conn.frameData.join("\n");
    conn.frameData = [];
    this.#emitEvent(data, conn.dir ?? null);
  }

  // --- fan-out ----------------------------------------------------------------

  // SSE wire format: a data value containing newlines must be re-emitted as
  // one `data:` line per source line, or clients would silently drop the
  // continuation lines.
  // Wire id: `<epoch>.<seq>` (ADR-005). seq === null → no id line.
  #frame(seq, data) {
    const dataLines = data.split("\n").map((line) => `data: ${line}`).join("\n");
    return seq === null ? `${dataLines}\n\n` : `id: ${this.#epoch}.${seq}\n${dataLines}\n\n`;
  }

  #emitEvent(data, dir = null) {
    const follow = this.#noteEvent(data, dir); // busy/dialog bookkeeping before (or regardless of) fan-out
    // TASK-16.31: служебные события адаптера v2 (properties.zaiInternal) — только
    // для учёта хаба; ни в кольцо, ни клиентам, ни слушателям не идут. Текст
    // пользователя сюда не попадает: в JSON кавычки внутри строк экранированы.
    if (data.includes('"zaiInternal":true')) {
      for (const f of follow) this.#emitEvent(JSON.stringify(f.event), f.dir ?? dir);
      return;
    }
    const seq = (this.#seq += 1);
    this.#ring.push({ seq, data, dir }); // dir rides the ring so tenant filtering survives replay
    if (this.#ring.length > this.#ringSize) this.#ring.shift(); // oldest dropped
    this.#broadcast(seq, data, dir);
    for (const fn of this.#listeners) {
      try {
        fn(data, dir);
      } catch {}
    }
    for (const f of follow) this.#emitEvent(JSON.stringify(f.event), f.dir ?? dir);
  }

  // One guarded write to an SSE client. BUG-12.17: a client that does not
  // drain (dead mobile socket, frozen tab) would buffer without bound; past
  // maxClientBufferBytes it is cut off — it reconnects with Last-Event-ID
  // and gets a replay or zai.resync. Returns false when the client is gone.
  #write(c, chunk) {
    const res = c.res;
    if (res.destroyed || res.socket?.destroyed || res.writableEnded) {
      this.#clients.delete(c);
      return false;
    }
    try {
      res.write(chunk);
    } catch {
      this.#clients.delete(c);
      return false;
    }
    if (this.#maxClientBufferBytes > 0 && res.writableLength > this.#maxClientBufferBytes) {
      console.log(`[zai-hub] SSE client dropped: ${res.writableLength} bytes unsent (slow consumer)`);
      this.#clients.delete(c);
      res.destroy();
      return false;
    }
    return true;
  }

  #broadcast(seq, data, dir) {
    const frame = this.#frame(seq, data);
    // One transformed frame per distinct transform function (all tenants
    // share server.js's redactor), not one JSON round-trip per client.
    const byTransform = new Map();
    for (const c of [...this.#clients]) {
      // Tenant scope: an event from a directory the client cannot see is
      // silently skipped (e.g. admin sessions never leak to tenant pages).
      if (c.visible && !c.visible(dir)) continue;
      if (!c.transform) {
        this.#write(c, frame);
        continue;
      }
      if (!byTransform.has(c.transform)) byTransform.set(c.transform, this.#transformedFrame(c.transform, seq, data));
      const f = byTransform.get(c.transform);
      if (f) this.#write(c, f);
    }
  }

  // FEAT-12.16: transform(data) → data' (string) | null (drop the event).
  // A throwing transform drops the event rather than leaking it raw.
  #transformedFrame(transform, seq, data) {
    let out;
    try {
      out = transform(data);
    } catch {
      return null;
    }
    return typeof out === "string" ? this.#frame(seq, out) : null;
  }

  #ping() {
    for (const c of [...this.#clients]) this.#write(c, ": ping\n\n");
  }

  // --- client side ------------------------------------------------------------

  // Last-Event-ID → {epoch, seq} | null (unparseable / legacy numeric id).
  static #parseLastId(raw) {
    const m = /^([0-9a-z]+)\.(\d+)$/i.exec(String(raw).trim());
    if (!m) return null;
    const seq = Number(m[2]);
    return Number.isSafeInteger(seq) ? { epoch: m[1], seq } : null;
  }

  // Number of live SSE streams (introspection / tests).
  clientCount(key = undefined) {
    if (key === undefined) return this.#clients.size;
    let n = 0;
    for (const c of this.#clients) if (c.key === key) n += 1;
    return n;
  }

  // Close every stream of one key (server.js: a user disabled/deleted or a
  // token rotated — BUG-12.10 asks for this through Г2). Returns the count.
  closeClients(key) {
    let n = 0;
    for (const c of [...this.#clients]) {
      if (c.key !== key) continue;
      this.#clients.delete(c);
      c.res.destroy();
      n += 1;
    }
    return n;
  }

  // handleClient(req, res, { visible, key }): visible(dir) → boolean is the
  // tenant scope filter applied to both live broadcast and ring replay
  // (server.js passes the logged-in user's scope). key (the user id) groups
  // streams for the per-user cap and closeClients(). No options = see
  // everything, no cap (tests, single-tenant deployments).
  //
  // Resume rules (ADR-005):
  //  - no Last-Event-ID → fresh client: live events only (state via REST);
  //  - unparseable id, foreign epoch, seq ahead of this hub, or seq older
  //    than the ring covers → one zai.resync frame;
  //  - else replay ring events after seq (visibility-filtered).
  // The resync frame carries the CURRENT position as its id, so the browser's
  // next reconnect resumes from here instead of resyncing again.
  //
  // transform(data) (FEAT-12.16): per-client rewrite of the event JSON
  // string (server.js redacts tool parts for tenants); null drops it. It
  // applies to live fan-out and ring replay alike.
  handleClient(req, res, { visible = null, key = null, transform = null } = {}) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      "x-zai-epoch": this.#epoch,
    });
    res.write("retry: 3000\n\n");

    const entry = { res, visible, key, transform };
    if (key != null && this.#maxStreamsPerKey > 0) {
      // Evict the oldest streams of this key (Set keeps insertion order).
      const mine = [...this.#clients].filter((c) => c.key === key);
      for (let i = 0; i <= mine.length - this.#maxStreamsPerKey; i += 1) {
        this.#clients.delete(mine[i]);
        mine[i].res.destroy();
      }
    }

    const url = new URL(req.url, "http://localhost");
    const lastRaw = req.headers["last-event-id"] ?? url.searchParams.get("last");
    if (lastRaw != null && String(lastRaw).trim() !== "") {
      const pos = EventHub.#parseLastId(lastRaw);
      const oldest = this.#ring.length > 0 ? this.#ring[0].seq : this.#seq + 1;
      if (!pos || pos.epoch !== this.#epoch || pos.seq > this.#seq || pos.seq < oldest - 1) {
        res.write(`id: ${this.#epoch}.${this.#seq}\n${this.#frame(null, RESYNC)}`);
      } else {
        for (const ev of this.#ring) {
          if (ev.seq <= pos.seq || (visible && !visible(ev.dir))) continue;
          const f = transform ? this.#transformedFrame(transform, ev.seq, ev.data) : this.#frame(ev.seq, ev.data);
          if (f) res.write(f);
        }
      }
    }

    this.#clients.add(entry);
    res.on("error", () => this.#clients.delete(entry));
    res.on("close", () => this.#clients.delete(entry));
  }
}
