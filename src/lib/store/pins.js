// FEAT-01.69: pinned chats. The list lives in the user's account on the
// server (GET/PUT /zai/api/me/pins) — every device of the same user sees it,
// another user never does. The server keeps only chats the user sees in
// their own list (a foreign / unknown id → 404), so the client never has to
// guess ownership. Pinning is optimistic with a visible rollback (П31.Н1);
// one change at a time (Н8: a double tap sends one request).
import { signal } from "@preact/signals";
import { api, explainApiError } from "../api.js";
import { active, pins, sessions, setNotice } from "./state.js";
import { displayTitle } from "../normalize.js";
import { t } from "../i18n.js";

// id of the chat whose pin/unpin is in flight (the menu item shows «…»).
export const pinBusy = signal(null);

let navigate = () => {};
export function setPinsNavigate(fn) {
  if (typeof fn === "function") navigate = fn;
}

const cleanIds = (list) => (Array.isArray(list) ? [...new Set(list.filter((x) => typeof x === "string" && x))] : []);

// A pin/unpin made while the GET was in flight wins (the GET answer is older).
let changes = 0;

export async function refreshPins() {
  const at = changes;
  try {
    const r = await api.getPins();
    if (at !== changes || pinBusy.value) return true;
    pins.value = cleanIds(r?.ids);
    return true;
  } catch {
    return false; // keep the last known list; the next load retries
  }
}

export const isPinned = (id) => pins.value.includes(id);

// The chat is gone on the server (deleted on another device, П31.Н2): the
// row and the pin go, the user is told in words, an open chat leaves to
// «Чаты» without a history entry back into it.
export function chatGone(id) {
  const s = sessions.value.find((x) => x.id === id);
  const title = displayTitle(s?.title ?? "");
  sessions.value = sessions.value.filter((x) => x.id !== id);
  if (pins.value.includes(id)) pins.value = pins.value.filter((x) => x !== id);
  setNotice(title && title !== t("common.untitled") ? t("store.pins.goneNamed", { title }) : t("store.pins.gone"), 10_000);
  if (active.value?.id === id) navigate("/", { replace: true });
}

// Pin / unpin. → true on success. A failure rolls the pin back and says so
// with «Повторить» (E1); a 404 on PINNING = the chat is gone (Н2).
export async function togglePin(id) {
  if (!id || pinBusy.value) return false;
  const before = pins.value;
  const pinning = !before.includes(id);
  const next = pinning ? [...before, id] : before.filter((x) => x !== id);
  pins.value = next;
  pinBusy.value = id;
  changes++;
  try {
    const r = await api.setPins(next);
    pins.value = cleanIds(r?.ids ?? next);
    return true;
  } catch (err) {
    pins.value = before;
    if (pinning && err?.status === 404) {
      chatGone(id);
      return false;
    }
    const what = pinning ? t("store.pins.pinFailed") : t("store.pins.unpinFailed");
    setNotice(explainApiError(err, what), 10_000, { label: t("common.retry"), run: () => togglePin(id) });
    return false;
  } finally {
    pinBusy.value = null;
  }
}

// Pinned chats first (pin order), the rest after — for the list screens.
// Only chats present in `list` (a pin of a chat the list does not show is
// never drawn: no «ghosts», Н3).
export function splitPinned(list, ids = pins.value) {
  const byId = new Map((list ?? []).map((s) => [s.id, s]));
  const pinned = ids.map((id) => byId.get(id)).filter(Boolean);
  const set = new Set(pinned.map((s) => s.id));
  return { pinned, rest: (list ?? []).filter((s) => !set.has(s.id)) };
}

// Н14: many pins fold after PINNED_FOLD with «Ещё N».
export const PINNED_FOLD = 5;
