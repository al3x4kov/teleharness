// BUG-224 (BUG-12.33, design §4): не-прод экземпляр отказывает ЛЮБОЙ прод-порт
// апстрима — :4096 (opencode 1.x) и :4196 (opencode 2.x, с 1.16.0). Раньше
// защита знала только :4096. Образец — проверки конфигурации в
// tests/g1-units.test.js: spawnSync с таймаутом, tmp-каталог данных, чистое
// окружение из tests/helpers/env.mjs. Сервер завершается ДО любого сетевого
// обращения: защита в server.js стоит раньше старта слушателя (ADR-003 п.2,
// проверено g1-units: «before the hub dials anything»).
// Run: node --test tests/stand-guard.test.js
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROD_UPSTREAM_PORTS } from "../lib/config.js";
import { FORBIDDEN_PORTS, isolatedServerEnv, makeTmpRoot } from "./helpers/env.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ISO = makeTmpRoot("zai-stand-guard-");
after(() => ISO.cleanup());

test("сверка: каждый порт PROD_UPSTREAM_PORTS есть в FORBIDDEN_PORTS тестовой защиты", () => {
  assert.ok(Array.isArray(PROD_UPSTREAM_PORTS) && PROD_UPSTREAM_PORTS.length > 0);
  for (const port of PROD_UPSTREAM_PORTS) {
    assert.ok(FORBIDDEN_PORTS.has(port), `:${port} из PROD_UPSTREAM_PORTS нет в FORBIDDEN_PORTS (tests/helpers/env.mjs)`);
  }
});

// Адрес собирается из частей: литерал прод-апстрима в исходниках тестов
// запрещён контрактом no-prod (TASK-14.4, tests/no-prod.test.js).
for (const port of PROD_UPSTREAM_PORTS) {
  test(`ZAI_ENV=stand отказывает прод-upstream :${port} — код 1, порт назван в stderr`, () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "server.js")], {
      env: {
        ...isolatedServerEnv({ tmp: ISO, mock: true }),
        ZAI_DATA_DIR: ISO.data,
        ZAI_MOCK: "0",
        ZAI_ENV: "stand",
        ZAI_UPSTREAM: `http://127.0.0.1:${port}`,
      },
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(r.status, 1, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /ZAI_ENV=stand/);
    assert.match(r.stderr, new RegExp(`:${port}\\b`), "в отказе назван порт");
  });
}
