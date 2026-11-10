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

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), "zai-push-"));

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
  assert.ok(endpointProblem("https://127.0.0.1:4170/zai/api/x"));
  assert.ok(endpointProblem("https://192.168.0.10/zai/"));
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
function rig({ info = {}, managed = new Set(), recipients = () => ["u1"], debounceMs = 20_000 } = {}) {
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
    assert.equal(r.sent[0].payload.url, "/zai/#/chat/ses_a");
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
  assert.equal(p.url, "/zai/#/chat/ses%2F1");
  assert.equal(p.tag, "zai-ses/1");
  assert.equal(payloadFor("done", { sid: "s", title: "" }).title, "Готово: Новый чат");
});
