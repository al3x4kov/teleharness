// BUG-195: освобождение простаивающих экземпляров opencode по папкам чатов.
//
// opencode (1.x и 2.x) поднимает на каждую папку, к которой обратился портал
// (ход, история, создание чата, прогрев), свой экземпляр с набором MCP-серверов
// (на проде — пара процессов playwright + marketplace) и держит его до рестарта
// serve. С папкой на каждый чат тенанта (FEAT-04.12) память растёт без предела
// (2026-11-08: 4 serve держали ~200 MCP-процессов, ~5 ГБ).
// Реапер: touch(dir) на каждое обращение; sweep() освобождает папки, простоявшие
// дольше idleMs, если там не идёт ход; защищённые папки (HOME / папка чатов
// владельца) не учитываются. seed() — папки индекса чатов при старте портала:
// экземпляры, поднятые до рестарта портала, тоже уйдут после простоя.
// Освобождённый экземпляр opencode поднимет заново при следующем обращении.
import { pathKey, platformOfPath } from "./paths.js";

// TASK-17.1: Windows — без учёта регистра и вида слэша (как было); Linux — pathKey с учётом регистра
const key = (d) => {
  const s = String(d ?? "");
  if (!s) return "";
  return process.platform === "win32" ? s.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : pathKey(s, platformOfPath(s));
};

export function createInstanceReaper({ idleMs, isProtected = () => false, isBusy = async () => false, dispose, log = () => {} }) {
  if (!(idleMs > 0)) throw new Error("instance-reaper: idleMs must be > 0");
  if (typeof dispose !== "function") throw new Error("instance-reaper: dispose is required");
  const seen = new Map(); // key → { dir, at }
  let running = null;

  function touch(dir, now = Date.now()) {
    const k = key(dir);
    if (!k || isProtected(dir)) return;
    seen.set(k, { dir, at: now });
  }

  function seed(dirs, now = Date.now()) {
    for (const d of dirs ?? []) {
      const k = key(d);
      if (!k || seen.has(k) || isProtected(d)) continue;
      seen.set(k, { dir: d, at: now });
    }
  }

  async function sweepOnce(now) {
    const out = { disposed: 0, busy: 0, kept: 0 };
    for (const [k, rec] of [...seen]) {
      if (now - rec.at < idleMs) {
        out.kept++;
        continue;
      }
      let busy = true;
      try {
        busy = await isBusy(rec.dir);
      } catch {}
      if (busy) {
        out.busy++;
        continue;
      }
      // touch во время await: папка снова активна — не трогаем
      if (seen.get(k) !== rec) continue;
      // BUG-218 (SRV-14, design §3): повторная проверка занятости
      // непосредственно перед dispose — ход, начавшийся в окне, не теряет инстанс
      try {
        if (await isBusy(rec.dir)) {
          out.busy++;
          continue;
        }
      } catch {}
      try {
        await dispose(rec.dir);
        if (seen.get(k) === rec) seen.delete(k);
        out.disposed++;
        // начатый dispose не отменить: busy, появившийся за его время, — гонка, фиксируем
        try {
          if (await isBusy(rec.dir)) log(`[zai-reaper] ${rec.dir}: dispose raced a starting turn`);
        } catch {}
      } catch (err) {
        log(`[zai-reaper] ${rec.dir}: dispose failed — ${err?.message ?? err}`);
      }
    }
    if (out.disposed) log(`[zai-reaper] released ${out.disposed} idle opencode instance(s); tracked ${seen.size}`);
    return out;
  }

  function sweep(now = Date.now()) {
    if (running) return running; // один проход за раз
    running = sweepOnce(now).finally(() => {
      running = null;
    });
    return running;
  }

  return { touch, seed, sweep, size: () => seen.size };
}
