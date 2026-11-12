// FEAT-11.18 (шаг В): передача чата на другой движок или модель — чистая логика и хранилище.
// Run: node --test tests/relay.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RELAY_CATCHUP_MARK, RelayStore, catchUpPart, marksForJournal, mergeFeeds, missedTurns, planRelay, relayMark, relayRule, withCatchUp } from "../lib/relay.js";

const TMP = mkdtempSync(path.join(tmpdir(), "zai-relay-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const CLAUDE = { engine: "claude", model: { providerID: "anthropic", modelID: "claude-opus-5-5" }, agent: null, prompted: true };
const GLM = { engine: "opencode", model: { providerID: "zai-coding-plan", modelID: "glm-5.3" }, agent: "orchestrator", prompted: true };

test("planRelay: Claude → opencode и обратно разрешены у чата с сообщениями; привязка помечена prompted", () => {
  const a = planRelay({ current: CLAUDE, target: { model: GLM.model } });
  assert.equal(a.changed, "engine");
  assert.deepEqual(a.binding, { engine: "opencode", model: GLM.model, agent: null, prompted: true }, "агент прежнего движка не переносится");
  const b = planRelay({ current: GLM, target: { model: CLAUDE.model } });
  assert.equal(b.binding.engine, "claude");
  assert.equal(b.changed, "engine");
});

test("planRelay: смена модели внутри движка сохраняет агента; явный агент принимается", () => {
  const r = planRelay({ current: GLM, target: { model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" } } });
  assert.equal(r.changed, "model");
  assert.equal(r.binding.agent, "orchestrator");
  assert.equal(planRelay({ current: CLAUDE, target: { model: GLM.model, agent: "build" } }).binding.agent, "build");
});

test("planRelay: отказы — ход идёт, та же модель, нет модели, пустой чат", () => {
  assert.deepEqual(planRelay({ current: CLAUDE, target: { model: GLM.model }, busy: true }), { status: 409, error: "turn is running" });
  assert.equal(planRelay({ current: GLM, target: { model: GLM.model } }).status, 400);
  assert.equal(planRelay({ current: GLM, target: {} }).status, 400);
  assert.equal(planRelay({ current: GLM, target: { model: CLAUDE.model, agent: 5 } }).status, 400);
  assert.equal(planRelay({ current: null, target: { model: GLM.model } }).status, 409);
});

test("relayMark / relayRule / marksForJournal: отметка, строка для нового движка с путём журнала", () => {
  const m = relayMark(CLAUDE, GLM, { at: 1000, reason: "limit" });
  assert.deepEqual(m, { at: 1000, from: { engine: "claude", providerID: "anthropic", modelID: "claude-opus-5-5" }, to: { engine: "opencode", providerID: "zai-coding-plan", modelID: "glm-5.3" }, reason: "limit" });
  const rule = relayRule([m], "D:\\Obsidian\\agents\\journal\\2026-11-12-ses_1.md");
  assert.match(rule, /claude-opus-5-5 → glm-5\.3/);
  assert.match(rule, /D:\/Obsidian\/agents\/journal\/2026-11-12-ses_1\.md/);
  assert.match(rule, /прочитай журнал/);
  assert.equal(relayRule([], "x"), "");
  assert.deepEqual(marksForJournal([m]), [{ at: 1000, from: { engine: "claude", model: "claude-opus-5-5" }, to: { engine: "opencode", model: "glm-5.3" } }]);
});

test("mergeFeeds: истории двух движков — одна лента по времени, без повторов", () => {
  const m = (id, at) => ({ info: { id, time: { created: at } }, parts: [] });
  const out = mergeFeeds([m("o1", 30), m("o2", 50)], [m("c1", 10), m("c2", 20), m("o1", 30)]);
  assert.deepEqual(out.map((x) => x.info.id), ["c1", "c2", "o1", "o2"]);
  assert.deepEqual(mergeFeeds(null, undefined), []);
});

test("RelayStore: отметки переживают перезапуск; forget убирает чат; не больше 50 на чат", () => {
  const file = path.join(TMP, "relays.json");
  const s = new RelayStore(file);
  assert.deepEqual(s.get("ses_1"), []);
  s.add("ses_1", relayMark(CLAUDE, GLM, { at: 1 }));
  s.add("ses_1", relayMark(GLM, CLAUDE, { at: 2 }));
  s.add("ses_2", relayMark(GLM, CLAUDE, { at: 3 }));
  const again = new RelayStore(file);
  assert.equal(again.get("ses_1").length, 2);
  assert.equal(again.has("ses_2"), true);
  again.forget("ses_2");
  assert.equal(new RelayStore(file).has("ses_2"), false);
  for (let i = 0; i < 60; i++) again.add("ses_1", relayMark(CLAUDE, GLM, { at: 10 + i }));
  assert.equal(again.get("ses_1").length, 50);
  assert.ok(JSON.parse(readFileSync(file, "utf8")).ses_1);
  assert.deepEqual(new RelayStore(null).get("x"), [], "без файла — в памяти");
});

test("BUG-232: возврат на движок, который уже вёл этот чат, — строка называет пропущенный промежуток и запрещает верить своей истории", () => {
  const out = relayMark(CLAUDE, GLM, { at: Date.UTC(2026, 10, 12, 14, 26, 0) });
  const back = relayMark(GLM, CLAUDE, { at: Date.UTC(2026, 10, 12, 14, 31, 0) });
  const rule = relayRule([out, back], "D:\kb\journal\j.md");
  assert.match(rule, /Ты уже вёл этот чат раньше/);
  assert.match(rule, /с 17:26 до 17:31 \(МСК\)/, "промежуток чужих ходов назван явно");
  assert.match(rule, /твоя история неполна/i);
  assert.match(rule, /номера и порядок сообщений/);
  // первая передача (движок чат ещё не вёл) — без этой добавки
  assert.doesNotMatch(relayRule([out], "x"), /Ты уже вёл этот чат раньше/);
  // смена модели внутри одного движка — история общая, добавки нет
  const FLASH = { ...GLM, model: { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" } };
  assert.doesNotMatch(relayRule([out, relayMark(GLM, FLASH, { at: 5 })], "x"), /Ты уже вёл этот чат раньше/);
  // после возврата сменили модель внутри движка — история по-прежнему неполна, добавка остаётся
  const OPUS2 = { ...CLAUDE, model: { providerID: "anthropic", modelID: "claude-haiku-4-5" } };
  assert.match(relayRule([out, back, relayMark(CLAUDE, OPUS2, { at: back.at + 60_000 })], "x"), /с 17:26 до 17:31 \(МСК\)/);
});

// ── BUG-232: пропущенные ходы вкладываются в запрос (детерминированно, а не «прочитай журнал») ──
const T = Date.UTC(2026, 10, 12, 16, 0, 0);
const um = (id, at, text, extra = []) => ({ info: { id, role: "user", time: { created: at } }, parts: [{ type: "text", text }, ...extra] });
const am = (id, at, text, modelID, extra = []) => ({ info: { id, role: "assistant", modelID, time: { created: at } }, parts: [...extra, { type: "text", text }] });

test("BUG-232 missedTurns: чужие ходы новее последнего своего; у движка без истории — все; свои свежее — пусто", () => {
  const own = [um("c1", T, "Запомни слово ОПАЛ"), am("c2", T + 1000, "принял", "claude-haiku-4-5")];
  const other = [um("o0", T - 5000, "старое"), um("o1", T + 60_000, "Назови слово"), am("o2", T + 61_000, "ОПАЛ", "glm-5.3-flash")];
  assert.deepEqual(missedTurns(own, other).map((m) => m.info.id), ["o1", "o2"]);
  assert.deepEqual(missedTurns([], other).map((m) => m.info.id), ["o0", "o1", "o2"], "движок без своей истории получает всё");
  assert.deepEqual(missedTurns([...own, um("c3", T + 120_000, "ещё")], other), [], "после своего хода вкладывать нечего — вложение разовое");
  assert.deepEqual(missedTurns(own, null), []);
});

test("BUG-232 catchUpPart: скрытая часть с дословными ходами по порядку, моделью, файлами и путём журнала", () => {
  const tool = { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "D:\\proj\\report.md", content: "…" }, output: "ok ".repeat(500) } };
  const hidden = { type: "text", synthetic: true, text: "<system-reminder>секретная вставка</system-reminder>" };
  const part = catchUpPart([um("o1", T + 60_000, "Назови слово", [hidden]), am("o2", T + 61_000, "ОПАЛ", "glm-5.3-flash", [tool])], { journalFile: "D:\\kb\\journal\\j.md" });
  assert.equal(part.type, "text");
  assert.equal(part.synthetic, true, "пользователю в ленте не показывается");
  assert.ok(part.text.startsWith(RELAY_CATCHUP_MARK));
  assert.ok(part.text.trimEnd().endsWith("</system-reminder>"));
  assert.match(part.text, /этих ходов нет в твоей истории/i);
  const iU = part.text.indexOf("Пользователь: Назови слово");
  const iA = part.text.indexOf("Агент (glm-5.3-flash): ОПАЛ");
  assert.ok(iU > 0 && iA > iU, "дословно и по порядку: " + part.text);
  assert.match(part.text, /\[19:01 МСК\]/);
  assert.match(part.text, /Изменённые файлы: D:\/proj\/report\.md/);
  assert.match(part.text, /D:\/kb\/journal\/j\.md/);
  assert.doesNotMatch(part.text, /секретная вставка/, "служебные вставки портала не переносятся");
  assert.doesNotMatch(part.text, /ok ok ok/, "вывод инструментов не переносится");
  assert.equal(catchUpPart([], {}), null);
  assert.equal(catchUpPart([{ info: { role: "assistant", time: { created: T } }, parts: [] }], {}), null, "без текста вкладывать нечего");
});

test("BUG-232 catchUpPart: потолок объёма — свежие ходы целиком, обрезка названа явно; длинное сообщение сокращается с пометкой", () => {
  const many = [];
  for (let i = 0; i < 40; i++) many.push(um(`u${i}`, T + i * 2000, `запрос номер ${i} ` + "я".repeat(300)), am(`a${i}`, T + i * 2000 + 1000, `ответ номер ${i} ` + "ю".repeat(300), "glm-5.3"));
  const part = catchUpPart(many, { journalFile: "D:\\kb\\journal\\j.md", limit: 4000 });
  assert.ok(part.text.length < 4000 + 900, "потолок соблюдён (плюс шапка): " + part.text.length);
  assert.match(part.text, /Показаны последние (\d+) сообщений из 80; более ранние \d+ — только в журнале/);
  assert.match(part.text, /ответ номер 39/, "самое свежее — на месте");
  assert.doesNotMatch(part.text, /запрос номер 0 /, "самое раннее — отброшено");
  const shown = Number(part.text.match(/Показаны последние (\d+)/)[1]);
  assert.ok(shown >= 2 && shown < 80);
  // одно огромное сообщение не выбрасывается целиком и не съедает весь потолок молча
  const big = catchUpPart([um("u", T, "коротко"), am("a", T + 1000, "НАЧАЛО " + "ж".repeat(20_000) + " КОНЕЦ", "glm-5.3")], { limit: 4000 });
  assert.match(big.text, /НАЧАЛО/);
  assert.match(big.text, /КОНЕЦ/);
  assert.match(big.text, /…сокращено \d+ знаков; полностью — в журнале…/);
  assert.match(big.text, /Пользователь: коротко/);
});

test("BUG-232 withCatchUp: часть добавляется к запросу один раз; прежняя или подделанная копия убирается", () => {
  const missed = [um("o1", T, "Назови слово"), am("o2", T + 1000, "ОПАЛ", "glm-5.3")];
  const body = { parts: [{ type: "text", text: "Что было во втором сообщении?" }] };
  const out = withCatchUp(body, missed, { journalFile: null });
  assert.equal(out.parts.length, 2);
  assert.equal(out.parts[0].text, "Что было во втором сообщении?", "текст пользователя не тронут и стоит первым");
  assert.equal(body.parts.length, 1, "исходное тело не меняется");
  const again = withCatchUp({ parts: [...out.parts, { type: "text", synthetic: true, text: RELAY_CATCHUP_MARK + " подделка" }] }, missed, {});
  assert.equal(again.parts.filter((p) => p.synthetic).length, 1, "копии не копятся");
  const none = withCatchUp({ parts: [...out.parts] }, [], {});
  assert.equal(none.parts.length, 1, "пропущенного нет — старая вставка убрана, новой нет");
});
