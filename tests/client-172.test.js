// zai 1.7.2 client fixes (openspec bugfix-1.7.2): chat titles live from the
// server (BUG-01.27 / BUG-083, client half), pictures made by a shell command
// (BUG-05.13 / BUG-079), image viewer size (BUG-05.14), CSS of the 20-chip
// composer (BUG-05.12) and of the row actions (BUG-01.44).
// No network. Run: node --test tests/client-172.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as store from "../src/lib/store.js";
import {
  collectArtifactEntries,
  groupSessionsByDate,
  commandImagePaths,
  dataUrlBytes,
  displayTitle,
  firstUserText,
  isScratchPath,
} from "../src/lib/normalize.js";

const { active, firstTexts, handleEvent, sessions } = store;
const S = "D:\\Chats\\s1";
const bash = (command, { status = "completed", tool = "bash", ...input } = {}) => ({
  type: "tool",
  tool,
  state: { status, input: { command, ...input } },
});

function reset() {
  active.value = null;
  sessions.value = [];
  firstTexts.value = {};
}

// ---- BUG-05.13 / BUG-079: pictures from a shell command ----------------------

test("BUG-098: Git Bash paths /d/… and cd /d/… are the D: drive, not the chat folder", () => {
  assert.deepEqual(commandImagePaths(bash("cp data.bin /d/Portal/zai/shots/a.png"), S), ["D:\\Portal\\zai\\shots\\a.png"]);
  assert.deepEqual(commandImagePaths(bash("cd /c/Users/USER && python plot.py --out chart.png"), S), ["C:\\Users\\USER\\chart.png"]);
  assert.deepEqual(commandImagePaths(bash("ls /mnt/d/pics/p.jpg"), S), ["D:\\pics\\p.jpg"]);
  assert.deepEqual(commandImagePaths(bash("cp a /tmp/x.png"), S), ["/tmp/x.png"], "/tmp — не диск");
  // live-smoke прода 1.8.6: «ls C:\Users\USER\*.png» → 404 на /file?path=…\*.png
  assert.deepEqual(commandImagePaths(bash("ls C:\\Users\\USER\\*.png shot-?.jpg"), S), [], "маски — не файлы");
});

test("BUG-05.13: image paths from a completed bash command resolve into the session folder", () => {
  assert.deepEqual(commandImagePaths(bash("python plot.py --out chart.png"), S), ["D:\\Chats\\s1\\chart.png"]);
  assert.deepEqual(commandImagePaths(bash("magick D:\\Chats\\s1\\out\\big.png -resize 50% D:/Chats/s1/out/small.webp"), S), [
    "D:\\Chats\\s1\\out\\big.png",
    "D:\\Chats\\s1\\out\\small.webp",
  ]);
  // quoted (spaces) and inside python -c code
  assert.deepEqual(commandImagePaths(bash('copy x "D:\\Chats\\s1\\My dir\\a b.png"'), S), ["D:\\Chats\\s1\\My dir\\a b.png"]);
  assert.deepEqual(commandImagePaths(bash(`python -c "import matplotlib; plt.savefig('red.png')"`), S), ["D:\\Chats\\s1\\red.png"]);
  // --out=…, > redirect, ./ prefix, nested relative folder
  assert.deepEqual(commandImagePaths(bash("gen --out=a.jpg > ./b.gif && conv charts/c.svg"), S), [
    "D:\\Chats\\s1\\a.jpg",
    "D:\\Chats\\s1\\b.gif",
    "D:\\Chats\\s1\\charts\\c.svg",
  ]);
});

test("BUG-05.13: relative names follow the tool's working folder (workdir/cwd, a leading cd)", () => {
  assert.deepEqual(commandImagePaths(bash("python a.py -o w.png", { workdir: "D:\\Chats\\s1\\sub" }), S), ["D:\\Chats\\s1\\sub\\w.png"]);
  assert.deepEqual(commandImagePaths(bash("python a.py -o w.png", { cwd: "charts" }), S), ["D:\\Chats\\s1\\charts\\w.png"]);
  assert.deepEqual(commandImagePaths(bash("cd charts && python gen.py -o out.png"), S), ["D:\\Chats\\s1\\charts\\out.png"]);
  assert.deepEqual(commandImagePaths(bash('cd /d "D:\\Chats\\s1\\x y" && run -o z.png'), S), ["D:\\Chats\\s1\\x y\\z.png"]);
});

test("BUG-086: shell variables — $PWD/%CD% mean the working folder, other variables are skipped", () => {
  assert.deepEqual(commandImagePaths(bash(`$b.Save("$PWD\\dot.png")`), S), ["D:\\Chats\\s1\\dot.png"]);
  assert.deepEqual(commandImagePaths(bash(`x "\${PWD}/a.png" "$(pwd)/b.png" "%CD%\\c.png"`), S), [
    "D:\\Chats\\s1\\a.png",
    "D:\\Chats\\s1\\b.png",
    "D:\\Chats\\s1\\c.png",
  ]);
  assert.deepEqual(commandImagePaths(bash(`x "$env:TEMP\\a.png" "$out\\b.png" "%TEMP%\\c.png"`), S), []);
});

test("BUG-05.13: no URL, variable, «..», upload ref; not from a running/failed call or a non-shell tool", () => {
  assert.deepEqual(commandImagePaths(bash("curl https://example.com/a.png -o $name.png ../up.png .zai-uploads/u.png"), S), []);
  assert.deepEqual(commandImagePaths(bash("python plot.py -o chart.png", { status: "running" }), S), []);
  assert.deepEqual(commandImagePaths(bash("python plot.py -o chart.png", { status: "error" }), S), []);
  assert.deepEqual(commandImagePaths(bash("python plot.py -o chart.png", { tool: "read" }), S), []);
  assert.deepEqual(commandImagePaths(bash("python plot.py -o chart.png"), ""), [], "unknown session folder → nothing");
  assert.deepEqual(commandImagePaths(bash("x -o chart.png", { tool: "Bash" }), S), ["D:\\Chats\\s1\\chart.png"], "Claude-style tool name");
});

test("BUG-05.13: collectArtifactEntries — command pictures are chips marked guessed (404 hides the card); Temp and outside folders are not", () => {
  const parts = [
    bash("python plot.py --out chart.png"),
    bash("x C:\\Users\\USER\\AppData\\Local\\Temp\\opencode\\z.png"),
    bash("y D:\\Other\\q.png"),
    bash("python plot.py --out later.png", { status: "running" }),
  ];
  assert.equal(isScratchPath("C:\\Users\\USER\\AppData\\Local\\Temp\\opencode\\z.png"), true);
  assert.deepEqual(collectArtifactEntries(parts, [], S), [{ path: "D:\\Chats\\s1\\chart.png", guessed: true }]);
  // The same picture named by the text with its full path: one chip, not guessed
  // (the text path wins — the absolute path keeps the broken-card face).
  assert.deepEqual(collectArtifactEntries(parts, ["Готово: D:\\Chats\\s1\\chart.png"], S), [{ path: "D:\\Chats\\s1\\chart.png", guessed: false }]);
  // A bare name in the text after the command made it: still one chip.
  assert.deepEqual(collectArtifactEntries(parts, ["Готово: chart.png"], S), [{ path: "D:\\Chats\\s1\\chart.png", guessed: true }]);
  // write/edit files keep their place first.
  const withWrite = [{ type: "tool", tool: "write", state: { status: "completed", input: { filePath: "D:\\Chats\\s1\\a.md" } } }, ...parts];
  assert.deepEqual(collectArtifactEntries(withWrite, [], S).map((e) => e.path), ["D:\\Chats\\s1\\a.md", "D:\\Chats\\s1\\chart.png"]);
});

// ---- BUG-01.27 / BUG-083: titles ----------------------------------------------

test("BUG-01.27: firstUserText — the first sent user text (snapshot included), failed bubbles skipped", () => {
  const msgs = [
    { info: { id: "u0", role: "user", failed: true }, parts: [{ type: "text", text: "не ушло" }] },
    { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "Сводка продаж" }, { type: "text", text: "служебное", synthetic: true }] },
    { info: { id: "a1", role: "assistant" }, parts: [{ type: "text", text: "ответ" }] },
  ];
  assert.equal(firstUserText(msgs), "Сводка продаж");
  assert.equal(firstUserText([]), null);
  assert.equal(displayTitle("", null), "Без названия");
  assert.equal(displayTitle("", "Сводка продаж за квартал"), "Сводка продаж за квартал");
});

test("BUG-083: session.updated with a new title updates the list and the open chat — no reload", () => {
  reset();
  sessions.value = [{ id: "ses_t", title: "", directory: S, time: { updated: 1 } }];
  active.value = { id: "ses_t", title: "", status: "idle", messages: [] };
  handleEvent({ type: "session.updated", properties: { info: { id: "ses_t", title: "Отчёт по продажам", directory: S, time: { updated: 2 } } } });
  assert.equal(sessions.value[0].title, "Отчёт по продажам");
  assert.equal(active.value.title, "Отчёт по продажам");
  reset();
});

test("BUG-083: zai.session.title {sessionID, title} patches a known chat and the open chat; an unknown id never enters the list", () => {
  reset();
  sessions.value = [{ id: "ses_a", title: "", directory: S, zai: { engine: "claude" } }];
  active.value = { id: "ses_a", title: "", status: "busy", lastEventAt: 5, lastActivityAt: 5, messages: [] };
  handleEvent({ type: "zai.session.title", properties: { sessionID: "ses_a", title: "Столица Италии" } });
  assert.equal(sessions.value[0].title, "Столица Италии");
  assert.equal(sessions.value[0].directory, S, "the rest of the record survives");
  assert.equal(sessions.value[0].zai.engine, "claude");
  assert.equal(active.value.title, "Столица Италии");
  assert.equal(active.value.lastActivityAt, 5, "a title is not turn progress (stall clock untouched)");
  handleEvent({ type: "zai.session.title", properties: { sessionID: "ses_ghost", title: "x" } });
  assert.deepEqual(sessions.value.map((s) => s.id), ["ses_a"]);
  handleEvent({ type: "zai.session.title", properties: { sessionID: "ses_a" } }); // no title → ignored
  assert.equal(sessions.value[0].title, "Столица Италии");
  reset();
});

// ---- BUG-13.16 / BUG-085: a Claude chat climbs the list on activity ----------

test("BUG-13.16: a partial session.updated {id, directory, time.updated} lifts a Claude chat to the top, keeps the record", () => {
  reset();
  const now = Date.now();
  sessions.value = [
    { id: "ses_glm", title: "GLM-чат", directory: S, time: { created: now - 5000, updated: now - 1000 }, zai: { engine: "opencode" } },
    { id: "ses_cl", title: "Claude-чат", directory: S, time: { created: now - 9000, updated: now - 9000 }, zai: { engine: "claude" } },
  ];
  handleEvent({ type: "session.updated", properties: { sessionID: "ses_cl", info: { id: "ses_cl", directory: S, time: { updated: now } } } });
  assert.deepEqual(sessions.value.map((s) => s.id), ["ses_cl", "ses_glm"], "the store list is re-sorted");
  const top = sessions.value[0];
  assert.equal(top.title, "Claude-чат", "title survives a title-less update");
  assert.equal(top.zai.engine, "claude");
  assert.equal(top.time.created, now - 9000, "time merges per field");
  assert.equal(top.time.updated, now);
  const today = groupSessionsByDate(sessions.value, now).find((g) => g.key === "today");
  assert.equal(today.items[0].id, "ses_cl", "the visible «Сегодня» group shows it first");
  // The opencode chat climbs back the same way (its own session.updated).
  handleEvent({ type: "session.updated", properties: { info: { id: "ses_glm", title: "GLM-чат", directory: S, time: { created: now - 5000, updated: now + 10 } } } });
  assert.deepEqual(sessions.value.map((s) => s.id), ["ses_glm", "ses_cl"]);
  reset();
});

test("BUG-13.16: a stale record never pushes a chat down; a partial update of an unknown chat never enters the list", () => {
  reset();
  sessions.value = [
    { id: "ses_cl", title: "Claude", directory: S, time: { created: 1, updated: 500 } },
    { id: "ses_x", title: "X", directory: S, time: { created: 1, updated: 300 } },
  ];
  handleEvent({ type: "session.updated", properties: { info: { id: "ses_cl", title: "Новое имя", directory: S, time: { created: 1, updated: 1 } } } });
  assert.equal(sessions.value[0].id, "ses_cl");
  assert.equal(sessions.value[0].title, "Новое имя");
  assert.equal(sessions.value[0].time.updated, 500, "updated never goes back");
  handleEvent({ type: "session.updated", properties: { info: { id: "ses_ghost", directory: S, time: { updated: 900 } } } });
  assert.deepEqual(sessions.value.map((s) => s.id), ["ses_cl", "ses_x"], "no title-less stub");
  reset();
});

test("BUG-01.27: the open chat's first user text is remembered for the list (firstTexts)", () => {
  reset();
  active.value = { id: "ses_f", title: "", status: "idle", messages: [] };
  assert.equal(firstTexts.value.ses_f, undefined);
  active.value = { ...active.value, messages: [{ info: { id: "tmp-1", role: "user" }, parts: [{ type: "text", text: "Ответь: столица Италии?" }] }] };
  assert.equal(firstTexts.value.ses_f, "Ответь: столица Италии?");
  active.value = null; // leaving the chat keeps it
  assert.equal(firstTexts.value.ses_f, "Ответь: столица Италии?");
  reset();
});

// ---- BUG-05.14: viewer header size ---------------------------------------------

test("BUG-05.14: dataUrlBytes — base64 padding and plain payloads count decoded bytes", () => {
  const b64 = (buf) => `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;
  assert.equal(dataUrlBytes(b64([1, 2, 3])), 3);
  assert.equal(dataUrlBytes(b64([1, 2, 3, 4])), 4, "«==» padding is not a byte");
  assert.equal(dataUrlBytes(b64([1, 2, 3, 4, 5])), 5, "«=» padding is not a byte");
  assert.equal(dataUrlBytes(b64(new Uint8Array(315))), 315);
  assert.equal(dataUrlBytes("data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E"), "<svg></svg>".length);
  assert.equal(dataUrlBytes("blob:https://x/1"), null);
});

// ---- BUG-05.12 / BUG-01.44: CSS contracts ---------------------------------------

const ruleOf = (css, selector) => {
  const at = css.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `нет правила ${selector}`);
  return css.slice(at, css.indexOf("}", at));
};

test("BUG-05.12: the chip row is height-capped with its own scroll; ✕ is a 44×44 target", () => {
  const css = readFileSync(new URL("../src/components/chat.css", import.meta.url), "utf8");
  const chips = ruleOf(css, ".composer-chips");
  assert.match(chips, /max-height:\s*min\(28dvh,\s*156px\)/);
  assert.match(chips, /overflow-y:\s*auto/);
  const x = ruleOf(css, ".attach-x");
  assert.match(x, /width:\s*44px/);
  assert.match(x, /height:\s*44px/);
});

test("BUG-01.44: keyboard focus inside a row reveals ✎/🗑 (visibility, so Tab can land on them)", () => {
  const css = readFileSync(new URL("../src/components/views.css", import.meta.url), "utf8");
  const rule = ruleOf(css, ".swipe:has(:focus-visible) .swipe-actions");
  assert.match(rule, /visibility:\s*visible/);
  assert.match(rule, /opacity:\s*1/);
});

// ---- BUG-11.13 / BUG-082: the empty-turn face -------------------------------

test("BUG-11.13: EmptyTurnError → «Модель вернула пустой ответ» with «Повторить» (live and from history)", async () => {
  const { describeTurnError, turnErrorFromMessages } = await import("../src/lib/turn.js");
  const err = { name: "EmptyTurnError", data: { message: "Модель завершила ход без ответа и без ошибки (пустой ответ)." } };
  for (const engine of ["opencode", "claude"]) {
    const d = describeTurnError(err, { engine });
    assert.equal(d.kind, "empty");
    assert.equal(d.title, "Модель вернула пустой ответ");
    assert.deepEqual(d.actions, ["retry"]);
  }
  const hist = [
    { info: { id: "u", role: "user" }, parts: [{ type: "text", text: "q" }] },
    { info: { id: "a", role: "assistant", error: err, time: { completed: 1 } }, parts: [] },
  ];
  assert.equal(turnErrorFromMessages(hist).kind, "empty");
});
