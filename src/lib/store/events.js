// SSE event reducer: live events → the open chat / sessions / dialogs.
import { applyDelta, extractDialog, keepTitle, makeMessage, upsertPart, upsertSession } from "../normalize.js";
import { actionOf, describeTurnError, isTmp, turnErrorFromMessages } from "../turn.js";
import {
  active,
  clearPending,
  dialogs,
  engineOfSession,
  patchActive,
  pins,
  sessions,
  setBusyTracked,
  noteIdle,
  setNotice,
} from "./state.js";
import { dropDialog, pushDialog } from "./dialogs.js";
import { isChildOfActive, patchChildFeed } from "./childfeeds.js";
import { chatGone } from "./pins.js";
import { finalizeTurn, refreshMessages, refreshStall, releaseHeld, touchActive } from "./session.js";
import { t } from "../i18n.js";

function textOf(parts) {
  return (parts ?? [])
    .filter((p) => p?.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
}

// message.updated carries info only. A real user message replaces the matching
// optimistic tmp- entry (text-prefix match; message.updated has no parts, so
// fall back to the oldest tmp user message — prompts are sequential). Failed
// bubbles never match: they never reached the server (CC-08).
// An assistant message answering a user message = the turn on it started
// (FEAT-01.29: «в очереди» → «принято»; ISSUE-003: also when the answer
// placeholder was materialized by a delta first).
function acceptParent(messages, props) {
  if (props.role !== "assistant" || !props.parentID) return messages;
  return messages.map((m) =>
    m.info.id === props.parentID && m.info.role === "user" && (m.info.delivery !== "accepted" || m.info.queued)
      ? { info: { ...m.info, delivery: "accepted", queued: false }, parts: m.parts }
      : m,
  );
}

// Where a NEW assistant message goes (ISSUE-003): right after its question
// and the answers already given to it — never below a later queued question
// (the Claude runner answers a queue one by one; appending glued answer 2
// under answer 1 above the still-queued bubble).
function answerSlot(messages, parentID) {
  if (!parentID) return messages.length;
  const at = messages.findIndex((m) => m.info.id === parentID);
  if (at < 0) return messages.length;
  let i = at + 1;
  while (i < messages.length && messages[i].info.role !== "user") i++;
  return i;
}

function upsertIncoming(messages, props) {
  if (!props?.id) return messages; // an info without id cannot be merged — ignore, never append
  const idx = messages.findIndex((m) => m.info.id === props.id);
  if (idx >= 0) {
    let next = messages.slice();
    next[idx] = { info: { ...next[idx].info, ...props }, parts: next[idx].parts };
    // A delta-materialized placeholder learns its parentID only now: move it
    // under its question if it landed elsewhere.
    if (props.role === "assistant" && props.parentID && !messages[idx].info.parentID) {
      const [moved] = next.splice(idx, 1);
      next.splice(answerSlot(next, props.parentID), 0, moved);
    }
    return acceptParent(next, props);
  }
  let tmpIdx = -1;
  if (props.role === "user") {
    const incoming = textOf(props.parts);
    const prefixMatch = (a, b) => a && b && (a.startsWith(b) || b.startsWith(a));
    tmpIdx = messages.findIndex(
      // Held bubbles (ISSUE-002) were never sent: no server twin can match them.
      (m) =>
        isTmp(m) && !m.info.failed && m.info.delivery !== "held" && m.info.role === "user" &&
        (incoming ? prefixMatch(textOf(m.parts), incoming) : true),
    );
  }
  if (tmpIdx >= 0) {
    const next = messages.slice();
    const tmp = next[tmpIdx].info;
    next[tmpIdx] = { info: { ...tmp, ...props, delivery: "delivered", queued: tmp.queued }, parts: next[tmpIdx].parts };
    return next;
  }
  const next = messages.slice();
  next.splice(props.role === "assistant" ? answerSlot(messages, props.parentID) : messages.length, 0, makeMessage(props, []));
  return acceptParent(next, props);
}

// Deltas/parts can arrive before message.updated: materialize a placeholder.
// BUG-164: one delayed history re-read per finished turn of the open chat.
export const HEAL_MS = 700;
const healTimers = new Map();
export function scheduleHeal(sid, { delay = HEAL_MS, refresh = refreshMessages } = {}) {
  if (typeof sid !== "string" || !sid) return;
  clearTimeout(healTimers.get(sid));
  const t = setTimeout(() => {
    healTimers.delete(sid);
    if (active.value?.id === sid) refresh(sid);
  }, delay);
  t?.unref?.();
  healTimers.set(sid, t);
}

function withPartMessage(messages, props, fn) {
  const mid = props.messageID ?? props.part?.messageID;
  const idx = messages.findIndex((m) => m.info.id === mid);
  if (idx >= 0) {
    const next = messages.slice();
    next[idx] = fn(next[idx]);
    return next;
  }
  if (!mid) return messages;
  return [...messages, fn(makeMessage({ id: mid, sessionID: props.sessionID, role: "assistant", time: { created: Date.now() } }))];
}

// Liveness-only frames (BUG-13.3): `zai.keepalive` (claude runner) proves the
// process is alive but NOT that it produced anything — it must not reset the
// stall clock, or a hung CLI looks alive forever.
function isKeepalive(evt) {
  // A title update (portal auto-title) is bookkeeping, not turn progress.
  return evt?.type === "zai.keepalive" || evt?.type === "zai.session.title" || evt?.type === "zai.notice" || evt?.properties?.keepalive === true;
}

// Entry wrapper: every event refreshes the active session's stall clock
// (deltas, tool part transitions, permission asks — any traffic proves the
// turn is alive), then re-evaluates the stalled banner.
export function handleEvent(evt) {
  const sid = evt?.properties?.sessionID;
  if (typeof sid === "string" && !isKeepalive(evt)) {
    touchActive(sid, evt.type !== "session.status");
  }
  reduce(evt);
  refreshStall();
}

// Чистое применение события к массиву сообщений ленты субагента (FEAT-01.77):
// тот же набор правил, что у открытого чата, но без побочных эффектов стора
// (turnError, held, pending и т.п. — у ленты их нет).
export function applyFeedEvent(messages, evt) {
  const type = evt?.type;
  const p = evt?.properties ?? {};
  switch (type) {
    case "message.updated": {
      const info = p.info ?? p;
      return upsertIncoming(messages, info);
    }
    case "message.part.updated":
      return withPartMessage(messages, p, (m) => upsertPart(m, p.part));
    case "message.part.delta":
      return withPartMessage(messages, p, (m) => applyDelta(m, { partID: p.partID, field: p.field, delta: p.delta }));
    case "message.part.removed":
      return messages.map((m) => (m.info.id === p.messageID ? { info: m.info, parts: m.parts.filter((x) => x.id !== p.partID) } : m));
    default:
      return messages;
  }
}

function reduce(evt) {
  const type = evt?.type;
  if (typeof type !== "string") return;
  if (type.startsWith("permission") || type.startsWith("question")) {
    if (type.endsWith(".asked")) pushDialog(extractDialog(evt));
    else dropDialog(evt); // .updated/.replied: answered elsewhere or withdrawn
    return;
  }
  const p = evt.properties ?? {};
  // FEAT-01.77: события четырёх типов для дочерних сессий открытого чата
  // маршрутятся в их ленты (карточки агентов) и активный чат не трогают.
  if (
    (type === "message.updated" || type === "message.part.updated" || type === "message.part.delta" || type === "message.part.removed") &&
    active.value
  ) {
    const sid = type === "message.updated" ? p.sessionID ?? (p.info ?? p).sessionID : p.sessionID;
    if (sid && isChildOfActive(sid)) {
      patchChildFeed(sid, (messages) => applyFeedEvent(messages, evt));
      return;
    }
  }
  switch (type) {
    case "session.updated":
    case "session.created": {
      const info = p.info ?? p;
      // A portal-side activity bump of a Claude chat (BUG-13.16) is partial
      // ({id, directory, time.updated}): it only moves a KNOWN chat up and
      // never adds a title-less stub to the list.
      if (typeof info?.title !== "string" && !sessions.value.some((s) => s.id === info?.id)) return;
      sessions.value = upsertSession(sessions.value, info);
      // The header follows a new title live (BUG-01.27 / BUG-083).
      if (typeof info?.title === "string") patchActive(info.id, (act) => (keepTitle(act.title, info.title) === act.title ? act : { ...act, title: info.title }));
      return;
    }
    case "zai.session.title": {
      // Portal-side auto-title (Claude chats, a title retold from the vault
      // snapshot replaced): {sessionID, title}. Only a KNOWN chat is patched —
      // a bare {id, title} record must not enter the list without its folder.
      const id = p.sessionID ?? p.info?.id;
      const title = p.title ?? p.info?.title;
      if (typeof id !== "string" || typeof title !== "string") return;
      if (sessions.value.some((s) => s.id === id)) {
        sessions.value = sessions.value.map((s) => (s.id === id ? { ...s, title } : s));
      }
      patchActive(id, (act) => ({ ...act, title }));
      return;
    }
    case "zai.notice": {
      // Portal-side notice about a chat (FEAT-13.17: «Агент «Workflow» больше
      // недоступен — ответ без агента.»): shown while that chat is open.
      if (typeof p.text !== "string" || !p.text) return;
      if (p.sessionID && active.value?.id !== p.sessionID) return;
      setNotice(p.text, 10_000);
      return;
    }
    case "session.deleted": {
      const id = p.sessionID ?? p.info?.id;
      // FEAT-01.69 П31.Н2: the OPEN chat deleted elsewhere (its row is still
      // listed — our own delete drops the row before the request) → words +
      // «Чаты», not an endless loading skeleton.
      if (id && active.value?.id === id && sessions.value.some((s) => s.id === id)) {
        setBusyTracked(id, false);
        chatGone(id);
        active.value = null;
        return;
      }
      if (id && pins.value.includes(id)) pins.value = pins.value.filter((x) => x !== id);
      sessions.value = sessions.value.filter((s) => s.id !== id);
      setBusyTracked(id, false);
      if (active.value?.id === id) active.value = null;
      return;
    }
    case "session.status": {
      // Live 1.19.5 shape: status is an OBJECT {type:"busy"|"idle"|"retry"} —
      // the old `p.status === "idle"` string compare never matched, so idle
      // events kept the chat "busy" forever and only session.idle saved it.
      const st = typeof p.status === "string" ? p.status : p.status?.type;
      if (!st) return;
      if (st === "idle") noteIdle(p.sessionID);
      setBusyTracked(p.sessionID, st !== "idle");
      patchActive(p.sessionID, (act) => ({ ...act, status: st === "idle" ? "idle" : act.status === "stopping" ? "stopping" : "busy" }));
      // The turn ended: a held follow-up (ISSUE-002) starts the next one.
      if (st === "idle") releaseHeld(p.sessionID, { idle: true });
      return;
    }
    case "session.idle": {
      noteIdle(p.sessionID);
      setBusyTracked(p.sessionID, false);
      const before = active.value?.id === p.sessionID ? active.value : null;
      patchActive(p.sessionID, (act) => {
        const done = finalizeTurn(act);
        const err = act.turnError ?? turnErrorFromMessages(done.messages, { engine: engineOfSession(act.id) });
        return { ...done, turnError: err };
      });
      // A delivered tmp that never got its real twin (queued prompt, lost
      // message.updated) was just dropped: pull the real history.
      if (before && before.messages.some((m) => isTmp(m) && m.info.delivery === "delivered")) refreshMessages(p.sessionID);
      // BUG-164: the turn of the OPEN chat ended — re-read its history once,
      // a moment later (after the final parts landed). Any live frame the
      // feed missed (dead stream, reload or resync mid-turn) is healed by
      // the stored answer instead of waiting for a manual page reload.
      else if (before) scheduleHeal(p.sessionID);
      // A finished session cannot have live permission/question requests.
      dialogs.value = dialogs.value.filter((d) => d.sessionID !== p.sessionID);
      releaseHeld(p.sessionID, { idle: true });
      return;
    }
    case "session.error": {
      const err = describeTurnError(p.error ?? { name: "UnknownError" }, { engine: engineOfSession(p.sessionID) });
      // No sessionID = a global upstream error: it must NOT finalize the open
      // chat (CC-24) — the user only gets a notice.
      if (!p.sessionID) {
        if (err) setNotice(`${err.title}${err.detail ? ` — ${err.detail}` : ""}`, 10_000);
        return;
      }
      noteIdle(p.sessionID);
      setBusyTracked(p.sessionID, false);
      patchActive(p.sessionID, (act) => ({ ...finalizeTurn(act), turnError: err ?? act.turnError ?? null }));
      releaseHeld(p.sessionID, { idle: true });
      return;
    }
    case "zai.turn.incomplete":
      // BUG-07.8 (hub): the turn ended with open todos — offer «Продолжить».
      patchActive(p.sessionID, (act) => ({
        ...act,
        incomplete: { reason: p.reason ?? "open-todos", todosOpen: p.todosOpen ?? null, todosTotal: p.todosTotal ?? null },
      }));
      return;
    case "zai.loop":
      // BUG-07.7 (hub): the loop detector aborted the turn.
      patchActive(p.sessionID, (act) => ({
        ...act,
        turnError: {
          kind: "loop",
          title: t("store.loop.title"),
          text: t("store.loop.text", { tool: p.tool ? ` (${p.tool})` : "", count: p.count ?? t("store.loop.many") }),
          detail: null,
          actions: ["retry"],
        },
      }));
      return;
    case "zai.keepalive":
      // Claude liveness: lastAction / lastOutputAt from the runner.
      patchActive(p.sessionID, (act) => ({
        ...act,
        lastAction: p.lastAction ? { label: actionOf({ type: "tool", tool: p.lastAction }), at: p.lastOutputAt ?? act.lastAction?.at ?? null } : act.lastAction,
        lastActivityAt: typeof p.lastOutputAt === "number" ? p.lastOutputAt : act.lastActivityAt,
      }));
      return;
    case "message.updated": {
      // opencode 1.19.5 nests the message under properties.info (live-captured
      // 2026-10-31: {sessionID, info:{id, role, ...}}). Passing the raw
      // properties made every lookup miss (props.id undefined), appended a
      // role-less garbage message and stranded the optimistic user bubble —
      // the first part.updated then materialized the user text as a fresh
      // role:"assistant" message, injecting the raw vault-cache snapshot into
      // the chat. Tolerate the older flat shape via ?? p.
      const info = p.info ?? p;
      const sid = p.sessionID ?? info.sessionID;
      patchActive(sid, (act) => {
        const next = { ...act, messages: upsertIncoming(act.messages, info) };
        if (info.role === "assistant" && info.error) {
          const err = describeTurnError(info.error, { engine: engineOfSession(sid) });
          if (err) next.turnError = err;
        }
        // Claude runner: an interrupted turn (idle timeout, restart) = «не
        // закончил» face with «Продолжить»; a user «Стоп» is not.
        const intr = info.zai?.interrupted;
        if (info.role === "assistant" && intr && intr !== "user" && intr !== "deleted") next.incomplete = { reason: intr };
        return next;
      });
      // The answer arrived: the «ход завис» banner must go now, not on the
      // next 10 s poll (CC-21).
      if (info.role === "assistant" && info.time?.completed != null) clearPending(sid);
      // The answer to the newest sent question has started: the next held
      // follow-up (ISSUE-002) may go now — opencode queues it behind this turn.
      if (info.role === "assistant") releaseHeld(sid);
      return;
    }
    case "message.removed":
      patchActive(p.sessionID, (act) => ({ ...act, messages: act.messages.filter((m) => m.info.id !== p.messageID) }));
      return;
    case "message.part.updated": {
      const label = actionOf(p.part);
      patchActive(p.sessionID, (act) => ({
        ...act,
        messages: withPartMessage(act.messages, p, (m) => upsertPart(m, p.part)),
        lastAction: label && act.status !== "idle" ? { label, at: Date.now() } : act.lastAction,
      }));
      return;
    }
    case "message.part.delta": {
      const label = p.field === "text" ? t("store.activity.writing") : t("store.activity.thinking");
      patchActive(p.sessionID, (act) => ({
        ...act,
        messages: withPartMessage(act.messages, p, (m) => applyDelta(m, { partID: p.partID, field: p.field, delta: p.delta })),
        lastAction: act.status !== "idle" && act.lastAction?.label !== label ? { label, at: Date.now() } : act.lastAction,
      }));
      return;
    }
    case "message.part.removed":
      patchActive(p.sessionID, (act) => ({
        ...act,
        messages: act.messages.map((m) =>
          m.info.id === p.messageID ? { info: m.info, parts: m.parts.filter((x) => x.id !== p.partID) } : m,
        ),
      }));
      return;
    default:
      return; // server.connected/heartbeat/session.diff and future types: no store effect
  }
}
