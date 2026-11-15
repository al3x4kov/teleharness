// FEAT-18.6: автоматический Relay при лимите (опция пользователя, по умолчанию выключена —
// Ручная кнопка «Продолжить в …» остаётся поведением
// по умолчанию). Ход упал по лимиту подписки → сервер (а не клиент: телефон может быть
// закрыт) передаёт чат первой доступной пользователю запасной модели, отличной от
// текущей, тем же путём, что ручной relay, и просит новый движок продолжить.
// Не чаще одного раза на ход: если и запасная упала по лимиту в том же цикле —
// остановиться, клиент покажет обычную плашку.
// Здесь: чистая проверка настройки, выбор модели и оркестратор с внедряемыми
// зависимостями (server.js даёт владельца чата, доступность модели, relay и ход).
// Zero deps.

export const AUTO_RELAY_ORDER_MAX = 3;
export const AUTO_RELAY_OFF = Object.freeze({ on: false, order: Object.freeze([]) });
const ID_RE = /^[A-Za-z0-9._:@/+-]{1,128}$/;

const bad = (message) => Object.assign(new Error(message), { status: 400 });

function cleanEntry(x) {
  if (!x || typeof x !== "object") return null;
  const providerID = typeof x.providerID === "string" ? x.providerID.trim() : "";
  const modelID = typeof x.modelID === "string" ? x.modelID.trim() : "";
  if (!ID_RE.test(providerID) || !ID_RE.test(modelID)) return null;
  return { providerID, modelID };
}

// Тело PUT → {on, order}; плохая форма → ошибка со status 400. Повторы схлопываются.
export function cleanAutoRelay(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("нужен объект {on, order}");
  if (typeof body.on !== "boolean") throw bad("on: нужно true или false");
  const raw = body.order ?? [];
  if (!Array.isArray(raw)) throw bad("order: нужен массив моделей");
  if (raw.length > AUTO_RELAY_ORDER_MAX) throw bad(`order: не больше ${AUTO_RELAY_ORDER_MAX} моделей`);
  const order = [];
  for (const x of raw) {
    const m = cleanEntry(x);
    if (!m) throw bad("order: модель — {providerID, modelID}");
    if (!order.some((o) => o.providerID === m.providerID && o.modelID === m.modelID)) order.push(m);
  }
  return { on: body.on, order };
}

// Сохранённое значение (users.json) → {on, order}; мусор → выключено.
export function readAutoRelay(stored) {
  try {
    return stored ? cleanAutoRelay(stored) : { on: false, order: [] };
  } catch {
    return { on: false, order: [] };
  }
}

const same = (a, b) => a?.providerID === b?.providerID && a?.modelID === b?.modelID;

// Первая модель порядка, отличная от текущей и доступная пользователю (сейчас, не при
// сохранении: права могли измениться). available — async (model) => boolean.
export async function pickAutoRelayModel(order, current, available) {
  for (const m of Array.isArray(order) ? order : []) {
    if (same(m, current)) continue;
    let ok = false;
    try {
      ok = await available(m);
    } catch {
      ok = false;
    }
    if (ok) return { providerID: m.providerID, modelID: m.modelID };
  }
  return null;
}

// Оркестратор. deps:
//   ownerOf(sid, dir)        → пользователь, чья настройка действует (или null)
//   settingOf(user)          → {on, order}
//   bindingOf(sid)           → текущая привязка чата ({engine, model} | null)
//   available(user, model)   → async boolean
//   relay({sid, dir, user, model})  → async {ok, status?, error?} — тот же путь, что ручной
//   resume({sid, dir, user}) → async {ok, status?} — ход «продолжи с места остановки»
//   log(msg)
// Защита от цикла: после авто-передачи чат «взведён» до следующего хода пользователя
// (userTurn(sid)); лимит во взведённом чате — без новой передачи.
export function createAutoRelay(deps) {
  const armed = new Map(); // sid → время авто-передачи
  const inflight = new Set();
  const log = typeof deps.log === "function" ? deps.log : () => {};

  async function onLimit({ sid, dir = null } = {}) {
    if (!sid) return { done: false, why: "no-session" };
    if (armed.has(sid)) {
      log(`[teleharness-autorelay] ${sid}: лимит и после авто-передачи — второй раз не передаём`);
      return { done: false, why: "cycle" };
    }
    if (inflight.has(sid)) return { done: false, why: "inflight" };
    inflight.add(sid);
    try {
      const user = await deps.ownerOf(sid, dir);
      if (!user) return { done: false, why: "no-owner" };
      const setting = readAutoRelay(await deps.settingOf(user));
      if (!setting.on) return { done: false, why: "off" };
      const current = await deps.bindingOf(sid);
      if (!current?.model) return { done: false, why: "no-binding" };
      const model = await pickAutoRelayModel(setting.order, current.model, (m) => deps.available(user, m));
      if (!model) {
        log(`[teleharness-autorelay] ${sid}: нет доступной запасной модели — остаётся плашка`);
        return { done: false, why: "no-target" };
      }
      const r = await deps.relay({ sid, dir, user, model });
      if (!r?.ok) {
        log(`[teleharness-autorelay] ${sid}: передача не удалась (${r?.status ?? "?"} ${r?.error ?? ""})`);
        return { done: false, why: "relay-failed", status: r?.status ?? null };
      }
      armed.set(sid, Date.now());
      const g = await deps.resume({ sid, dir, user });
      if (!g?.ok) log(`[teleharness-autorelay] ${sid}: ход «продолжи» не принят (${g?.status ?? "?"} ${g?.error ?? ""})`);
      log(`[teleharness-autorelay] ${sid}: передан ${current.model.modelID} → ${model.modelID} (настройка ${user.id ?? "?"})`);
      return { done: true, model, resumed: Boolean(g?.ok) };
    } catch (err) {
      log(`[teleharness-autorelay] ${sid}: ошибка ${err?.message ?? err}`);
      return { done: false, why: "error" };
    } finally {
      inflight.delete(sid);
    }
  }

  return {
    onLimit,
    // Ход, начатый пользователем (не авто-«продолжи»), открывает новый цикл.
    userTurn(sid) {
      armed.delete(sid);
    },
    forget(sid) {
      armed.delete(sid);
      inflight.delete(sid);
    },
    isArmed: (sid) => armed.has(sid),
  };
}
