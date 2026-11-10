// FEAT-01.32 / BUG-01.27: the user bubble shows only the typed text; the
// knowledge-base snapshot (metadata.kbContext, both engines) becomes the quiet
// «Контекст из базы знаний» row — expandable for admin only. Legacy messages
// (snapshot inside the text) render the same way.
import { test, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { $, $$, createHarness, loadUI } from "./helpers/load.mjs";

let ui, t$;
before(async () => {
  ui = await loadUI({ MessageBubble: "src/components/chat/MessageBubble.jsx" });
  t$ = createHarness(ui);
});
afterEach(() => {
  t$.cleanup();
  ui.store.me.value = null;
  ui.store.sessions.value = [];
  ui.store.active.value = null;
});

const SNAP = "[obsidian-cache] Активный кэш проекта «zai».\n\nПравила кэша: D:\\Obsidian\\agents\\_index.md.";
const userMsg = (parts) => ({ info: { id: "u1", role: "user", sessionID: "s1", time: { created: 1 } }, parts });

test("metadata.kbContext: bubble = typed text, admin gets the expandable context row", () => {
  ui.store.me.value = { id: "admin", name: "A", role: "admin" };
  const { root } = t$.mount(ui.MessageBubble, { msg: userMsg([{ id: "p", type: "text", text: "Привет", metadata: { kbContext: SNAP } }]) });
  assert.ok($(root, "details.turn-ctx"), "admin: expandable row");
  assert.equal($(root, ".turn-ctx .ctx-body").textContent, SNAP);
  const outside = root.cloneNode(true);
  for (const e of $$(outside, ".msg-turnctx")) e.remove();
  assert.ok(outside.textContent.includes("Привет"));
  assert.equal(outside.textContent.includes("obsidian-cache"), false, "the bubble shows only the typed text");
});

test("tenant: a static row, the snapshot text is not rendered", () => {
  ui.store.me.value = { id: "t", name: "T", role: "user" };
  const { root } = t$.mount(ui.MessageBubble, { msg: userMsg([{ id: "p", type: "text", text: "Привет", metadata: { kbContext: SNAP } }]) });
  assert.ok($(root, ".turn-ctx.is-static"));
  assert.equal(root.textContent.includes("Правила кэша"), false);
});

test("legacy message (snapshot inside the text) — same look, no double row", () => {
  ui.store.me.value = { id: "admin", name: "A", role: "admin" };
  const { root } = t$.mount(ui.MessageBubble, { msg: userMsg([{ id: "p", type: "text", text: `${SNAP}\n\n---\n\nПривет` }]) });
  assert.equal($$(root, ".turn-ctx").length, 1);
  assert.equal($(root, ".turn-ctx .ctx-body").textContent, SNAP);
});

// Ревью 212 (N-1): подпись досланного сообщения по движку чата — opencode вплетает его в ход.
test("queued bubble: Claude — «В очереди — отправится после текущего хода», opencode — «учтёт на ближайшем шаге»", () => {
  const q = { info: { id: "u2", role: "user", sessionID: "s1", queued: true, time: { created: 2 } }, parts: [{ id: "p2", type: "text", text: "досылка" }] };
  const a = { info: { id: "a1", role: "assistant", sessionID: "s1", time: { created: 1 } }, parts: [] };
  for (const [model, re] of [
    [{ providerID: "anthropic", modelID: "claude-opus-5-5" }, /В очереди — отправится после текущего хода/],
    [{ providerID: "zai-coding-plan", modelID: "glm-5.3-flash" }, /Доставлено — агент учтёт его на ближайшем шаге/],
  ]) {
    ui.store.sessions.value = [{ id: "s1", zai: { model } }];
    ui.store.active.value = { id: "s1", status: "busy", messages: [a, q] };
    const { root } = t$.mount(ui.MessageBubble, { msg: q });
    const tag = $(root, ".queue-tag");
    assert.ok(tag, "queue tag shown");
    assert.match(tag.textContent, re);
    t$.cleanup();
  }
});
