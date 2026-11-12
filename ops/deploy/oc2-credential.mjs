#!/usr/bin/env node
// FEAT-16.3 (tasks 6.2, design §9): перенос ключа провайдера из auth.json (1.x)
// в credential API opencode 2.x. Живой v2: POST /api/credential не идемпотентен
// (повтор того же id → 409, ключ при этом сохранён и работает, Э2), а ответ
// ЭХОМ возвращает ключ открытым текстом (api-map §10). Поэтому:
//   - POST → 409 → DELETE /api/credential/{id} → POST снова;
//   - тело ответа всегда отбрасывается, печатается ТОЛЬКО статус;
//   - ключ и пароль не попадают ни в stdout, ни в stderr (любая печать проходит
//     через redact(), который вырезает их из строки);
//   - в ошибке печатается HTTP-статус и _tag, но не message (там может быть эхо).
//
// Использование:
//   node ops/deploy/oc2-credential.mjs --url=http://127.0.0.1:4101 \
//        --auth=<путь к auth.json> [--id=zai-coding-plan]
//
// Пароль Basic-авторизации v2 — только из окружения: ZAI_OC_PASSWORD или
// OPENCODE_SERVER_PASSWORD. Коды выхода: 0 — установлен/обновлён; 1 — сервер
// отказал или транспорт; 2 — ошибка использования (аргументы, пароль, ключ).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const USAGE =
  "usage: node ops/deploy/oc2-credential.mjs --url=http://127.0.0.1:<port> --auth=<auth.json> [--id=zai-coding-plan]";

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) return { error: `${USAGE} (неожиданный аргумент: ${arg})` };
    const eq = arg.indexOf("=");
    if (eq < 0) return { error: `${USAGE} (ожидается --ключ=значение: ${arg})` };
    const key = arg.slice(2, eq);
    if (!["url", "auth", "id"].includes(key)) return { error: `${USAGE} (неизвестный ключ --${key})` };
    opts[key] = arg.slice(eq + 1);
  }
  if (!opts.url || !opts.auth) return { error: `${USAGE} (нужны --url и --auth)` };
  return { opts };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { opts, error } = parseArgs(argv);
  if (error) {
    console.error(error);
    return 2;
  }
  const id = opts.id ?? "zai-coding-plan";
  const password = env.ZAI_OC_PASSWORD || env.OPENCODE_SERVER_PASSWORD || "";
  if (!password) {
    console.error("нет пароля v2 в окружении: задайте ZAI_OC_PASSWORD (или OPENCODE_SERVER_PASSWORD)");
    return 2;
  }

  // --- ключ из auth.json: читается, но никогда не печатается ---
  let key = null;
  try {
    const auth = JSON.parse(readFileSync(opts.auth, "utf8"));
    const entry = auth?.[id];
    key = entry && typeof entry === "object" ? (entry.key ?? entry.value?.key) : entry;
  } catch (err) {
    console.error(`не удалось прочитать ${opts.auth}: ${err.message}`);
    return 2;
  }
  if (typeof key !== "string" || key === "") {
    console.error(`в ${opts.auth} нет ключа для провайдера «${id}»`);
    return 2;
  }

  // вся печать — через redact: ни ключ, ни пароль не могут просочиться
  const red = (s) => String(s).split(key).join("***").split(password).join("***");
  const fail = (code, msg) => {
    console.error(red(msg));
    return code;
  };

  const base = opts.url.replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json",
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  };
  // тело ответа (эхо ключа) читается в память и отбрасывается, не логируется
  const drain = async (res) => {
    await res.arrayBuffer();
    return res.status;
  };

  const post = () =>
    fetch(`${base}/api/credential`, {
      method: "POST",
      headers,
      body: JSON.stringify({ id, integrationID: id, value: { type: "key", key }, activate: true }),
    }).then(drain);

  let status;
  let updated = false;
  try {
    status = await post();
    if (status === 409) {
      const del = await drain(
        await fetch(`${base}/api/credential/${encodeURIComponent(id)}`, { method: "DELETE", headers }),
      );
      if (!(del === 204 || del === 200 || del === 404)) {
        return fail(1, `удаление существующего credential: HTTP ${del}`);
      }
      status = await post();
      updated = true;
    }
  } catch (err) {
    return fail(1, `транспортная ошибка: ${err.cause?.code ?? err.message}`);
  }

  if (status >= 200 && status < 300) {
    console.log(red(`credential: ок (HTTP ${status}${updated ? ", обновлён после 409" : ""})`));
    return 0;
  }
  // ошибка: только статус; message не печатается (может нести эхо ключа)
  return fail(1, `сервер ответил HTTP ${status}${updated ? " (после удаления при 409)" : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
