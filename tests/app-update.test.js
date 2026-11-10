// BUG-179 (BUG-08.11): выкат фронта без рестарта не доходил до приложения на
// телефоне, развёрнутого из фона (запись владельца 2026-11-06 07:53 — телефон
// работал на 1.14.5 через полчаса после выката 1.14.6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUpdater } from "../src/lib/app-update.js";

function rig({ etags, typing = false }) {
  const st = { t: 0, reloads: 0, typing, calls: 0 };
  const seq = [...etags];
  const u = createUpdater({
    fetchHead: async () => {
      st.calls++;
      const v = seq.length > 1 ? seq.shift() : seq[0];
      if (v instanceof Error) throw v;
      return v;
    },
    reload: () => st.reloads++,
    isTyping: () => st.typing,
    now: () => st.t,
  });
  return { u, st };
}

test("BUG-179: новая сборка (ETag app.js сменился) → при возврате в приложение перезагрузка", async () => {
  const { u, st } = rig({ etags: ['"a"', '"b"'] });
  await u.init();
  st.t = 60_000;
  assert.equal(await u.onVisible(), true);
  assert.equal(st.reloads, 1);
});

test("BUG-179: та же сборка — без перезагрузки; проверка не чаще раза в 30 с", async () => {
  const { u, st } = rig({ etags: ['"a"'] });
  await u.init();
  st.t = 60_000;
  assert.equal(await u.onVisible(), false);
  st.t = 70_000;
  await u.onVisible();
  assert.equal(st.calls, 2, "второй возврат через 10 с — без запроса");
  assert.equal(st.reloads, 0);
});

test("BUG-179: печатает (фокус в поле) — не перезагружаем, перезагрузим при следующем возврате", async () => {
  const { u, st } = rig({ etags: ['"a"', '"b"'], typing: true });
  await u.init();
  st.t = 60_000;
  assert.equal(await u.onVisible(), false);
  assert.equal(st.reloads, 0);
  st.typing = false;
  st.t = 100_000;
  assert.equal(await u.onVisible(), true);
  assert.equal(st.reloads, 1);
});

test("BUG-179: ошибка сети — ничего не ломает; нет исходного ETag — первый ответ становится исходным", async () => {
  const { u, st } = rig({ etags: [new Error("offline"), '"a"', '"a"'] });
  await u.init();
  st.t = 60_000;
  assert.equal(await u.onVisible(), false, "исходного не было — запоминаем, не перезагружаем");
  st.t = 120_000;
  assert.equal(await u.onVisible(), false);
  const r2 = rig({ etags: ['"a"', new Error("offline")] });
  await r2.u.init();
  r2.st.t = 60_000;
  assert.equal(await r2.u.onVisible(), false);
  assert.equal(st.reloads + r2.st.reloads, 0);
});
