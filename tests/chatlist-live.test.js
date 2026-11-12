// BUG-223 (BUG-01.76): открытый список «Чаты» узнаёт о чате, созданном или переименованном
// в другой вкладке / через API. Причина: opencode 2.x шлёт session.created / session.renamed
// с data.sessionID без data.id — адаптер отдавал session.updated, где info без id, и клиент
// (upsertSession) такое событие молча выбрасывал.
// Run: node --test tests/chatlist-live.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createV2Rewriter } from "../lib/oc-client.js";
import * as store from "../src/lib/store.js";

const FX = JSON.parse(readFileSync(new URL("./fixtures/v2-subagent-sync.json", import.meta.url), "utf8"));
const raw = FX.events.filter((e) => e.type === "session.created" || e.type === "session.renamed");

function rewritten() {
  const got = [];
  const rewrite = createV2Rewriter({ emit: (e) => got.push(e), throttleMs: 0 });
  for (const e of raw) {
    const out = rewrite(e);
    for (const o of Array.isArray(out) ? out : [out]) if (o) got.push(o);
  }
  return got.filter((e) => e.type === "session.updated");
}

test("BUG-223: запись живого потока 2.2.6 — session.created/renamed приходят без data.id", () => {
  assert.ok(raw.length >= 2);
  assert.ok(raw.every((e) => e.data.sessionID && e.data.id === undefined), "форма движка: только sessionID");
});

test("BUG-223: адаптер отдаёт session.updated с info.id, папкой и временем обновления", () => {
  const ups = rewritten();
  assert.ok(ups.length >= 2);
  for (const u of ups) {
    assert.equal(typeof u.properties.info.id, "string");
    assert.equal(u.properties.info.id, u.properties.info.sessionID);
    assert.ok(u.properties.info.directory, "папка — чтобы строка списка открывалась");
    assert.ok(Number(u.properties.info.time?.updated) > 0, "время — чтобы строка встала наверх списка");
  }
  // переименование дочерней сессии: parentID берётся из её session.created
  const rw = createV2Rewriter({ emit: () => {}, throttleMs: 0 });
  rw({ type: "session.created", created: 5, data: { sessionID: "ses_kid", parentID: "ses_par" } });
  assert.equal(rw({ type: "session.renamed", created: 6, data: { sessionID: "ses_kid", title: "t" } }).properties.info.parentID, "ses_par");
  const ren = ups.find((u) => u.properties.info.id === raw[0].data.sessionID && typeof u.properties.info.title === "string");
  assert.equal(ren.properties.info.title, raw.find((e) => e.type === "session.renamed").data.title);
});

test("BUG-223: открытый список получает новый чат и новое имя из этих событий", () => {
  store.sessions.value = [{ id: "ses_old", title: "Старый", directory: "D:\\x", time: { updated: 1 } }];
  try {
    const ups = rewritten();
    for (const u of ups) store.handleEvent(u);
    const id = raw[0].data.sessionID;
    const row = store.sessions.value.find((s) => s.id === id);
    assert.ok(row, "чат, созданный вне этой вкладки, появился в списке");
    assert.equal(row.title, raw.find((e) => e.type === "session.renamed" && e.data.sessionID === id).data.title);
    const top = store.sessions.value.filter((s) => s.parentID == null);
    assert.equal(top[0].id, id, "свежий чат — первым среди обычных чатов");
    assert.ok(store.sessions.value.filter((s) => s.id !== id && s.id !== "ses_old").every((s) => s.parentID), "дочерние сессии субагентов несут parentID — список их скрывает");
    // переименование известного чата
    store.handleEvent({ type: "session.updated", properties: { info: { id, sessionID: id, title: "Новое имя", time: { updated: Date.now() } } } });
    assert.equal(store.sessions.value.find((s) => s.id === id).title, "Новое имя");
  } finally {
    store.sessions.value = [];
  }
});
