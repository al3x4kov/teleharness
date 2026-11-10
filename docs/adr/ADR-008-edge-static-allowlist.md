---
id: ADR-008
title: Edge — allow-list статики и отказ Windows-алиасам путей
status: accepted (реализовано 2026-11-02, edge перезапущен 15:37)
date: 2026-11-02
release: в проде (незакоммиченная правка ops/portal-server.js)
sources: docs/reviews/2026-11-02/architecture.md S2 (R2, R3); code-security.md #1, #3, #4, #6
---

# ADR-008. Edge — allow-list статики и отказ Windows-алиасам путей

## Контекст

`ops/portal-server.js` раздавал файлы из всего `D:\Portal` и защищался
deny-list'ом (`HIDE`, `SEGMENT_BLOCK = {zai, zai-qa, .git}`). Ревью
2026-11-02 показало, что любой deny-list на NTFS обходится:

- NTFS-поток: `GET /zai::$INDEX_ALLOCATION/data/admin-token.txt` открывал
  каталог `D:\Portal\zai` и отдавал без авторизации admin-токен прода,
  `users.json`, `claude-sessions.json` (SEC-1);
- регистр и ADS: `/API.PS1`, `/api.ps1::$DATA`, `/SECRETS/…` (SEC-4, R2);
- новый каталог по умолчанию открыт: `D:\Portal\zai-stage` с
  `stand.cmd` (токен стенда), `stand-data\*` (SEC-3, R3);
- `new URL` без try на absolute-form request-target ронял edge целиком
  (SEC-6).

## Решение

Реализовано 2026-11-02:

1. **Allow-list**: статика раздаётся только из `D:\Portal\tv` (первый
   сегмент пути — `tv`). Всё прочее вне `/zai/*`, `/tv/api/*` и
   `/zai/ca.pem` — 404.
2. **Отказ алиасам** до любой работы с ФС: путь с `:` (потоки), `~`
   (8.3-имена), `* ? " < > | \`, управляющими символами, а также сегмент с
   хвостовой точкой или пробелом — 404.
3. Второй эшелон: `HIDE` сравнивается в нижнем регистре; `SEGMENT_BLOCK`
   дополнен `zai-stage`.
4. Вся маршрутизация обёрнута в `handler()` с try/catch: ошибка разбора —
   400 и строка в лог, edge не падает.

## Последствия

- Закрыт неаутентифицированный доступ к данным портала, стенда и
  `secrets`. Любой новый каталог в `D:\Portal` по умолчанию закрыт.
- Остаточный риск: до 15:37 2026-11-02 данные были доступны из LAN —
  admin-токен прода и токен стенда перевыпустить, `data/admin-token.txt`
  удалить.
- Если в `D:\Portal` понадобится раздавать что-то кроме `tv`, это
  делается явным добавлением в allow-list (а не исключением из блока).
- Не покрыто тестом: нужен `tests/edge.test.js` (L3e, tests.md §4.1) —
  потоки, 8.3, регистр, хвостовые точки, `zai-stage`, absolute-form URL,
  `/tv/` и `/zai/ca.pem` продолжают работать.
- Правку нужно закоммитить вместе с тестом.
- Не решено этим ADR: заголовки `x-forwarded-*` и область куки — ADR-009.
