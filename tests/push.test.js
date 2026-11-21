// FEAT-07.20 (L1): Web Push — RFC 8291 encryption byte for byte on the §5
// vector, VAPID JWT verified with the public key, endpoint policy, store
// (cap, ownership, presence), triggers and the per-chat debounce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PushNotifier, PushStore, b64u, encryptPayload, endpointProblem, fromB64u, generateVapidKeys, loadOrCreateVapid,
  payloadFor, sendPush, topicFor, vapidJwt,
} from "../lib/push.js";
import { checkVapid, decryptPayload, makeUaKeys } from "./helpers/push-decrypt.mjs";

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), "teleharness-push-"));

// RFC 8291 §5 / Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  prkKey: "Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  prk: "09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("RFC 8291 §5: aes128gcm body byte for byte, every intermediate value of Appendix A", () => {
  const { body, intermediates: i } = encryptPayload(Buffer.from(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, {
    salt: fromB64u(RFC.salt),
    senderPrivate: fromB64u(RFC.asPrivate),
  });
  assert.equal(b64u(i.asPublic), RFC.asPublic);
  assert.equal(b64u(i.ecdhSecret), RFC.ecdhSecret);
  assert.equal(b64u(i.prkKey), RFC.prkKey);
  assert.equal(b64u(i.ikm), RFC.ikm);
  assert.equal(b64u(i.prk), RFC.prk);
  assert.equal(b64u(i.cek), RFC.cek);
  assert.equal(b64u(i.nonce), RFC.nonce);
  assert.equal(b64u(body), RFC.body);
  assert.equal(body.readUInt32BE(16), 4096, "rs = 4096");
  // and the receiver of the RFC decrypts it
  assert.equal(decryptPayload(body, { privateKey: fromB64u(RFC.uaPrivate), auth: RFC.auth }).text, RFC.plaintext);
});

test("encryption: a random salt/sender key per message, the receiver decrypts; bad keys refused", () => {
  const ua = makeUaKeys();
  const a = encryptPayload(Buffer.from("привет"), ua).body;
  const b = encryptPayload(Buffer.from("привет"), ua).body;
  assert.notEqual(b64u(a), b64u(b));
  assert.equal(decryptPayload(a, ua).text, "привет");
  assert.throws(() => encryptPayload(Buffer.from("x"), { p256dh: "AAAA", auth: ua.auth }), /p256dh/);
  assert.throws(() => encryptPayload(Buffer.from("x"), { p256dh: ua.p256dh, auth: "AAAA" }), /auth/);
  assert.throws(() => encryptPayload(Buffer.alloc(5000), ua), /too large/);
});

test("VAPID: JWT ES256 verifies with the public key; aud = endpoint origin, exp ≤ 24 h, sub set", () => {
  const keys = generateVapidKeys();
  assert.equal(fromB64u(keys.publicKey).length, 65);
  assert.equal(fromB64u(keys.privateKey).length, 32);
  const now = Date.UTC(2026, 10, 4, 12, 0, 0);
  const jwt = vapidJwt(keys, "https://fcm.googleapis.com", { subject: "mailto:x@y.z", now });
  const v = checkVapid(`vapid t=${jwt}, k=${keys.publicKey}`);
  assert.equal(v.valid, true, "signature verifies");
  assert.deepEqual(v.header, { typ: "JWT", alg: "ES256" });
  assert.equal(v.claims.aud, "https://fcm.googleapis.com");
  assert.equal(v.claims.sub, "mailto:x@y.z");
  assert.ok(v.claims.exp > now / 1000 && v.claims.exp <= now / 1000 + 24 * 3600);
  // another key does not verify it
  const other = generateVapidKeys();
  assert.equal(checkVapid(`vapid t=${jwt}, k=${other.publicKey}`).valid, false);
  // tampered claims do not verify
  const [h, , s] = jwt.split(".");
  const forged = `${h}.${b64u(JSON.stringify({ aud: "https://evil", exp: 1, sub: "x" }))}.${s}`;
  assert.equal(checkVapid(`vapid t=${forged}, k=${keys.publicKey}`).valid, false);
});

test("VAPID key: created once into <dir>/vapid.json, reused on the next start, never logged; corrupt file moved aside", () => {
  const dir = tmpDir();
  try {
    const logs = [];
    const k1 = loadOrCreateVapid(dir, { log: (m) => logs.push(m) });
    const k2 = loadOrCreateVapid(dir, { log: (m) => logs.push(m) });
    assert.deepEqual(k1, k2);
    const onDisk = JSON.parse(readFileSync(path.join(dir, "vapid.json"), "utf8"));
    assert.equal(onDisk.publicKey, k1.publicKey);
    assert.ok(!logs.join("\n").includes(k1.privateKey), "private key not in the log");
    writeFileSync(path.join(dir, "vapid.json"), "{broken");
    const k3 = loadOrCreateVapid(dir, { log: (m) => logs.push(m) });
    assert.notEqual(k3.publicKey, k1.publicKey);
    assert.ok(readdirSync(dir).some((f) => f.startsWith("vapid.json.corrupt-")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("endpoint policy: only https push services (+ explicit extra origins) — no LAN/loopback (SSRF)", () => {
  assert.equal(endpointProblem("https://fcm.googleapis.com/fcm/send/abc"), null);
  assert.equal(endpointProblem("https://web.push.apple.com/QOx"), null);
  assert.equal(endpointProblem("https://updates.push.services.mozilla.com/wpush/v2/x"), null);
  assert.equal(endpointProblem("https://wns2-db5p.notify.windows.com/w/?token=x"), null);
  assert.ok(endpointProblem("http://fcm.googleapis.com/x"));
  assert.ok(endpointProblem("https://127.0.0.1:4170/teleharness/api/x"));
  assert.ok(endpointProblem("https://192.0.2.10/teleharness/"));
  assert.ok(endpointProblem("https://evilfcm.googleapis.com.evil.io/x"));
  assert.ok(endpointProblem("https://u:p@fcm.googleapis.com/x"));
  assert.ok(endpointProblem("not a url"));
  assert.equal(endpointProblem("http://127.0.0.1:5555/push/1", ["http://127.0.0.1:5555"]), null);
});

test("sendPush: POST with TTL, Urgency, Topic, aes128gcm and a valid vapid header; 404/410 = gone", async () => {
  const vapid = generateVapidKeys();
  const ua = makeUaKeys();
  const calls = [];
  let status = 201;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(null, { status });
  };
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/xyz", keys: { p256dh: ua.p256dh, auth: ua.auth } };
  const r = await sendPush(sub, { title: "Готово: чат" }, { vapid, subject: "mailto:a@b.c", ttl: 60, urgency: "high", topic: topicFor("ses_1"), fetchImpl });
  assert.deepEqual(r, { status: 201, gone: false });
  const h = calls[0].init.headers;
  assert.equal(calls[0].init.method, "POST");
  assert.equal(h.TTL, "60");
  assert.equal(h.Urgency, "high");
  assert.match(h.Topic, /^[A-Za-z0-9_-]{1,32}$/);
  assert.equal(h["Content-Encoding"], "aes128gcm");
  const v = checkVapid(h.Authorization);
  assert.equal(v.valid, true);
  assert.equal(v.claims.aud, "https://fcm.googleapis.com");
  assert.equal(JSON.parse(decryptPayload(calls[0].init.body, ua).text).title, "Готово: чат");
  status = 410;
  assert.deepEqual(await sendPush(sub, "x", { vapid, subject: "s", fetchImpl }), { status: 410, gone: true });
  status = 404;
  assert.equal((await sendPush(sub, "x", { vapid, subject: "s", fetchImpl })).gone, true);
  status = 429;
  assert.equal((await sendPush(sub, "x", { vapid, subject: "s", fetchImpl })).gone, false);
});

test("PushStore: bound to a user, cap per user (oldest goes), only the owner removes, a new login takes the endpoint over", () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, "subscriptions.json");
    const ua = makeUaKeys();
    const keys = { p256dh: ua.p256dh, auth: ua.auth };
    const st = new PushStore({ file, maxPerUser: 2 });
    st.add("u1", { endpoint: "https://fcm.googleapis.com/a", keys }, { now: 1 });
    st.add("u1", { endpoint: "https://fcm.googleapis.com/b", keys }, { now: 2 });
    st.add("u1", { endpoint: "https://fcm.googleapis.com/c", keys }, { now: 3 });
    assert.deepEqual(st.forUser("u1").map((s) => s.endpoint).sort(), ["https://fcm.googleapis.com/b", "https://fcm.googleapis.com/c"]);
    assert.equal(st.remove("u2", "https://fcm.googleapis.com/b"), false, "not yours");
    assert.equal(st.forUser("u1").length, 2);
    st.add("u2", { endpoint: "https://fcm.googleapis.com/b", keys }, { now: 4 });
    assert.equal(st.forUser("u1").length, 1);
    assert.equal(st.forUser("u2").length, 1);
    // persisted
    const again = new PushStore({ file, maxPerUser: 2 });
    assert.equal(again.size, 2);
    assert.equal(again.remove("u2", "https://fcm.googleapis.com/b"), true);
    assert.equal(new PushStore({ file }).size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A notifier with a fake clock and a recording sender.
// summaryWindowMs 0: эти тесты — про отдельные события (дебаунс, получатели);
// окно сводной push FEAT-20.2 проверяется своими тестами ниже.
function rig({ info = {}, managed = new Set(), recipients = () => ["u1"], debounceMs = 20_000, summaryWindowMs = 0, prefsOf, activeAt, timers } = {}) {
  const dir = tmpDir();
  const store = new PushStore({ file: path.join(dir, "s.json") });
  const ua = makeUaKeys();
  store.add("u1", { endpoint: "https://fcm.googleapis.com/u1", keys: { p256dh: ua.p256dh, auth: ua.auth } });
  store.add("u2", { endpoint: "https://fcm.googleapis.com/u2", keys: { p256dh: ua.p256dh, auth: ua.auth } });
  const sent = [];
  const clock = { t: 1_000_000 };
  const n = new PushNotifier({
    store,
    vapid: generateVapidKeys(),
    subject: "s",
    recipients,
    chatInfo: async (sid) => info[sid] ?? { dir: "C:\\Home", title: `чат ${sid}` },
    isManaged: (sid) => managed.has(sid),
    debounceMs,
    summaryWindowMs,
    ...(prefsOf ? { prefsOf } : {}),
    ...(activeAt ? { activeAt } : {}),
    ...(timers ? { setTimer: (fn, ms) => timers.push({ fn, ms }) } : {}),
    now: () => clock.t,
    log: () => {},
    send: async (sub, payload, opts) => {
      sent.push({ user: sub.userId, payload, opts });
      return { status: 201, gone: false };
    },
  });
  return { n, sent, clock, store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const ev = (type, sid, extra = {}) => JSON.stringify({ type, properties: { sessionID: sid, ...extra } });
const tick = () => new Promise((r) => setImmediate(r));

test("debounce: once per 20 s per chat; another chat is independent; «ask» is not swallowed by a fresh «done»", async () => {
  const r = rig();
  try {
    assert.equal(await r.n.fire("done", "ses_a"), 1);
    r.clock.t += 5_000;
    assert.equal(await r.n.fire("done", "ses_a"), 0, "within 20 s — suppressed");
    assert.equal(await r.n.fire("done", "ses_b"), 1, "another chat");
    assert.equal(await r.n.fire("ask", "ses_a"), 1, "ask after done goes");
    r.clock.t += 1_000;
    assert.equal(await r.n.fire("ask", "ses_a"), 0, "ask after ask — suppressed");
    r.clock.t += 20_000;
    assert.equal(await r.n.fire("done", "ses_a"), 1, "after the window");
    assert.equal(r.sent[0].payload.title, "Готово: чат ses_a");
    assert.equal(r.sent[0].payload.url, "/teleharness/#/chat/ses_a");
    assert.equal(r.sent.find((s) => s.payload.kind === "ask").payload.title, "Нужен ваш ответ: чат ses_a");
    assert.equal(r.sent.find((s) => s.payload.kind === "ask").opts.urgency, "high");
  } finally {
    r.cleanup();
  }
});

test("hub events: busy → idle = «Готово»; idle without busy, Claude-managed and sub-agent chats — nothing; ask of a sub-agent → parent chat", async () => {
  const r = rig({
    managed: new Set(["ses_claude"]),
    info: { ses_child: { dir: "C:\\Home", title: "child", parentID: "ses_parent" }, ses_parent: { dir: "C:\\Home", title: "Родитель" } },
  });
  try {
    r.n.observe(ev("session.idle", "ses_x")); // never busy
    r.n.observe(ev("session.status", "ses_x", { status: { type: "busy" } }));
    r.n.observe(ev("session.status", "ses_x", { status: { type: "idle" } }));
    r.n.observe(ev("session.idle", "ses_x")); // same turn end, second frame
    r.n.observe(ev("session.status", "ses_claude", { status: { type: "busy" } }));
    r.n.observe(ev("session.idle", "ses_claude"));
    r.n.observe(ev("session.status", "ses_child", { status: { type: "busy" } }));
    r.n.observe(ev("session.idle", "ses_child"));
    r.n.observe(ev("permission.asked", "ses_child", { id: "per_1" }));
    await tick();
    await tick();
    const titles = r.sent.map((s) => s.payload.title);
    assert.deepEqual(titles, ["Готово: чат ses_x", "Нужен ваш ответ: Родитель"]);
    assert.equal(r.sent[1].payload.chat, "ses_parent");
    // error turn
    r.n.observe(ev("session.status", "ses_e", { status: { type: "busy" } }));
    r.n.observe(ev("session.error", "ses_e", { error: { name: "X" } }));
    r.n.observe(ev("session.idle", "ses_e"));
    await tick();
    await tick();
    assert.equal(r.sent.at(-1).payload.title, "Ошибка: чат ses_e");
  } finally {
    r.cleanup();
  }
});

// BUG-272: opencode 2.x — после execution.failed idle не приходит; ошибка с terminal завершает ход
test("BUG-272: opencode 2.x error turn (terminal session.error, no idle) — «Ошибка» once; next turn counts again", async () => {
  const r = rig();
  try {
    r.n.observe(ev("session.status", "ses_q", { status: "busy" }));
    r.n.observe(ev("session.error", "ses_q", { error: { name: "provider.quota", data: { message: "429" } }, terminal: true }));
    await tick();
    await tick();
    assert.deepEqual(r.sent.map((s) => s.payload.title), ["Ошибка: чат ses_q"]);
    r.clock.t += 60_000;
    r.n.observe(ev("session.status", "ses_q", { status: "busy" }));
    r.n.observe(ev("session.idle", "ses_q"));
    await tick();
    await tick();
    assert.deepEqual(r.sent.map((s) => s.payload.title), ["Ошибка: чат ses_q", "Готово: чат ses_q"]);
  } finally {
    r.cleanup();
  }
});

test("Claude onTurnEnd: «Готово»; stop by the person / delete / restart — nothing; timeout — «Ошибка»", async () => {
  const r = rig();
  try {
    assert.equal(await r.n.claudeTurnEnd({ sid: "c1", reason: null }), 1);
    assert.equal(await r.n.claudeTurnEnd({ sid: "c2", reason: "user" }), 0);
    assert.equal(await r.n.claudeTurnEnd({ sid: "c3", reason: "deleted" }), 0);
    assert.equal(await r.n.claudeTurnEnd({ sid: "c4", reason: "restart" }), 0);
    assert.equal(await r.n.claudeTurnEnd({ sid: "c5", reason: "timeout" }), 1);
    assert.deepEqual(r.sent.map((s) => s.payload.title), ["Готово: чат c1", "Ошибка: чат c5"]);
  } finally {
    r.cleanup();
  }
});

test("recipients and presence: only the chat's owners; a device that shows this chat right now is skipped", async () => {
  const r = rig({ recipients: (dir) => (dir === "C:\\Tenant" ? ["u2"] : ["u1"]), info: { t1: { dir: "C:\\Tenant", title: "T" } } });
  try {
    await r.n.fire("done", "t1");
    assert.deepEqual(r.sent.map((s) => s.user), ["u2"]);
    assert.equal(r.store.setPresence("u1", "https://fcm.googleapis.com/u2", "a1"), false, "not your endpoint");
    assert.equal(r.store.setPresence("u1", "https://fcm.googleapis.com/u1", "a1", r.clock.t), true);
    assert.equal(await r.n.fire("done", "a1"), 0, "u1 is looking at a1");
    r.clock.t += 60_000; // presence expired
    assert.equal(await r.n.fire("done", "a1"), 1);
  } finally {
    r.cleanup();
  }
});

test("payload: short title, url of the chat, tag per chat", () => {
  const p = payloadFor("done", { sid: "ses/1", title: "  очень\n длинное " + "x".repeat(200) });
  assert.ok(p.title.length <= 90);
  assert.equal(p.url, "/teleharness/#/chat/ses%2F1");
  assert.equal(p.tag, "teleharness-ses/1");
  assert.equal(payloadFor("done", { sid: "s", title: "" }).title, "Готово: Новый чат");
});

// ---- FEAT-20.2: политика push доски внимания ---------------------------------
import { quietLeftMs, summaryPayload } from "../lib/push.js";

test("FEAT-20.2 кр. 15: выключенный вид — нет push ни на одно устройство; «Ждёт вас» по-прежнему приходит", async () => {
  const { n, sent, clock, cleanup } = rig({ prefsOf: () => ({ needs: true, failed: true, done: false }) });
  try {
    await n.fire("done", "ses_a");
    assert.equal(sent.length, 0);
    clock.t += 30_000;
    await n.fire("ask", "ses_a");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.kind, "ask");
  } finally {
    cleanup();
  }
});

test("FEAT-20.2 N-14: «Готово»/«Упало» не приходят, пока пользователь смотрит портал (45 с), «Ждёт вас» — приходит", async () => {
  const at = { t: 1_000_000 };
  const { n, sent, clock, cleanup } = rig({ activeAt: () => at.t });
  try {
    await n.fire("done", "ses_a");
    await n.fire("error", "ses_b");
    assert.equal(sent.length, 0, "смотрит портал");
    await n.fire("ask", "ses_c");
    assert.equal(sent.length, 1);
    clock.t += 46_000;
    await n.fire("done", "ses_d");
    assert.equal(sent.length, 2, "ушёл — push снова приходят");
  } finally {
    cleanup();
  }
});

test("FEAT-20.2 P-12: окно 120 с — первое событие сразу, следующие одной сводной push «Готово 2 · Упало 1» на доску", async () => {
  const timers = [];
  const { n, sent, clock, cleanup } = rig({ summaryWindowMs: 120_000, timers });
  try {
    await n.fire("done", "ses_1");
    assert.equal(sent.length, 1, "первое — сразу");
    clock.t += 10_000;
    await n.fire("done", "ses_2");
    clock.t += 10_000;
    await n.fire("done", "ses_3");
    clock.t += 10_000;
    await n.fire("error", "ses_4");
    assert.equal(sent.length, 1, "накоплено, не отправлено");
    assert.equal(timers[0].ms, 120_000);
    await timers[0].fn();
    const last = sent.at(-1).payload;
    assert.equal(last.kind, "summary");
    assert.equal(last.title, "Готово 2 · Упало 1");
    assert.equal(last.url, "/teleharness/#/board");
    assert.equal(sent.length, 2, "одна сводка вместо трёх push");
  } finally {
    cleanup();
  }
});

test("FEAT-20.2: в окне один накопленный — уходит как есть; «Ждёт вас» окна не ждёт", async () => {
  const timers = [];
  const { n, sent, clock, cleanup } = rig({ summaryWindowMs: 120_000, timers, recipients: () => ["u1"] });
  try {
    await n.fire("done", "ses_1");
    clock.t += 5_000;
    await n.fire("ask", "ses_2");
    assert.equal(sent.length, 2, "запрос — сразу");
    clock.t += 5_000;
    await n.fire("done", "ses_3");
    assert.equal(sent.length, 2);
    await timers[0].fn();
    assert.equal(sent.at(-1).payload.kind, "done");
    assert.equal(sent.at(-1).payload.chat, "ses_3");
  } finally {
    cleanup();
  }
});

test("FEAT-20.2 N-30: тихие часы — «Готово»/«Упало» копятся до конца одной сводкой, «Ждёт вас» сразу", async () => {
  const timers = [];
  const night = Date.UTC(2026, 10, 20, 2, 0, 0);
  const { n, sent, clock, cleanup } = rig({ recipients: () => ["u1"], timers, prefsOf: () => ({ needs: true, failed: true, done: true, quiet: { on: true, from: "23:00", to: "08:00", tz: "UTC" } }) });
  try {
    clock.t = night;
    await n.fire("error", "ses_r");
    await n.fire("done", "ses_a");
    clock.t += 30_000;
    await n.fire("done", "ses_b");
    assert.equal(sent.length, 0);
    await n.fire("ask", "ses_q");
    assert.equal(sent.length, 1, "запрос разрешения в 02:00 — сразу");
    assert.equal(timers[0].ms, 6 * 3600_000, "до 08:00");
    await timers[0].fn();
    assert.equal(sent.at(-1).payload.title, "Готово 2 · Упало 1");
  } finally {
    cleanup();
  }
});

test("FEAT-20.2: тот же открытый запрос после переподключения хаба — без второй push", async () => {
  const { n, sent, clock, cleanup } = rig({ recipients: () => ["u1"] });
  try {
    n.observe(ev("permission.asked", "ses_p", { id: "per_same" }));
    await tick();
    await tick();
    clock.t += 60_000;
    n.observe(ev("permission.asked", "ses_p", { id: "per_same" }));
    await tick();
    await tick();
    assert.equal(sent.length, 1);
  } finally {
    cleanup();
  }
});

test("FEAT-20.2: тихие часы через полночь и днём; сводка с правильной формой числа", () => {
  const q = { on: true, from: "23:00", to: "08:00", tz: "UTC" };
  assert.equal(quietLeftMs(q, Date.UTC(2026, 0, 1, 23, 30)), 8.5 * 3600_000);
  assert.equal(quietLeftMs(q, Date.UTC(2026, 0, 1, 12, 0)), 0);
  assert.equal(quietLeftMs({ ...q, on: false }, Date.UTC(2026, 0, 1, 2, 0)), 0);
  assert.equal(quietLeftMs({ on: true, from: "13:00", to: "15:00", tz: "UTC" }, Date.UTC(2026, 0, 1, 14, 0)), 3600_000);
  assert.equal(summaryPayload("u", { done: 1 }).body, "1 событие — откройте доску");
  assert.equal(summaryPayload("u", { done: 2, needs: 2 }).body, "4 события — откройте доску");
  assert.equal(summaryPayload("u", { failed: 5 }).body, "5 событий — откройте доску");
  assert.equal(summaryPayload("u", { done: 3, failed: 1, needs: 2 }).title, "Готово 3 · Упало 1 · Ждут вас 2");
});
