---
id: ADR-007
title: Наблюдаемость — /healthz, журнал запросов, логи ошибок
status: accepted
date: 2026-11-02
release: 1.6.2
sources: docs/reviews/2026-11-02/architecture.md S13 (R20, R1)
---

# ADR-007. Наблюдаемость — /healthz, журнал запросов, логи ошибок

## Контекст

- Нет access-лога, request-id и IP клиента (edge не передаёт
  `x-forwarded-for`).
- Ошибки молча проглатываются: `fetchSessionIndex` (server.js:94),
  `BindingStore.#flush`, `ClaudeRunner.#flush`, stderr claude CLI
  (claude.js:397), `handleApi().catch` (500 без записи).
- Нет `/healthz`. Watchdog (общий watchdog, раз в 2 мин) проверяет только,
  что порт слушается. Зависший event loop или хаб без upstream-коннектов
  считаются живыми.
- Логи хаба — `console.log` без уровня и ротации, в stdout задачи.
- Разбор падений 2026-11-02 (битая кука, битый request-target) делался
  воспроизведением, а не по логам.

## Решение

1. **`GET /zai/api/healthz`** — без авторизации, только с 127.0.0.1
   (edge его наружу не проксирует, либо отвечает 404 на внешний запрос).
   Ответ:

   ```json
   { "ok": true, "version": "1.6.1", "epoch": "…", "uptimeS": 1234,
     "upstream": { "ok": true, "indexAgeS": 4, "sseConns": 7 },
     "claude": { "runs": 1 }, "hub": { "clients": 3, "busy": 2, "pending": 0 },
     "store": { "bindings": 42, "claudeSessions": 9 } }
   ```

   `ok=false` и статус 503, если индекс сессий старше 60 с или ни один
   upstream-коннект не жив дольше 60 с.
2. **Watchdog** проверяет `http://127.0.0.1:4170/zai/api/healthz` с
   таймаутом 5 с. Два провала подряд → перезапуск `zai-web` (через
   `CanRestart`, чтобы не зациклиться). Порт-проверка остаётся как первая
   ступень.
3. **Журнал запросов**: одна строка JSON на запрос после `res.finish`:
   `ts, rid, method, path (без query), status, ms, user.id, ip
   (x-forwarded-for от edge, ADR-009)`. SSE пишется при закрытии потока с
   длительностью. Файл `logs/access-YYYYMMDD.log`, ротация по дате и
   размеру (10 МБ), хранение 14 дней; выключается `ZAI_ACCESS_LOG=0`.
   Токены, куки и тела не пишутся.
4. **Логи ошибок**: в каждом тихом catch — строка `[zai-err] <место>:
   <сообщение>` с троттлингом (не чаще раза в минуту на место). stderr
   claude: последние 4 КБ сохраняются и пишутся в лог при ненулевом коде
   выхода. `handleApi().catch` пишет стек с `rid`.
5. `process.on("uncaughtException" | "unhandledRejection")`: лог со стеком
   и `exit(1)` — пусть watchdog поднимает процесс, но причина останется в
   логе.

## Последствия

- Плюсы: watchdog видит реальное зависание, а не только закрытый порт;
  инциденты разбираются по журналу; healthz пригоден для L5-проверки после
  выката.
- Минусы: запись на диск на каждый запрос (объём при текущей нагрузке —
  единицы МБ в день); нужен каталог `logs/` в `.gitignore`.
- Зависимости: IP клиента появится после ADR-009; список переменных —
  ADR-006.
- Тесты: L3 — healthz 200/503 при живом/мёртвом fake upstream; строка
  журнала без токена и query.
