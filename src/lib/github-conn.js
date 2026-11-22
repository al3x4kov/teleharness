// FEAT-20.3 (2.1): лицо подключения GitHub — общее для строки «GitHub» в
// корне настроек и самой секции. null = ещё не знаем; {connected:false} =
// подключение не настроено. Сервис не ходит сам по таймеру: секция обновляет
// при открытии и после действий, ошибки оставляют старое значение.
//
// Туда же — сводка по триггерам для счётчика ошибок на вкладке «Триггеры»
// (T-1): список читает её же, отдельного запроса на бейдж нет.
import { signal } from "@preact/signals";
import { api } from "./api.js";

export const githubConn = signal(null);

export async function refreshGithubConn() {
  try {
    githubConn.value = await api.githubConnection();
  } catch {
    /* нет связи — держим прежнее лицо */
  }
  return githubConn.value;
}

export const githubTriggers = signal({ loaded: false, errors: 0, list: null });

export async function refreshGithubTriggers() {
  try {
    const list = await api.temporalTriggers();
    githubTriggers.value = { loaded: true, errors: list.reduce((n, t) => n + (t.errors ?? 0), 0), list };
    return githubTriggers.value;
  } catch (e) {
    // счётчик не врёт «0» из-за обрыва — но ошибку отдаём экрану
    githubTriggers.value = { ...githubTriggers.value, loaded: true };
    throw e;
  }
}

