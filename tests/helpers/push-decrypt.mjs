// FEAT-07.20: the receiving side of RFC 8291 (what a browser does) — tests
// decrypt what lib/push.js sent and verify the VAPID JWT with the public key.
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";

const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
const expand1 = (prk, info, len) => hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);

// A fresh «browser» subscription key pair: {p256dh, auth, privateKey}.
export function makeUaKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url"), privateKey: ecdh.getPrivateKey() };
}

export function decryptPayload(body, ua) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const rs = buf.readUInt32BE(16);
  const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen);
  const ct = buf.subarray(21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(ua.privateKey));
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const ikm = expand1(hmac(Buffer.from(ua.auth, "base64url"), secret), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32);
  const prk = hmac(salt, ikm);
  const cek = expand1(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = expand1(prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--; // padding
  if (plain[end] !== 2) throw new Error("no last-record delimiter");
  return { rs, text: plain.subarray(0, end).toString("utf8") };
}

// Authorization: vapid t=<jwt>, k=<key> → {header, claims, valid}
export function checkVapid(authorization) {
  const m = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(String(authorization || ""));
  if (!m) return { valid: false };
  const [h, c, s] = m[1].split(".");
  const pub = Buffer.from(m[2], "base64url");
  const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33, 65).toString("base64url") } });
  const valid = verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  return { valid, k: m[2], header: JSON.parse(Buffer.from(h, "base64url")), claims: JSON.parse(Buffer.from(c, "base64url")) };
}
