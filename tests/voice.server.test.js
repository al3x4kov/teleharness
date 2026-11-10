// FEAT-06.2 voice mode — server side: VoiceService over the fake worker,
// quotas, text cleaning, and the /zai/api/voice routes in a real server.js.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VoiceQuota, VoiceService, cleanTtsText, pcmSeconds, voiceLabel } from "../lib/voice.js";
import { spawnPortal } from "./helpers/spawn-server.mjs";
import { startFakeOpencode } from "./helpers/fake-opencode.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fixtures", "voice-fake.mjs");
const wavText = (buf) => buf.subarray(44).toString("utf8");

test("cleanTtsText drops code, markdown and links; caps the length", () => {
  assert.equal(cleanTtsText("**Итог:** см. `sales.xlsx` и [отчёт](http://x)\n```js\nconst a=1\n```"), "Итог: см. sales.xlsx и отчёт");
  assert.equal(cleanTtsText("а".repeat(900)).length, 600);
  assert.equal(voiceLabel("irina"), "Ирина");
  assert.equal(voiceLabel("kseniya"), "Kseniya");
  assert.equal(pcmSeconds(32000), 1);
});

test("cleanTtsText keeps what the speech normalizer needs (FEAT-06.3)", () => {
  assert.equal(cleanTtsText("~5 мин, 23 км/ч, 12%, C# и #5, my_report.xlsx, 5 > 3"), "~5 мин, 23 км/ч, 12%, C# и #5, my_report.xlsx, 5 > 3");
  assert.equal(cleanTtsText("> цитата __жирно__ ~~зачёркнуто~~ | ## Заголовок"), "цитата жирно зачёркнуто Заголовок");
});

test("VoiceService.norm returns the text the worker will speak", async () => {
  const v = new VoiceService({ python: process.execPath, script: FAKE, timeoutMs: 2000 });
  assert.deepEqual(await v.norm("**23** км/ч"), { text: "норм:23 км/ч", ms: 1.5 });
  v.stop();
});

test("VoiceService: tts/stt round trip, errors keep the worker, crash respawns", async () => {
  const logs = [];
  const v = new VoiceService({ python: process.execPath, script: FAKE, log: (m) => logs.push(m), timeoutMs: 2000 });
  assert.equal(v.available, true);
  const info = await v.info();
  assert.deepEqual(info.voices, ["denis", "irina"]);
  assert.equal(wavText(await v.tts({ text: "Привет, **мир**", voice: "denis", rate: 1.2 })), "denis|1.2|Привет, мир");
  assert.equal(await v.stt(Buffer.alloc(3200)), "распознано 3200 байт");
  await assert.rejects(v.tts({ text: "x", voice: "nope" }), /unknown voice/);
  assert.equal(wavText(await v.tts({ text: "ещё" })), "irina|1|ещё", "a failed request does not kill the worker");
  await assert.rejects(v.tts({ text: "CRASH" }), /stopped/);
  assert.equal(wavText(await v.tts({ text: "снова" })), "irina|1|снова", "respawned on the next call");
  await assert.rejects(v.tts({ text: "SLOWTTS" }), /timeout/);
  assert.equal(wavText(await v.tts({ text: "после таймаута" })), "irina|1|после таймаута");
  v.stop();
});

test("VoiceService: missing python → unavailable, never spawns", async () => {
  const v = new VoiceService({ python: "Z:\\nope\\python.exe", script: FAKE, spawn: () => assert.fail("must not spawn") });
  assert.equal(v.available, false);
  assert.deepEqual(await v.info(), { available: false, voices: [], stt: false });
  await assert.rejects(v.tts({ text: "a" }), (e) => e.code === "unavailable");
});

test("VoiceQuota: per user per day, resets on a new day", () => {
  let day = "2026-11-05T10:00:00Z";
  const q = new VoiceQuota({ ttsChars: 10, sttSeconds: 5, now: () => new Date(day) });
  assert.equal(q.takeTts("u", 6), true);
  assert.equal(q.takeTts("u", 5), false);
  assert.equal(q.takeTts("w", 10), true, "another user has its own budget");
  assert.equal(q.takeStt("u", 5), true);
  assert.equal(q.takeStt("u", 0.5), false);
  day = "2026-11-06T00:00:01Z";
  assert.equal(q.takeTts("u", 10), true);
});

// ---- routes in a real server.js ---------------------------------------------
const ADMIN_TOKEN = "voice-admin-token-0123456789abcdef";
const up = await startFakeOpencode();
const srv = await spawnPortal({
  upstream: up.base ?? up.url,
  env: { ZAI_ADMIN_TOKEN: ADMIN_TOKEN, ZAI_VOICE: "1", ZAI_VOICE_PYTHON: process.execPath, ZAI_VOICE_WORKER: FAKE, ZAI_VOICE_TENANT_TTS_CHARS: "12" },
});
after(async () => { await srv.stop(); await up.close(); });
const base = srv.base;
async function login(token) {
  const r = await fetch(`${base}/zai/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ token }) });
  assert.equal(r.status, 200);
  return (r.headers.getSetCookie?.() ?? []).join(";").match(/(zai_[a-z0-9_]+=[^;]+)/i)[1];
}
const ADMIN = await login(ADMIN_TOKEN);
const call = (p, { cookie = ADMIN, ...opts } = {}) => fetch(`${base}${p}`, { ...opts, headers: { origin: base, ...(opts.headers ?? {}), cookie } });

test("GET /zai/api/voice lists the voices with Russian names", async () => {
  const r = await call("/zai/api/voice");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.enabled, true);
  assert.equal(j.stt, true);
  assert.deepEqual(j.voices, [{ id: "denis", name: "Денис" }, { id: "irina", name: "Ирина" }]);
  assert.equal((await fetch(`${base}/zai/api/voice`)).status, 401, "anonymous → 401");
});

test("POST /voice/tts → audio/wav; bad input 400; tenant quota 429; admin unlimited", async () => {
  const ok = await call("/zai/api/voice/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Привет", voice: "denis", rate: 3 }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "audio/wav");
  assert.equal(wavText(Buffer.from(await ok.arrayBuffer())), "denis|1.6|Привет", "rate clamped to 1.6");
  const bad = await call("/zai/api/voice/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "```x```" }) });
  assert.equal(bad.status, 400);
  const odd = await call("/zai/api/voice/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "a", voice: "../../etc" }) });
  assert.equal(wavText(Buffer.from(await odd.arrayBuffer())), "irina|1|a", "an odd voice id falls back to the default");

  const created = await (await call("/zai/api/admin/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "voicetenant" }) })).json();
  const T = await login(created.token);
  const t1 = await call("/zai/api/voice/tts", { cookie: T, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "десять букв" }) });
  assert.equal(t1.status, 200);
  const t2 = await call("/zai/api/voice/tts", { cookie: T, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "ещё" }) });
  assert.equal(t2.status, 429);
  assert.equal((await t2.json()).code, "quota");
  for (let i = 0; i < 3; i++) {
    const a = await call("/zai/api/voice/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "админ без лимита" }) });
    assert.equal(a.status, 200);
  }
});

test("POST /voice/norm: admin debug of the normalized text; tenants 403; empty 400", async () => {
  const post = (body, cookie) => call("/zai/api/voice/norm", { cookie, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ok = await post({ text: "Скорость 23 км/ч" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { text: "норм:Скорость 23 км/ч", ms: 1.5 });
  assert.equal((await post({ text: "```x```" })).status, 400);
  const created = await (await call("/zai/api/admin/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "normtenant" }) })).json();
  assert.equal((await post({ text: "1 км" }, await login(created.token))).status, 403);
});

test("POST /voice/stt: raw PCM → text; too long → 413", async () => {
  const r = await call("/zai/api/voice/stt", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.alloc(6400) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { text: "распознано 6400 байт", seconds: 0.2 });
  const big = await call("/zai/api/voice/stt", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.alloc(61 * 32000) });
  assert.equal(big.status, 413);
});
