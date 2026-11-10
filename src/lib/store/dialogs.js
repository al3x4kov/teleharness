// Permission/question dialogs: REST seed, optimistic replies with retry
// policy, and the in-flight / just-answered guards (BUG-07.13).
import { api } from "../api.js";
import { normalizeDialogRecords } from "../normalize.js";
import { dialogs, sessionDir, setNotice } from "./state.js";
import { t } from "../i18n.js";

// Dialog ids whose reply is in flight or was just accepted: the merge-only
// seed must not resurrect them (a lagging upstream listing re-added the card
// and parked it in «Отправлено» with no buttons — BUG-07.13).
const replying = new Set();
const answered = new Map(); // id → ms of the successful reply
const ANSWERED_TTL_MS = 60_000;

export function recentlyAnswered(id) {
  const at = answered.get(id);
  if (at == null) return false;
  if (Date.now() - at > ANSWERED_TTL_MS) {
    answered.delete(id);
    return false;
  }
  return true;
}

// Seed open permission/question requests from the server (upstream listings +
// hub snapshot). SSE only delivers .asked to pages that were connected at the
// moment of asking — without this REST seed, a dialog that fired before the
// page loaded never renders and its session parks invisibly. Merge-only: live
// entries are never dropped here; .replied events and session.idle handle
// removal. Replies in flight / just answered are skipped.
export async function seedDialogs() {
  try {
    const shaped = normalizeDialogRecords(await api.getDialogs());
    if (shaped.length === 0) return;
    const have = new Set(dialogs.value.map((d) => d.id));
    const add = shaped.filter((d) => !have.has(d.id) && !replying.has(d.id) && !recentlyAnswered(d.id));
    if (add.length > 0) dialogs.value = [...dialogs.value, ...add];
  } catch {}
}

export function pushDialog(dialog) {
  if (!dialog?.id || recentlyAnswered(dialog.id)) return;
  dialogs.value = [...dialogs.value.filter((d) => d.id !== dialog.id), dialog];
}

// permission/question .updated/.replied: the request was answered elsewhere
// or withdrawn — drop its dialog. Tolerant parse: the id may ride on
// properties.id or properties.requestID; no id → no-op.
export function dropDialog(evt) {
  const p = evt?.properties ?? {};
  const gone = new Set([p.id, p.requestID].filter((x) => typeof x === "string"));
  if (gone.size === 0) return;
  dialogs.value = dialogs.value.filter((d) => !gone.has(d.id));
}

// Optimistic reply: the dialog leaves the queue immediately. Outcome split
// (2026-11-01, «Не удалось отправить ответ» на каждый тап):
//   • network failure (no err.status) → one transparent retry, then return
//     the dialog with error:true and a bumped attempt counter (the card
//     re-arms on EVERY failure, not only the first — CC-10);
//   • 404/409/410 on the retry after a transport failure → the first POST
//     DID land (the answer took longer than the deadline) → success (CC-18);
//   • 5xx → re-arm (transient server trouble);
//   • other 4xx → retrying the same payload can NEVER succeed: drop the
//     dialog for good and surface a notice instead of an eternal card.
const REPLY_TIMEOUT_MS = 10_000;

// AbortSignal.timeout is missing on older Safari; a missing signal just means
// the retry path (not the timeout hint) still covers a dead connection.
function replySignal() {
  try {
    return typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(REPLY_TIMEOUT_MS) : undefined;
  } catch {
    return undefined;
  }
}


// answer: permission → "once"|"always"|"reject"; question → string (single
// question, single label) or string[][] (one label array PER question).
export async function replyDialog(dialog, answer) {
  if (!dialog?.id) return;
  dialogs.value = dialogs.value.filter((d) => d.id !== dialog.id);
  replying.add(dialog.id);
  // The reply must reach the upstream instance that owns the request:
  // directory-scoped like every session call (a directory-less reply 404s
  // after an opencode restart — live 2026-11-01).
  const directory = dialog.sessionID ? sessionDir(dialog.sessionID) : null;
  const answers = Array.isArray(answer) ? answer.map((a) => (Array.isArray(a) ? a : [a])) : [[answer]];
  const post = () =>
    dialog.kind === "question"
      ? api.replyQuestion(dialog.id, { answers }, { directory, signal: replySignal() })
      : api.replyPermission(dialog.id, { reply: answer }, { directory, signal: replySignal() });
  const rearm = (reason) => {
    dialogs.value = [
      ...dialogs.value.filter((d) => d.id !== dialog.id),
      { ...dialog, error: true, errorReason: reason, attempt: (dialog.attempt ?? 0) + 1 },
    ];
  };
  const ok = () => answered.set(dialog.id, Date.now());
  try {
    await post();
    ok();
  } catch (err) {
    if (err?.status >= 500) return rearm(t("store.dialog.serverError"));
    if (err?.status) {
      setNotice(t("store.dialog.stale"));
      return;
    }
    // No status = transport-level (dropout/timeout). One transparent retry:
    // the answer payload is idempotent-until-answered upstream.
    try {
      await post();
      ok();
    } catch (err2) {
      if ([404, 409, 410].includes(err2?.status)) {
        ok(); // the first attempt landed after all
        return;
      }
      if (err2?.status >= 500) return rearm(t("store.dialog.serverError"));
      if (err2?.status) {
        setNotice(t("store.dialog.stale"));
        return;
      }
      rearm(err2?.name === "TimeoutError" || err?.name === "TimeoutError" ? t("store.dialog.timeout") : t("store.dialog.offline"));
    }
  } finally {
    replying.delete(dialog.id);
  }
}
