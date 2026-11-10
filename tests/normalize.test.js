// Unit tests for src/lib/normalize.js (pure helpers) against the recorded
// fixtures. Run: node --test tests/normalize.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyDelta,
  buildProjects,
  collapseToolRuns,
  collectArtifacts,
  isScratchPath,
  validateProjectDir,
  dirBasename,
  displayTitle,
  extractDialog,
  normalizeDialogRecords,
  extractFilePaths,
  collectArtifactEntries,
  fmtClock,
  fmtElapsed,
  groupSessionsByDate,
  isAgentTool,
  isHiddenDir,
  isSubagentSession,
  isUnderPath,
  makeMessage,
  mergePostIntoMessages,
  normalizeAgents,
  normalizeMcp,
  normalizeProviders,
  parseTime,
  projectDisplayName,
  splitDirective,
  splitInjected,
  upsertPart,
  upsertSession,
} from "../src/lib/normalize.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const providerResp = JSON.parse(readFileSync(path.join(ROOT, "fixtures", "provider.json"), "utf8"));
const agentsResp = JSON.parse(readFileSync(path.join(ROOT, "fixtures", "agents.json"), "utf8"));

test("parseTime treats sub-1e12 values as seconds and larger ones as ms", () => {
  assert.equal(parseTime(1793393472), 1793393472000);
  assert.equal(parseTime(1793393472.5), 1793393472500);
  assert.equal(parseTime(1793393472331), 1793393472331);
});

test("isUnderPath containment: case-insensitive, boundary-safe, empty-dir hides", () => {
  assert.equal(isUnderPath("D:\\Obsidian\\x.md", "D:\\Obsidian"), true);
  assert.equal(isUnderPath("d:/obsidian/sub/x.md", "D:\\Obsidian"), true);
  assert.equal(isUnderPath("D:\\ObsidianX\\x.md", "D:\\Obsidian"), false, "segment boundary required");
  assert.equal(isUnderPath("C:\\Users\\USER\\version.js", "C:\\Users\\USER"), true);
  assert.equal(isUnderPath("version.js", ""), false, "no session dir -> cannot verify scope");
  assert.equal(isUnderPath(null, "D:\\x"), false);
});

test("fmtClock: ru HH:MM from epoch seconds or ms, invalid -> empty", () => {
  const ms = new Date(2026, 0, 15, 14, 5).getTime();
  assert.equal(fmtClock(ms), "14:05");
  assert.equal(fmtClock(Math.round(ms / 1000)), "14:05");
  assert.equal(fmtClock(null), "");
  assert.equal(fmtClock("junk"), "");
});

test("groupSessionsByDate buckets by local day, sorts desc, omits empty groups", () => {
  const now = new Date(2026, 9, 31, 15, 0, 0).getTime();
  const day0 = new Date(2026, 9, 31, 0, 0, 0).getTime();
  const mk = (id, updated) => ({ id, time: { updated } });
  const groups = groupSessionsByDate(
    [
      mk("old", day0 - 20 * 86400e3),
      mk("today2", now - 2 * 3600e3),
      mk("week", day0 - 3 * 86400e3),
      mk("today1", now - 30 * 60e3),
      mk("yest", day0 - 3600e3),
    ],
    now,
  );
  assert.deepEqual(
    groups.map((g) => g.key),
    ["today", "yesterday", "week", "older"],
  );
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Сегодня", "Вчера", "На этой неделе", "Раньше"],
  );
  assert.deepEqual(
    groups[0].items.map((s) => s.id),
    ["today1", "today2"],
  );
  assert.equal(groupSessionsByDate([mk("only", now)], now).length, 1);
});

test("normalizeProviders flattens the fixture, filters to connected providers, sorts defaults first", () => {
  const cfg = normalizeProviders(providerResp);
  assert.ok(cfg.models.length >= 1);
  assert.deepEqual(cfg.defaults, providerResp.default);
  assert.deepEqual(cfg.connected, providerResp.connected);

  // NEW contract (2026-10-31): only models from CONNECTED providers are listed.
  // kosmik/scaleway are in the fixture catalog but not connected -> filtered out.
  assert.ok(providerResp.connected.length > 0, "fixture must carry a connected list");
  for (const m of cfg.models) {
    assert.ok(
      providerResp.connected.includes(m.providerID),
      `model ${m.id} from non-connected provider ${m.providerID} must be filtered`,
    );
  }
  assert.ok(!cfg.models.some((m) => m.providerID === "kosmik"), "kosmik (no token) must not appear");
  assert.ok(!cfg.models.some((m) => m.providerID === "scaleway"), "scaleway (no token) must not appear");
  assert.ok(cfg.models.some((m) => m.imageInput === true), "expected an image-capable model among connected");
  assert.ok(cfg.models.some((m) => m.imageInput === false), "expected at least one non-image model");

  // every provider-default model ranks before every non-default model
  const isDefault = (m) => cfg.defaults[m.providerID] === m.id;
  const lastDefault = cfg.models.map(isDefault).lastIndexOf(true);
  const firstNonDefault = cfg.models.findIndex((m) => !isDefault(m));
  assert.ok(lastDefault !== -1 && firstNonDefault !== -1);
  assert.ok(lastDefault < firstNonDefault);
});

test("normalizeProviders accepts the documented array form of capabilities.input", () => {
  const cfg = normalizeProviders({
    all: [{ id: "p1", name: "P1", models: { a: { id: "a", providerID: "p1", name: "A", capabilities: { input: ["text", "image"] }, limit: { context: 8 }, status: "active" } } }],
    default: { p1: "a" },
    connected: ["p1"],
  });
  assert.equal(cfg.models[0].imageInput, true);
  assert.equal(cfg.models[0].contextLimit, 8);
  assert.equal(cfg.models[0].status, "active");
});

test("normalizeAgents keeps name/description/mode only", () => {
  const list = normalizeAgents(agentsResp);
  const first = list[0];
  assert.equal(first.name, agentsResp[0].name);
  assert.deepEqual(Object.keys(first).sort(), ["description", "mode", "name"]);
});

// ISSUE-007: hidden/service agents never reach the sheets; one row per name.
test("normalizeAgents drops hidden and service agents, dedupes by name", () => {
  const list = normalizeAgents(agentsResp);
  const names = list.map((a) => a.name);
  for (const svc of ["compaction", "summary", "title"]) assert.ok(!names.includes(svc), svc);
  assert.equal(new Set(names).size, names.length, "no duplicate names");
  assert.ok(names.includes("Sisyphus - ultraworker"));
  assert.ok(names.includes("Prometheus - Plan Builder"));
  assert.deepEqual(normalizeAgents([{ name: "x", mode: "primary", hidden: true }]), []);
});

test("upsertPart appends new parts and replaces by id in place, without mutating", () => {
  let msg = makeMessage({ id: "msg_1" }, []);
  msg = upsertPart(msg, { id: "prt_a", type: "text", text: "hi" });
  const before = msg;
  msg = upsertPart(msg, { id: "prt_b", type: "text", text: "there" });
  assert.equal(before.parts.length, 1, "upsertPart must not mutate its input");
  assert.deepEqual(
    msg.parts.map((p) => p.id),
    ["prt_a", "prt_b"],
  );
  msg = upsertPart(msg, { id: "prt_a", type: "text", text: "HI" });
  assert.deepEqual(
    msg.parts.map((p) => p.id),
    ["prt_a", "prt_b"],
  );
  assert.equal(msg.parts[0].text, "HI");
});

test("upsertPart passes unknown part types through unchanged", () => {
  let msg = makeMessage({ id: "msg_1" }, []);
  msg = upsertPart(msg, { id: "prt_f", type: "future-widget", payload: { x: 1 } });
  assert.equal(msg.parts.length, 1);
  assert.equal(msg.parts[0].type, "future-widget");
  assert.deepEqual(msg.parts[0].payload, { x: 1 });
});

test("upsertPart replaces an id-less optimistic part of the same type in place", () => {
  // send() builds parts without ids; the first server part (real id) must take
  // its place instead of appending a duplicate text next to it (2026-10-31).
  const snapshot = "[obsidian-cache] снапшот.";
  let msg = makeMessage({ id: "msg_u", role: "user" }, [{ type: "text", text: "Привет" }]);
  msg = upsertPart(msg, { id: "prt_s", type: "text", text: snapshot + "\n\n---\n\nПривет" });
  assert.equal(msg.parts.length, 1, "server part must replace the optimistic one, not append");
  assert.equal(msg.parts[0].id, "prt_s");
  assert.equal(splitInjected(msg.parts[0].text).text, "Привет");
  // a following delta/update for the same real id still merges into that part
  msg = upsertPart(msg, { id: "prt_s", type: "text", text: snapshot + "\n\n---\n\nПока" });
  assert.equal(msg.parts.length, 1);
  assert.equal(splitInjected(msg.parts[0].text).text, "Пока");
});

test("applyDelta creates a placeholder part when delta arrives before part.updated", () => {
  const msg = makeMessage({ id: "m" }, []);
  const withDelta = applyDelta(msg, { partID: "prt_x", field: "text", delta: "Hel" });
  assert.equal(msg.parts.length, 0, "applyDelta must not mutate its input");
  assert.equal(withDelta.parts.length, 1);
  assert.equal(withDelta.parts[0].id, "prt_x");
  assert.equal(withDelta.parts[0].type, "text");
  assert.equal(withDelta.parts[0].text, "Hel");
  // non-text field synthesizes a reasoning part
  const r = applyDelta(msg, { partID: "prt_r", field: "reasoning", delta: "hmm" });
  assert.equal(r.parts[0].type, "reasoning");
  assert.equal(r.parts[0].reasoning, "hmm");
});

test("applyDelta appends string deltas to the matching existing part", () => {
  let msg = makeMessage({ id: "m" }, [{ id: "prt_x", type: "text", text: "Hel" }]);
  msg = applyDelta(msg, { partID: "prt_x", field: "text", delta: "lo" });
  msg = applyDelta(msg, { partID: "prt_x", field: "text", delta: "!" });
  assert.equal(msg.parts.length, 1);
  assert.equal(msg.parts[0].text, "Hello!");
});

test("extractDialog parses live permission.asked (metadata.command, patterns, always)", () => {
  // Shape captured live from opencode 1.19.5 on 2026-10-31.
  const d = extractDialog({
    id: "evt_1",
    type: "permission.asked",
    properties: {
      id: "per_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["rm -rf /tmp/x"],
      metadata: { command: "rm -rf /tmp/x" },
      always: ["rm *"],
      tool: { messageID: "msg_1", callID: "call_1" },
    },
  });
  assert.equal(d.kind, "permission");
  assert.equal(d.id, "per_1");
  assert.equal(d.sessionID, "ses_1");
  assert.equal(d.permission, "bash");
  assert.equal(d.command, "rm -rf /tmp/x");
  assert.deepEqual(d.patterns, ["rm -rf /tmp/x"]);
  assert.deepEqual(d.always, ["rm *"]);
  assert.equal(d.raw.type, "permission.asked");
  // a dialog without a repliable id is dropped
  assert.equal(extractDialog({ type: "permission.asked", properties: { sessionID: "ses_1" } }), null);
});

test("extractDialog tolerant fallbacks (legacy requestID/pattern shapes)", () => {
  const d = extractDialog({
    id: "evt_1b",
    type: "permission.updated",
    properties: { sessionID: "ses_1", requestID: "perm_1", pattern: "bash" },
  });
  assert.equal(d.kind, "permission");
  assert.equal(d.id, "perm_1");
  assert.deepEqual(d.patterns, ["bash"]);
  assert.equal(d.command, "bash"); // falls back to patterns[0]
  assert.deepEqual(d.always, []);
});

test("extractDialog parses live question.asked (questions array with labels)", () => {
  const q = extractDialog({
    id: "evt_2",
    type: "question.asked",
    properties: {
      id: "que_9",
      sessionID: "ses_1",
      questions: [
        {
          question: "Продолжаем?",
          header: "Продолжение",
          options: [
            { label: "Да", description: "Продолжить работу" },
            { label: "Нет", description: "Остановиться" },
          ],
        },
      ],
      tool: { messageID: "msg_2", callID: "call_2" },
    },
  });
  assert.equal(q.kind, "question");
  assert.equal(q.id, "que_9");
  assert.equal(q.sessionID, "ses_1");
  assert.equal(q.questions.length, 1);
  assert.equal(q.questions[0].header, "Продолжение");
  assert.equal(q.questions[0].question, "Продолжаем?");
  assert.equal(q.questions[0].options[0].label, "Да");
  assert.equal(q.questions[0].options[0].description, "Продолжить работу");
  // legacy single-question shape stays parseable
  const legacy = extractDialog({
    type: "question.asked",
    properties: { id: "que_1", sessionID: "ses_1", question: "Готов?" },
  });
  assert.equal(legacy.questions[0].question, "Готов?");
  assert.deepEqual(legacy.questions[0].options, []);
  assert.equal(extractDialog({ type: "message.updated", properties: {} }), null);
  assert.equal(extractDialog(null), null);
});

test("splitInjected hides the vault-cache snapshot, keeps the user text", () => {
  const snapshot = "[obsidian-cache] Активный кэш проекта.\n\nПравила кэша: _index.md.";
  const r = splitInjected(snapshot + "\n\n---\n\nПривет");
  assert.ok(r.context && r.context.startsWith("[obsidian-cache]"));
  assert.ok(!r.context.includes("---"), "separator must not leak into the context");
  assert.ok(!r.context.includes("Привет"));
  assert.equal(r.text, "Привет");
});

// BUG-010 (dogfood 2026-11-02): the snapshot quotes the tail of the last
// digest, which carries its own `---` separators. The cut must happen at the
// separator AFTER the snapshot terminator, not at the first `---`.
test("splitInjected: snapshot with inner --- lines (digest tail) stays out of the bubble", () => {
  const snapshot = [
    "[obsidian-cache] Активный кэш проекта «user» (C:\\Users\\USER), собран 2026-11-02 14:31.",
    "## Хвост последнего дайджеста (2026-11-02-user.md)",
    "- Итог: работает.",
    "",
    "---",
    "",
    "# Сессия 2026-11-02 — HTTPS-сертификат",
    "## 08:55 — в общем так и не заработало",
    "",
    "Правила кэша: D:\\Obsidian\\agents\\_index.md. Дайджест пишется автоматически.",
  ].join("\n");
  const r = splitInjected(snapshot + "\n\n---\n\nОтветь одним словом: столица Франции?");
  assert.equal(r.text, "Ответь одним словом: столица Франции?");
  assert.ok(r.context.includes("# Сессия 2026-11-02"), "the whole snapshot goes to the chip");
  assert.ok(r.context.trim().endsWith("Дайджест пишется автоматически."));
});

test("splitInjected: truncated snapshot (…(снапшот обрезан…)) with inner ---", () => {
  const snapshot = "[obsidian-cache] кэш.\n\n---\n\n# Сессия\nтекст\n…(снапшот обрезан, полные данные в vault)";
  const r = splitInjected(snapshot + "\n\n---\n\nПривет\n\n---\n\nмой markdown с линией");
  assert.equal(r.text, "Привет\n\n---\n\nмой markdown с линией", "user's own --- survives");
  assert.ok(r.context.endsWith("(снапшот обрезан, полные данные в vault)"));
});

test("validateProjectDir (BUG-013): absolute, no .., no system dirs", () => {
  assert.equal(validateProjectDir("D:\\Projects\\my-app"), null);
  assert.equal(validateProjectDir("d:/work/x"), null);
  assert.equal(validateProjectDir("\\\\nas\\share\\proj"), null);
  assert.equal(validateProjectDir("/home/u/proj"), null, "POSIX absolute path");
  assert.match(validateProjectDir("/"), /полный путь/);
  assert.match(validateProjectDir("relative\\folder"), /полный путь/);
  assert.match(validateProjectDir("..\\x"), /\.\./);
  assert.match(validateProjectDir("D:\\a\\..\\b"), /\.\./);
  assert.match(validateProjectDir("C:\\Windows\\System32\\x"), /Системные/);
  assert.match(validateProjectDir("C:\\Program Files (x86)\\x"), /Системные/);
  assert.match(validateProjectDir("   "), /Укажите/);
});

test("collectArtifacts (BUG-012): files in temp scratch dirs are not result chips", () => {
  assert.equal(isScratchPath("C:\\Users\\USER\\AppData\\Local\\Temp\\opencode\\gen-qa.ps1"), true);
  assert.equal(isScratchPath("C:\\Users\\USER\\qa-files\\qa-doc.pdf"), false);
  const parts = [
    { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "C:\\Users\\USER\\AppData\\Local\\Temp\\opencode\\gen-qa.ps1" } } },
    { type: "tool", tool: "write", state: { status: "completed", input: { filePath: "C:\\Users\\USER\\qa-files\\qa-page.html" } } },
  ];
  const chips = collectArtifacts(parts, ["готово: C:\\Users\\USER\\qa-files\\qa-doc.pdf"], "C:\\Users\\USER");
  assert.deepEqual(chips, ["C:\\Users\\USER\\qa-files\\qa-page.html", "C:\\Users\\USER\\qa-files\\qa-doc.pdf"]);
});

test("splitInjected passes clean texts through untouched", () => {
  assert.deepEqual(splitInjected("Привет"), { context: null, text: "Привет" });
  assert.deepEqual(splitInjected(""), { context: null, text: "" });
  assert.deepEqual(splitInjected("---\nтолько тире"), { context: null, text: "---\nтолько тире" });
});

test("splitInjected degenerate shapes fall back to showing as-is", () => {
  const noSep = splitInjected("[obsidian-cache] снапшот без разделителя");
  assert.equal(noSep.context, null);
  assert.ok(noSep.text.startsWith("[obsidian-cache]"));
  const emptyTail = splitInjected("[obsidian-cache] x\n---\n\n");
  assert.equal(emptyTail.context, null);
  assert.ok(emptyTail.text.startsWith("[obsidian-cache]"), "no user text after ---: show raw");
});

test("upsertSession dedupes by id, replaces fields and re-sorts by updated desc", () => {
  const base = 1793393000000;
  const list = [
    { id: "a", title: "A", time: { updated: base + 2000 } },
    { id: "b", title: "B", time: { updated: base + 1000 } },
  ];
  const updated = upsertSession(list, { id: "a", title: "A2", time: { updated: base + 3000 } });
  assert.equal(updated.length, 2, "same id must not duplicate");
  assert.equal(updated[0].id, "a");
  assert.equal(updated[0].title, "A2");
  const added = upsertSession(list, { id: "c", title: "C", time: { updated: base + 5000 } });
  assert.deepEqual(
    added.map((s) => s.id),
    ["c", "a", "b"],
  );
});

test("mergePostIntoMessages appends by id and replaces keeping old parts when new are empty", () => {
  const msgs = [makeMessage({ id: "m1", role: "assistant" }, [{ id: "p1", type: "text", text: "old" }])];
  const appended = mergePostIntoMessages(msgs, { info: { id: "m2", role: "assistant" }, parts: [{ id: "p2", type: "text", text: "new" }] });
  assert.equal(appended.length, 2);
  assert.equal(appended[1].parts[0].text, "new");
  const replaced = mergePostIntoMessages(msgs, { info: { id: "m1", role: "assistant", cost: 5 }, parts: [] });
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].info.cost, 5);
  assert.equal(replaced[0].parts[0].text, "old");
  assert.deepEqual(mergePostIntoMessages(msgs, null), msgs);
});

// ---- projects (Claude-style grouping) --------------------------------------

test("dirBasename takes the last segment of both separators, falls back for roots", () => {
  assert.equal(dirBasename("C:\\Users\\USER"), "USER");
  assert.equal(dirBasename("C:\\Users\\USER\\AppData\\Local\\Temp\\oc_test"), "oc_test");
  assert.equal(dirBasename("D:/Portal/zai"), "zai");
  assert.equal(dirBasename("C:\\"), "C:"); // root drive: label without the slash
  assert.equal(dirBasename("/"), "/");
  assert.equal(dirBasename(""), "");
  assert.equal(dirBasename(null), "");
});

test("isHiddenDir default rules hide windows/temp with segment boundaries, extra is exact", () => {
  // built-in junk from the live server (watchdog incident + test runs)
  assert.equal(isHiddenDir("C:\\Windows\\System32"), true);
  assert.equal(isHiddenDir("C:\\Users\\USER\\AppData\\Local\\Temp\\oc_test"), true);
  // real projects survive, including lookalike names (boundary required)
  assert.equal(isHiddenDir("C:\\Users\\USER"), false);
  assert.equal(isHiddenDir("D:\\Portal\\zai"), false);
  assert.equal(isHiddenDir("D:\\Portal\\template"), false);
  assert.equal(isHiddenDir("D:\\Portal\\windows-tools"), false);
  // user extras: exact, case-insensitive
  assert.equal(isHiddenDir("D:\\Secret", ["d:\\secret"]), true);
  assert.equal(isHiddenDir("D:\\Secret", ["D:\\Other"]), false);
  assert.equal(isHiddenDir(""), true);
});

test("buildProjects groups by directory with counts and recency, sorted desc", () => {
  // parseTime treats <1e12 as seconds: use realistic millisecond timestamps.
  const t = (ms) => ({ updated: ms });
  const sessions = [
    { id: "a", directory: "C:\\Users\\USER", time: t(1_793_393_000_000) },
    { id: "b", directory: "C:\\Users\\USER", time: t(1_793_393_002_000) },
    { id: "c", directory: "D:\\Proj", time: t(1_793_393_001_000) },
    { id: "d", directory: null }, // no directory: dropped
    { id: "e" }, // no directory field: dropped
  ];
  const groups = buildProjects(sessions);
  assert.deepEqual(
    groups.map((g) => g.directory),
    ["C:\\Users\\USER", "D:\\Proj"], // by lastUpdated desc (...002 > ...001)
  );
  const home = groups[0];
  assert.equal(home.name, "USER");
  assert.equal(home.count, 2);
  assert.equal(home.lastUpdated, 1_793_393_002_000);
  assert.deepEqual(
    home.sessions.map((s) => s.id),
    ["b", "a"], // inner list also newest first
  );
  const proj = groups[1];
  assert.equal(proj.name, "Proj");
  assert.equal(proj.count, 1);
});

test("buildProjects applies default junk rules and extra hidden list", () => {
  const sessions = [
    { id: "a", directory: "C:\\Users\\USER", time: { updated: 1 } },
    { id: "sys", directory: "C:\\Windows\\System32", time: { updated: 2 } },
    { id: "tmp", directory: "C:\\Users\\USER\\AppData\\Local\\Temp\\oc_test", time: { updated: 3 } },
    { id: "x", directory: "D:\\X", time: { updated: 4 } },
  ];
  assert.deepEqual(
    buildProjects(sessions).map((g) => g.directory),
    ["D:\\X", "C:\\Users\\USER"],
  );
  assert.deepEqual(
    buildProjects(sessions, { hidden: ["D:\\X"] }).map((g) => g.directory),
    ["C:\\Users\\USER"],
  );
  assert.deepEqual(buildProjects(null), []);
});

test("buildProjects merges user-added folders as empty cards, dedupes and hides", () => {
  const sessions = [
    { id: "a", directory: "C:\\Users\\USER", time: { updated: 1_793_393_000_000 } },
    { id: "b", directory: "D:\\Proj", time: { updated: 5 } },
  ];
  const groups = buildProjects(sessions, { extraDirs: ["D:\\Proj", "E:\\Fresh", "C:\\Windows\\junk", "not a dir? no — it is"] });
  // D:\Proj deduped (case-insensitive), junk dir hidden by default rules,
  // the empty folder sorts last (lastUpdated 0).
  assert.deepEqual(
    groups.map((g) => [g.directory, g.count]),
    [
      ["C:\\Users\\USER", 1],
      ["D:\\Proj", 1],
      ["E:\\Fresh", 0],
      ["not a dir? no — it is", 0],
    ],
  );
  const fresh = groups.find((g) => g.directory === "E:\\Fresh");
  assert.equal(fresh.name, "Fresh");
  assert.deepEqual(fresh.sessions, []);
  // hidden extra dirs do not appear even when listed by the user
  assert.equal(buildProjects([], { extraDirs: ["C:\\Windows\\Temp"] }).length, 0);
});

// ---- MCP servers -----------------------------------------------------------

test("normalizeMcp flattens the live map shape, sorts by name, tolerates junk", () => {
  // live-captured opencode 1.19.5 GET /mcp shape (+ a failed entry for the UI)
  const list = normalizeMcp({
    websearch: { status: "connected" },
    context7: { status: "connected" },
    grep_app: { status: "connected" },
    lsp: { status: "connected" },
    playwright: { status: "connected" },
    broken: { status: "failed", error: "Connection closed" },
  });
  assert.deepEqual(
    list.map((s) => s.name),
    ["broken", "context7", "grep_app", "lsp", "playwright", "websearch"],
  );
  const ok = list.find((s) => s.name === "playwright");
  assert.deepEqual(ok, { name: "playwright", status: "connected", error: null });
  const bad = list.find((s) => s.name === "broken");
  assert.equal(bad.status, "failed");
  assert.equal(bad.error, "Connection closed");
  // tolerant of odd payloads
  assert.deepEqual(normalizeMcp(null), []);
  assert.deepEqual(normalizeMcp([]), []);
  assert.deepEqual(normalizeMcp({ x: null, y: { status: 42 }, z: { status: "disabled" } }), [
    { name: "y", status: "unknown", error: null },
    { name: "z", status: "disabled", error: null },
  ]);
});

// ---- chat artifacts ----------------------------------------------------------

test("extractFilePaths finds windows paths in order, dedupes, caps", () => {
  const text = [
    "Готово. Отчёт: D:\\Projects\\app\\report.md, таблица D:\\projects\\app\\data.xlsx.",
    "Ещё D:\\Projects\\app\\report.md повтор.",
    "И /home/user/out/summary.pdf для unix.",
  ].join("\n");
  assert.deepEqual(extractFilePaths(text), [
    "D:\\Projects\\app\\report.md",
    "D:\\projects\\app\\data.xlsx",
    "/home/user/out/summary.pdf",
  ]);
  assert.equal(
    extractFilePaths("C:\\a.md C:\\b.md C:\\c.md C:\\d.md C:\\e.md C:\\f.md C:\\g.md C:\\h.md C:\\i.md C:\\j.md").length,
    8,
  ); // cap
});

test("extractFilePaths picks up .zai-uploads refs and skips non-artifacts", () => {
  assert.deepEqual(
    extractFilePaths("[Пользователь приложил файл: .zai-uploads/данные (1).xlsx (100 байт, тип неизвестен)."),
    [".zai-uploads/данные (1).xlsx"],
  );
  assert.deepEqual(extractFilePaths("версия 3x844 и время 12:30 и 1.5 шага"), []);
  assert.deepEqual(extractFilePaths(null), []);
});

test("projectDisplayName renames home folders, keeps real project names", () => {
  assert.equal(projectDisplayName("C:\\Users\\USER"), "Домашняя папка");
  assert.equal(projectDisplayName("/home/john"), "Домашняя папка");
  assert.equal(projectDisplayName("D:\\Portal\\zai"), "zai");
  assert.equal(projectDisplayName("C:\\Users\\USER\\AppData\\Local\\Temp\\oc_test"), "oc_test");
  // a sibling folder like C:\Users\USER\dev is a real project, not a home
  assert.equal(projectDisplayName("C:\\Users\\USER\\dev"), "dev");
});

// ---- orchestration directives ------------------------------------------------

test("splitDirective separates typed text from the harness payload", () => {
  const r = splitDirective("Продолжай\n[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]\nбла-бла\n<!-- OMO_INTERNAL_INITIATOR -->");
  assert.equal(r.text, "Продолжай");
  assert.equal(r.full, false);
  assert.ok(r.directive.startsWith("[SYSTEM DIRECTIVE:"));
  assert.ok(!r.directive.includes("OMO_INTERNAL_INITIATOR"));
});

test("splitDirective: pure directive renders as a system card", () => {
  const r = splitDirective("[SYSTEM DIRECTIVE: x]\nтело\n<!-- OMO_INTERNAL_NOREPLY -->");
  assert.equal(r.text, "");
  assert.equal(r.full, true);
  assert.ok(r.directive.includes("тело"));
});

test("splitDirective: ordinary text passes untouched, tags stripped", () => {
  assert.deepEqual(splitDirective("просто сообщение"), { text: "просто сообщение", directive: null, full: false });
  const tagged = splitDirective("текст <!-- OMO_INTERNAL_INITIATOR -->");
  assert.equal(tagged.text, "текст");
  assert.equal(tagged.directive, null);
  assert.deepEqual(splitDirective(null), { text: "", directive: null, full: false });
});

// ---- multi-agent -------------------------------------------------------------

test("isAgentTool: opencode task tool is an agent run, bash is not", () => {
  assert.equal(isAgentTool({ type: "tool", tool: "task" }), true);
  assert.equal(isAgentTool({ type: "tool", tool: "Agent" }), true);
  assert.equal(isAgentTool({ type: "tool", tool: "bash" }), false);
  assert.equal(isAgentTool({ type: "text" }), false);
  assert.equal(isAgentTool(null), false);
});

test("fmtElapsed: compact seconds/minutes/hours", () => {
  assert.equal(fmtElapsed(0), "0с");
  assert.equal(fmtElapsed(34000), "34с");
  assert.equal(fmtElapsed(125000), "2м 05с");
  assert.equal(fmtElapsed(4320000), "1ч 12м");
  assert.equal(fmtElapsed(NaN), "");
  assert.equal(fmtElapsed(-5), "");
});

test("displayTitle: harness default becomes Без названия", () => {
  assert.equal(displayTitle("New session - 2026-10-31T10:26:07.425Z"), "Без названия");
  assert.equal(displayTitle("new session - 2026-10-31T10:26:07.425Z"), "Без названия");
  assert.equal(displayTitle("Анализ задолженности 45 414 рублей"), "Анализ задолженности 45 414 рублей");
  assert.equal(displayTitle("  "), "Без названия");
  assert.equal(displayTitle(null), "Без названия");
});

test("isSubagentSession: parentID/subagent-agent hide, user chats stay", () => {
  const sub = [
    { name: "librarian", mode: "subagent" },
    { name: "multimodal-looker", mode: "subagent" },
    { name: "build", mode: "subagent" },
  ];
  // opencode's own marker: parentID → hidden regardless of title/agent
  assert.equal(isSubagentSession({ title: "Find GitHub QA skills", agent: "librarian", parentID: "ses_parent" }, sub), true);
  assert.equal(isSubagentSession({ title: "Чат", agent: null, parentID: "ses_parent" }, []), true);
  // agent-mode rule covers records without parent (once /agent loads)
  assert.equal(isSubagentSession({ title: "Describe layout", agent: "multimodal-looker" }, sub), true);
  // agents not loaded yet + no parentID → stays visible briefly, then filters
  assert.equal(isSubagentSession({ title: "Describe layout", agent: "multimodal-looker" }, []), false);
  // primary user agents never hide
  assert.equal(isSubagentSession({ title: "Разбор зависшей сессии", agent: "Sisyphus - ultraworker" }, sub), false);
  assert.equal(isSubagentSession({ title: "Чат", agent: null }, sub), false);
});

test("normalizeDialogRecords: REST records shape like SSE asks, junk drops", () => {
  const list = normalizeDialogRecords([
    {
      kind: "permission",
      id: "per_1",
      sessionID: "ses_1",
      permission: "bash",
      patterns: ["rm *"],
      metadata: { command: "rm junk" },
      always: ["rm *"],
      askedAt: 123,
      directory: "C:\\H",
    },
    {
      kind: "question",
      id: "que_1",
      sessionID: "ses_1",
      questions: [{ question: "Q?", header: "H", options: [{ label: "A" }] }],
    },
    { kind: "permission", id: "per_2", askedAt: "не число" },
    null,
    { kind: "weird", id: "x" },
    { id: "no-kind" },
  ]);
  assert.equal(list.length, 3, "junk records must drop");
  const p = list[0];
  assert.equal(p.kind, "permission");
  assert.equal(p.id, "per_1");
  assert.equal(p.sessionID, "ses_1");
  assert.equal(p.permission, "bash");
  assert.equal(p.command, "rm junk", "the command comes from metadata like on the SSE wire");
  assert.deepEqual(p.always, ["rm *"]);
  assert.equal(p.askedAt, 123);
  const q = list[1];
  assert.equal(q.kind, "question");
  assert.deepEqual(q.questions, [{ question: "Q?", header: "H", options: [{ label: "A" }] }]);
  assert.equal(q.askedAt, null, "records without a numeric askedAt carry null");
  assert.equal(list[2].id, "per_2");
});

test("normalizeDialogRecords: non-array input yields an empty list", () => {
  assert.deepEqual(normalizeDialogRecords(null), []);
  assert.deepEqual(normalizeDialogRecords("nope"), []);
});

test("collapseToolRuns: identical consecutive tool calls collapse with a counter", () => {
  const echo = (i) => ({ id: `p${i}`, type: "tool", tool: "bash", state: { status: "completed", input: { command: "echo x" }, title: "echo x" } });
  const parts = [echo(1), echo(2), echo(3), { id: "t", type: "text", text: "D3D_�,D_D�D_" }, echo(4)];
  const out = collapseToolRuns(parts);
  assert.equal(out.length, 3); // [echo-run ×3] [text] [echo ×1]
  assert.equal(out[0].count, 3);
  assert.equal(out[0].part.id, "p3"); // freshest wins
  assert.equal(out[1].part.type, "text");
  assert.equal(out[2].count, 1); // same call, but the run was broken by text
  // a differing argument must NOT collapse
  const diff = { id: "z", type: "tool", tool: "bash", state: { input: { command: "echo y" }, title: "echo y" } };
  assert.equal(collapseToolRuns([echo(1), diff, echo(2)]).length, 3);
  assert.equal(collapseToolRuns(null).length, 0);
});

test("collectArtifacts: write-tool files chip only inside the session dir", () => {
  const write = (p) => ({ id: "w", type: "tool", tool: "write", state: { status: "completed", input: { filePath: p } } });
  const parts = [write("C:\\Users\\USER\\qa-files\\qa-picture.png"), write("D:\\Portal\\zai\\src\\lib\\version.js")];
  const out = collectArtifacts(parts, [], "C:\\Users\\USER");
  assert.deepEqual(out, ["C:\\Users\\USER\\qa-files\\qa-picture.png"], "вне папки сессии — не чип (leak audit)");
});

test("collectArtifacts: script-generated artifacts from the final text chip (scoped)", () => {
  const text = `Готово — 4 артефакта созданы в C:\\Users\\USER\\qa-files\\:
| qa-picture.png | C:\\Users\\USER\\qa-files\\qa-picture.png | 12 592 B |
| qa-table.xlsx | C:\\Users\\USER\\qa-files\\qa-table.xlsx | 2 097 B |
| qa-doc.pdf | C:\\Users\\USER\\qa-files\\qa-doc.pdf | 1 084 B |`;
  const out = collectArtifacts([], [text], "C:\\Users\\USER");
  assert.equal(out.length, 3);
  assert.ok(out[0].endsWith("qa-picture.png"));
  assert.ok(out.every((p) => p.toLowerCase().replace(/\\/g, "/").startsWith("c:/users/user/qa-files/")));
});

test("collectArtifacts: text path outside the session dir never chips (leak guard)", () => {
  const text = "Правку внёс в D:\\Portal\\zai\\src\\app.css и заметку D:\\Obsidian\\notes\\x.md.";
  assert.deepEqual(collectArtifacts([], [text], "C:\\Users\\USER"), []);
});

test("collectArtifacts: unknown session dir hides everything", () => {
  const write = { id: "w", type: "tool", tool: "write", state: { status: "completed", input: { filePath: "C:\\Users\\USER\\qa-files\\qa-doc.pdf" } } };
  assert.deepEqual(collectArtifacts([write], ["См. C:\\Users\\USER\\qa-files\\qa-doc.pdf"], ""), []);
});

test("collectArtifacts: dedupe write + text mention of the same file, order of appearance", () => {
  const write = { id: "w", type: "tool", tool: "write", state: { status: "completed", input: { filePath: "C:\\Users\\USER\\qa-files\\qa-page.html" } } };
  const text = "Страница: C:\\Users\\USER\\qa-files\\qa-page.html и отчёт C:\\Users\\USER\\qa-files\\qa-doc.pdf";
  const out = collectArtifacts([write], [text], "C:\\Users\\USER");
  assert.equal(out.length, 2);
  assert.ok(out[0].toLowerCase().endsWith("qa-page.html"));
  assert.ok(out[1].toLowerCase().endsWith("qa-doc.pdf"));
});

test("collectArtifacts: cap 8 across both sources", () => {
  const parts = [];
  for (let i = 1; i <= 5; i++) parts.push({ id: `w${i}`, type: "tool", tool: "write", state: { status: "completed", input: { filePath: `C:\\Users\\USER\\qa-files\\f${i}.md` } } });
  let text = "";
  for (let i = 6; i <= 12; i++) text += `C:\\Users\\USER\\qa-files\\g${i}.md `;
  const out = collectArtifacts(parts, [text], "C:\\Users\\USER");
  assert.equal(out.length, 8);
});

// BUG-155 (BUG-05.26): a glob mask in the answer is not a file — no chip, no /zai/api/file 404.
test("BUG-155: paths with * or ? are not artifacts", () => {
  const dir = String.raw`C:\Users\USER`;
  const text = String.raw`Превью лежат в C:\Users\USER\zai-preview\*.svg и C:\Users\USER\out\chart?.png, а итог — C:\Users\USER\zai-preview\a.svg; см. /home/u/x/*.md`;
  const want = [String.raw`C:\Users\USER\zai-preview\a.svg`];
  assert.deepEqual(extractFilePaths(text), want);
  assert.deepEqual(collectArtifactEntries([], [text], dir).map((e) => e.path), want);
});
