// Г4b «клиент-чат: отображение» — pure helpers behind MessageBubble, ToolCard,
// AgentCard, Attachment and FileViewer (src/lib/normalize.js).
// Run: node --test tests/chat-display.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTurns,
  detectCsvDelimiter,
  displayTitle,
  fileBadge,
  fileCardInfo,
  fileErrorInfo,
  fileKindOf,
  fileTypeLabel,
  fmtBytes,
  fmtDecimal,
  fmtElapsed,
  fmtNum,
  isAwaitingPermission,
  isImageName,
  isNumericCell,
  isScratchPath,
  middleEllipsis,
  parseCsv,
  queuedUserIds,
  resolveRelativePath,
  splitEnvPrefix,
  titleFromText,
  toolStepDesc,
  turnAuthor,
  turnMetaLine,
} from "../src/lib/normalize.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NB = "\u00A0";

// ---- ru numbers (R-04, FV-15, BUG-01.41 п.3) ------------------------------
test("fmtNum: ru compact with comma, k/M thresholds", () => {
  assert.equal(fmtNum(0), "0");
  assert.equal(fmtNum(999), "999");
  assert.equal(fmtNum(1000), "1k");
  assert.equal(fmtNum(2300), "2,3k");
  assert.equal(fmtNum(18_700), "18,7k");
  assert.equal(fmtNum(41_000), "41k");
  assert.equal(fmtNum(419_000), "419k");
  assert.equal(fmtNum(1_234_567), "1,2M");
  assert.equal(fmtNum(NaN), "");
  assert.ok(!/\./.test(fmtNum(12_400)), "no dot decimals");
});

test("fmtBytes / fmtDecimal: ru comma, nbsp before unit, 0 Б", () => {
  assert.equal(fmtBytes(9_332_000), `8,9${NB}МБ`);
  assert.equal(fmtBytes(86_000), `84${NB}КБ`);
  assert.equal(fmtBytes(0), `0${NB}Б`);
  assert.equal(fmtBytes(-1), "");
  assert.equal(fmtDecimal(4.2), "4,2");
  assert.equal(fmtDecimal(20), "20");
});

test("fmtElapsed precise: sub-10s keeps one decimal (tool cards)", () => {
  assert.equal(fmtElapsed(4200, true), "4,2с");
  assert.equal(fmtElapsed(300, true), "0,3с");
  assert.equal(fmtElapsed(34000, true), "34с");
  assert.equal(fmtElapsed(4200), "4с", "default unchanged");
  assert.equal(fmtElapsed(0, true), "0с");
});

// ---- turns: one copy + one meta per turn (R-02/R-03) -----------------------
const u = (id, created, text = "q", extra = {}) => ({ info: { id, role: "user", time: { created }, ...extra }, parts: [{ type: "text", text }] });
const a = (id, created, completed, tokens, text, extra = {}) => ({
  info: { id, role: "assistant", time: { created, completed }, tokens, ...extra },
  parts: text ? [{ type: "text", text }] : [{ type: "tool", tool: "bash", state: { status: "completed" } }],
});

test("buildTurns: steps of one answer share one turn; text, tokens, duration", () => {
  const t0 = Date.UTC(2026, 10, 2, 11, 31, 0);
  const msgs = [
    u("u1", t0),
    a("a1", t0 + 1000, t0 + 5000, { input: 10_000, output: 100, reasoning: 50, total: 400_000, cache: { read: 389_000 } }, "Сейчас посмотрю."),
    a("a2", t0 + 5000, t0 + 185_000, { input: 2400, output: 48_050, reasoning: 0 }, "Готово, вот график."),
    u("u2", t0 + 200_000),
    a("a3", t0 + 201_000, t0 + 222_000, { total: 12_873 }, "Вчера пик был в 21:10."),
  ];
  const turns = buildTurns(msgs);
  const t1 = turns.get("a1");
  assert.equal(t1, turns.get("a2"), "same turn object for both steps");
  assert.equal(t1.first, "a1");
  assert.equal(t1.last, "a2");
  assert.equal(t1.closed, true);
  assert.equal(t1.text, "Сейчас посмотрю.\n\nГотово, вот график.");
  assert.equal(t1.tokensIn, 12_400, "input without cache reads");
  assert.equal(t1.tokensOut, 48_200, "output + reasoning");
  assert.equal(t1.durationMs, 185_000, "from the user's send to the last step");
  const line = turnMetaLine(t1);
  assert.match(line, /^↑12,4k ↓48,2k · \d\d:\d\d · 3м 05с$/);
  assert.match(turnMetaLine(turns.get("a3")), /^12,9k ток · \d\d:\d\d · 22с$/, "total-only fallback, duration from the user's send");
});

test("buildTurns: the tail turn of a busy session is not closed", () => {
  const msgs = [u("u1", 1000), a("a1", 2000, 3000, {}, "шаг 1")];
  assert.equal(buildTurns(msgs, { busy: true }).get("a1").closed, false);
  assert.equal(buildTurns(msgs, { busy: false }).get("a1").closed, true);
  const running = [u("u1", 1000), a("a1", 2000, undefined, {}, "пишу…")];
  assert.equal(buildTurns(running).get("a1").closed, false, "unfinished step");
});

// ---- author (R-08) --------------------------------------------------------
test("turnAuthor: Claude chats show the model, never the opencode agent", () => {
  const info = { providerID: "anthropic", modelID: "claude-opus-4-5", agent: "Sisyphus - ultraworker" };
  assert.deepEqual(turnAuthor(info, { modelLabel: "Claude Opus 4.5" }), { name: "Claude Opus 4.5", claude: true });
  assert.equal(turnAuthor({ agent: "Sisyphus - ultraworker" }, { engine: "claude" }).name, "Claude");
  assert.deepEqual(turnAuthor({ agent: "Sisyphus - ultraworker", providerID: "zai" }), { name: "Sisyphus - ultraworker", claude: false });
});

test("BUG-087: a Claude answer given by a portal agent is signed «model · agent»", () => {
  const info = { providerID: "anthropic", modelID: "claude-haiku-4-5", agent: "workflow" };
  const list = [{ id: "workflow", name: "Workflow" }];
  assert.deepEqual(turnAuthor(info, { modelLabel: "Claude Haiku 4.5", claudeAgents: list }), { name: "Claude Haiku 4.5 · Workflow", claude: true, agent: "workflow" });
  // catalog not loaded / agent gone: the id, capitalized
  assert.equal(turnAuthor({ ...info, agent: "reviewer" }, { modelLabel: "Claude Haiku 4.5" }).name, "Claude Haiku 4.5 · Reviewer");
  // no agent → the model only
  assert.equal(turnAuthor({ providerID: "anthropic", modelID: "claude-haiku-4-5" }, { modelLabel: "Claude Haiku 4.5", claudeAgents: list }).name, "Claude Haiku 4.5");
});

// ---- queue mark (R-13, FEAT-01.29) ---------------------------------------
test("queuedUserIds: follow-up during an unfinished step is queued until answered", () => {
  const msgs = [u("u1", 1000), a("a1", 2000, undefined, {}, "работаю"), u("u2", 3000)];
  assert.deepEqual([...queuedUserIds(msgs, true)], ["u2"]);
  assert.equal(queuedUserIds(msgs, false).size, 0, "idle session: nothing waits");
  const answered = [...msgs, a("a2", 4000, undefined, {}, "", { parentID: "u2" })];
  assert.equal(queuedUserIds(answered, true).size, 0);
  const plain = [u("u1", 1000), a("a1", 2000, 2500, {}, "ok"), u("u2", 3000)];
  assert.equal(queuedUserIds(plain, true).size, 0, "a normal send after a finished turn is not queued");
  assert.deepEqual([...queuedUserIds([u("u9", 1, "x", { queued: true })], false)], ["u9"], "explicit store flag wins");
  assert.equal(queuedUserIds([...msgs.slice(0, 2), u("u3", 3000, "x", { failed: true })], true).size, 0, "failed is not queued");
});

// ---- tool cards (R-14, R-15, BUG-01.33) -----------------------------------
test("splitEnvPrefix: PowerShell/bash/cmd env plumbing is cut from the command", () => {
  assert.deepEqual(splitEnvPrefix("$env:CI='true'; $env:NODE_ENV=\"test\"; npm test"), {
    command: "npm test",
    env: [{ name: "CI", value: "true" }, { name: "NODE_ENV", value: "test" }],
  });
  assert.deepEqual(splitEnvPrefix("export A=1 && export B='x y'; make"), {
    command: "make",
    env: [{ name: "A", value: "1" }, { name: "B", value: "x y" }],
  });
  assert.deepEqual(splitEnvPrefix('set "PYTHONIOENCODING=utf-8" && python a.py'), {
    command: "python a.py",
    env: [{ name: "PYTHONIOENCODING", value: "utf-8" }],
  });
  assert.deepEqual(splitEnvPrefix("CI=true npm test"), { command: "npm test", env: [{ name: "CI", value: "true" }] });
  assert.deepEqual(splitEnvPrefix("node --version"), { command: "node --version", env: [] });
  assert.deepEqual(splitEnvPrefix("$x = 5; echo $x"), { command: "$x = 5; echo $x", env: [] }, "plain variables stay");
});

test("toolStepDesc: agent description first, raw command/path titles never", () => {
  assert.equal(toolStepDesc({ state: { input: { command: "python make_chart.py", description: "Построить график" } } }), "Построить график");
  assert.equal(toolStepDesc({ state: { input: { command: "node --version" }, title: "node --version" } }), "");
  assert.equal(toolStepDesc({ state: { input: { filePath: "D:\\x\\a.md" }, title: "D:\\x\\a.md" } }), "");
  assert.equal(toolStepDesc({ state: { input: {}, title: "Список задач" } }), "Список задач");
});

test("isAwaitingPermission: by callID, or by command in the same session", () => {
  const part = { callID: "call_1", state: { status: "running", input: { command: "rm -rf x" } } };
  const byCall = [{ kind: "permission", command: "other", raw: { properties: { tool: { callID: "call_1" } } } }];
  assert.equal(isAwaitingPermission(part, byCall), true);
  const otherCall = [{ kind: "permission", command: "rm -rf x", raw: { properties: { tool: { callID: "call_2" } } } }];
  assert.equal(isAwaitingPermission(part, otherCall), false, "a different call's request");
  const byCmd = [{ kind: "permission", command: "rm -rf x", sessionID: "s1", raw: { properties: {} } }];
  assert.equal(isAwaitingPermission(part, byCmd, "s1"), true);
  assert.equal(isAwaitingPermission(part, byCmd, "s2"), false);
  assert.equal(isAwaitingPermission({ ...part, state: { ...part.state, status: "completed" } }, byCall), false);
  assert.equal(isAwaitingPermission(part, [{ kind: "question", raw: {} }]), false);
});

// ---- file kinds / badges / names (FV-10/12/13/14/17, BUG-05.9) -------------
test("fileKindOf: office, extended text/audio, mkv/mov to the download card", () => {
  assert.equal(fileKindOf("отчёт.xlsx"), "xlsx");
  assert.equal(fileKindOf("qa-doc.DOCX"), "docx");
  assert.equal(fileKindOf("data.tsv"), "csv");
  for (const n of ["a.toml", "b.sql", "c.go", "d.rs", "e.ini", "f.diff", "g.env", "h.conf"]) assert.equal(fileKindOf(n), "text", n);
  for (const n of ["rec.m4a", "x.flac", "y.opus", "z.aac"]) assert.equal(fileKindOf(n), "audio", n);
  assert.equal(fileKindOf("clip.mkv"), "binary");
  assert.equal(fileKindOf("clip.mov"), "binary");
  assert.equal(fileKindOf("clip.mp4"), "video");
  assert.equal(fileKindOf("archive.zip"), "binary");
});

test("isImageName / fileBadge / fileTypeLabel", () => {
  assert.equal(isImageName("D:\\s\\график-канал.png"), true);
  assert.equal(isImageName("chart.SVG"), true);
  assert.equal(isImageName("report.pdf"), false);
  assert.equal(fileBadge("трафик-по-часам.xlsx"), "xlsx");
  assert.equal(fileBadge("noext"), null);
  assert.equal(fileTypeLabel("a.xlsx"), "Таблица Excel");
  assert.equal(fileTypeLabel("a.toml"), "Текст · toml");
  assert.equal(fileTypeLabel("a.zip"), "Файл ZIP");
});

test("middleEllipsis keeps the extension", () => {
  const long = "очень-длинное-имя-файла-с-результатами-анализа-трафика-за-день.xlsx";
  const s = middleEllipsis(long, 30);
  assert.ok(s.length <= 30, s);
  assert.ok(s.endsWith(".xlsx"), s);
  assert.ok(s.includes("…"));
  assert.equal(middleEllipsis("short.md", 30), "short.md");
});

test("fileErrorInfo: a reasoned screen per cause (FV-03)", () => {
  assert.equal(fileErrorInfo(404).title, "Файл не найден");
  assert.equal(fileErrorInfo(403).retry, false);
  assert.match(fileErrorInfo(502).text, /502/);
  assert.equal(fileErrorInfo(0).title, "Нет связи с сервером");
  assert.equal(fileErrorInfo(null).retry, true);
});

// ---- CSV (FV-06/07) -------------------------------------------------------
test("CSV: delimiter sniffing (Excel RU «;», TSV, comma) and parsing", () => {
  const ru = "\uFEFFЧас;Вход, Мбит/с;Выход\n09:00;12,5;3\n";
  assert.equal(detectCsvDelimiter(ru), ";");
  assert.deepEqual(parseCsv(ru, ";"), [["Час", "Вход, Мбит/с", "Выход"], ["09:00", "12,5", "3"]]);
  assert.equal(detectCsvDelimiter("a\tb\n1\t2", "x.csv"), "\t");
  assert.equal(detectCsvDelimiter("anything", "x.tsv"), "\t");
  assert.equal(detectCsvDelimiter('"a;b",c\n'), ",", "quoted ; does not count");
  assert.deepEqual(parseCsv('a,"b ""q""",c\r\n1,2,3'), [["a", 'b "q"', "c"], ["1", "2", "3"]]);
});

test("isNumericCell: right-aligned numbers", () => {
  for (const v of ["12", "12,5", "-3.4", "1 234,5", "45%", "1e3"]) assert.equal(isNumericCell(v), true, v);
  for (const v of ["", "09:00", "abc", "12 шт"]) assert.equal(isNumericCell(v), false, v);
});

// ---- markdown relative links (FV-19) --------------------------------------
test("resolveRelativePath: against the viewed file's folder", () => {
  assert.equal(resolveRelativePath("D:\\proj\\docs\\report.md", "chart.png"), "D:\\proj\\docs\\chart.png");
  assert.equal(resolveRelativePath("D:\\proj\\docs\\report.md", "../img/a%20b.png"), "D:\\proj\\img\\a b.png");
  assert.equal(resolveRelativePath(".zai-uploads/x.md", "./y.png"), ".zai-uploads/y.png");
  assert.equal(resolveRelativePath("D:\\a\\b.md", "https://example.com/x.png"), null);
  assert.equal(resolveRelativePath("D:\\a\\b.md", "#section"), null);
  assert.equal(resolveRelativePath("D:\\a\\b.md", "data:image/png;base64,xx"), null);
  assert.equal(resolveRelativePath("D:\\a\\b.md", "/abs"), null);
});

// ---- BUG-01.27 (client half) -----------------------------------------------
test("displayTitle: a title retelling the vault snapshot falls back to the typed text", () => {
  const snapshot = "[obsidian-cache] Активный кэш проекта.\n\n## Последний дайджест\nzai.home.example.net HTTPS IPv6 настроен\nПравила кэша: читать vault при сомнении.";
  const first = snapshot + "\n\n---\n\nОтветь одним словом: столица Италии?";
  assert.equal(displayTitle("zai.home.example.net HTTPS IPv6", first), "Ответь одним словом: столица Италии?");
  assert.equal(displayTitle("Столица Италии", first), "Столица Италии", "related title stays");
  assert.equal(displayTitle("[obsidian-cache] Активный кэш", first), "Ответь одним словом: столица Италии?");
  assert.equal(displayTitle("[obsidian-cache] Активный кэш"), "Без названия");
  assert.equal(displayTitle("New session - 2026-10-31T10:26:07.425Z", first), "Ответь одним словом: столица Италии?");
  assert.equal(displayTitle("Анализ логов", "Найди ошибку в логах"), "Анализ логов", "no snapshot → untouched");
});

test("titleFromText: word-boundary cut with ellipsis", () => {
  const t = titleFromText("Сформируй график входящего и исходящего трафика за сегодня с 9:00 до 23:30 по данным роутера");
  assert.ok(t.length <= 61, t);
  assert.ok(t.endsWith("…"));
  assert.ok(!/\s…$/.test(t));
});

// ---- BUG-01.37 п.6 ---------------------------------------------------------
test("isScratchPath: only system temp roots, a project tmp folder keeps its chips", () => {
  assert.equal(isScratchPath("C:\\Users\\USER\\AppData\\Local\\Temp\\opencode\\gen.ps1"), true);
  assert.equal(isScratchPath("C:\\Windows\\Temp\\x.ps1"), true);
  assert.equal(isScratchPath("/tmp/x.sh"), true);
  assert.equal(isScratchPath("D:\\proj\\tmp\\report.pdf"), false);
  assert.equal(isScratchPath("D:\\proj\\temp\\chart.png"), false);
});

// ---- BUG-01.39: every chat input ≥16px -------------------------------------
test("chat.css: composer textarea is 16px (iOS zoom guard)", () => {
  const css = readFileSync(path.join(ROOT, "src", "components", "chat.css"), "utf8");
  const block = /\.composer-ta\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const size = Number(/font-size:\s*(\d+(?:\.\d+)?)px/.exec(block)?.[1]);
  assert.ok(size >= 16, `composer font-size ${size}px`);
});

test("all text inputs across stylesheets are ≥16px", () => {
  const files = ["src/app.css", "src/components/views.css", "src/components/dialogs.css", "src/components/chat.css"];
  const selectors = [".composer-ta", ".dlg-custom-input", ".modal-input", ".login-input", ".access-input", ".search"];
  for (const f of files) {
    const css = readFileSync(path.join(ROOT, f), "utf8");
    for (const sel of selectors) {
      const re = new RegExp(`(?:^|\\n)${sel.replace(".", "\\.")}\\s*\\{([^}]*)\\}`);
      const block = re.exec(css)?.[1];
      if (!block || !/font-size/.test(block)) continue;
      const size = Number(/font-size:\s*(\d+(?:\.\d+)?)px/.exec(block)?.[1]);
      assert.ok(size >= 16, `${f} ${sel}: ${size}px`);
    }
  }
});

// FEAT-05.17: Claude-style file card — type in words + EXT, name without ext.
test("fileCardInfo: «Тип · РАСШ» и имя без расширения (FEAT-05.17)", () => {
  const sub = (n) => fileCardInfo(n).sub;
  assert.equal(sub("crpv-schema.html"), "Код · HTML");
  assert.equal(sub("crpv-schema.drawio"), "Файл · DRAWIO");
  assert.equal(sub("crpv-schema.md"), "Документ · MD");
  assert.equal(sub("crpv-model-preview.png"), "Изображение · PNG");
  assert.equal(sub("report.xlsx"), "Таблица · XLSX");
  assert.equal(sub("deck.pptx"), "Презентация · PPTX");
  assert.equal(sub("bundle.zip"), "Архив · ZIP");
  assert.equal(sub("clip.mp4"), "Видео · MP4");
  assert.equal(sub("voice.m4a"), "Аудио · M4A");
  assert.equal(sub("Makefile"), "Файл");
  assert.equal(fileCardInfo("D:\\Chats\\x\\opencode-obsidian-setup.md").stem, "opencode-obsidian-setup");
  assert.equal(fileCardInfo("a/b/my.report.v2.xlsx").stem, "my.report.v2");
  assert.equal(fileCardInfo(".env").stem, ".env");
  assert.equal(fileCardInfo("x.HTML").kind, "code");
  assert.equal(fileCardInfo("p.svg").kind, "image");
  assert.equal(fileCardInfo(null).sub, "Файл");
});
