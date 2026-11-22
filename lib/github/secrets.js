// FEAT-20.3 (1.1): шифрованное хранение сторонних токенов (GitHub PAT).
// AES-256-GCM; ключ — data/secrets.key (32 случайных байта, файл 0600).
// Ротация: rotateKey() подменяет ключ, хранилище перешифровывает значения
// (connections.rotateSecrets). Токен не попадает в ответы API и логи:
// наружу отдаётся last4, для печати — redact().
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const KEY_FILE = "secrets.key";

// Ключ: существующий читаем; создаём 0600 только если файла нет. Ключ чужой
// длины — громкая ошибка: тихая пересоздача потеряла бы все сохранённые токены.
export function loadKey(dataDir, { fsImpl = fs, random = randomBytes } = {}) {
  const file = path.join(dataDir, KEY_FILE);
  let key;
  try {
    key = fsImpl.readFileSync(file);
    if (key.length !== 32) throw new Error(`Ключ ${file} повреждён (длина ${key.length} ≠ 32) — хранилище токенов не открывается`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    key = random(32);
    fsImpl.mkdirSync(dataDir, { recursive: true });
    const fd = fsImpl.openSync(file, "wx", 0o600); // wx: не затереть существующий
    try { fsImpl.writeSync(fd, key); } finally { fsImpl.closeSync(fd); }
  }
  return key;
}

export function encrypt(key, plaintext, { random = randomBytes } = {}) {
  const iv = random(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), ct.toString("base64"), cipher.getAuthTag().toString("base64")].join(":");
}

// Бросает при подмене/повреждении (auth tag не сойдётся) — молча не читаем.
export function decrypt(key, box) {
  const parts = String(box ?? "").split(":");
  const [v, iv, ct, tag] = parts;
  if (v !== "v1" || parts.length !== 4 || !iv || !ct || !tag) throw new Error("Секрет в неизвестном формате");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

// Ротация: старый ключ → новый, файл заменяется атомарно (tmp + rename).
// Перешифровку значений делает хранилище сразу после (rotateSecrets) — между
// rotateKey и rotateSecrets читать токены нельзя.
export function rotateKey(dataDir, { fsImpl = fs, random = randomBytes } = {}) {
  const file = path.join(dataDir, KEY_FILE);
  const oldKey = loadKey(dataDir, { fsImpl, random });
  const newKey = random(32);
  const tmp = `${file}.new`;
  const fd = fsImpl.openSync(tmp, "w", 0o600);
  try { fsImpl.writeSync(fd, newKey); } finally { fsImpl.closeSync(fd); }
  fsImpl.renameSync(tmp, file);
  return { oldKey, newKey };
}

// Лицо подключения: максимум 4 последних символа (кр. 1).
export const last4 = (token) => String(token ?? "").slice(-4);

// Логи/исключения: вхождения секретов → «••••» до печати. Короткие (<8) не
// считаются секретами — иначе замусорим текст.
export function redact(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets ?? []) {
    const v = String(s ?? "");
    if (v.length >= 8) out = out.split(v).join("••••");
  }
  return out;
}
