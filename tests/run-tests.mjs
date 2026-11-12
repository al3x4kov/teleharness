// Партийный прогон тестов (TASK-14.3, tests.md §1.1, §3.1-4/9; BUG-222: QA-04, QA-05).
//
//   node tests/run-tests.mjs all      # unit+components (параллельно) → server (последовательно)
//   node tests/run-tests.mjs unit     # L1 + L2: без спавна процессов и сетевых серверов
//   node tests/run-tests.mjs server   # L3/L3e: server.js / edge / hub с фейковым upstream
//   node tests/run-tests.mjs server --batch=3   # партиями по 3 файла
//   node tests/run-tests.mjs files <путь…>      # только названные файлы, по одному —
//                                               # для разбора зависшего набора (строка ТАЙМАУТ)
//
// Зачем: `node --test tests/` на Node 24 падает (каталог трактуется как файл);
// параллельный прогон 6 серверов исторически вешался. Здесь: явные glob-ы,
// server-e2e — --test-concurrency=1, у всех --test-timeout; партии печатают
// итог каждая, так что после обрыва видно, что уже прошло, а что нет.
//
// Таймаут набора (QA-04): --test-timeout ограничивает тесты, но не top-level
// after-хуки — зависший after вешал npm test навсегда. Теперь у каждой партии
// свой дедлайн: unit 10 мин, server-файл или server-партия 5 мин
// (ZAI_TEST_TIMEOUT_UNIT_MS / ZAI_TEST_TIMEOUT_SERVER_MS переопределяют).
// При срабатывании печатается «ТАЙМАУТ: набор/партия — файлы» с подсказкой
// запустить файлы по одному, дерево процесса добивается (Windows: taskkill /T /F
// по pid дочернего — spawnSync/kill убивают только прямой процесс, а внуки —
// server.js, CLI-фикстуры — остались бы сиротами), код возврата 1.
//
// Классификация файла (QA-05): server, если файл спавнит процесс (spawn(
// / spawnPortal( / spawnEdge( / spawnSync() или поднимает свой http-сервер,
// или импортирует хаб. Метка в первых 5 строках решает явно:
// `// @suite: server` — server; `// @suite: unit` — исключение для файла,
// который spawnSync-ит быстрый чистый скрипт. Классификатор экспортируется
// для tests/run-tests-runner.test.js; при импорте модуль ничего не запускает.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(TESTS);
const THIS_FILE = fileURLToPath(import.meta.url);

// Первый явный маркер @suite в первых 5 строках решает; без метки — содержимое.
export function classifySuite(source) {
  for (const line of source.split(/\r?\n/).slice(0, 5)) {
    const m = /@suite:\s*(server|unit)/.exec(line);
    if (m) return m[1];
  }
  if (/\bspawn(Portal|Edge|Sync)?\(|http\.createServer\(|from "\.\.?\/(lib\/)?hub\.js"|\/lib\/hub\.js/.test(source)) return "server";
  return "unit";
}

const envMs = (name, def) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
};

// BUG-222: spawn + дедлайн вместо spawnSync без timeout; при срабатывании —
// печатаем набор/партию и файлы, добиваем дерево, возвращаем 1.
function run(files, { serial, timeoutMs, label }) {
  if (files.length === 0) return Promise.resolve(0);
  const args = ["--test", "--test-timeout=60000", ...(serial ? ["--test-concurrency=1"] : []), ...files];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: "inherit", windowsHide: true });
    let done = false;
    let timedOut = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(timedOut ? 1 : code ?? 1);
    };
    const killTree = () => {
      // по pid дочернего, никогда по имени: по имени убили бы и прод-процессы
      if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
      else child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`\n[run-tests] ТАЙМАУТ: ${label} — ${files.join(", ")}`);
      console.error("[run-tests] подсказка: запустите файлы по одному — node --test --test-timeout=60000 <файл> (или node tests/run-tests.mjs files <файл…>)");
      killTree();
    }, timeoutMs);
    child.on("exit", (code) => finish(code));
    child.on("error", () => finish(1));
  });
}

async function runBatched(files, opts, label, BATCH = 0) {
  // без партий весь набор — один запуск: дедлайн растёт с числом файлов (база — на 4 файла)
  if (!BATCH) return run(files, { ...opts, timeoutMs: opts.timeoutMs * Math.max(1, Math.ceil(files.length / 4)), label });
  let worst = 0;
  for (let i = 0; i < files.length; i += BATCH) {
    const part = files.slice(i, i + BATCH);
    const name = `${label}: партия ${i / BATCH + 1}`;
    console.log(`\n[run-tests] ${name} — ${part.join(", ")}`);
    const code = await run(part, { ...opts, label: name });
    console.log(`[run-tests] ${name} → ${code === 0 ? "OK" : "FAIL (" + code + ")"}`);
    worst = worst || code;
  }
  return worst;
}

async function main() {
  const mode = process.argv[2] ?? "all";
  const batchArg = process.argv.find((a) => a.startsWith("--batch="));
  const BATCH = batchArg ? Math.max(1, Number(batchArg.slice(8))) : 0;
  const UNIT_MS = envMs("ZAI_TEST_TIMEOUT_UNIT_MS", 600_000);
  const SERVER_MS = envMs("ZAI_TEST_TIMEOUT_SERVER_MS", 300_000);

  const list = (dir) =>
    readdirSync(path.join(TESTS, dir))
      .filter((f) => f.endsWith(".test.js"))
      .map((f) => path.join("tests", dir, f));

  // TASK-16.7: тесты плагина v2, песочницы и конфигов opencode (ops/opencode/tests/*.test.mjs)
  // раньше в npm test не входили — регрессии плагина ловились только живьём (BUG-193/194).
  const opsTests = readdirSync(path.join(ROOT, "ops", "opencode", "tests"))
    .filter((f) => f.endsWith(".test.mjs"))
    .map((f) => path.join("ops", "opencode", "tests", f));
  const all = [...list(""), ...list("components"), ...opsTests];
  const isServer = (f) => classifySuite(readFileSync(path.join(ROOT, f), "utf8")) === "server";
  const server = all.filter(isServer);
  const unit = all.filter((f) => !server.includes(f));

  let code = 0;
  if (mode === "files") {
    const files = process.argv.slice(3);
    if (files.length === 0) {
      console.error("режим files: укажите хотя бы один путь к тест-файлу");
      code = 2;
    }
    for (const f of files) {
      console.log(`\n[run-tests] files — ${f}`);
      code = (await run([f], { serial: true, timeoutMs: SERVER_MS, label: `files: ${f}` })) || code;
    }
  }
  if (mode === "unit" || mode === "all") {
    console.log(`[run-tests] unit/components: ${unit.length} файлов (дедлайн партии ${UNIT_MS} мс)`);
    code = (await runBatched(unit, { serial: false, timeoutMs: UNIT_MS }, "unit", BATCH)) || code;
  }
  if (mode === "server" || mode === "all") {
    console.log(`[run-tests] server-e2e: ${server.length} файлов (последовательно, дедлайн ${SERVER_MS} мс)`);
    code = (await runBatched(server, { serial: true, timeoutMs: SERVER_MS }, "server", BATCH)) || code;
  }
  if (!["unit", "server", "all", "files"].includes(mode)) {
    console.error(`неизвестный режим ${mode}: unit | server | all | files`);
    code = 2;
  }
  process.exit(code);
}

// Защита «запущен как скрипт» (BUG-222): при импорте (тест раннера импортирует
// classifySuite) ничего не выполняется.
const arg1 = process.argv[1] ? path.resolve(process.argv[1]) : null;
const isMain = arg1 !== null && (process.platform === "win32" ? arg1.toLowerCase() === THIS_FILE.toLowerCase() : arg1 === THIS_FILE);
if (isMain) main();
