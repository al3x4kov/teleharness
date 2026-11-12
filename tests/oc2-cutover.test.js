// @suite: server — spawnSync PowerShell-парсера (BUG-222/QA-05)
// FEAT-16.3, п.9 (перевод прода на v2): комплект скриптов.
//   ops/opencode/serve-v2.cmd   — opencode 2.2.6 serve на :4196, своя XDG-зона
//                                 D:\Portal\zai-oc2, пароль из data\oc2-password.txt
//   ops/web-v2.cmd              — тот же server.js, только ZAI_OC_API/ZAI_UPSTREAM/ZAI_OC_PASSWORD
//   ops/deploy/oc2-install.ps1  — разовая подготовка прода v2: бинарник (SHA256),
//                                 пароль (генерация + ACL), XDG, конфиг/плагин/скиллы,
//                                 регистрация S4U-задачи zai-opencode-v2 БЕЗ запуска
// Скрипты ничего не стартуют и не рестартуют: запуск/переключение — решение Claude.
// Проверки статические (разбор текста), по образцу ops/opencode/tests/glm-config.test.mjs:
// порт, XDG-зона, пароль только через set /p (не печатается), файлы ASCII
// (PS 5.1 без BOM читает не-ASCII как ANSI, cmd — по кодовой странице).
// Run: node --test tests/oc2-cutover.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const read = (f) => readFileSync(path.join(ROOT, f), "utf8");
// ASCII-байт в байт: ни кириллицы, ни BOM — файл целиком <= 0x7F
const ascii = (f) => {
  const buf = readFileSync(path.join(ROOT, f));
  const bad = [...buf].filter((b) => b > 0x7f).length;
  return { ok: bad === 0, bad };
};
const PASSWORD_FILE = "D:\\Portal\\zai\\data\\oc2-password.txt";
// литеральный текст → источник regex (бэкслеши и метасимволы)
const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pwReadRe = (varName) => new RegExp(`set /p ${varName}=<${re(PASSWORD_FILE)}`);

// ---- serve-v2.cmd ------------------------------------------------------------

test("serve-v2.cmd: порт 4196, XDG-зона zai-oc2, проектный конфиг отключён, OUTPUT_TOKEN_MAX как в 1.x", () => {
  const s = read("ops/opencode/serve-v2.cmd");
  assert.match(s, /serve --hostname 127\.0\.0\.1 --port 4196/);
  assert.match(s, /set "XDG_CONFIG_HOME=D:\\Portal\\zai-oc2\\config"/);
  assert.match(s, /set "XDG_DATA_HOME=D:\\Portal\\zai-oc2\\data"/);
  assert.match(s, /set "XDG_STATE_HOME=D:\\Portal\\zai-oc2\\state"/);
  assert.match(s, /set "HOME=D:\\Portal\\zai-oc2\\home"/);
  assert.match(s, /set "OPENCODE_DISABLE_PROJECT_CONFIG=1"/, "как у прод 1.x serve.cmd");
  assert.match(s, /set "OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=65536"/, "BUG-180 паритет с 1.x");
  assert.match(s, /D:\\Portal\\zai-oc2\\bin\\opencode\.exe/, "бинарник — копия в зоне v2");
  assert.match(s, /%~1/, "путь бинарника можно передать параметром");
  assert.match(s, /zai-oc2\\logs/, "логи serve — в XDG-зоне");
});

test("serve-v2.cmd: пароль только из файла через set /p, не печатается; ASCII", () => {
  const s = read("ops/opencode/serve-v2.cmd");
  assert.match(s, pwReadRe("OPENCODE_SERVER_PASSWORD"));
  assert.doesNotMatch(s, /echo[^\r\n]*%OPENCODE_SERVER_PASSWORD%/i, "пароль не печатается");
  assert.doesNotMatch(s, /set OPENCODE_SERVER_PASSWORD=[^\r\n]+/, "значение задают только set /p и сброс");
  const a = ascii("ops/opencode/serve-v2.cmd");
  assert.equal(a.ok, true, `не-ASCII байт: ${a.bad}`);
});

// ---- web-v2.cmd --------------------------------------------------------------

test("web-v2.cmd: только ZAI_OC_API/ZAI_UPSTREAM/ZAI_OC_CONFIG_FILE/ZAI_OC_PASSWORD, затем node server.js; пароль не печатается; ASCII", () => {
  const s = read("ops/web-v2.cmd");
  assert.match(s, /set "ZAI_OC_API=v2"/);
  assert.match(s, /set "ZAI_UPSTREAM=http:\/\/127\.0\.0\.1:4196"/);
  assert.match(s, pwReadRe("ZAI_OC_PASSWORD"));
  // запуск — как действие задачи zai-web (watchdog): абсолютный node + cwd корня репо
  assert.match(s, /cd \/d D:\\Portal\\zai\r?\n/);
  assert.match(s, /D:\\nodejs\\node\.exe D:\\Portal\\zai\\server\.js\r?\n/);
  // остальные env не задавать: прод живёт на умолчаниях lib/config.js.
  // Разрешены ровно пять строк: три set "NAME=...", сброс пароля и set /p.
  // BUG-190: ZAI_OC_CONFIG_FILE — путь к конфигу зоны v2 (версия slim в «О приложении»), не секрет.
  const sets = s.split(/\r?\n/).filter((l) => /^set /i.test(l));
  assert.deepEqual(
    sets,
    [
      'set "ZAI_OC_API=v2"',
      'set "ZAI_UPSTREAM=http://127.0.0.1:4196"',
      String.raw`set "ZAI_OC_CONFIG_FILE=D:\Portal\zai-oc2\config\opencode\opencode.json"`,
      'set "ZAI_OC_PASSWORD="',
      `set /p ZAI_OC_PASSWORD=<${PASSWORD_FILE}`,
    ],
    "в web-v2.cmd задаются только ZAI_OC_API/ZAI_UPSTREAM/ZAI_OC_PASSWORD",
  );
  assert.doesNotMatch(s, /echo[^\r\n]*%ZAI_OC_PASSWORD%/i, "пароль не печатается");
  assert.doesNotMatch(s, /ZAI_DATA_DIR|ZAI_PORT|ZAI_COOKIE|ZAI_PUBLIC_DIR|ZAI_ENV/, "прод-умолчания не трогаем");
  const a = ascii("ops/web-v2.cmd");
  assert.equal(a.ok, true, `не-ASCII байт: ${a.bad}`);
});

// ---- oc2-install.ps1 ---------------------------------------------------------

test("oc2-install.ps1: SHA256 копии бинарника, пароль генерируется один раз + ACL, без запусков и рестартов", () => {
  const s = read("ops/deploy/oc2-install.ps1");
  // бинарник: хэш источника сверяется с пином, копии — с источником
  assert.match(s, /Get-FileHash[^\r\n]*SHA256/);
  assert.match(s, /ExpectedSha256/, "пин хэша — параметром");
  assert.match(s, /\$dstBin = "\$Root\\bin\\opencode\.exe"/, "копия кладётся в зону v2");
  assert.match(s, /Copy-Item \$Binary \$dstBin/);
  // пароль: генерация только если файла нет; значение в файл, не в вывод
  assert.match(s, /if \(Test-Path \$PasswordFile\)/, "существующий пароль не перезаписывается");
  assert.match(s, /RandomNumberGenerator/, "генерация криптостойкая");
  assert.match(s, /\[IO\.File\]::WriteAllText\(\$PasswordFile/, "пароль пишется в файл (без перевода строки)");
  assert.match(s, /icacls[^\r\n]*\/inheritance:r/, "ACL: только текущий пользователь");
  assert.doesNotMatch(s, /(Write-Host|Write-Output|Write-Verbose)[^\r\n]*\$pw\b/, "значение пароля не печатается");
  // ничего не стартует и не рестартует: прод (1.x serve :4096, zai-web) не трогается
  assert.doesNotMatch(s, /Start-ScheduledTask|schtasks \/run|schtasks \/change|Restart-Service|Stop-ScheduledTask|Start-Process|Start-Job/i);
  assert.match(s, /Register-ScheduledTask/, "S4U-задача регистрируется");
  assert.match(s, /zai-opencode-v2/, "имя задачи");
  assert.match(s, /LogonType S4U/, "S4U-вход");
  assert.match(s, /NOT started|not started/i, "статус явно говорит: задача не запущена");
  const a = ascii("ops/deploy/oc2-install.ps1");
  assert.equal(a.ok, true, `не-ASCII байт: ${a.bad}`);
});

test("oc2-install.ps1: раскладка конфиг-зоны v2 как на стенде + agent-skills в каталог v2", () => {
  const s = read("ops/deploy/oc2-install.ps1");
  assert.match(s, /opencode\.v2\.json/, "источник конфига");
  assert.match(s, /WriteAllText\("\$cfg\\opencode\.json"/, "файл кладётся как opencode.json в зону поиска v2");
  assert.match(s, /glm-rules\.md/, "инструкция перепатчивается на копию рядом с конфигом (как на стенде)");
  assert.match(s, /ConvertFrom-Json/, "JSON-валидность после патча");
  assert.match(s, /plugin-v2/, "плагин v2");
  assert.match(s, /sandbox-core/, "ядро песочницы (plugin-v2 импортирует ../sandbox-core/index.mjs)");
  assert.match(s, /prompts/, "промпты ({file:./prompts/...})");
  assert.match(s, /skills/, "скиллы zai-*");
  assert.match(s, /oh-my-opencode-slim\.json/, "конфиг slim рядом с opencode.json");
  assert.match(s, /agent-skills-opencode\.mjs/, "скиллы/персоны/команды as-* — тем же установщиком, что в 1.x");
});

// Синтаксис под Windows PowerShell 5.1 (его и запускают S4U-задачи): ловит,
// например, `"$var: ..."` в двойных кавычках (scope-синтаксис) — parse без запуска.
test("oc2-install.ps1: parse PowerShell 5.1 без выполнения", { skip: process.platform !== "win32" }, () => {
  const ps1 = path.join(ROOT, "ops", "deploy", "oc2-install.ps1").replace(/'/g, "''");
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      `$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('${ps1}',[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|ForEach-Object{$_.Message};exit 1}else{'PARSE OK'}`],
    { timeout: 60_000 },
  );
  assert.equal(r.status, 0, `parse failed: ${r.stdout} ${r.stderr}`);
  assert.match(String(r.stdout), /PARSE OK/);
});
