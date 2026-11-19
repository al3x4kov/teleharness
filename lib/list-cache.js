// BUG-260 / TASK-261: склейка одинаковых одновременных чтений списка у движка и
// запасной «последний удачный» ответ на время его кратковременного сбоя
// (рестарт opencode — ~10–60 с). Значения не копируются: вызывающий не должен
// мутировать результат (список чатов дальше только map/filter).
export function createListCache({ staleMs = 120_000, now = Date.now } = {}) {
  const inflight = new Map(); // key → { gen, p }
  const last = new Map(); // key → { at, value }
  let gen = 0;

  async function get(key, load) {
    const cur = inflight.get(key);
    let p = cur && cur.gen === gen ? cur.p : null;
    if (!p) {
      const rec = { gen, p: null };
      p = rec.p = (async () => {
        try {
          const value = await load();
          const prev = last.get(key);
          if (!prev || prev.gen <= rec.gen) last.set(key, { at: now(), value, gen: rec.gen }); // поход до изменения не затирает более свежий
          return value;
        } finally {
          if (inflight.get(key) === rec) inflight.delete(key);
        }
      })();
      inflight.set(key, rec);
    }
    try {
      return { value: await p, stale: false };
    } catch (err) {
      const l = last.get(key);
      if (l && now() - l.at <= staleMs) return { value: l.value, stale: true };
      throw err;
    }
  }

  // Изменение (создание/удаление/переименование чата…): запросы после него не
  // присоединяются к походу, начатому раньше, — иначе новый чат не виден.
  function bump() {
    gen++;
  }

  return { get, bump };
}
