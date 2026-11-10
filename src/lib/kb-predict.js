// BUG-177 (device trace 2026-11-05, iPhone 17 Pro Max, iOS 18.7, «На экран Домой»):
// in the standalone web app Safari does NOT move the visual viewport — offsetTop
// and scrollY stay 0 — but it reports the new height LATE: on focus the keyboard
// is already sliding up for ~130 ms while visualViewport.height is still the full
// one (iOS meanwhile scrolls the page to reveal the field → the header jumps); on
// blur the height stays short for ~150 ms while the keyboard slides away (the
// composer hangs mid-screen over an empty strip). So we PREDICT: on focus — the
// keyboard-up height learned last time; on blur — the full height; the prediction
// holds until Safari reports a different height (or `until` passes).
export const KB_KEY = "zai.kbH";

// One layout decision. → { h, kb } — the shell height and the «keyboard up» flag.
//   vvH, innerH — current visualViewport.height / innerHeight; tall — tallest seen;
//   typing — a text field is focused; pred — { kind: "open"|"close", h, base, until } | null.
export function shellFrame({ vvH, innerH, tall, typing, pred = null, now = 0 }) {
  if (pred && now < pred.until && Math.abs(vvH - pred.base) < 2) {
    return { h: pred.h, kb: pred.kind === "open" };
  }
  const h = typing ? Math.min(vvH, innerH || vvH) : vvH;
  return { h, kb: typing && h < tall - 80 };
}

// The prediction for a focus change, or null when there is nothing to predict
// (no learned keyboard height yet; the keyboard is already in the wanted state).
export function predictFor(kind, { vvH, tall, kbH, now, ms = 700 }) {
  if (kind === "open") {
    if (!(kbH > 80) || vvH < tall - 80) return null; // unknown height / already up
    return { kind, h: Math.round(tall - kbH), base: vvH, until: now + ms };
  }
  if (vvH >= tall - 2) return null; // already full height
  return { kind, h: tall, base: vvH, until: now + ms };
}

// Learn the keyboard height from a real «keyboard up» frame.
export function learnKbH(tall, h) {
  const k = Math.round(tall - h);
  return k > 80 && k < tall * 0.8 ? k : null;
}

// BUG-177, записи 1.14.4–1.14.5 (2026-11-06): мгновенный прыжок шелла на фокусе
// обгонял клавиатуру (поле ввода улетало вверх, под ним пусто ~0,2 с) и iOS
// отвечал коротким сдвигом экрана на 214 px. Теперь предсказанная высота
// доезжает плавно — за время выезда клавиатуры (класс .kb-move на <html>).
export const KB_MOVE_MS = 300;
