// BUG-11.13 / BUG-082 (and the «пустой ответ» half of BUG-02.5 / BUG-057):
// a turn that completes with an assistant message holding no content and no
// error used to leave the chat silent. The hub turns that into a turn error
// (live: a synthetic session.error event; history: info.error on the tail
// answer), so the client shows its regular error card with «Повторить».
//
// Pure, zero dependencies.

export const EMPTY_TURN_ERROR = Object.freeze({
  name: "EmptyTurnError",
  data: Object.freeze({ message: "Модель завершила ход без ответа и без ошибки (пустой ответ). Повторите запрос или смените модель." }),
});

// Parts that carry something for the human. Step markers / snapshots do not.
const CONTENT_TYPES = new Set(["text", "reasoning", "tool", "file", "patch", "agent", "subtask"]);

export function isContentPart(part) {
  if (!part || typeof part !== "object" || !CONTENT_TYPES.has(part.type)) return false;
  if (part.type === "text" || part.type === "reasoning") return typeof part.text === "string" && part.text.trim().length > 0;
  return true;
}

// A finished assistant message with no content and no error.
export function isEmptyAnswer(entry) {
  const info = entry?.info ?? entry;
  if (info?.role !== "assistant" || info.error) return false;
  if (info.time?.completed == null) return false;
  const parts = Array.isArray(entry?.parts) ? entry.parts : [];
  return !parts.some(isContentPart);
}

// History face: the TAIL answer of a list ([{info, parts}], oldest first)
// gets EMPTY_TURN_ERROR as info.error when it is empty — the client derives
// the turn error from the tail (turnErrorFromMessages). Earlier messages are
// left alone (intermediate steps of a multi-step turn may be content-free).
// Never mutates the input.
export function markEmptyTail(list) {
  if (!Array.isArray(list) || list.length === 0) return list;
  const tail = list[list.length - 1];
  if (!isEmptyAnswer(tail)) return list;
  // Only when the whole turn (assistant messages after the last user one)
  // produced nothing: a tool step followed by an empty closing message is a
  // normal answer.
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m?.info?.role === "user") break;
    if (m?.info?.role === "assistant" && (Array.isArray(m.parts) ? m.parts : []).some(isContentPart)) return list;
  }
  const out = list.slice();
  out[out.length - 1] = { ...tail, info: { ...tail.info, error: { ...EMPTY_TURN_ERROR, data: { ...EMPTY_TURN_ERROR.data } } } };
  return out;
}
