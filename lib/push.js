// FEAT-07.20: Web Push — уведомления о конце хода и о запросе разрешения/ответа.
// Zero runtime dependencies — node:crypto only.
//
//   - VAPID (RFC 8292): ES256 key generated on first start into
//     <data>/push/vapid.json (atomic write; a secret — never logged, not in git);
//     the JWT is signed with node:crypto (ieee-p1363 = raw r||s, as JWS wants).
//   - Payload encryption: RFC 8291 (aes128gcm content coding, RFC 8188),
//     one record, rs = 4096. encryptPayload() takes optional salt/sender key
//     so the RFC 8291 §5 vector is reproducible byte for byte.
//   - sendPush(): POST to the endpoint with TTL, Urgency, Topic;
//     404/410 → the caller drops the subscription.
//   - PushStore: <data>/push/subscriptions.json, bound to a user id, a cap per user.
//   - PushNotifier: turn end (busy → idle) / dialog asked → «Готово: <чат>» /
//     «Нужен ваш ответ: <чат>» to the chat's owners; per-chat debounce.
import { createECDH, createHash, createHmac, createCipheriv, createPrivateKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import path from "node:path";
import { readJsonStore, writeJsonAtomic } from "./json-store.js";

// ---- base64url ----------------------------------------------------------------

export const b64u = (buf) => Buffer.from(buf).toString("base64url");
export function fromB64u(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_\-]*={0,2}$/.test(s)) return null;
  return Buffer.from(s.replace(/=+$/, ""), "base64url");
}

// ---- RFC 8291 encryption --------------------------------------------------------

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
// HKDF-Expand with L ≤ 32: a single block T(1) = HMAC(PRK, info || 0x01).
const expand1 = (prk, info, len) => hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);
const RECORD_SIZE = 4096;

// → { body, intermediates } (intermediates only for tests; never logged).
// sub: { p256dh, auth } base64url (from PushSubscription.toJSON().keys).
export function encryptPayload(plaintext, sub, { salt = randomBytes(16), senderPrivate = null } = {}) {
  const uaPublic = typeof sub.p256dh === "string" ? fromB64u(sub.p256dh) : Buffer.from(sub.p256dh);
  const authSecret = typeof sub.auth === "string" ? fromB64u(sub.auth) : Buffer.from(sub.auth);
  if (!uaPublic || uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("bad p256dh");
  if (!authSecret || authSecret.length !== 16) throw new Error("bad auth");
  const ecdh = createECDH("prime256v1");
  if (senderPrivate) ecdh.setPrivateKey(Buffer.from(senderPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // uncompressed, 65 octets
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  // §3.3: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" 0x00 ua_public as_public, 32)
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, asPublic]);
  const ikm = expand1(prkKey, keyInfo, 32);
  // RFC 8188 §2.2/2.3
  const prk = hmac(salt, ikm);
  const cek = expand1(prk, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16);
  const nonce = expand1(prk, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12);
  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]); // last record delimiter
  if (data.length + 16 + 86 > RECORD_SIZE) throw new Error("payload too large");
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  const body = Buffer.concat([header, asPublic, ct]);
  return { body, intermediates: { ecdhSecret, prkKey, ikm, prk, cek, nonce, asPublic } };
}

// ---- VAPID (RFC 8292) ------------------------------------------------------------

// {publicKey: b64u(65-octet point), privateKey: b64u(32-octet d)}
export function generateVapidKeys() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return { publicKey: b64u(pub), privateKey: jwk.d };
}

export function vapidKeyObject(keys) {
  const pub = fromB64u(keys.publicKey);
  return createPrivateKey({
    format: "jwk",
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
  });
}

function validVapid(v) {
  const pub = fromB64u(v?.publicKey);
  const d = fromB64u(v?.privateKey);
  return Boolean(pub && pub.length === 65 && pub[0] === 4 && d && d.length === 32);
}

// Loads <dir>/vapid.json or creates it (atomic). Never prints the key.
export function loadOrCreateVapid(dir, { log = console.log } = {}) {
  const file = path.join(dir, "vapid.json");
  const cur = readJsonStore(file, { fallback: () => null, validate: validVapid, log: (m) => log(m) });
  if (cur) return { publicKey: cur.publicKey, privateKey: cur.privateKey };
  const keys = generateVapidKeys();
  if (!writeJsonAtomic(file, { ...keys, createdAt: new Date().toISOString() }, { log })) {
    log("[zai-push] не удалось сохранить VAPID-ключ — push выключен до следующего старта");
    return null;
  }
  log(`[zai-push] VAPID-ключ создан (${path.basename(file)})`);
  return keys;
}

// JWT for the endpoint's origin, 12 h (RFC 8292 §2: ≤ 24 h).
export function vapidJwt(keys, audience, { subject, now = Date.now(), ttlSec = 12 * 3600, keyObject = null } = {}) {
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + ttlSec, sub: subject }));
  const input = `${head}.${claims}`;
  const sig = cryptoSign("sha256", Buffer.from(input), { key: keyObject ?? vapidKeyObject(keys), dsaEncoding: "ieee-p1363" });
  return `${input}.${b64u(sig)}`;
}

export const vapidAuthHeader = (jwt, publicKey) => `vapid t=${jwt}, k=${publicKey}`;

// ---- endpoint policy --------------------------------------------------------------

// Known push services. The server POSTs to client-supplied URLs — anything
// else (LAN, loopback, random hosts) is refused (SSRF). Tests and the live
// check add their fake service via ZAI_PUSH_EXTRA_ORIGINS.
export const PUSH_HOST_SUFFIXES = ["fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "notify.windows.com", "push.apple.com"];

export function endpointProblem(endpoint, extraOrigins = []) {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return "bad endpoint";
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return "bad endpoint";
  }
  if (extraOrigins.includes(u.origin)) return null;
  if (u.protocol !== "https:" || u.username || u.password) return "endpoint must be https";
  const host = u.hostname.toLowerCase();
  if (!PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s))) return "unknown push service";
  return null;
}

// Topic (RFC 8030 §5.4): ≤ 32 chars of the base64url alphabet — one pending
// message per chat at the push service; a newer one replaces it.
export const topicFor = (key) => createHash("sha256").update(String(key)).digest("base64url").slice(0, 32);

// ---- send ---------------------------------------------------------------------------

// → { status, gone } ; gone = 404/410 (subscription is dead, drop it).
export async function sendPush(sub, payload, { vapid, subject, ttl = 3600, urgency = "normal", topic = null, fetchImpl = fetch, timeoutMs = 15_000, keyObject = null } = {}) {
  const { body } = encryptPayload(Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)), sub.keys);
  const aud = new URL(sub.endpoint).origin;
  const headers = {
    TTL: String(ttl),
    Urgency: urgency,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    Authorization: vapidAuthHeader(vapidJwt(vapid, aud, { subject, keyObject }), vapid.publicKey),
  };
  if (topic) headers.Topic = topic;
  const r = await fetchImpl(sub.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  try {
    await r.arrayBuffer();
  } catch {}
  return { status: r.status, gone: r.status === 404 || r.status === 410 };
}

// ---- subscriptions --------------------------------------------------------------------

// The client repeats its presence every 30 s while the chat is in view.
export const PRESENCE_MS = 45_000;

export const subId = (endpoint) => createHash("sha256").update(endpoint).digest("base64url").slice(0, 16);

export class PushStore {
  #file;
  #log;
  #subs;
  #max;
  constructor({ file, maxPerUser = 10, log = console.error }) {
    this.#file = file;
    this.#log = log;
    this.#max = maxPerUser;
    const raw = readJsonStore(file, { fallback: () => ({ subs: [] }), validate: (v) => Array.isArray(v?.subs), log });
    this.#subs = raw.subs.filter((s) => s && typeof s.endpoint === "string" && typeof s.userId === "string" && s.keys);
  }

  #flush() {
    writeJsonAtomic(this.#file, { version: 1, subs: this.#subs }, { log: this.#log });
  }

  // An endpoint belongs to one browser: a new owner (another login on the
  // same device) takes it over. Over the cap the oldest of the user goes.
  add(userId, { endpoint, keys }, { ua = null, now = Date.now() } = {}) {
    const id = subId(endpoint);
    const prev = this.#subs.find((s) => s.id === id);
    // SRV-32: подписку забрал другой пользователь — «чат открыт» прежнего владельца не его
    if (prev && prev.userId !== userId) this.#seen.delete(id);
    this.#subs = this.#subs.filter((s) => s.id !== id);
    const rec = { id, userId, endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, createdAt: prev?.userId === userId ? prev.createdAt : now, ua: ua ? String(ua).slice(0, 160) : null };
    this.#subs.push(rec);
    const mine = this.#subs.filter((s) => s.userId === userId);
    if (mine.length > this.#max) {
      const drop = new Set(mine.sort((a, b) => a.createdAt - b.createdAt).slice(0, mine.length - this.#max).map((s) => s.id));
      this.#subs = this.#subs.filter((s) => !drop.has(s.id));
    }
    this.#flush();
    return rec;
  }

  // Only the owner can remove its subscription (another user's endpoint → false).
  remove(userId, endpoint) {
    const id = subId(endpoint);
    const before = this.#subs.length;
    this.#subs = this.#subs.filter((s) => !(s.id === id && s.userId === userId));
    if (this.#subs.length === before) return false;
    this.#flush();
    return true;
  }

  dropId(id) {
    const before = this.#subs.length;
    this.#subs = this.#subs.filter((s) => s.id !== id);
    if (this.#subs.length !== before) this.#flush();
  }

  dropUser(userId) {
    const before = this.#subs.length;
    this.#subs = this.#subs.filter((s) => s.userId !== userId);
    if (this.#subs.length !== before) this.#flush();
  }

  forUser(userId) {
    return this.#subs.filter((s) => s.userId === userId);
  }

  has(userId, endpoint) {
    const id = subId(endpoint);
    return this.#subs.some((s) => s.id === id && s.userId === userId);
  }

  get size() {
    return this.#subs.length;
  }

  // Presence (in memory only): the device of this subscription shows chat X
  // in a focused, visible window right now. iOS revokes a subscription whose
  // pushes end without a notification, so «this chat is open» is decided
  // HERE, before sending; the service worker check is the second layer.
  #seen = new Map(); // subId → {chat, at}
  setPresence(userId, endpoint, chat, now = Date.now()) {
    if (!this.has(userId, endpoint)) return false;
    const id = subId(endpoint);
    if (typeof chat === "string" && chat) this.#seen.set(id, { chat, at: now });
    else this.#seen.delete(id);
    return true;
  }

  present(id, chat, now = Date.now(), freshMs = PRESENCE_MS) {
    const s = this.#seen.get(id);
    return Boolean(s && chat && s.chat === chat && now - s.at < freshMs);
  }
}

// ---- triggers ------------------------------------------------------------------------

const TEXT = {
  done: { title: (t) => `Готово: ${t}`, body: "Ход завершён", urgency: "normal", ttl: 6 * 3600 },
  error: { title: (t) => `Ошибка: ${t}`, body: "Ход завершился с ошибкой", urgency: "normal", ttl: 6 * 3600 },
  ask: { title: (t) => `Нужен ваш ответ: ${t}`, body: "Агент ждёт разрешения или ответа", urgency: "high", ttl: 24 * 3600 },
};

export function payloadFor(kind, { sid, title }) {
  const t = TEXT[kind] ?? TEXT.done;
  const name = String(title || "Новый чат").replace(/\s+/g, " ").trim().slice(0, 80);
  return { title: t.title(name), body: t.body, chat: sid, kind, url: `/zai/#/chat/${encodeURIComponent(sid)}`, tag: `zai-${sid}` };
}

// deps:
//   store: PushStore; vapid: keys; subject;
//   recipients(dir) → [userId] — owners of a chat folder;
//   chatInfo(sid) → Promise<{dir, title, parentID}|null>;
//   isManaged(sid) → true for chats whose end comes via onTurnEnd (Claude);
//   send(sub, payload, opts) (default sendPush); debounceMs; now(); log.
export class PushNotifier {
  #d;
  #busy = new Set();
  #errored = new Set();
  #last = new Map(); // sid → {at, kind}
  constructor(deps) {
    this.#d = { debounceMs: 20_000, now: () => Date.now(), log: console.log, send: sendPush, isManaged: () => false, ...deps };
  }

  // Debounce: no more than once per debounceMs per chat. A question/permission
  // is not swallowed by a «done» of the same chat a moment earlier (the person
  // is needed — that is the point of the notification).
  allow(sid, kind) {
    const now = this.#d.now();
    const last = this.#last.get(sid);
    if (last && now - last.at < this.#d.debounceMs && !(kind === "ask" && last.kind !== "ask")) return false;
    this.#last.set(sid, { at: now, kind });
    if (this.#last.size > 2000) for (const k of [...this.#last.keys()].slice(0, 500)) this.#last.delete(k);
    return true;
  }

  // Hub listener (raw SSE data). opencode chats: busy → idle = turn end;
  // permission.asked / question.asked = the agent needs the person.
  observe(data, dir = null) {
    if (typeof data !== "string" || !/"(session\.status|session\.idle|session\.error|session\.deleted|permission\.asked|question\.asked)"/.test(data)) return;
    let evt;
    try {
      evt = JSON.parse(data);
    } catch {
      return;
    }
    const p = evt?.properties ?? {};
    const sid = p.sessionID;
    if (typeof sid !== "string" || !sid) return;
    const type = evt.type;
    if (type === "permission.asked" || type === "question.asked") {
      void this.fire("ask", sid, dir);
      return;
    }
    if (this.#d.isManaged(sid)) return; // Claude: onTurnEnd
    if (type === "session.status") {
      const st = typeof p.status === "string" ? p.status : p.status?.type;
      if (st && st !== "idle") {
        this.#busy.add(sid);
        return;
      }
    }
    if (type === "session.error") {
      if (this.#busy.has(sid)) this.#errored.add(sid);
      return;
    }
    if (type === "session.deleted") {
      this.#busy.delete(sid);
      this.#errored.delete(sid);
      return;
    }
    // idle (status idle or session.idle)
    if (!this.#busy.delete(sid)) return;
    const kind = this.#errored.delete(sid) ? "error" : "done";
    void this.fire(kind, sid, dir);
  }

  // Claude onTurnEnd({sid, dir, reason}).
  claudeTurnEnd({ sid, dir = null, reason = null } = {}) {
    if (typeof sid !== "string" || !sid) return Promise.resolve(0);
    // The person stopped / deleted / restarted it — nobody waits for news.
    if (["user", "cancelled", "deleted", "restart"].includes(reason)) return Promise.resolve(0);
    return this.fire(reason ? "error" : "done", sid, dir);
  }

  // → number of subscriptions the message was handed to.
  async fire(kind, sid, dir = null) {
    try {
      let info = (await this.#d.chatInfo(sid)) ?? {};
      let chat = sid;
      if (info.parentID) {
        if (kind !== "ask") return 0; // a sub-agent's turn end is not the chat's
        chat = info.parentID;
        info = (await this.#d.chatInfo(chat)) ?? info;
      }
      if (!this.allow(chat, kind)) return 0;
      const users = this.#d.recipients(info.dir ?? dir ?? null);
      const payload = payloadFor(kind, { sid: chat, title: info.title });
      let n = 0;
      for (const userId of users) n += (await this.sendToUser(userId, payload, { topic: topicFor(chat), urgency: TEXT[kind]?.urgency, ttl: TEXT[kind]?.ttl })).ok;
      return n;
    } catch (err) {
      this.#d.log(`[zai-push] ${kind} ${sid}: ${err?.message ?? err}`);
      return 0;
    }
  }

  // → {ok: accepted deliveries, results: [{id, status}]}; dead subscriptions are dropped.
  async sendToUser(userId, payload, { topic = null, urgency = "normal", ttl = 3600 } = {}) {
    let ok = 0;
    const results = [];
    for (const sub of this.#d.store.forUser(userId)) {
      if (payload.chat && this.#d.store.present(sub.id, payload.chat, this.#d.now())) {
        results.push({ id: sub.id, status: "present" });
        continue;
      }
      let host = "?";
      try {
        host = new URL(sub.endpoint).host;
        const r = await this.#d.send(sub, payload, { vapid: this.#d.vapid, subject: this.#d.subject, topic, urgency, ttl, keyObject: this.#d.keyObject ?? null, fetchImpl: this.#d.fetchImpl ?? fetch });
        results.push({ id: sub.id, status: r.status });
        if (r.gone) {
          this.#d.store.dropId(sub.id);
          this.#d.log(`[zai-push] подписка ${sub.id} (${host}) недействительна (${r.status}) — удалена`);
        } else if (r.status >= 200 && r.status < 300) ok += 1;
        else this.#d.log(`[zai-push] ${host} ответил ${r.status} (подписка ${sub.id})`);
      } catch (err) {
        results.push({ id: sub.id, status: 0 });
        this.#d.log(`[zai-push] отправка на ${host} не удалась: ${err?.message ?? err}`);
      }
    }
    return { ok, results };
  }
}
