// FEAT-20.6: учёт истории до фичи (кр. 15; P-12, N-9, N-31). Фоном, пачками, с отметкой после каждой
// пачки (рестарт продолжает с места), запись — тем же upsert (дублей нет, живые записи не трогаются).
//   claude — data/claude-sessions.json (Claude и Codex): ответы без токенов → «нет данных · ход до учёта».
//   opencode — по API opencode: по 5 сессий, пауза 200 мс; сервер не отвечает → ошибка источника,
//     повтор через 10 мин, остальные источники идут.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const RETRY_MS = 10 * 60_000;

export class CostBackfill {
  #ledger;
  #recorder;
  #d;
  #running = new Map();
  #timers = new Set();
  constructor({ ledger, recorder, deps }) {
    this.#ledger = ledger;
    this.#recorder = recorder;
    // deps: claudeSessions() → {sid: {directory, messages}}; ocSessions() → [{id, directory, parentID}];
    //   ocMessages(sid, dir) → [{info}]; batch (20), pauseMs (200), now, log
    this.#d = { batch: 20, ocBatch: 5, pauseMs: 200, now: Date.now, log: () => {}, ...deps };
  }

  state() {
    return this.#ledger.allBackfill().map((s) => ({ source: s.source, done: Boolean(s.done), cursor: s.cursor, total: s.total, error: s.error, retryAt: s.retry_at, progress: s.progress, running: this.#running.has(s.source) }));
  }

  start({ force = false } = {}) {
    const jobs = [];
    if (this.#d.claudeSessions) jobs.push(this.#run("claude", () => this.#claude(force)));
    if (this.#d.ocSessions) jobs.push(this.#run("opencode", () => this.#opencode(force)));
    return Promise.all(jobs);
  }

  stop() {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.#stopped = true;
  }
  #stopped = false;

  #run(source, fn) {
    if (this.#running.has(source)) return this.#running.get(source);
    const p = (async () => {
      try {
        await fn();
      } catch (err) {
        this.#d.log(`[teleharness-cost] backfill ${source}: ${err?.message ?? err}`);
        if (this.#ledger.db) this.#ledger.setBackfill(source, { error: String(err?.message ?? err).slice(0, 200), retry_at: this.#d.now() + RETRY_MS });
        const t = setTimeout(() => {
          this.#timers.delete(t);
          if (!this.#stopped) this.#run(source, fn);
        }, RETRY_MS);
        t.unref?.();
        this.#timers.add(t);
      } finally {
        this.#running.delete(source);
      }
    })();
    this.#running.set(source, p);
    return p;
  }

  async #claude(force) {
    if (!this.#ledger.db) throw new Error("журнал недоступен");
    const st = this.#ledger.backfillState("claude");
    if (st?.done && !force) return;
    const sessions = this.#d.claudeSessions() ?? {};
    const sids = Object.keys(sessions).sort();
    const total = sids.reduce((a, sid) => a + (sessions[sid]?.messages ?? []).filter((m) => m?.info?.role === "assistant").length, 0);
    let i = force ? 0 : Math.min(st?.cursor ?? 0, sids.length);
    let done = 0;
    for (let k = 0; k < i; k++) done += (sessions[sids[k]]?.messages ?? []).filter((m) => m?.info?.role === "assistant").length;
    this.#ledger.setBackfill("claude", { total, cursor: i, done: 0, error: null, retry_at: null, progress: done });
    while (i < sids.length) {
      if (this.#stopped) return;
      for (const sid of sids.slice(i, i + this.#d.batch)) {
        const entry = sessions[sid];
        for (const m of entry?.messages ?? []) {
          const info = m?.info;
          if (info?.role !== "assistant" || typeof info.id !== "string") continue;
          done += 1;
          const completed = info.time?.completed ?? info.time?.created;
          if (!completed) continue;
          this.#recorder.answer({ ...info, sessionID: info.sessionID ?? sid, time: { ...info.time, completed } }, { dir: entry.directory ?? null, source: "backfill" });
        }
      }
      i = Math.min(sids.length, i + this.#d.batch);
      this.#ledger.setBackfill("claude", { cursor: i, total, progress: done });
      await sleep(0);
    }
    this.#ledger.setBackfill("claude", { cursor: i, total, done: 1, error: null, retry_at: null, progress: total });
  }

  async #opencode(force) {
    if (!this.#ledger.db) throw new Error("журнал недоступен");
    const st = this.#ledger.backfillState("opencode");
    if (st?.done && !force) return;
    let list;
    try {
      list = (await this.#d.ocSessions()) ?? [];
    } catch (err) {
      throw new Error("сервер opencode не отвечает");
    }
    list = [...list].filter((s) => s?.id).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    let i = force ? 0 : Math.min(st?.cursor ?? 0, list.length);
    this.#ledger.setBackfill("opencode", { total: list.length, cursor: i, done: 0, error: null, retry_at: null, progress: i });
    while (i < list.length) {
      if (this.#stopped) return;
      for (const s of list.slice(i, i + this.#d.ocBatch)) {
        let msgs;
        try {
          msgs = (await this.#d.ocMessages(s.id, s.directory ?? null)) ?? [];
        } catch {
          throw new Error("сервер opencode не отвечает");
        }
        for (const m of msgs) {
          const info = m?.info;
          if (info?.role !== "assistant" || !info.time?.completed) continue;
          this.#recorder.answer({ ...info, sessionID: info.sessionID ?? s.id }, { dir: s.directory ?? null, source: "backfill", parentSid: s.parentID ?? null });
        }
      }
      i = Math.min(list.length, i + this.#d.ocBatch);
      this.#ledger.setBackfill("opencode", { cursor: i, total: list.length, progress: i });
      await sleep(this.#d.pauseMs);
    }
    this.#ledger.setBackfill("opencode", { cursor: i, total: list.length, done: 1, error: null, retry_at: null, progress: i });
  }
}
