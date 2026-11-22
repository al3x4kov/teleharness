// FEAT-20.3 (1.3): часовой обход подключений GitHub (кр. 2).
//  - истечение ≤ 7 дней → предупреждение один раз (warned_at), без сетевого хода;
//  - сам токен перепроверяется не чаще intervalMs (check у GitHub);
//  - истёкший/отозванный: status='expired' и push один раз (expired_notified_at);
//    сеть/лимит/5xx — status='unreachable', это не «истёк».
// notify(userId, kind, info) подставляет существующую push-инфраструктуру портала.
export function createTokenWatchdog({
  connections, check, secrets, notify, log = () => {},
  intervalMs = 3600_000, warnMs = 7 * 24 * 3600_000, now = () => Date.now(),
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
} = {}) {
  let timer = null;
  let running = false;

  async function tick() {
    if (running) return; // длинная проверка не наслаивается сама на себя
    running = true;
    try {
      for (const conn of connections.listWithTokens()) {
        try {
          await inspect(conn);
        } catch (error) {
          log(`github-watchdog: ${conn.owner}: ${error?.message ?? error}`);
        }
      }
    } finally {
      running = false;
    }
  }

  async function inspect(conn) {
    const t = now();
    if (conn.expiresAt && conn.expiresAt - t <= warnMs && !conn.warnedAt) {
      const days = Math.max(0, Math.ceil((conn.expiresAt - t) / 86_400_000));
      const updated = connections.update(conn.owner, { warnedAt: t });
      await notify(conn.owner, "expiring", { login: updated.login, tokenLast4: updated.tokenLast4, days });
    }
    if (conn.checkedAt && t - conn.checkedAt < intervalMs) return;
    let face;
    try {
      face = await check(secrets.decrypt(conn.tokenEnc));
    } catch (error) {
      if (error?.kind === "auth") {
        const updated = connections.update(conn.owner, { status: "expired", checkedAt: t });
        if (!updated.expiredNotifiedAt) {
          connections.update(conn.owner, { expiredNotifiedAt: t });
          await notify(conn.owner, "expired", { login: updated.login, tokenLast4: updated.tokenLast4 });
        }
      } else {
        connections.update(conn.owner, { status: "unreachable", checkedAt: t });
      }
      return;
    }
    connections.update(conn.owner, { status: "ok", expiresAt: face.expiresAt, permissions: { repos: face.repos }, checkedAt: t });
  }

  function start() {
    if (timer) return;
    timer = setTimer(() => { void tick(); }, intervalMs);
  }
  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
  }
  return { tick, start, stop };
}
