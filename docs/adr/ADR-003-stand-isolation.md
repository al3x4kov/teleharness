---
id: ADR-003
title: Изоляция стенда от прод-upstream
status: accepted
date: 2026-11-02
release: 1.6.2
sources: docs/reviews/2026-11-02/architecture.md S10, S3 (R18, R3); code-security.md #3, #10
---

# ADR-003. Изоляция стенда от прод-upstream

## Контекст

Стенд (`D:\Portal\teleharness-stage\stand.cmd`) запускает тот же `server.js` на
127.0.0.1:4172 со своими `TELEHARNESS_DATA_DIR`, `TELEHARNESS_PUBLIC_DIR` и
`TELEHARNESS_COOKIE_NAME`, но **`TELEHARNESS_UPSTREAM` не задан** — стенд работает с прод
`opencode serve` :4096.

- Admin стенда видит, промптит и удаляет все прод-сессии всех тенантов.
- Тестовые чаты стенда оседают в проде; их приходится удалять вручную.
- Привязки расходятся: у стенда и прода разные `session-bindings.json`
  при общих сессиях.
- `TELEHARNESS_ADMIN_TOKEN` стенда записан открытым текстом в `stand.cmd`, а
  каталог стенда лежит в web-root `D:\Portal` (до 2026-11-02 edge его
  раздавал).

## Решение

1. **Отдельный opencode для стенда**: `opencode serve --hostname 127.0.0.1
   --port 4097` с собственным рабочим каталогом/хранилищем (переменные
   окружения opencode для data-dir — уточнить по версии 1.19.5). В
   `stand.cmd`: `set TELEHARNESS_UPSTREAM=http://127.0.0.1:4097`.
2. **Guard в server.js** (через ADR-006): новая переменная `TELEHARNESS_ENV`
   (`prod` | `stand` | `test`, по умолчанию `prod`). При `TELEHARNESS_ENV=stand`
   и `TELEHARNESS_UPSTREAM`, указывающем на :4096, сервер не стартует. Ошибку
   конфигурации ловит сам портал, а не человек.
3. Для быстрых UI-проверок без opencode допустим режим `TELEHARNESS_MOCK=1` (уже
   есть, :4171).
4. **Секреты стенда вне web-root**: каталог стенда переносится в
   `D:\teleharness-stage` (вне `D:\Portal`), токен читается из файла с ACL
   владельца, а не из `stand.cmd`.
5. Claude на стенде продолжает использовать подписку владельца; это
   допустимо, пока стенд слушает только 127.0.0.1.

## Последствия

- Плюсы: стенд не может повредить прод-чаты; тестовые данные не
  смешиваются с боевыми; проверки DELETE и watchdog на стенде становятся
  безопасными (сейчас watchdog хаба на стенде выключен как раз из-за общего
  upstream).
- Минусы: ещё один процесс opencode (память, порт 4097); чаты прода на
  стенде больше не видны — для воспроизведения прод-бага нужен экспорт
  сессии или чтение через L5 (live read-only).
- Процесс: обновить memory/README по стенду, `restart-*.ps1`, путь сборки
  `TELEHARNESS_OUT_DIR`.
- Проверка: после переключения `GET :4172/teleharness/api/session` не содержит
  ни одного id из прода.
