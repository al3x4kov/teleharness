// BUG-177: device keyboard trace (src/lib/kb-trace.js) — frames + events, capped, numbers only.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadUI } from "./helpers/load.mjs";

let ui;
before(async () => {
  ui = await loadUI({ startKbTrace: "src/lib/kb-trace.js#startKbTrace", resetKbTrace: "src/lib/kb-trace.js#resetKbTrace", MAX_TRACES: "src/lib/kb-trace.js#MAX_TRACES" });
});

test("BUG-177: startKbTrace — кадры с числами вьюпорта и раскладки, события Safari, отправка; не больше MAX_TRACES", async () => {
  const L = {};
  const vv = { height: 956, offsetTop: 0, pageTop: 0, addEventListener: (t, f) => ((L[t] ??= []).push(f)), removeEventListener: (t, f) => (L[t] = (L[t] ?? []).filter((x) => x !== f)) };
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => vv });
  document.body.innerHTML = '<div class="shell"><header class="chat-header"></header><div class="composer"><textarea>секрет</textarea></div></div>';
  ui.resetKbTrace();
  const sent = [];
  const p = ui.startKbTrace("focus", { ms: 60, send: (x) => sent.push(x) });
  vv.height = 620; vv.offsetTop = 180;
  for (const f of L.resize ?? []) f(new Event("resize"));
  const payload = await p;
  assert.equal(sent.length, 1);
  assert.equal(payload.kind, "focus");
  assert.ok(payload.frames.length >= 1);
  const f = payload.frames.at(-1);
  for (const k of ["t", "vvH", "vvTop", "sy", "shell", "head", "comp"]) assert.ok(k in f, k);
  assert.equal(f.vvH, 620);
  assert.deepEqual(payload.events[0].slice(0, 1), ["vv.resize"]);
  assert.ok(!JSON.stringify(payload).includes("секрет"), "текст пользователя не попадает в запись");
  for (let i = 1; i < ui.MAX_TRACES; i++) await ui.startKbTrace("blur", { ms: 10, send: () => {} });
  assert.equal(await ui.startKbTrace("blur", { ms: 10, send: () => {} }), null, "лимит записей за страницу");
});
