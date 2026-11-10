// Свежесть графа graphify (TASK-15.5, REQ-X4006 70/U001).
//
//   node scripts/graph-fresh.mjs            # из корня репозитория
//   node scripts/graph-fresh.mjs --json     # машинный вывод
//   node scripts/graph-fresh.mjs --root=<dir> --graph=<path>
//
// Сравнивает mtime graphify-out/graph.json с самым свежим mtime отслеживаемых
// исходников (server.js, build.mjs, lib/, src/, shared/, ops/ — только код).
// Exit: 0 — граф свежий; 1 — устарел (есть исходник новее графа);
//       2 — графа нет или ошибка чтения.
// Лечение при exit 1/2: `graphify update .` (скилл graphify), затем повторить.
// Чистые функции экспортируются для tests/graph-fresh.test.js.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SOURCE_ROOTS = ["server.js", "build.mjs", "lib", "src", "shared", "ops"];
export const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".ps1"]);
// Секреты и артефакты не считаются исходниками (и не обходятся).
const SKIP_DIRS = new Set(["node_modules", "certs", ".git", "graphify-out", "public", "data"]);

// Самый свежий файл кода под root по списку SOURCE_ROOTS → {file, mtimeMs} | null.
export function newestSource(root, roots = SOURCE_ROOTS) {
  let best = null;
  const consider = (abs) => {
    if (!CODE_EXT.has(path.extname(abs).toLowerCase())) return;
    const st = statSync(abs);
    if (!best || st.mtimeMs > best.mtimeMs) best = { file: path.relative(root, abs).split(path.sep).join("/"), mtimeMs: st.mtimeMs };
  };
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(abs);
      } else if (ent.isFile()) consider(abs);
    }
  };
  for (const rel of roots) {
    const abs = path.join(root, rel);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walk(abs);
    else if (st.isFile()) consider(abs);
  }
  return best;
}

// Вердикт по корню репозитория → {status: "fresh"|"stale"|"missing", graph, graphMtimeMs, newest, lagMs}.
export function checkGraph(root, graphPath = path.join(root, "graphify-out", "graph.json")) {
  let graphMtimeMs = null;
  try { graphMtimeMs = statSync(graphPath).mtimeMs; } catch { /* нет графа */ }
  const newest = newestSource(root);
  if (graphMtimeMs == null) return { status: "missing", graph: graphPath, graphMtimeMs, newest, lagMs: null };
  const lagMs = newest ? Math.max(0, newest.mtimeMs - graphMtimeMs) : 0;
  return { status: lagMs > 0 ? "stale" : "fresh", graph: graphPath, graphMtimeMs, newest, lagMs };
}

export const exitCode = (r) => (r.status === "fresh" ? 0 : r.status === "stale" ? 1 : 2);

const iso = (ms) => (ms == null ? "—" : new Date(ms).toISOString());

export function formatReport(r) {
  if (r.status === "missing") return `graph-fresh: MISSING — нет ${r.graph}; выполнить \`graphify update .\``;
  const src = r.newest ? `${r.newest.file} ${iso(r.newest.mtimeMs)}` : "исходников нет";
  if (r.status === "fresh") return `graph-fresh: OK — граф ${iso(r.graphMtimeMs)} ≥ самый свежий исходник ${src}`;
  const min = Math.ceil(r.lagMs / 60000);
  return `graph-fresh: STALE — граф ${iso(r.graphMtimeMs)} старше ${src} на ${min} мин; выполнить \`graphify update .\``;
}

function main(argv) {
  const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const root = path.resolve(arg("root") ?? path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const graph = arg("graph") ? path.resolve(arg("graph")) : undefined;
  let r;
  try {
    r = checkGraph(root, graph);
  } catch (err) {
    console.error(`graph-fresh: ERROR — ${err?.message ?? err}`);
    return 2;
  }
  console.log(argv.includes("--json") ? JSON.stringify(r) : formatReport(r));
  return exitCode(r);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
