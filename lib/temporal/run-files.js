// FEAT-19.16 (U012 п.2): files of one run folder for the run screen.
import { readdirSync, statSync, realpathSync } from "node:fs";
import path from "node:path";

export function listRunFiles(workspace, relFolder, { max = 200 } = {}) {
  if (!relFolder) return [];
  const root = path.join(workspace, relFolder);
  let realRoot;
  try { realRoot = realpathSync(root); } catch { return []; }
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4 || out.length >= max) return;
    let names = [];
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= max || d.name.startsWith(".")) continue;
      const full = path.join(dir, d.name);
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) { walk(full, depth + 1); continue; }
      if (!d.isFile()) continue;
      let st; try { st = statSync(full); } catch { continue; }
      out.push({ path: path.relative(workspace, full), name: path.relative(realRoot, full), size: st.size, modified: st.mtime.toISOString() });
    }
  };
  walk(realRoot, 0);
  return out;
}
