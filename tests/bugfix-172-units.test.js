// bugfix-1.7.2 server units (no processes, no sockets):
//   BUG-13.14 / BUG-01.27  shared/title.js + lib/title.js generateTitle
//   BUG-11.13              lib/empty-turn.js, policy.pickDefaultModel
//   BUG-01.48              lib/gc.js selectEmptyChats / runEmptyChatGc
//   BUG-04.6               lib/gc.js PendingRemovals
//   config                 new env keys validated
// Run: node --test tests/bugfix-172-units.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanLlmTitle,
  clipTitle,
  firstUserText,
  heuristicTitle,
  isDefaultTitle,
  snapshotDerivedTitle,
  splitInjected,
  typedText,
} from "../shared/title.js";
import { splitInjected as clientSplit } from "../src/lib/normalize.js";
import { generateTitle, titleArgs, TitleStore } from "../lib/title.js";
import { EMPTY_TURN_ERROR, isContentPart, isEmptyAnswer, markEmptyTail } from "../lib/empty-turn.js";
import { parseModelRef, pickDefaultModel } from "../lib/policy.js";
import { PendingRemovals, runEmptyChatGc, selectEmptyChats } from "../lib/gc.js";
import { loadConfig } from "../lib/config.js";

const SNAP =
  "[obsidian-cache] Снапшот базы знаний (Obsidian)\n" +
  "Последний дайджест: zai.home.example.net HTTPS IPv6\n---\nстарый дайджест\n" +
  "Правила кэша: читай vault, если нужно больше\n\n---\n\n";

// ---- titles -------------------------------------------------------------------

test("BUG-13.14: splitInjected is the exact server twin of the client helper", () => {
  for (const s of [SNAP + "Ответь одним словом: столица Италии?", "просто вопрос", "[obsidian-cache] x\n---\n", SNAP + "  ", "[obsidian-cache] a\n---\nb"]) {
    assert.deepEqual(splitInjected(s), clientSplit(s), JSON.stringify(s));
  }
  assert.equal(splitInjected(SNAP + "Вопрос?").text, "Вопрос?");
});

test("BUG-13.14: typedText drops snapshot, directives and attachment references", () => {
  const raw = SNAP + "Посмотри файл [Пользователь приложил файл: .zai-uploads/a.pdf (10 байт, application/pdf). Файл лежит в папке сессии.] и скажи итог [SYSTEM DIRECTIVE: OH-MY-OPENCODE continue]";
  assert.equal(typedText(raw), "Посмотри файл и скажи итог");
});

test("BUG-13.14: default titles", () => {
  assert.equal(isDefaultTitle(""), true);
  assert.equal(isDefaultTitle(null), true);
  assert.equal(isDefaultTitle("New session - 2026-11-03T08:00:00.000Z"), true);
  assert.equal(isDefaultTitle("Child session - 2026-11-03T08:00:00.000Z"), true);
  assert.equal(isDefaultTitle("Столица Италии"), false);
});

test("BUG-13.14: heuristic title — first phrase, word cut ≤60, capitalized, never the snapshot", () => {
  assert.equal(heuristicTitle(SNAP + "ответь одним словом: столица Италии? И ещё вопрос."), "Ответь одним словом: столица Италии?");
  const long = "как настроить резервное копирование домашнего NAS на внешний диск по расписанию каждую ночь без участия человека";
  const t = heuristicTitle(long);
  assert.ok(t.length <= 60, t);
  assert.match(t, /^Как настроить резервное/);
  assert.match(t, /…$/);
  assert.ok(!/\s…$/.test(t), "cut at a word, no dangling space");
  assert.equal(heuristicTitle(SNAP), heuristicTitle(SNAP), "degenerate shape tolerated");
  assert.equal(heuristicTitle("   "), "");
  assert.equal(heuristicTitle("Hi."), "Hi", "short phrase: whole text");
  assert.ok(clipTitle("a".repeat(100)).length <= 60);
});

test("BUG-13.14: LLM output cleaning", () => {
  assert.equal(cleanLlmTitle("Заголовок: «Столица Италии».\n"), "Столица Италии");
  assert.equal(cleanLlmTitle('\n\n"Backup plan for NAS"'), "Backup plan for NAS");
  assert.equal(cleanLlmTitle("**Резервное копирование**"), "Резервное копирование");
  assert.equal(cleanLlmTitle('{"type":"system"}'), "", "machine output is not a title");
  assert.equal(cleanLlmTitle(""), "");
  assert.ok(cleanLlmTitle("x ".repeat(80)).length <= 60);
});

test("BUG-01.27: snapshot-derived upstream title detection", () => {
  const raw = SNAP + "Ответь одним словом: столица Италии?";
  assert.equal(snapshotDerivedTitle("zai.home.example.net HTTPS IPv6", raw), true, "retells the snapshot");
  assert.equal(snapshotDerivedTitle("Кэш Obsidian и правила", raw), true, "names the snapshot");
  assert.equal(snapshotDerivedTitle("Столица Италии", raw), false, "shares a word with the question");
  assert.equal(snapshotDerivedTitle("zai.home.example.net HTTPS IPv6", "Ответь одним словом: столица Италии?"), false, "no snapshot → never replaced");
  assert.equal(snapshotDerivedTitle("New session - 2026-11-03T08:00:00.000Z", raw), false, "default title is not judged");
  assert.equal(snapshotDerivedTitle("[obsidian-cache] Снапшот", raw), true);
});

test("BUG-01.27: firstUserText takes the first user message, synthetic parts skipped", () => {
  const list = [
    { info: { role: "user" }, parts: [{ type: "text", text: "служебное", synthetic: true }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "ответ" }] },
    { info: { role: "user" }, parts: [{ type: "file", url: "x" }, { type: "text", text: "вопрос" }] },
  ];
  assert.equal(firstUserText(list), "вопрос");
  assert.equal(firstUserText(null), "");
});

test("BUG-13.14: generateTitle — LLM first, heuristic on failure / garbage / timeout", async () => {
  const raw = SNAP + "Ответь одним словом: столица Италии?";
  let seen = null;
  const ok = await generateTitle(raw, { llm: async (t) => ((seen = t), "Столица Италии") });
  assert.deepEqual(ok, { title: "Столица Италии", via: "llm" });
  assert.equal(seen, "Ответь одним словом: столица Италии?", "the generator never sees the snapshot");
  const logs = [];
  const fail = await generateTitle(raw, { llm: async () => Promise.reject(new Error("timed out")), log: (m) => logs.push(m) });
  assert.deepEqual(fail, { title: "Ответь одним словом: столица Италии?", via: "heuristic" });
  assert.match(logs[0], /heuristic/);
  assert.equal((await generateTitle(raw, { llm: async () => "" })).via, "heuristic");
  assert.equal(await generateTitle(SNAP, { llm: async () => "x" }), null, "nothing typed → no title");
});

test("BUG-13.14: title CLI argv — no tools, no MCP, no persistence, prompt never in argv", () => {
  const a = titleArgs("claude-haiku-4-5");
  assert.equal(a[a.indexOf("--tools") + 1], "");
  assert.ok(a.includes("--strict-mcp-config"));
  assert.ok(a.includes("--no-session-persistence"));
  assert.equal(a[a.indexOf("--model") + 1], "claude-haiku-4-5");
  assert.equal(a[a.indexOf("--input-format") + 1], "text");
});

test("BUG-13.14: TitleStore persists marks", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zai-title-store-"));
  try {
    const file = path.join(dir, "t.json");
    const s = new TitleStore({ storePath: file });
    s.set("ses_a", { source: "user" });
    assert.equal(new TitleStore({ storePath: file }).get("ses_a").source, "user");
    s.forget("ses_a");
    assert.equal(new TitleStore({ storePath: file }).get("ses_a"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- empty turns (BUG-11.13) -------------------------------------------------------

test("BUG-11.13: empty answer detection and history marking (tail only)", () => {
  const u = { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "q" }] };
  const empty = { info: { id: "a1", role: "assistant", time: { created: 1, completed: 2 } }, parts: [{ type: "step-start" }, { type: "step-finish" }] };
  assert.equal(isContentPart({ type: "text", text: "  " }), false);
  assert.equal(isContentPart({ type: "tool" }), true);
  assert.equal(isEmptyAnswer(empty), true);
  assert.equal(isEmptyAnswer({ ...empty, info: { ...empty.info, time: { created: 1 } } }), false, "still running");
  assert.equal(isEmptyAnswer({ ...empty, info: { ...empty.info, error: { name: "X" } } }), false, "has its own error");
  const marked = markEmptyTail([u, empty]);
  assert.equal(marked[1].info.error.name, EMPTY_TURN_ERROR.name);
  assert.equal(empty.info.error, undefined, "input not mutated");
  const withTool = [u, { info: { id: "a0", role: "assistant", time: { completed: 1 } }, parts: [{ type: "tool", tool: "read" }] }, empty];
  assert.equal(markEmptyTail(withTool), withTool, "a tool step earlier in the turn = a normal answer");
  const answered = [u, { ...empty, parts: [{ type: "text", text: "ok" }] }];
  assert.equal(markEmptyTail(answered), answered);
});

test("BUG-11.13: default model for a prompt without one — never claude implicitly", () => {
  assert.deepEqual(parseModelRef("zai-coding-plan/glm-5.3"), { providerID: "zai-coding-plan", modelID: "glm-5.3" });
  assert.equal(parseModelRef("nope"), null);
  assert.deepEqual(pickDefaultModel({ preferred: "zai/glm-5" }), { providerID: "zai", modelID: "glm-5" });
  assert.deepEqual(pickDefaultModel({ configModel: "zai-coding-plan/glm-5.3" }), { providerID: "zai-coding-plan", modelID: "glm-5.3" });
  const catalog = { connected: ["anthropic", "zai-coding-plan"], default: { anthropic: "claude-opus-5-5", "zai-coding-plan": "glm-5.3-flash" } };
  assert.deepEqual(pickDefaultModel({ configModel: "anthropic/claude-opus-5-5", catalog }), { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" });
  assert.deepEqual(pickDefaultModel({ configModel: "openai/gpt", catalog }), { providerID: "zai-coding-plan", modelID: "glm-5.3-flash" }, "a disconnected provider is skipped");
  assert.equal(pickDefaultModel({}), null);
});

// ---- empty-chat gc (BUG-01.48) -------------------------------------------------------

const NOW = Date.parse("2026-11-03T12:00:00Z");
const OLD = NOW - 2 * 3_600_000;
const DEF = "New session - 2026-11-03T10:00:00.000Z";
const S = (id, extra = {}) => ({ id, directory: "C:\\H", title: DEF, time: { created: OLD, updated: OLD }, ...extra });

test("BUG-01.48: candidates — default title, old, untouched, not busy/dialog/claude/child", () => {
  const sessions = [
    S("ses_empty"),
    S("ses_titled", { title: "Про NAS" }),
    S("ses_fresh", { time: { created: NOW - 60_000, updated: NOW - 60_000 } }),
    S("ses_touched", { time: { created: OLD, updated: NOW - 60_000 } }),
    S("ses_busy"),
    S("ses_dialog"),
    S("ses_claude"),
    S("ses_child", { parentID: "ses_empty" }),
    S("ses_secs", { time: { created: Math.floor(OLD / 1000), updated: Math.floor(OLD / 1000) } }),
  ];
  const ids = selectEmptyChats({ sessions, minAgeMs: 30 * 60_000, now: NOW, busy: new Set(["ses_busy"]), dialogs: new Set(["ses_dialog"]), claude: new Set(["ses_claude"]) }).map((c) => c.id);
  assert.deepEqual(ids, ["ses_empty", "ses_secs"]);
  assert.deepEqual(selectEmptyChats({ sessions, minAgeMs: 0, now: NOW }), [], "0 disables");
});

test("BUG-01.48: sweep deletes ONLY chats confirmed to have zero messages", async () => {
  const sessions = [S("ses_a"), S("ses_b"), S("ses_c"), S("ses_d")];
  const counts = { ses_a: 0, ses_b: 3, ses_c: null, ses_d: 0 };
  const deleted = [];
  const logs = [];
  const r = await runEmptyChatGc({
    sessions,
    minAgeMs: 30 * 60_000,
    now: NOW,
    countMessages: async (id) => counts[id],
    isBusy: (id) => id === "ses_d", // became busy between the scan and the delete
    deleteSession: async (id) => (deleted.push(id), true),
    log: (m) => logs.push(m),
  });
  assert.deepEqual(deleted, ["ses_a"]);
  assert.deepEqual(r.deleted, ["ses_a"]);
  assert.deepEqual(r.kept.map((k) => `${k.id}:${k.reason}`).sort(), ["ses_b:has-messages", "ses_c:unknown", "ses_d:busy"]);
  assert.match(logs[0], /deleted empty chat ses_a/);
});

test("BUG-01.48: dryRun reports exactly what the sweep would delete and deletes nothing", async () => {
  const sessions = [S("ses_a"), S("ses_b"), S("ses_c"), S("ses_d")];
  const counts = { ses_a: 0, ses_b: 3, ses_c: null, ses_d: 0 };
  const args = { sessions, minAgeMs: 30 * 60_000, now: NOW, countMessages: async (id) => counts[id], isBusy: (id) => id === "ses_d" };
  let deletes = 0;
  const dry = await runEmptyChatGc({ ...args, dryRun: true, deleteSession: async () => (deletes++, true) });
  assert.equal(deletes, 0);
  assert.deepEqual(dry.deleted, []);
  assert.deepEqual(dry.wouldDelete.map((c) => c.id), ["ses_a"]);
  const real = await runEmptyChatGc({ ...args, deleteSession: async () => true });
  assert.deepEqual(real.deleted, dry.wouldDelete.map((c) => c.id), "report == sweep");
  assert.deepEqual(dry.kept, real.kept);
});

// ---- leftover tenant folders (BUG-04.6) ---------------------------------------------

test("BUG-04.6: PendingRemovals — retried, kept with the reason on failure, dropped when owned again", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zai-pending-"));
  try {
    const file = path.join(dir, "pending.json");
    const a = path.join(dir, "a");
    const b = path.join(dir, "b");
    const c = path.join(dir, "c");
    for (const d of [a, b, c]) {
      mkdirSync(d);
      writeFileSync(path.join(d, "f.txt"), "x");
    }
    const pr = new PendingRemovals(file);
    pr.add([{ path: a, userId: "u" }, { path: b }, { path: c }, { path: path.join(dir, "gone") }]);
    let busy = true;
    const disposed = [];
    const r1 = await pr.retry({
      isReferenced: (p) => p === c,
      beforeRemove: async (p) => disposed.push(p),
      rm: (p) => {
        if (p === b && busy) throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
        rmSync(p, { recursive: true, force: true });
      },
    });
    assert.deepEqual(r1.removed.sort(), [a, path.join(dir, "gone")].sort());
    assert.deepEqual(r1.left.map((x) => x.path), [b]);
    assert.match(r1.left[0].reason, /EBUSY/);
    assert.ok(existsSync(c), "a folder owned again is never deleted");
    assert.ok(!existsSync(a));
    assert.ok(disposed.includes(b));
    const reloaded = new PendingRemovals(file).list();
    assert.deepEqual(reloaded.map((x) => x.path), [b], "persisted for the next start");
    assert.equal(reloaded[0].attempts, 1);
    busy = false;
    const pr2 = new PendingRemovals(file);
    const r2 = await pr2.retry({ rm: (p) => rmSync(p, { recursive: true, force: true }) });
    assert.deepEqual(r2.removed, [b]);
    assert.deepEqual(pr2.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- config --------------------------------------------------------------------------

test("bugfix-1.7.2 config keys: defaults and validation", () => {
  const d = loadConfig({});
  assert.equal(d.config.ZAI_GC_EMPTY_MIN, 30);
  assert.equal(d.config.ZAI_TITLE_LLM, true);
  assert.equal(d.config.ZAI_TITLE_MODEL, "claude-haiku-4-5");
  assert.equal(d.config.ZAI_TITLE_TIMEOUT_MS, 20_000);
  const bad = loadConfig({ ZAI_GC_EMPTY_MIN: "3o", ZAI_TITLE_LLM: "yes" });
  assert.equal(bad.errors.length, 2);
});
