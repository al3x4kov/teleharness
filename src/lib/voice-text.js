// FEAT-06.2 voice mode — text side (pure, Node-importable).
//  - the hidden voice hint part and the «голосом» / «озвучено» marks;
//  - the answer text of the turn the mode is waiting for;
//  - cleanForSpeech: markdown → what is worth saying aloud (code, tables,
//    links and markup never reach the TTS — «Код — в чате.» instead);
//  - createSentenceSegmenter: a growing (streamed) answer → newly completed
//    sentences, so the first one is spoken before the turn ends.

// Every voice message carries ONE synthetic text part starting with this
// mark: it tells the model about the mode and marks the message for the
// feed («голосом»). Synthetic parts are never shown as the user's words
// (MessageBubble / firstUserText / auto-title / resend skip them).
export const VOICE_MARK = "[Голосовой режим]";
export const VOICE_HINT =
  `${VOICE_MARK} Отвечай на языке пользователя (по умолчанию по-русски), коротко и разговорно, 1–4 предложения, без markdown, таблиц и кода, если пользователь сам не просит.`;

// shortAnswers off (Настройки) → the bare mark: still a voice message, no
// instruction for the model.
export function voiceHintPart(shortAnswers = true) {
  return { type: "text", text: shortAnswers ? VOICE_HINT : VOICE_MARK, synthetic: true };
}

export function isVoicePart(p) {
  return p?.type === "text" && p.synthetic === true && String(p.text ?? "").startsWith(VOICE_MARK);
}

export function isVoiceMessage(m) {
  return m?.info?.role === "user" && (m.parts ?? []).some(isVoicePart);
}

// «озвучено»: the assistant message `id` answers a voice message (the user
// message right above its turn carries the mark). Derived from the feed —
// nothing is stored on the server.
export function isSpokenAnswer(messages, id) {
  const list = Array.isArray(messages) ? messages : [];
  let i = list.findIndex((m) => m?.info?.id === id);
  if (i < 0 || list[i]?.info?.role !== "assistant") return false;
  while (i >= 0 && list[i]?.info?.role === "assistant") i -= 1;
  return i >= 0 && isVoiceMessage(list[i]);
}

// The answer to the prompt the mode sent: text parts (not reasoning, not
// tools, not synthetic) of the assistant messages that were not in the feed
// at send time (`known` = their ids), in feed order.
export function answerText(messages, known) {
  const out = [];
  for (const m of messages ?? []) {
    if (m?.info?.role !== "assistant" || known?.has?.(m.info.id)) continue;
    for (const p of m.parts ?? []) {
      if (p?.type === "text" && !p.synthetic && typeof p.text === "string" && p.text.trim()) out.push(p.text);
    }
  }
  return out.join("\n\n");
}

// GigaAM gives lower-case text without punctuation: «привет как дела» →
// «Привет как дела».
export function capitalize(s) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t ? t[0].toLocaleUpperCase("ru") + t.slice(1) : "";
}

const CODE_SAY = "\nКод — в чате.\n";
const TABLE_SAY = "\nТаблица — в чате.\n";

// Markdown → speakable plain text. final=false (the answer is still
// streaming): an unclosed ``` fence hides everything after it, so a code
// block is never read out half-way; the prefix before it stays stable.
export function cleanForSpeech(src, { final = false } = {}) {
  let s = String(src ?? "").replace(/\r\n?/g, "\n");
  s = s.replace(/```[\s\S]*?```/g, CODE_SAY);
  const open = s.indexOf("```");
  if (open >= 0) s = s.slice(0, open) + (final ? CODE_SAY : "");
  // A run of table rows (| a | b |) — one placeholder.
  s = s.replace(/(?:^[ \t]*\|.*(?:\n|$))+/gm, TABLE_SAY);
  s = s
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
    .replace(/^[ \t]*(?:[-*+•]|\d{1,3}[.)])[ \t]+/gm, "")
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, "")
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1")
    .replace(/<\/?[a-z][^>\n]*>/gi, "")
    // BUG-167: «ссылка https://…», «по ссылке: https://…» — the word is already
    // there, only «в чате» replaces the address (no «ссылка ссылка»).
    .replace(/(ссылк[а-яё]*)\s*[:—–-]?\s*https?:\/\/\S+/giu, "$1 в чате")
    .replace(/https?:\/\/\S+/g, "ссылка в чате")
    .replace(/`/g, "")
    .replace(/\*\*|__|~~|\*/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/[ \t]+/g, " ");
  return s;
}

const ENDS = ".!?…";
const CLOSERS = "»\"')]”";
// Words after which a dot never ends a sentence, even before a capital
// («см. Рис. 3», «т. Е.» is covered by the lower-case rule below).
// FEAT-06.3: + «г. Москва», «д. 5», «кв.», «корп.», «пр.» — the server
// normalizer reads them out, a split there would break the phrase.
const ABBR = new Set(["т", "напр", "см", "рис", "стр", "ул", "им", "проф", "акад", "тел", "илл", "ср", "г", "д", "кв", "корп", "пр", "e.g", "i.e", "mr", "dr"]);

function abbrevBefore(text, start, i) {
  const m = /([\p{L}]+)$/u.exec(text.slice(start, i));
  if (!m) return false;
  const w = m[1];
  if (w.length === 1 && w !== w.toLowerCase()) return true; // initial: «А. С. Пушкин»
  return ABBR.has(w.toLowerCase());
}

const speakable = (s) => /[\p{L}\p{N}]/u.test(s);

// push(fullText) → sentences completed since the last call; flush(fullText)
// → the rest (turn end). The segmenter works on cleanForSpeech(fullText) and
// remembers how far it has emitted, so a growing text is split exactly once.
// Rules: . ! ? … (with closing quotes) followed by whitespace end a sentence;
// a newline ends one too (paragraphs, list items). Not an end: a dot inside a
// token (3.75, sales.xlsx, т.е.), a dot (or …) before a lower-case word
// («т. е. мы», «в 10 ч. утра»), initials and a few abbreviations. A long run
// without an end is cut at a comma/colon/dash (else a space) near maxLen —
// the TTS takes ≤ 600 chars and a short first chunk starts the voice sooner.
// The FIRST chunk of an answer is kept ≤ firstMax chars: a longer first
// sentence is cut at its first clause separator (≥ firstMin chars in) — Piper
// needs ~2.8 s for a 100-char sentence on a GPU-less mini PC, ~1 s for 45 chars, and
// the voice must start ≤ ~2 s after the first sentence (FEAT-06.2 п.4).
// BUG-166: 90 → 60 chars — on prod an 85-char first sentence took 2.3 s.
const FIRST_SEPS = [", ", "; ", ": ", " — "];
function clauseCut(s, min, max) {
  let best = -1;
  for (const sep of FIRST_SEPS) {
    const at = s.indexOf(sep, min);
    const end = at + sep.length - 1;
    if (at >= 0 && end <= max && (best < 0 || end < best)) best = end;
  }
  return best;
}

export function createSentenceSegmenter({ maxLen = 280, firstMax = 60, firstMin = 20 } = {}) {
  let pos = 0;
  let emitted = 0;

  function scan(clean, final) {
    const out = [];
    if (pos > clean.length) pos = clean.length;
    let start = pos;
    const push = (a, b) => {
      const t = clean.slice(a, b).replace(/\s+/g, " ").trim();
      if (speakable(t)) {
        out.push(t);
        emitted += 1;
      }
    };
    const emit = (a, b) => {
      if (emitted === 0 && b - a > firstMax) {
        const c = clauseCut(clean.slice(a, b), firstMin, firstMax);
        if (c > 0) {
          push(a, a + c);
          push(a + c, b);
          return;
        }
      }
      push(a, b);
    };
    let i = pos;
    for (; i < clean.length; i += 1) {
      const c = clean[i];
      if (c === "\n") {
        emit(start, i);
        start = i + 1;
        continue;
      }
      if (!ENDS.includes(c)) continue;
      let j = i;
      while (j + 1 < clean.length && ENDS.includes(clean[j + 1])) j += 1;
      let k = j;
      while (k + 1 < clean.length && CLOSERS.includes(clean[k + 1])) k += 1;
      if (k + 1 >= clean.length) {
        if (!final) break; // the next char decides — wait for it
        i = k;
        continue; // end of text: the remainder below takes it
      }
      if (!/\s/.test(clean[k + 1])) {
        i = k;
        continue;
      }
      const dotsOnly = /^[.…]+$/.test(clean.slice(i, j + 1));
      if (c === "." && j === i && abbrevBefore(clean, start, i)) {
        i = k;
        continue;
      }
      let m = k + 1;
      while (m < clean.length && clean[m] === " ") m += 1;
      if (m >= clean.length && !final) break; // next word not here yet
      if (dotsOnly && m < clean.length && /[a-zа-яё]/.test(clean[m])) {
        i = k;
        continue;
      }
      emit(start, k + 1);
      start = k + 1;
      i = k;
    }
    if (final) {
      emit(start, clean.length);
      start = clean.length;
    } else {
      // A long first sentence still streaming: its first clause goes now.
      if (emitted === 0 && clean.length - start > firstMax) {
        const c = clauseCut(clean.slice(start), firstMin, firstMax);
        if (c > 0) {
          push(start, start + c);
          start += c;
        }
      }
      // Long run without an end: cut it.
      while (clean.length - start > maxLen) {
        const win = clean.slice(start, start + maxLen);
        let cut = -1;
        for (const sep of [", ", "; ", ": ", " — ", " - "]) {
          const at = win.lastIndexOf(sep);
          if (at >= 0) cut = Math.max(cut, at + sep.length - 1);
        }
        if (cut < Math.min(60, maxLen / 3)) cut = win.lastIndexOf(" ");
        if (cut < 1) cut = maxLen;
        emit(start, start + cut);
        start += cut;
      }
    }
    pos = start;
    return out;
  }

  return {
    push(text) {
      return scan(cleanForSpeech(text), false);
    },
    flush(text) {
      const out = scan(cleanForSpeech(text, { final: true }), true);
      pos = 0;
      emitted = 0;
      return out;
    },
    reset() {
      pos = 0;
      emitted = 0;
    },
  };
}
