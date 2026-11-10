// FEAT-03.19: the feed with «Детализация выполнения» OFF.
// The owner (2026-11-04): until the answer is formed — a preloader; once the
// turn is over — only the full answer, no reasoning / tools / «Шаг N» /
// intermediate text, in history too.
//
// compactFeed(messages, {busy}) → { messages, preloader }
// - user messages pass through untouched;
// - a turn that is still running (busy and not closed, see buildTurns) is
//   hidden entirely — the preloader stands in for it;
// - a closed (or abandoned, when idle) turn becomes ONE message: id/info of
//   its last step (so the turn foot, copy, rewind actions keep working), the
//   error of its last failed step, every non-text part of every step (tool
//   parts still feed the file cards; MessageBubble does not draw them in
//   compact mode) and the text parts of the step that holds the final answer
//   (the last step with a non-empty text).
// - preloader: the session is busy (a turn is being formed).
import { buildTurns } from "./normalize.js";

const hasText = (m) =>
  (m?.parts ?? []).some((p) => p?.type === "text" && !p.synthetic && String(p.text ?? "").trim() !== "");

export function mergeTurn(steps) {
  let answer = -1;
  for (let k = steps.length - 1; k >= 0 && answer < 0; k--) if (hasText(steps[k])) answer = k;
  let error = null;
  for (const s of steps) if (s?.info?.error) error = s.info.error;
  const last = steps[steps.length - 1];
  const parts = [];
  steps.forEach((s, k) => {
    for (const p of s?.parts ?? []) if (p?.type !== "text" || k === answer) parts.push(p);
  });
  const info = { ...(last?.info ?? {}) };
  if (error) info.error = error;
  return { info, parts, compact: true };
}

export function compactFeed(messages, { busy = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const turns = buildTurns(list, { busy });
  const out = [];
  let i = 0;
  while (i < list.length) {
    const m = list[i];
    if (m?.info?.role !== "assistant") {
      out.push(m);
      i += 1;
      continue;
    }
    const steps = [];
    while (i < list.length && list[i]?.info?.role === "assistant") steps.push(list[i++]);
    const turn = turns.get(steps[0]?.info?.id);
    if (busy && !turn?.closed) continue; // being formed: the preloader shows instead
    out.push(mergeTurn(steps));
  }
  return { messages: out, preloader: Boolean(busy) };
}

// ---- Постепенный вывод готового ответа (уточнение владельца 2026-11-04 ~23:00) ----
// «когда ответ готов, то нужно убрать прелоадер и постепенно выводить ответ как
// он сейчас выводится в режиме без прелоадера»: a turn that completed in front
// of the user is revealed from the start like a live stream instead of landing
// whole (the feed used to jump to the END of a long answer). ~250 chars/s,
// 0.6–4 s per answer, one tick per frame-ish (33 ms).
export const REVEAL = Object.freeze({ cps: 250, minMs: 600, maxMs: 4000, tickMs: 33 });

export function revealPlan(total, o = REVEAL) {
  const n = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  if (n === 0) return { durationMs: 0, ticks: 0, step: 0 };
  const durationMs = Math.min(o.maxMs, Math.max(o.minMs, Math.round((n / o.cps) * 1000)));
  const ticks = Math.max(1, Math.round(durationMs / o.tickMs));
  return { durationMs, ticks, step: Math.ceil(n / ticks) };
}

// texts: the answer's text parts in order; shown: how many chars are out.
// Returns the visible prefix of each part (later parts stay "" until reached).
export function revealSlices(texts, shown) {
  let left = Math.max(0, shown);
  return texts.map((t) => {
    const s = String(t ?? "");
    const out = s.slice(0, left);
    left = Math.max(0, left - s.length);
    return out;
  });
}

// The answer to reveal when a turn has just finished: the last item of the
// compact feed, if it is a merged answer with text.
export function revealTarget(compactMessages) {
  const last = Array.isArray(compactMessages) ? compactMessages[compactMessages.length - 1] : null;
  if (!last?.compact || last.info?.role !== "assistant") return null;
  const hasAnswer = (last.parts ?? []).some((p) => p?.type === "text" && String(p.text ?? "").trim() !== "");
  return hasAnswer ? last.info.id ?? null : null;
}
