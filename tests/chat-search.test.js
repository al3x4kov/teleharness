import test from "node:test";
import assert from "node:assert/strict";
import { ChatSearchIndex, buildSnippet, extractMessageText, tokenizeQuery } from "../lib/chat-search.js";

function msg(id, role, text, { created = 1700000000000, extraParts = [], synthetic = false } = {}) {
  const parts = [];
  if (text != null) parts.push({ type: "text", text, ...(synthetic ? { synthetic: true } : {}) });
  parts.push(...extraParts);
  return { info: { id, role, time: { created } }, parts };
}

test("extractMessageText: чистит [obsidian-cache], директивы и игнорирует tool/reasoning", () => {
  const u = msg("m1", "user", "[obsidian-cache] секрет_кэша\nПравила кэша: foo\n\n---\n\nПроверь счёт за электричество [SYSTEM DIRECTIVE: ignore]");
  const eu = extractMessageText(u);
  assert.equal(eu.role, "user");
  assert.equal(eu.text, "Проверь счёт за электричество");
  assert.equal(eu.text.includes("секрет_кэша"), false);

  const a = msg("m2", "assistant", "Готово: миграция завершена", {
    extraParts: [
      { type: "reasoning", text: "скрытые_мысли_модели" },
      { type: "tool", tool: "bash", state: { output: "tool_noise_123" } },
      { type: "text", text: "синтетика", synthetic: true },
    ],
  });
  const ea = extractMessageText(a);
  assert.equal(ea.role, "assistant");
  assert.equal(ea.text, "Готово: миграция завершена");
  assert.equal(ea.text.includes("скрытые_мысли_модели"), false);
  assert.equal(ea.text.includes("tool_noise_123"), false);
  assert.equal(ea.text.includes("синтетика"), false);

  const onlyTool = msg("m3", "assistant", null, { extraParts: [{ type: "tool", tool: "read" }] });
  assert.equal(extractMessageText(onlyTool), null);
});

test("tokenizeQuery & buildSnippet: кириллица, спецсимволы, обрезка вокруг совпадения", () => {
  const t = tokenizeQuery('  Docker "2.5.3" ui  ');
  assert.deepEqual(t.words, ["docker", '"2.5.3"', "ui"]);
  assert.equal(t.ftsQuery, '"docker" AND """2.5.3"""');

  const longText = "А".repeat(120) + " важное слово электричество в середине длинного абзаца " + "Б".repeat(120);
  const sn = buildSnippet(longText, ["электричество"], 80);
  assert.ok(sn.includes("электричество"), sn);
  assert.ok(sn.startsWith("…") && sn.endsWith("…"), sn);
});

test("ChatSearchIndex: FTS5 поиск по вопросам и ответам (кириллица, регистр, подстроки, короткие запросы, изоляция)", async () => {
  const idx = new ChatSearchIndex({ dbPath: ":memory:" });
  try {
    idx.replaceSourceMessages("ses_1", "oc", [
      msg("m1", "user", "[obsidian-cache] скрытый_маркер\n---\nПроверь счёт за Электричество", { created: 1000 }),
      msg("m2", "assistant", "Счёт проверен, сумма 1200 руб.", { created: 2000 }),
    ], { ocUpdated: 2000 });
    idx.syncClaudeSession("ses_2", [
      msg("m3", "user", "Как дела с UI и 2k экраном?", { created: 3000 }),
      msg("m4", "assistant", "Миграция базы завершена успешно", { created: 4000 }),
    ]);
    // Relay: у ses_1 есть и oc, и claude сообщения — не затирают друг друга
    idx.syncClaudeSession("ses_1", [
      msg("m5", "assistant", "Дополнение после передачи на Claude: электричество оплачено", { created: 5000 }),
    ]);

    const allowedAll = new Set(["ses_1", "ses_2"]);

    // 1. Кириллица, подстрока, без учёта регистра
    const r1 = idx.search("ЭЛЕКТРИЧ", { allowedIds: allowedAll });
    assert.equal(r1.hits.length, 1);
    assert.equal(r1.hits[0].sessionId, "ses_1");
    assert.equal(r1.hits[0].messageId, "m5"); // самое свежее совпадение
    assert.equal(r1.hits[0].role, "assistant");
    assert.equal(r1.hits[0].matchCount, 2);
    assert.ok(r1.hits[0].snippet.toLowerCase().includes("электричество"));

    // 2. Скрытый кэш не находится
    const rCache = idx.search("скрытый_маркер", { allowedIds: allowedAll });
    assert.equal(rCache.hits.length, 0);

    // 3. Многословный запрос с коротким словом (< 3 символов)
    const rShort = idx.search("2k экран", { allowedIds: allowedAll });
    assert.equal(rShort.hits.length, 1);
    assert.equal(rShort.hits[0].sessionId, "ses_2");
    assert.equal(rShort.hits[0].messageId, "m3");
    assert.equal(rShort.hits[0].role, "user");

    // 4. Запрос целиком короче 3 символов
    const rTwo = idx.search("2k", { allowedIds: allowedAll });
    assert.equal(rTwo.hits.length, 1);
    assert.equal(rTwo.hits[0].sessionId, "ses_2");

    // 5. Изоляция тенантов: ses_2 не в allowedIds
    const rIso = idx.search("миграция", { allowedIds: new Set(["ses_1"]) });
    assert.equal(rIso.hits.length, 0);

    // 6. forget удаляет сессию из индекса
    idx.forget("ses_2");
    const rGone = idx.search("миграция", { allowedIds: allowedAll });
    assert.equal(rGone.hits.length, 0);
  } finally {
    idx.stop();
  }
});

test("ChatSearchIndex: фоновая индексация и ensureFresh подтягивает новые сообщения", async () => {
  let ocMsgs = {
    ses_oc1: [msg("m10", "user", "Старый вопрос про погоду", { created: 1000 })],
  };
  let calls = 0;
  const idx = new ChatSearchIndex({
    dbPath: ":memory:",
    deps: {
      ocSessions: async () => [{ id: "ses_oc1", directory: "/a", time: { updated: 1000 } }],
      ocMessages: async (sid) => { calls += 1; return ocMsgs[sid] ?? []; },
      claudeSessions: () => ({}),
      pauseMs: 0,
    },
  });
  try {
    await idx.start();
    assert.equal(idx.status().ready, true);
    assert.equal(calls, 1);
    assert.equal(idx.search("погоду", { allowedIds: new Set(["ses_oc1"]) }).hits.length, 1);

    // Не изменилась — повторно не запрашиваем
    await idx.ensureFresh([{ id: "ses_oc1", directory: "/a", time: { updated: 1000 } }]);
    assert.equal(calls, 1);

    // Новое сообщение + updated вырос — ensureFresh доиндексирует
    ocMsgs.ses_oc1.push(msg("m11", "assistant", "Завтра солнечно и без осадков", { created: 2000 }));
    await idx.ensureFresh([{ id: "ses_oc1", directory: "/a", time: { updated: 2000 } }]);
    assert.equal(calls, 2);
    const res = idx.search("осадков", { allowedIds: new Set(["ses_oc1"]) });
    assert.equal(res.hits.length, 1);
    assert.equal(res.hits[0].messageId, "m11");
  } finally {
    idx.stop();
  }
});
