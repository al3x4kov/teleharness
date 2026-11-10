// The open chat: open/close, sending (optimistic bubbles, queue marks),
// stop, busy reconciliation, history refresh, chat CRUD and binding.
import { api, explainApiError } from "../api.js";
import { makeMessage, upsertSession } from "../normalize.js";
import { bindingOf, defaultBinding } from "../engine.js";
import { awaitingAnswer, finalizeMessages, isTmp, mergeHistory, resendParts, turnErrorFromMessages } from "../turn.js";
import {
  active,
  busyMap,
  editing,
  effectivePrefs,
  engineOfSession,
  loadDraft,
  saveDraft,
  patchActive,
  pendingMap,
  pins,
  rewindBusy,
  sessionDir,
  sessions,
  setBusyTracked,
  setNotice,
  stalled,
  staleModelText,
} from "./state.js";
import { freshSessionList } from "./catalog.js";
import { setPinsNavigate } from "./pins.js";
import { t } from "../i18n.js";

const STALL_MS = 120_000;
// busy→idle reconciliation grace: a just-sent prompt may not be busy on the
// server's /status yet; only silence longer than this counts as «missed idle».
const IDLE_GRACE_MS = 15_000;

let navigate = () => {};

export function setNavigate(fn) {
  if (typeof fn === "function") navigate = fn;
  setPinsNavigate(fn);
}

// Stall clock: any event for the session (delta, part, permission, status)
// proves the turn is alive. null means "busy since before we looked".
// activity=true also moves the «последнее событие» clock of the liveness line.
export function touchActive(id, activity) {
  const act = active.value;
  if (!act || act.id !== id) return;
  const now = Date.now();
  active.value = activity ? { ...act, lastEventAt: now, lastActivityAt: now } : { ...act, lastEventAt: now };
}

export function refreshStall() {
  const act = active.value;
  stalled.value = !!(act && act.status === "busy" && (act.lastEventAt == null || Date.now() - act.lastEventAt > STALL_MS));
}

export function hasSendInFlight(act) {
  return (act?.messages ?? []).some((m) => isTmp(m) && m.info.delivery === "sending");
}

export function finalizeTurn(act) {
  return { ...act, status: "idle", lastAction: null, messages: finalizeMessages(act.messages) };
}

// Server truth → busy/pending maps + reconciliation of the open chat in BOTH
// directions (BUG-07.11 / CC-06): idle→busy when the page slept through the
// start, busy→idle when it slept through the end.
export async function pollBusy() {
  try {
    const st = (await api.getSessionStatus()) ?? {};
    const prev = busyMap.value;
    const m = {};
    const pm = {};
    for (const [id, v] of Object.entries(st)) {
      if (v && v.type !== "idle") m[id] = prev[id] ?? (typeof v.since === "number" ? v.since : Date.now());
      if (v?.pending) pm[id] = v.pending;
    }
    busyMap.value = m;
    pendingMap.value = pm;
    const act = active.value;
    if (act && act.status === "idle" && m[act.id]) {
      active.value = { ...act, status: "busy", lastEventAt: Date.now() };
    } else if (
      act &&
      (act.status === "busy" || act.status === "stopping") &&
      !m[act.id] &&
      !hasSendInFlight(act) &&
      Date.now() - (act.lastEventAt ?? 0) > IDLE_GRACE_MS
    ) {
      // The idle event was lost (restart, sleep, dead stream): finish the
      // turn locally and pull the real history.
      active.value = finalizeTurn(act);
      refreshMessages(act.id);
      releaseHeld(act.id, { idle: true });
    }
    releaseIdleHeld(m);
  } catch {}
  refreshStall();
}

// BUG-08.8: the history comes in pages of HISTORY_PAGE newest messages; older
// ones are fetched on demand (loadOlder) by the server's `before` cursor.
// active.hasOlder / olderCursor describe what is left above the oldest loaded
// message; loadingOlder / olderError drive the indicator at the top of the feed.
export const HISTORY_PAGE = 100;

export async function refreshMessages(id) {
  // BUG-01.19: a chat the server does not know (deleted, stale link) is not
  // re-asked on resync/idle — every ask is a raw 404 in the browser console.
  if (active.value?.id === id && active.value.missing) return;
  try {
    const page = await api.getMessagesPage(id, { limit: HISTORY_PAGE, directory: sessionDir(id) });
    const act = active.value;
    if (act?.id === id) {
      const shaped = page.list.map((m) => makeMessage(m.info ?? m, m.parts ?? []));
      // Older pages the user already scrolled in stay above the fresh newest
      // page (a resync must not throw them away) when the two overlap.
      let older = [];
      let hasOlder = page.hasMore;
      let olderCursor = page.nextBefore;
      if (page.hasMore && act.olderLoaded) {
        const loaded = act.messages.filter((m) => !isTmp(m));
        const firstId = shaped[0]?.info?.id;
        const at = firstId ? loaded.findIndex((m) => m.info?.id === firstId) : -1;
        if (at > 0) {
          older = loaded.slice(0, at);
          hasOlder = act.hasOlder;
          olderCursor = act.olderCursor;
        }
      }
      active.value = {
        ...act,
        messages: mergeHistory([...older, ...shaped], act.messages),
        loading: false,
        loadError: false,
        hasOlder,
        olderCursor,
        olderLoaded: older.length > 0,
        // A reload must still show why the last turn died (BUG-07.14).
        turnError: act.turnError ?? turnErrorFromMessages(shaped, { engine: engineOfSession(id) }),
      };
    }
  } catch {
    // История не доехала (404 у удалённой сессии, сбой сети): снимаем loading,
    // ChatView различает «история пуста» и «чат не найден» по loadError.
    if (active.value?.id === id) active.value = { ...active.value, loading: false, loadError: true };
  }
}

// BUG-08.8: the next older page above the oldest loaded message (scroll to
// the top of the feed / «Загрузить ещё»). → true when a page was added.
export async function loadOlder(id) {
  const act = active.value;
  if (!act || act.id !== id || !act.hasOlder || !act.olderCursor || act.loadingOlder) return false;
  const cursor = act.olderCursor;
  patchActive(id, (a) => ({ ...a, loadingOlder: true, olderError: false }));
  try {
    const page = await api.getMessagesPage(id, { limit: HISTORY_PAGE, before: cursor, directory: sessionDir(id) });
    let added = false;
    patchActive(id, (a) => {
      // A reopen/resync moved the cursor meanwhile: this page is stale.
      if (a.olderCursor !== cursor) return { ...a, loadingOlder: false };
      const have = new Set(a.messages.map((m) => m.info?.id));
      const older = page.list.map((m) => makeMessage(m.info ?? m, m.parts ?? [])).filter((m) => !have.has(m.info?.id));
      added = older.length > 0;
      // A server that ignores limit/before (zai-qa mock, older builds) answers
      // with the same messages again: no new ids or an unmoved cursor = the
      // start of the history, otherwise the top of the feed would refetch forever.
      const more = added && page.hasMore && page.nextBefore !== cursor;
      return { ...a, messages: [...older, ...a.messages], hasOlder: more, olderCursor: more ? page.nextBefore : null, olderLoaded: true, loadingOlder: false };
    });
    return added;
  } catch {
    patchActive(id, (a) => ({ ...a, loadingOlder: false, olderError: true }));
    return false;
  }
}

// Generation of openSession calls (BUG-01.35): a late answer for a chat the
// user already left must never overwrite the chat they are in now.
let openGen = 0;

export async function openSession(id) {
  const gen = ++openGen;
  const known = sessions.value.find((s) => s.id === id);
  const prev = active.value?.id === id ? active.value : null;
  // Switching straight from another chat (BUG-093: «Новый чат» from the menu
  // inside a chat): that chat is left here — an untouched fresh one is
  // cleaned up exactly as on «Назад» (BUG-009).
  const left = active.value && active.value.id !== id ? active.value : null;
  // The chat becomes active IMMEDIATELY (loading=true): a message typed while
  // history loads goes to THIS chat, never into a void or the previous one.
  // loading=true separates «история ещё едет» from «чат действительно пустой»;
  // loadError=true after a failed fetch (deleted session → upstream 404).
  active.value = {
    id,
    title: known?.title ?? "",
    status: prev?.status === "busy" || busyMap.value[id] ? "busy" : "idle",
    lastEventAt: Date.now(),
    lastActivityAt: null,
    lastAction: null,
    // Held follow-ups (ISSUE-002) of a chat we come back to stay visible.
    messages: prev ? prev.messages.filter((m) => isTmp(m)) : (held.get(id) ?? []).map((j) => j.bubble),
    loading: true,
    loadError: false,
    turnError: null,
    incomplete: null,
  };
  leaveFresh(left);
  // Upstream /session/status is the only busy source after a page reload: the
  // optimistic status died with the old page, and the SSE status event for an
  // already-running turn never re-fires. Without this, a hung chat shows no
  // stop button and the only exit is an ops intervention.
  const statusP = api.getSessionStatus().then(
    (st) => {
      if (gen !== openGen) return;
      const busy = !!(st?.[id]?.type && st[id].type !== "idle");
      setBusyTracked(id, busy);
      patchActive(id, (a) => {
        if (busy) return a.status === "idle" ? { ...a, status: "busy" } : a;
        return a.status === "busy" && !hasSendInFlight(a) ? { ...a, status: "idle" } : a;
      });
    },
    () => {},
  );
  // BUG-01.19: a chat missing from the list is checked against a fresh list
  // first — a deleted chat / stale link shows «Чат не найден» without asking
  // its history (the 404 the browser logs as a raw console error). A failed
  // list cannot tell, so the history is asked as before.
  const historyP = known
    ? refreshMessages(id)
    : freshSessionList().then((listed) => {
        if (gen !== openGen) return undefined;
        if (!listed || sessions.value.some((s) => s.id === id)) return refreshMessages(id);
        patchActive(id, (a) => ({ ...a, loading: false, loadError: true, missing: true }));
        return undefined;
      });
  await Promise.all([statusP, historyP]);
  if (gen !== openGen) return;
  refreshStall();
}

// Chats this tab created via «Новый чат» and that have not been written to
// yet. Leaving such a chat empty deletes it (BUG-009): the instant-create
// flow (FEAT-03.1) otherwise left a «Без названия» row behind every time the
// user changed their mind. Only OUR fresh chats — never someone else's or an
// old empty chat opened from the list.
const freshIds = new Set();

// id = the chat being LEFT (ChatView cleanup). «Новый чат» from the menu
// inside a chat makes the new chat active before the old ChatView unmounts
// (BUG-093): closing «whatever is active» then deleted the brand-new chat.
// A chat that is no longer active was already left in openSession.
export function closeSession(id) {
  if (id != null && active.value?.id !== id) return;
  openGen++; // any in-flight openSession is now stale
  const act = active.value;
  active.value = null;
  leaveFresh(act);
}

function leaveFresh(act) {
  if (!act || !freshIds.has(act.id)) return;
  freshIds.delete(act.id);
  // A fresh chat closed while its (empty) history was still loading is just
  // as untouched (CC-25) — only a typed message or a running turn keeps it.
  const untouched = act.status === "idle" && (act.messages?.length ?? 0) === 0 && !busyMap.value[act.id];
  if (untouched) deleteSessionById(act.id, { quiet: true });
}

// The chat's binding drives every prompt (server enforces it too): the
// Settings defaults only seed NEW chats. agent/model args are a fallback for
// a chat nobody has bound yet (pre-binding server / CLI-created chat).
// sessionId (from ChatView) pins the target: a send aimed at a chat that is
// not the active one is refused instead of landing in another chat (BUG-01.35).
// hidden (FEAT-06.2): synthetic text parts that ride after the user's own
// parts — the voice-mode hint; both engines pass them to the model, the feed
// never shows them (MessageBubble / firstUserText / resend skip synthetic).
export async function send({ text = "", attachments = [], agent, model, sessionId, hidden = [] } = {}) {
  const parts = [
    { type: "text", text },
    // Attachments come in two flavors: uploaded binaries are already on disk
    // in .zai-uploads and ride as reference text; images stay inline data URLs.
    ...(attachments ?? []).map((a) =>
      a.ref ? { type: "text", text: a.ref } : { type: "file", mime: a.mime, filename: a.filename, url: a.url },
    ),
  ].filter((p) => p.type !== "text" || p.text);
  // FEAT-01.57: «Изменить» — the edited question replaces the last turn.
  const ed = editing.value;
  if (ed && ed.sid === (sessionId ?? active.value?.id)) {
    if (parts.length === 0 && !(ed.parts ?? []).length) return false;
    return sendEdited(ed, parts, { agent, model, sessionId });
  }
  if (parts.length === 0) return false;
  const extra = (Array.isArray(hidden) ? hidden : []).filter((p) => p?.type === "text" && p.synthetic === true && p.text);
  return sendParts([...parts, ...extra], { agent, model, sessionId });
}

// «Повторить» on a bubble that never reached the server (BUG-017): drop the
// failed optimistic entry and push the very same parts again — the user's
// text and attachments are not lost to a dropped connection.
export async function retryFailed(messageId) {
  const act = active.value;
  if (!act) return false;
  const failed = act.messages.find((m) => m.info?.id === messageId && m.info?.failed);
  if (!failed) return false;
  active.value = { ...act, messages: act.messages.filter((m) => m !== failed) };
  const parts = (failed.parts ?? [])
    .filter((p) => p?.type === "text" || p?.type === "file")
    .map((p) =>
      p.type === "text"
        ? { type: "text", text: p.text ?? "", ...(p.synthetic ? { synthetic: true } : {}) } // FEAT-06.2: the voice hint stays hidden
        : { type: "file", mime: p.mime, filename: p.filename, url: p.url },
    );
  return sendParts(parts, { sessionId: act.id });
}

// «Отправить снова» / «Повторить» from a banner: the last real user message,
// cleaned of the vault snapshot / directives, WITH its files (CC-19).
export async function resendLast(sessionId) {
  const act = active.value;
  if (!act || (sessionId && act.id !== sessionId)) return false;
  const lastUser = [...act.messages].reverse().find((m) => m.info?.role === "user" && !m.info?.failed);
  const parts = resendParts(lastUser);
  if (parts.length === 0) {
    setNotice(t("store.resend.empty"));
    return false;
  }
  return sendParts(parts, { sessionId: act.id });
}

// ---- FEAT-01.57 / FEAT-01.58: «Изменить», «Сгенерировать заново»,
// «Отменить ход» -------------------------------------------------------------
// Only the last turn, only while nothing runs (the server refuses otherwise:
// 409). revert hides the last question with everything after it (session
// `revert`, ChatView cuts the feed) and rolls the turn's files back; a new
// prompt commits it, «Вернуть» (unrevert) undoes it.

// The last real user message of the open chat (no tmp/failed bubble).
export function lastUserMessage(act = active.value) {
  return [...(act?.messages ?? [])].reverse().find((m) => m.info?.role === "user" && !isTmp(m)) ?? null;
}

// The chat may rewind now: idle, no send in flight, no hidden turn yet.
export function canRewind(sid) {
  const act = active.value;
  if (!act || act.id !== sid || act.status !== "idle" || hasSendInFlight(act) || heldCount(sid) > 0) return false;
  if (rewindBusy.value?.sid === sid) return false;
  return !sessions.value.find((s) => s.id === sid)?.revert?.messageID;
}

function setRevert(sid, revert) {
  sessions.value = upsertSession(sessions.value, { id: sid, revert: revert ?? null });
}

// Drop the hidden messages for good (the next prompt commits the revert —
// the server drops them too; message.removed may follow).
function commitRevertLocally(sid) {
  const rv = sessions.value.find((s) => s.id === sid)?.revert;
  if (!rv?.messageID) return;
  patchActive(sid, (a) => {
    const at = a.messages.findIndex((m) => m.info?.id === rv.messageID);
    return at < 0 ? a : { ...a, messages: [...a.messages.slice(0, at), ...a.messages.slice(at).filter((m) => isTmp(m))], turnError: null, incomplete: null };
  });
  setRevert(sid, null);
}

async function revertLast(sid, kind) {
  const last = lastUserMessage();
  if (!last) return null;
  rewindBusy.value = { sid, kind };
  try {
    const r = await api.revert(sid, last.info.id, { directory: sessionDir(sid) });
    setRevert(sid, r?.revert ?? { messageID: last.info.id });
    return { last, result: r };
  } catch (err) {
    setNotice(
      err?.status === 409
        ? t("store.turn.busyOrNotLast")
        : explainApiError(err, kind === "revert" ? t("store.turn.revertFailed") : kind === "regenerate" ? t("store.turn.regenerateFailed") : t("store.turn.editFailed")),
    );
    return null;
  } finally {
    rewindBusy.value = null;
  }
}

// «Изменить» (FEAT-01.57): the last question goes into the composer.
export function startEdit(sid) {
  if (!canRewind(sid)) return false;
  const last = lastUserMessage();
  if (!last) return false;
  const parts = resendParts(last);
  const text = parts.filter((p) => p.type === "text" && !p.text.startsWith("[Пользователь приложил файл:")).map((p) => p.text).join("\n");
  editing.value = { sid, messageID: last.info.id, text, parts: parts.filter((p) => p.type !== "text" || p.text.startsWith("[Пользователь приложил файл:")) };
  return true;
}

export function cancelEdit() {
  editing.value = null;
}

// The edited question is sent: revert to it, then the new text (+ its
// files and the composer's new ones) as the next turn.
async function sendEdited(ed, parts, opts) {
  const last = lastUserMessage();
  if (!last || last.info.id !== ed.messageID || !canRewind(ed.sid)) {
    setNotice(t("store.turn.editOnlyLast"));
    return false;
  }
  const r = await revertLast(ed.sid, "edit");
  if (!r) return false;
  editing.value = null;
  commitRevertLocally(ed.sid);
  return sendParts([...parts, ...(ed.parts ?? [])], opts);
}

// «Сгенерировать заново» (FEAT-01.57): the same question, a new answer.
export async function regenerate(sid) {
  if (!canRewind(sid)) return false;
  const last = lastUserMessage();
  const parts = resendParts(last);
  if (!last || parts.length === 0) return false;
  const r = await revertLast(sid, "regenerate");
  if (!r) return false;
  commitRevertLocally(sid);
  return sendParts(parts, { sessionId: sid });
}

// «Отменить ход» (FEAT-01.58): what will roll back, before the confirm.
export function undoPreview(sid) {
  const last = lastUserMessage();
  if (!last) return Promise.reject(Object.assign(new Error("no turn"), { status: 409 }));
  return api.revertPreview(sid, last.info.id, { directory: sessionDir(sid) });
}

export async function undoTurn(sid) {
  if (!canRewind(sid)) return null;
  const r = await revertLast(sid, "revert");
  return r?.result ?? null;
}

// «Вернуть»: the hidden turn and its files come back.
export async function redoTurn(sid) {
  rewindBusy.value = { sid, kind: "unrevert" };
  try {
    await api.unrevert(sid, { directory: sessionDir(sid) });
    setRevert(sid, null);
    return true;
  } catch (err) {
    setNotice(explainApiError(err, t("store.turn.restoreFailed")));
    return false;
  } finally {
    rewindBusy.value = null;
  }
}

// One-tap «Продолжить» (BUG-07.8 / interrupted Claude turn / cut-off answer).
export function continueTurn(sessionId) {
  return send({ text: t("store.turn.continuePrompt"), sessionId });
}

export function dismissTurnError(sessionId) {
  patchActive(sessionId ?? active.value?.id, (a) => ({ ...a, turnError: null, incomplete: null }));
}

let tmpSeq = 0;

// The human-typed text of outgoing parts (upload reference texts excluded).
function draftTextOf(parts) {
  return (parts ?? [])
    .filter((p) => p?.type === "text" && typeof p.text === "string" && !p.synthetic && !p.text.startsWith("[Пользователь приложил файл:"))
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function patchMessage(sessionID, msgId, fn) {
  patchActive(sessionID, (a) => ({ ...a, messages: a.messages.map((m) => (m.info?.id === msgId ? fn(m) : m)) }));
}

// ISSUE-002: opencode answers only the newest unanswered user message — a
// follow-up sent before the running turn produced its first assistant
// message was merged with the question before it (two questions, one
// answer). Such a follow-up is HELD in this tab (bubble «В очереди») and
// sent once the answer to the previous question has started or the turn has
// ended; one held prompt goes out at a time. The claude runner keeps its own
// server-side queue, so claude chats send at once as before.
// sid → [{ tmpId, bubble, parts, body, directory, session, bound, binding, queued, at }]
const held = new Map();
// sids whose released prompt POST is still in flight (no double release when
// session.status idle and session.idle arrive back to back).
const releasing = new Set();

export function heldCount(sid) {
  return held.get(sid)?.length ?? 0;
}

async function sendParts(parts, { agent, model, sessionId } = {}) {
  let act = active.value;
  if (!act || (sessionId && act.id !== sessionId)) {
    setNotice(t("store.send.notReady"));
    return false;
  }
  // FEAT-01.58: a new message after «Отменить ход» drops the hidden turn
  // for good (the server commits the revert with this prompt).
  if (sessions.value.find((s) => s.id === act.id)?.revert?.messageID) {
    commitRevertLocally(act.id);
    act = active.value;
  }
  const session = sessions.value.find((s) => s.id === act.id);
  const bound = bindingOf(session);
  // ISSUE-001/002: unbound chats fall back to the defaults this user may
  // really run (never a stored engine/agent the server would refuse).
  const defs = effectivePrefs();
  const binding = bound ?? defaultBinding({ model: model ?? defs.model, agent: agent ?? defs.agent });
  const queued = act.status === "busy" || act.status === "stopping";
  const hold =
    queued && binding?.engine !== "claude" && (heldCount(act.id) > 0 || releasing.has(act.id) || awaitingAnswer(act.messages));
  const tmpId = `tmp-${Date.now()}-${++tmpSeq}`;
  const bubble = makeMessage({ id: tmpId, role: "user", time: { created: Date.now() }, delivery: hold ? "held" : "sending", queued }, parts);
  active.value = {
    ...act,
    status: "busy",
    lastEventAt: Date.now(), // stall clock starts at send time
    turnError: null,
    incomplete: null,
    messages: [...act.messages, bubble],
  };
  setBusyTracked(act.id, true);
  const body = {
    ...(binding?.engine === "claude" ? {} : { agent: binding?.agent ?? agent ?? defs.agent ?? undefined }),
    ...(binding ? { model: { providerID: binding.model.providerID, modelID: binding.model.modelID } } : {}),
    parts,
  };
  const job = { sid: act.id, tmpId, bubble, parts, body, directory: sessionDir(act.id), session, bound, binding, queued, at: Date.now() };
  if (hold) {
    held.set(act.id, [...(held.get(act.id) ?? []), job]);
    return true;
  }
  return deliver(job);
}

// POST one prompt and walk its bubble sending → delivered | failed.
async function deliver({ sid, tmpId, parts, body, directory, session, bound, binding, queued }) {
  try {
    await api.prompt(sid, body, { directory });
  } catch (err) {
    // The prompt never reached the server: mark THIS bubble failed (it stays
    // for «Повторить»). The bubble itself says what happened via failReason
    // (R-12: no duplicate global notice over it).
    const server = Boolean(err?.status);
    // ISSUE-015: the failed bubble lives only in this tab — keep its text as
    // the chat's draft so a reload puts it back in the composer.
    const typed = draftTextOf(parts);
    if (typed && !loadDraft(sid).trim()) saveDraft(sid, typed);
    const others = (active.value?.id === sid ? active.value.messages : []).some(
      (m) => isTmp(m) && m.info.id !== tmpId && !m.info.failed,
    );
    if (!others && !queued) setBusyTracked(sid, false);
    patchActive(sid, (a) => ({
      ...a,
      status: others || queued ? a.status : "idle",
      messages: a.messages.map((m) =>
        m.info.id === tmpId ? { info: { ...m.info, failed: true, delivery: "failed", failReason: server ? "rejected" : "network" }, parts: m.parts } : m,
      ),
    }));
    return false;
  }
  patchMessage(sid, tmpId, (m) => ({ info: { ...m.info, delivery: "delivered" }, parts: m.parts }));
  // A retried text that was parked as the draft is delivered now.
  const sent = draftTextOf(parts);
  if (sent && loadDraft(sid) === sent) saveDraft(sid, "");
  // The first ACCEPTED message locks the engine (CC-23): pills switch to the
  // locked face only once the server took the prompt.
  if (session && binding && !bound?.prompted) {
    const cur = sessions.value.find((s) => s.id === sid);
    if (cur) sessions.value = upsertSession(sessions.value, { id: sid, zai: { ...(bindingOf(cur) ?? binding), prompted: true } });
  }
  return true;
}

// Send the next held prompt of a chat (ISSUE-002). Release points: an
// assistant message showed up (events: message.updated) — released only when
// the newest SENT question already has its answer started; the turn ended
// (idle: true — session.idle / status idle / session.error / lost idle).
export async function releaseHeld(sid, { idle = false } = {}) {
  const q = held.get(sid);
  if (!q?.length || releasing.has(sid)) return false;
  const act = active.value?.id === sid ? active.value : null;
  if (!idle && (!act || awaitingAnswer(act.messages))) return false;
  const [job, ...rest] = q;
  if (rest.length) held.set(sid, rest);
  else held.delete(sid);
  releasing.add(sid);
  // A release on idle starts a fresh turn on this prompt: not queued any more.
  const queued = idle ? false : job.queued;
  setBusyTracked(sid, true);
  patchActive(sid, (a) => ({
    ...a,
    status: a.status === "stopping" ? a.status : "busy",
    lastEventAt: Date.now(),
    messages: a.messages.map((m) => (m.info.id === job.tmpId ? { info: { ...m.info, delivery: "sending", queued }, parts: m.parts } : m)),
  }));
  try {
    return await deliver({ ...job, queued });
  } finally {
    releasing.delete(sid);
  }
}

// «Стоп» cancels the held follow-ups too (the claude runner drops its queue
// the same way): they turn into «Не отправлено — ход остановлен» bubbles with
// «Повторить», the text is never lost.
function cancelHeld(sid) {
  const q = held.get(sid);
  if (!q?.length) return;
  held.delete(sid);
  const ids = new Set(q.map((j) => j.tmpId));
  patchActive(sid, (a) => ({
    ...a,
    messages: a.messages.map((m) =>
      ids.has(m.info.id) ? { info: { ...m.info, failed: true, delivery: "failed", queued: false, failReason: "stopped" }, parts: m.parts } : m,
    ),
  }));
}

// Turn-end poll fallback for chats that are not open (their idle event may
// be lost): /status says idle and the prompt waited past the grace window.
function releaseIdleHeld(busy) {
  for (const [sid, q] of held) {
    if (busy[sid] || !q.length) continue;
    if (Date.now() - q[0].at > IDLE_GRACE_MS) releaseHeld(sid, { idle: true });
  }
}

export function stop() {
  const act = active.value;
  if (!act || act.status === "stopping") return;
  active.value = { ...act, status: "stopping" };
  cancelHeld(act.id);
  api.abort(act.id, { directory: sessionDir(act.id) })
    .then(() => {
      // Belt-and-braces when SSE is dead (otherwise session.idle finalizes):
      // drop the busy mark, leave "stopping", refetch the aborted state.
      setBusyTracked(act.id, false);
      patchActive(act.id, (a) => (a.status === "stopping" ? finalizeTurn(a) : a));
      refreshStall();
      refreshMessages(act.id);
      // A follow-up typed while «Останавливаю» waited for this turn end.
      releaseHeld(act.id, { idle: true });
    })
    .catch((err) => {
      // CC-07: never park in «stopping» (composer blocked forever). A 404 =
      // the session is gone server-side → idle; otherwise back to busy so
      // «Стоп» can be pressed again.
      if (err?.status === 404) {
        setBusyTracked(act.id, false);
        patchActive(act.id, (a) => (a.status === "stopping" ? finalizeTurn(a) : a));
      } else {
        patchActive(act.id, (a) => (a.status === "stopping" ? { ...a, status: "busy" } : a));
        setNotice(err?.status ? t("store.abort.rejected") : t("store.abort.offline"));
      }
      refreshStall();
    });
}

// Optimistic rename/delete with a rollback + notice on failure (ISSUE-005:
// both used to swallow errors — the list changed, a reload brought it back).
// Resolve true/false. onError (ISSUE-007): the caller shows the failure
// itself (the rename modal keeps the typed name and the error inside) —
// no global notice over the «Чаты» header then.
export async function renameSession(id, title, { onError } = {}) {
  const before = sessions.value.find((s) => s.id === id);
  const oldTitle = before?.title ?? "";
  sessions.value = upsertSession(sessions.value, { id, title });
  if (active.value?.id === id) active.value = { ...active.value, title };
  try {
    await api.patchSession(id, { title }, { directory: sessionDir(id) });
    return true;
  } catch (err) {
    // rollback writes the old title as is — upsertSession would refuse a default one (BUG-088 guard)
    if (before) sessions.value = sessions.value.map((s) => (s.id === id ? { ...s, title: oldTitle } : s));
    if (active.value?.id === id) active.value = { ...active.value, title: oldTitle };
    const text = explainApiError(err, t("store.chat.renameFailed"));
    if (typeof onError === "function") onError(text, err);
    else setNotice(text);
    return false;
  }
}

// quiet: the silent clean-up of an untouched fresh chat (no notice).
// FEAT-01.69 (П31.Н6): the OPEN chat stays open until the server confirmed
// the delete — a failed delete from the chat header leaves the chat on
// screen (it used to blank the feed: active was dropped up front).
// The chat leaves the fresh-chat set first: the leave-clean-up (BUG-009)
// must not send a second DELETE for it (Н8: one request).
export async function deleteSessionById(id, { quiet = false } = {}) {
  const directory = sessionDir(id);
  const idx = sessions.value.findIndex((s) => s.id === id);
  const removed = idx >= 0 ? sessions.value[idx] : null;
  freshIds.delete(id);
  sessions.value = sessions.value.filter((s) => s.id !== id);
  const gone = () => {
    if (active.value?.id === id) active.value = null;
    if (pins.value.includes(id)) pins.value = pins.value.filter((x) => x !== id); // the server dropped it too
  };
  try {
    await api.deleteSession(id, { directory });
    gone();
    return true;
  } catch (err) {
    // 404 = already gone server-side: the removal stands.
    if (err?.status === 404) {
      gone();
      return true;
    }
    if (removed && !sessions.value.some((s) => s.id === id)) {
      const next = sessions.value.slice();
      next.splice(Math.min(idx, next.length), 0, removed);
      sessions.value = next;
    }
    if (!quiet) setNotice(explainApiError(err, t("store.chat.deleteFailed")));
    return false;
  }
}

// FEAT-01.69 (П31.Н5): delete from the chat menu. A running turn is stopped
// first (no orphan turn on the server), then the chat goes. → true/false
// like deleteSessionById (a failure leaves the chat in place + a notice).
export async function deleteChat(id, { stopFirst = false } = {}) {
  if (stopFirst) {
    cancelHeld(id);
    try {
      await api.abort(id, { directory: sessionDir(id) });
    } catch {}
    setBusyTracked(id, false);
    if (active.value?.id === id && active.value.status !== "idle") patchActive(id, (a) => finalizeTurn(a));
  }
  return deleteSessionById(id);
}

// Change the open chat's own model/agent (ModelBar pills). Optimistic, with a
// rollback + notice when the server refuses (409 = engine locked because the
// chat already has messages; anything else = transient failure).
export async function setSessionBinding(id, patch) {
  const s = sessions.value.find((x) => x.id === id);
  if (!s) return false;
  const prev = s.zai;
  const cur = bindingOf(s) ?? defaultBinding(effectivePrefs());
  const model = patch?.model ?? cur?.model;
  const nextAgent = "agent" in (patch ?? {}) ? patch.agent : cur?.agent;
  // claudeAgent: the same agent when the chat is (or becomes) a Claude chat.
  const optimistic = defaultBinding({ model, agent: nextAgent, claudeAgent: nextAgent });
  if (optimistic) sessions.value = upsertSession(sessions.value, { id, zai: { ...optimistic, prompted: cur?.prompted ?? false } });
  try {
    const r = await api.patchBinding(id, patch, { directory: sessionDir(id) });
    if (r?.zai) sessions.value = upsertSession(sessions.value, { id, zai: r.zai });
    return true;
  } catch (err) {
    sessions.value = upsertSession(sessions.value, { id, zai: prev });
    setNotice(
      err?.status === 409
        ? t("store.binding.engineLocked")
        : patch && !("model" in patch) && "agent" in patch
          ? t("store.binding.agentFailed")
          : t("store.binding.modelFailed"),
    );
    return false;
  }
}

// directory scopes the new chat to a project folder (Claude-style Projects);
// no directory → the server pins HOME (same as before Projects existed).
// The chat is created instantly (FEAT-03.1) WITH an explicit binding from the
// Settings defaults (FEAT-11.4); the pills in the empty chat can change it.
export async function createAndOpen({ directory, binding } = {}) {
  const eff = effectivePrefs();
  const b = binding ?? defaultBinding(eff);
  // BUG-137: the saved default model is gone from the catalog — the chat is
  // made on the working default, and the user is told so (never silently).
  if (!binding && eff.staleModel) setNotice(staleModelText(eff), 10_000);
  // agent null = «server picks» (tenant default, ISSUE-001) / «Без агента»
  // for Claude (FEAT-13.17): omit it.
  const created = await api.createSession(directory, b ? { model: b.model, ...(!b.agent ? {} : { agent: b.agent }) } : {});
  // Defensive: if the response omitted directory, patch it in so the project
  // list shows the new chat before the next full refresh. Same for the
  // binding (a pre-binding server answers the bare upstream record).
  let session = directory && !created?.directory ? { ...created, directory } : created;
  if (b && session && !session.zai) session = { ...session, zai: { ...b, prompted: false } };
  sessions.value = upsertSession(sessions.value, session);
  if (session?.id) freshIds.add(session.id);
  await openSession(session.id);
  navigate(`#/chat/${session.id}`);
  return session;
}
