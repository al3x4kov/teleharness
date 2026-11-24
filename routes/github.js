// FEAT-20.3 (1.3): подключение GitHub на пользователя (кр. 1, 2).
// Токен принимается один раз (PUT), хранится шифрованым (lib/github/secrets.js)
// и не возвращается ни в одном ответе — только last4. Ошибки клиента не содержат
// токен; тело запроса читается с запасным 400, чтобы его фрагменты не утекали в лог.
import { GhError } from "../lib/github/client.js";

const WARN_MS = 7 * 24 * 3600_000; // кр. 2: предупреждение за 7 дней

export function face(row, { now = () => Date.now() } = {}) {
  return {
    connected: true,
    login: row.login,
    tokenLast4: row.tokenLast4,
    expiresAt: row.expiresAt,
    status: row.status,
    checkedAt: row.checkedAt,
    expiringSoon: !!(row.expiresAt && row.expiresAt - now() <= WARN_MS),
    repos: row.permissions?.repos ?? [],
    reposTruncated: Boolean(row.permissions?.reposTruncated),
  };
}

export function githubRoutes(deps) {
  const base = "/teleharness/api/github";
  const { sendJson, readJsonBody, errLog, connections, check, secrets, log } = deps;

  function fail(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
  }
  // GhError → статус ответа портала; остальное летит в общий обработчик 500.
  function mapError(error) {
    if (!(error instanceof GhError)) return error;
    if (error.kind === "auth") return fail(401, "Токен не принят GitHub — выпустите новый и подключите заново");
    if (error.kind === "rate_limited") return fail(429, "Лимит запросов GitHub исчерпан — повторите позже");
    if (error.kind === "network") return fail(504, "Нет связи с github.com");
    return fail(502, "GitHub не смог выполнить проверку — попробуйте позже");
  }
  function route(method, path, handler) {
    return {
      method, path, scope: "user",
      handler: async (ctx) => {
        try {
          if (!ctx.user?.id) throw fail(403, "Требуется авторизация");
          await handler(ctx);
        } catch (error) {
          const mapped = mapError(error);
          if (typeof mapped?.status === "number") {
            sendJson(ctx.res, mapped.status, { error: mapped.message });
            return;
          }
          errLog?.("github", mapped?.stack ?? mapped);
          throw mapped;
        }
      },
    };
  }

  return [
    // Текущее лицо подключения; токен не отдаётся (кр. 1).
    route("GET", `${base}/connection`, async ({ res, user }) => {
      const row = connections.get(user.id);
      sendJson(res, 200, row ? face(row) : { connected: false });
    }),

    route("PUT", `${base}/connection`, async ({ req, res, user }) => {
      let body;
      try {
        body = await readJsonBody(req, 4096);
      } catch {
        throw fail(400, "Не удалось прочитать запрос — ожидается JSON {token}");
      }
      const token = typeof body?.token === "string" ? body.token.trim() : "";
      if (token.length < 20 || token.length > 255) throw fail(422, "Это не похоже на токен GitHub — ожидается строка 20–255 символов");
      const verified = await check(token);
      const row = connections.save(user.id, {
        login: verified.login,
        tokenEnc: secrets.encrypt(token),
        tokenLast4: secrets.last4(token),
        expiresAt: verified.expiresAt,
        permissions: { repos: verified.repos, reposTruncated: Boolean(verified.reposTruncated) },
        status: "ok",
        checkedAt: Date.now(),
      });
      log?.(`github: подключение ${verified.login} (…${row.tokenLast4}) сохранено`);
      sendJson(res, 200, face(row));
    }),

    // Перепроверка сейчас (кр. 2: статус «истёк» появляется не только раз в час).
    route("POST", `${base}/connection/check`, async ({ res, user }) => {
      const row = connections.get(user.id);
      if (!row) throw fail(404, "Подключение GitHub не настроено");
      let verified;
      try {
        verified = await check(secrets.decrypt(row.tokenEnc));
      } catch (error) {
        if (error instanceof GhError && error.kind === "auth") {
          const updated = connections.update(user.id, { status: "expired", checkedAt: Date.now() });
          sendJson(res, 401, { ...face(updated), expired: true, error: "Токен отозван или истёк — подключите новый" });
          return;
        }
        throw error;
      }
      const updated = connections.update(user.id, {
        status: "ok",
        expiresAt: verified.expiresAt,
        permissions: { repos: verified.repos, reposTruncated: Boolean(verified.reposTruncated) },
        checkedAt: Date.now(),
      });
      sendJson(res, 200, face(updated));
    }),

    route("DELETE", `${base}/connection`, async ({ res, user }) => {
      const removed = connections.remove(user.id);
      sendJson(res, 200, { ok: true, removed });
    }),

    // Список репозиториев последней проверки — для мастера триггеров (кр. 4).
    route("GET", `${base}/repos`, async ({ res, user }) => {
      const row = connections.get(user.id);
      if (!row) throw fail(404, "Подключение GitHub не настроено");
      sendJson(res, 200, {
        login: row.login,
        repos: row.permissions?.repos ?? [],
        reposTruncated: Boolean(row.permissions?.reposTruncated),
        checkedAt: row.checkedAt,
      });
    }),
  ];
}
