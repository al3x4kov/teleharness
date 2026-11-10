// Партийный прогон тестов (TASK-14.3, tests.md §1.1, §3.1-4/9).
//
//   node tests/run-tests.mjs all      # unit+components (параллельно) → server (последовательно)
//   node tests/run-tests.mjs unit     # L1 + L2: без спавна процессов и сетевых серверов
//   node tests/run-tests.mjs server   # L3/L3e: server.js / edge / hub с фейковым upstream
//   node tests/run-tests.mjs server --batch=3   # партиями по 3 файла
//
// Зачем: `node --test tests/` на Node 24 падает (каталог трактуется как файл);
// параллельный прогон 6 серверов исторически вешался. Здесь: явные glob-ы,
// server-e2e — --test-concurrency=1, у всех --test-timeout; партии печатают
// итог каждая, так что после обрыва видно, что уже прошло, а что нет.
// Классификация файла — по содержимому: спавн процесса / свой http-сервер =
// server, иначе unit.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(TESTS);
const mode = process.argv[2] ?? "all";
const batchArg = process.argv.find((a) => a.startsWith("--batch="));
const BATCH = batchArg ? Math.max(1, Number(batchArg.slice(8))) : 0;

const list = (dir) =>
  readdirSync(path.join(TESTS, dir))
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join("tests", dir, f));

const all = [...list(""), ...list("components")];
const isServer = (f) => /\bspawn(Portal|Edge)?\(|http\.createServer\(|from "\.\.?\/(lib\/)?hub\.js"|\/lib\/hub\.js/.test(readFileSync(path.join(ROOT, f), "utf8"));
const server = all.filter(isServer);
const unit = all.filter((f) => !server.includes(f));

function run(files, { serial }) {
  if (files.length === 0) return 0;
  const args = ["--test", "--test-timeout=60000", ...(serial ? ["--test-concurrency=1"] : []), ...files];
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  return r.status ?? 1;
}

function runBatched(files, opts, label) {
  if (!BATCH) return run(files, opts);
  let worst = 0;
  for (let i = 0; i < files.length; i += BATCH) {
    const part = files.slice(i, i + BATCH);
    console.log(`\n[run-tests] ${label}: партия ${i / BATCH + 1} — ${part.join(", ")}`);
    const code = run(part, opts);
    console.log(`[run-tests] ${label}: партия ${i / BATCH + 1} → ${code === 0 ? "OK" : "FAIL (" + code + ")"}`);
    worst = worst || code;
  }
  return worst;
}

let code = 0;
if (mode === "unit" || mode === "all") {
  console.log(`[run-tests] unit/components: ${unit.length} файлов`);
  code = runBatched(unit, { serial: false }, "unit") || code;
}
if (mode === "server" || mode === "all") {
  console.log(`[run-tests] server-e2e: ${server.length} файлов (последовательно)`);
  code = runBatched(server, { serial: true }, "server") || code;
}
if (!["unit", "server", "all"].includes(mode)) {
  console.error(`неизвестный режим ${mode}: unit | server | all`);
  code = 2;
}
process.exit(code);
