// FEAT-11.18 (шаг Б): журнал чата в базе знаний.
// Run: node --test tests/chat-journal.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JournalWriter, findJournal, isJournalAccess, journalFile, journalRule, renderJournal, writeJournal } from "../lib/chat-journal.js";

const TMP = mkdtempSync(path.join(tmpdir(), "zai-journal-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const T0 = new Date(2026, 10, 12, 14, 0, 0).getTime();
const user = (id, at, text, extra = {}) => ({ info: { id, role: "user", time: { created: at } }, parts: [{ id: id + "p", type: "text", text, ...extra }] });
const asst = (id, at, parts, info = {}) => ({ info: { id, role: "assistant", time: { created: at, completed: at + 1000 }, modelID: "glm-5.3", ...info }, parts });
const tool = (name, input, status = "completed") => ({ type: "tool", tool: name, state: { status, input, output: "ОЧЕНЬ ДЛИННЫЙ ВЫВОД ИНСТРУМЕНТА" } });

const MESSAGES = [
  user("u1", T0, "Перенеси отчёты на новый шаблон"),
  asst("a1", T0 + 1000, [tool("read", { filePath: "D:\\work\\r1.md" }), tool("write", { filePath: "D:\\work\\out\\r1.md" }), tool("bash", { command: "npm   test\n--silent" }, "error"), { type: "text", text: "Перенёс первый отчёт." }]),
  user("h1", T0 + 2000, "<system-reminder>скрытая подсказка</system-reminder>", { synthetic: true }),
  user("u2", T0 + 60_000, "Продолжай"),
  asst("a2", T0 + 61_000, [{ type: "reasoning", text: "думаю" }, { type: "text", text: "Готово, все пять." }], { modelID: "claude-opus-5-5" }),
];

test("renderJournal: ходы по порядку — запрос, действия одной строкой, ответ, изменённые файлы; без вывода инструментов и скрытых частей", () => {
  const r = renderJournal({ id: "ses_1", title: "Миграция отчётов", dir: "D:\\work", messages: MESSAGES, now: T0 + 70_000 });
  assert.equal(r.turns, 2);
  assert.equal(r.firstAt, T0);
  const t = r.text;
  assert.match(t, /^---\nchat: ses_1\ntitle: "Миграция отчётов"\n/);
  assert.match(t, /models: \["glm-5\.3","claude-opus-5-5"\]/);
  assert.match(t, /## Ход 1 · 2026-11-12 14:00 · glm-5\.3/);
  assert.match(t, /\*\*Запрос\*\*\n\nПеренеси отчёты на новый шаблон/);
  assert.match(t, /- read `D:\\work\\r1\.md`\n- write `D:\\work\\out\\r1\.md`\n- bash `npm test --silent` — ошибка/);
  assert.match(t, /\*\*Ответ\*\*\n\nПеренёс первый отчёт\./);
  assert.match(t, /\*\*Изменённые файлы\*\*\n\n- `D:\\work\\out\\r1\.md`/);
  assert.match(t, /## Ход 2 · 2026-11-12 14:01 · claude-opus-5-5/);
  assert.ok(!t.includes("ОЧЕНЬ ДЛИННЫЙ ВЫВОД"), "вывод инструментов в журнал не идёт");
  assert.ok(!t.includes("скрытая подсказка") && !t.includes("думаю"), "скрытые части и размышления не идут");
});

test("renderJournal: отметка передачи стоит между ходами; оборванный ход помечен; пустая история — 0 ходов", () => {
  const msgs = [MESSAGES[0], asst("a1", T0 + 1000, [{ type: "text", text: "Начал." }], { error: { name: "APIError", data: { message: "usage limit reached" } } }), MESSAGES[3], MESSAGES[4]];
  const r = renderJournal({ id: "ses_1", title: "x", messages: msgs, relays: [{ at: T0 + 30_000, from: { engine: "claude", model: "Claude Opus 5.5" }, to: { engine: "opencode", model: "GLM-5.3" } }] });
  const iRelay = r.text.indexOf("**Передача** · 2026-11-12 14:00 · Claude Opus 5.5 → GLM-5.3");
  assert.ok(iRelay > r.text.indexOf("## Ход 1") && iRelay < r.text.indexOf("## Ход 2"));
  assert.match(r.text, /\*\*Ход оборвался:\*\* usage limit reached/);
  assert.equal(renderJournal({ id: "s", messages: [] }).turns, 0);
});

test("renderJournal: больше 40 действий в ходе — остальные одной строкой «и ещё N»", () => {
  const many = Array.from({ length: 55 }, (_, i) => tool("read", { filePath: `f${i}.txt` }));
  const r = renderJournal({ id: "s", messages: [user("u", T0, "прочитай всё"), asst("a", T0 + 1, many)] });
  assert.match(r.text, /- …и ещё 15/);
  assert.equal((r.text.match(/^- read /gm) ?? []).length, 40);
});

test("journalFile / findJournal / writeJournal: имя по дате первого сообщения и id; повторная запись — тот же файл", () => {
  const zone = path.join(TMP, "zone1");
  assert.equal(findJournal(zone, "ses_9"), null);
  const f = journalFile(zone, "ses_9", T0);
  assert.equal(path.basename(f), "2026-11-12-ses_9.md");
  assert.equal(path.basename(path.dirname(f)), "journal");
  writeJournal(f, "раз\n");
  // на следующий день файл не переименовывается: ищется по id
  assert.equal(journalFile(zone, "ses_9", T0 + 5 * 86400_000), f);
  writeJournal(f, "два\n");
  assert.equal(readFileSync(f, "utf8"), "два\n");
  assert.deepEqual(readdirSync(path.dirname(f)), ["2026-11-12-ses_9.md"], "временных файлов не осталось");
});

test("JournalWriter: чат ещё не виден порталу — повтор, журнал первого хода не теряется", async () => {
  const zone = path.join(TMP, "zone3");
  let calls = 0;
  const w = new JournalWriter({ debounceMs: 5, resolve: async () => (++calls < 3 ? { retry: true } : { zoneRoot: zone, title: "t", dir: "d", messages: MESSAGES }) });
  w.note(JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_new" } }));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(calls, 3);
  assert.ok(w.fileOf("ses_new"), "после повторов журнал записан");
  // чат так и не появился (удалён) — после трёх повторов попытки прекращаются
  let gone = 0;
  const w2 = new JournalWriter({ debounceMs: 2, resolve: async () => { gone++; return { retry: true }; } });
  w2.schedule("ses_gone");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(gone, 4, "первая попытка и три повтора");
});

test("isJournalAccess: сам разрешается только доступ к папке журналов зоны чата", () => {
  const Z = "D:\\Obsidian\\agents";
  const ask = (patterns, permission = "external_directory") => ({ permission, patterns });
  assert.equal(isJournalAccess(ask(["D:/Obsidian/agents/journal/*"]), Z, "win32"), true);
  assert.equal(isJournalAccess(ask(["d:\\obsidian\\AGENTS\\journal\\2026-11-12-ses_1.md"]), Z, "win32"), true);
  assert.equal(isJournalAccess(ask(["D:/Obsidian/agents/journal"]), Z, "win32"), true);
  assert.equal(isJournalAccess(ask(["D:/Obsidian/agents/*"]), Z, "win32"), false, "вся зона — обычный диалог");
  assert.equal(isJournalAccess(ask(["D:/Obsidian/agents/journal/*", "C:/Windows/*"]), Z, "win32"), false, "хотя бы один чужой путь — диалог");
  assert.equal(isJournalAccess(ask(["D:/Obsidian/agents/journal/../secrets/*"]), Z, "win32"), false);
  assert.equal(isJournalAccess(ask(["D:/Obsidian/agents/journalX/*"]), Z, "win32"), false, "общий префикс имени — не вложенность");
  assert.equal(isJournalAccess(ask(["D:/Obsidian/agents/journal/*"], "bash"), Z, "win32"), false, "только доступ к папке");
  assert.equal(isJournalAccess(ask([]), Z, "win32"), false);
  assert.equal(isJournalAccess(ask(["D:/Obsidian/agents/journal/*"]), null, "win32"), false);
  assert.equal(isJournalAccess(ask(["/vault/a/journal/x.md"]), "/vault/a", "linux"), true);
  assert.equal(isJournalAccess(ask(["/vault/A/journal/x.md"]), "/vault/a", "linux"), false, "регистр на POSIX значим");
});

test("journalRule: путь прямыми слэшами и указание читать по необходимости; пустой путь — пусто", () => {
  const rule = journalRule("D:\\Obsidian\\agents\\journal\\2026-11-12-ses_9.md");
  assert.match(rule, /D:\/Obsidian\/agents\/journal\/2026-11-12-ses_9\.md/);
  assert.match(rule, /прочитай журнал/);
  assert.equal(journalRule(null), "");
});

test("JournalWriter: конец хода → журнал записан; дочерняя сессия и чат без зоны пропускаются; путь известен для промпта", async () => {
  const zone = path.join(TMP, "zone2");
  const asked = [];
  const w = new JournalWriter({
    debounceMs: 5,
    resolve: async (sid) => {
      asked.push(sid);
      if (sid === "ses_child") return null; // сервер так отвечает на дочерние сессии субагентов
      if (sid === "ses_nozone") return { zoneRoot: null, title: "t", dir: "d", messages: MESSAGES };
      return { zoneRoot: zone, title: "Миграция отчётов", dir: "D:\\work", messages: MESSAGES, relays: [] };
    },
  });
  assert.equal(w.fileOf("ses_1", zone), null, "до первого хода журнала нет");
  w.note(JSON.stringify({ type: "message.part.updated", properties: { sessionID: "ses_1" } }));
  w.note(JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_1" } }));
  w.note(JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_1" } })); // дребезг — одна запись
  w.note(JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_child" } }));
  w.note(JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_nozone" } }));
  w.note("не json session.idle");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(asked.sort(), ["ses_1", "ses_child", "ses_nozone"]);
  const f = w.fileOf("ses_1");
  assert.ok(f && existsSync(f));
  assert.match(readFileSync(f, "utf8"), /# Журнал чата: Миграция отчётов/);
  assert.deepEqual(readdirSync(path.join(zone, "journal")), ["2026-11-12-ses_1.md"]);
  // другой экземпляр (после рестарта портала) находит журнал по зоне
  assert.equal(new JournalWriter({ resolve: async () => null }).fileOf("ses_1", zone), f);
  assert.equal(await w.flush("ses_child"), null);
});
