// BUG-218 (BUG-12.27, design §1): per-chat lock — a promise chain keyed by the
// chat id. Three writers (PATCH binding, the `prompted` mark of a turn start,
// the claudeAgentGone reset) plus the revert used to read-modify-write the
// binding store between awaits and lose each other's updates; now every such
// section runs inside withSessionLock(id, fn).
//
// Contract: fns of one id run in call order; a rejected fn surfaces to ITS
// caller only and never poisons the queue; the map entry is dropped when the
// queue drains (no leak on long-lived chats). The same module carries the
// «revert in progress» flag the prompt start checks (409 revert in progress).
//
// Rule (design §1 risk): never call withSessionLock from code already running
// under it — the sections are short, they do not await the engine.
const queues = new Map(); // id → tail of the chain (settles when the fn does)
const reverting = new Set(); // id → a revert of this chat is under way

export function withSessionLock(id, fn) {
  const prev = queues.get(id) ?? Promise.resolve();
  // the chain itself never rejects: a failure belongs to the caller alone
  const result = prev.then(
    () => {},
    () => {},
  ).then(fn);
  const tail = result.then(
    () => {},
    () => {},
  );
  queues.set(id, tail);
  // BUG-218: the entry dies with the queue — only while someone waits does it stay
  tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return result;
}

// Only for tests: the map must be empty when no section is under way.
export function lockQueueSize() {
  return queues.size;
}

// «Идёт откат» — флаг между блокировками: откат ставит его под локом и снимает
// в finally, старт хода отвечает 409, не начиная побочных эффектов.
export function markReverting(id) {
  reverting.add(id);
}

export function clearReverting(id) {
  reverting.delete(id);
}

export function isReverting(id) {
  return reverting.has(id);
}
