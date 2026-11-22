// FEAT-20.3 (1.1): шифрованное хранение токенов — ключ, ротация, redact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadKey, encrypt, decrypt, rotateKey, last4, redact, KEY_FILE } from "../lib/github/secrets.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "gh-secrets-"));

test("FEAT-20.3: ключ создаётся 0600 и переживает повторное открытие", () => {
  const dir = tmp();
  try {
    const key = loadKey(dir);
    assert.equal(key.length, 32);
    const st = statSync(path.join(dir, KEY_FILE));
    if (process.platform !== "win32") assert.equal(st.mode & 0o777, 0o600, "файл ключа должен быть 0600");
    assert.deepEqual(loadKey(dir), key, "второе открытие возвращает тот же ключ");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3: чужой длины ключ — громкая ошибка, не тихая пересоздача", () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, KEY_FILE), Buffer.alloc(16));
    assert.throws(() => loadKey(dir), /повреждён/);
    assert.equal(readFileSync(path.join(dir, KEY_FILE)).length, 16, "файл не перезаписан");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3: encrypt/decrypt — обратимый, iv уникален, подмена ловится", () => {
  const key = loadKey(tmp());
  const token = "ghs_" + "supersecret_token_value_0123456789";
  const box1 = encrypt(key, token);
  const box2 = encrypt(key, token);
  assert.notEqual(box1, box2, "случайный iv — шифротексты разные");
  assert.equal(decrypt(key, box1), token);
  assert.ok(!box1.includes(token), "шифротекст не содержит открытый токен");
  const parts = box1.split(":");
  parts[2] = parts[2].slice(0, -4) + "AAAA"; // подмена шифротекста
  assert.throws(() => decrypt(key, parts.join(":")));
  const other = loadKey(tmp());
  assert.throws(() => decrypt(other, box1), "чужой ключ не расшифровывает");
});

test("FEAT-20.3: ротация ключа — старый ключ больше не открывает новые записи", () => {
  const dir = tmp();
  try {
    const oldKey = loadKey(dir);
    const before = encrypt(oldKey, "value-a");
    const { oldKey: k1, newKey: k2 } = rotateKey(dir);
    assert.deepEqual(k1, oldKey);
    assert.notEqual(k2, k1);
    assert.deepEqual(loadKey(dir), k2, "файл ключа заменён");
    assert.equal(decrypt(oldKey, before), "value-a", "старая запись читается старым ключом при перешифровке");
    const after = encrypt(k2, "value-b");
    assert.equal(decrypt(k2, after), "value-b");
    assert.throws(() => decrypt(oldKey, after), "старый ключ не читает новые записи");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FEAT-20.3: redact прячет секреты в тексте; наружу — только last4", () => {
  const token = "ghs_" + "supersecret_token_value_0123456789";
  const text = `PUT ok for ${token} at /user`;
  assert.equal(redact(text, [token]), "PUT ok for •••• at /user");
  assert.equal(redact("ничего", []), "ничего");
  assert.equal(redact("короткий abc тут", ["abc"]), "короткий abc тут", "строки <8 не считаются секретами");
  assert.equal(last4(token), "6789");
});
