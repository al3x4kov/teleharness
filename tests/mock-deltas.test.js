// TASK-14.9: SSE-дельты в моке (TC-CHAT-004, tests.md §2.1 «Живой стрим»).
// Мок-сервер (ZAI_MOCK=1) проигрывает fixtures/events.sse; общая фикстура
// дельт не содержит, поэтому тест кладёт в СВОЮ копию фикстур (ZAI_FIXTURES,
// tmp) поток хода с частичными дельтами в форме opencode 1.19.5:
//   message.updated(user) → message.updated(assistant, без completed) →
//   message.part.delta(reasoning) ДО part.updated (плейсхолдер) →
//   message.part.updated(text, пусто) → N × message.part.delta(text, куски
//   режут слова и многобайтовые символы по границе кадра) →
//   message.updated(completed) → session.idle.
// Проверяется: (1) мок отдаёт text/event-stream и каждую дельту отдельным
// кадром в исходном порядке; (2) клиентский store, получая эти кадры по
// одному, собирает текст и рассуждение без потерь и дублей, а на промежуточных
// шагах показывает растущий префикс («живая линия»).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnPortal, ROOT } from "./helpers/spawn-server.mjs";
import { makeTmpRoot } from "./helpers/env.mjs";
import * as store from "../src/lib/store.js";

const SES = "ses_delta";
const MSG_U = "msg_u1";
const MSG_A = "msg_a1";
const PART_T = "prt_text";
const PART_R = "prt_reason";
const T0 = 1_762_000_000_000;

// Ответ режется на куски посреди слов; эмодзи (суррогатная пара) — целиком в
// одном куске, кириллица — по 2 байта: проверка, что мок не бьёт UTF-8.
const TEXT_CHUNKS = ["При", "вет", ", ми", "р! Это ", "потоковый отв", "ет 👋", " — конец."];
const REASON_CHUNKS = ["Думаю", " над ", "ответом"];
const FULL_TEXT = TEXT_CHUNKS.join("");
const FULL_REASON = REASON_CHUNKS.join("");

const ev = (type, properties) => ({ type, properties });
const delta = (partID, field, d) => ev("message.part.delta", { sessionID: SES, messageID: MSG_A, partID, field, delta: d });
const EVENTS = [
  ev("server.connected", {}),
  ev("message.updated", { sessionID: SES, info: { id: MSG_U, sessionID: SES, role: "user", time: { created: T0 } } }),
  ev("message.part.updated", { sessionID: SES, part: { id: "prt_u", messageID: MSG_U, sessionID: SES, type: "text", text: "Поздоровайся" } }),
  ev("message.updated", { sessionID: SES, info: { id: MSG_A, sessionID: SES, role: "assistant", parentID: MSG_U, time: { created: T0 + 10 } } }),
  ...REASON_CHUNKS.map((c) => delta(PART_R, "reasoning", c)),
  ev("message.part.updated", { sessionID: SES, part: { id: PART_T, messageID: MSG_A, sessionID: SES, type: "text", text: "" } }),
  ...TEXT_CHUNKS.map((c) => delta(PART_T, "text", c)),
  ev("message.updated", { sessionID: SES, info: { id: MSG_A, sessionID: SES, role: "assistant", parentID: MSG_U, time: { created: T0 + 10, completed: T0 + 900 } } }),
  ev("session.idle", { sessionID: SES }),
];

const tmp = makeTmpRoot("zai-mock-deltas-");
const FIXTURES = path.join(tmp.root, "fixtures");
cpSync(path.join(ROOT, "fixtures"), FIXTURES, { recursive: true, filter: (src) => !src.endsWith("_captured.jsonl") });
writeFileSync(path.join(FIXTURES, "events.sse"), EVENTS.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") + "\n\n", "utf8");

const srv = await spawnPortal({ mock: true, tmp, env: { ZAI_FIXTURES: FIXTURES } });
after(() => srv.stop());

// Читает /zai/api/event до session.idle; SSE-разбор по спецификации: кадры
// разделены пустой строкой, data:-строки склеиваются, комментарии (": ping")
// пропускаются. Декодер потоковый — многобайтовый символ на границе чанков
// не ломается.
async function readStream({ timeoutMs = 15_000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`нет session.idle за ${timeoutMs} мс`)), timeoutMs);
  const frames = [];
  const chunks = [];
  try {
    const res = await fetch(`${srv.base}/zai/api/event`, { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/event-stream/);
    const reader = res.body.getReader();
    const dec = new TextDecoder("utf-8");
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("поток закрыт до session.idle");
      chunks.push(value.length);
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        frames.push(JSON.parse(data));
      }
      if (frames.at(-1)?.type === "session.idle") break;
    }
    ac.abort();
  } finally {
    clearTimeout(timer);
  }
  return { frames, chunks };
}

const stream = readStream();

test("мок: поток text/event-stream отдаёт все кадры хода в исходном порядке, каждая дельта — отдельным кадром", async () => {
  const { frames, chunks } = await stream;
  assert.deepEqual(frames.map((f) => f.type), EVENTS.map((e) => e.type));
  const deltas = frames.filter((f) => f.type === "message.part.delta");
  assert.equal(deltas.length, TEXT_CHUNKS.length + REASON_CHUNKS.length, "дельты не склеены и не потеряны");
  assert.deepEqual(deltas.filter((d) => d.properties.field === "text").map((d) => d.properties.delta), TEXT_CHUNKS);
  assert.deepEqual(deltas.filter((d) => d.properties.field === "reasoning").map((d) => d.properties.delta), REASON_CHUNKS);
  assert.ok(chunks.length >= deltas.length, `кадры приходят порциями во времени (чанков: ${chunks.length})`);
});

test("store: частичные дельты из мока собираются в текст и рассуждение; на каждом шаге — растущий префикс", async () => {
  const { frames } = await stream;
  const { active, sessions, handleEvent, setNotice } = store;
  sessions.value = [{ id: SES, title: "Дельты", directory: "D:\\Chats\\delta", time: { created: T0, updated: T0 } }];
  active.value = { id: SES, title: "", status: "busy", lastEventAt: Date.now(), messages: [], loading: false, loadError: false };
  const textOf = () => active.value.messages.find((m) => m.info.id === MSG_A)?.parts.find((p) => p.id === PART_T)?.text;
  const reasonOf = () => active.value.messages.find((m) => m.info.id === MSG_A)?.parts.find((p) => p.id === PART_R)?.reasoning;
  try {
    let shown = "";
    let sawWriting = false;
    for (const f of frames) {
      handleEvent(f);
      if (f.type === "message.part.delta" && f.properties.field === "text") {
        const now = textOf();
        assert.ok(now.startsWith(shown) && now.length > shown.length, `«${now}» продолжает «${shown}»`);
        assert.ok(FULL_TEXT.startsWith(now), `«${now}» — префикс ответа`);
        shown = now;
        if (active.value.lastAction?.label === "пишет ответ") sawWriting = true;
      }
      if (f.type === "message.part.delta" && f.properties.field === "reasoning") {
        assert.ok(FULL_REASON.startsWith(reasonOf()), "рассуждение растёт префиксом, плейсхолдер создан до part.updated");
      }
    }
    assert.equal(textOf(), FULL_TEXT);
    assert.equal(reasonOf(), FULL_REASON);
    assert.ok(sawWriting, "пока идут текстовые дельты, строка активности — «пишет ответ»");
    const asst = active.value.messages.filter((m) => m.info.role === "assistant");
    assert.equal(asst.length, 1, "ни дублей, ни сирот от дельт");
    assert.equal(asst[0].info.time.completed, T0 + 900);
    assert.equal(asst[0].parts.filter((p) => p.id === PART_T).length, 1);
    const ids = active.value.messages.map((m) => m.info.id);
    assert.ok(ids.indexOf(MSG_U) < ids.indexOf(MSG_A), "ответ под вопросом");
  } finally {
    active.value = null;
    sessions.value = [];
    setNotice(null);
  }
});
