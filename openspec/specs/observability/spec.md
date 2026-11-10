# observability Specification

## Purpose
Наблюдаемость портала: проверка здоровья teleharness-web для watchdog и выката (`/teleharness/api/healthz`) и журнал запросов edge и teleharness-web без секретов (ADR-007).

## Requirements

### Requirement: Проверка здоровья

Система SHALL отвечать на `GET /teleharness/api/healthz` без авторизации и только с 127.0.0.1 (ADR-007). При свежем индексе сессий и живом upstream ответ — 200 с ok, версией, эпохой и счётчиками; иначе — 503. Watchdog перезапускает teleharness-web после двух провалов подряд. (трекер: TASK-12.20)

#### Scenario: Upstream недоступен

- **WHEN** opencode upstream не отвечает дольше 60 с
- **THEN** healthz отвечает 503 с ok=false

#### Scenario: Внешний запрос

- **WHEN** healthz запрашивают снаружи через edge
- **THEN** ответ 404

### Requirement: Журнал запросов

Система SHALL писать access-лог edge и teleharness-web: одна JSON-строка на запрос (время, request-id, метод, путь без query, статус, длительность, пользователь, IP). Токены, cookie и тела не пишутся; ротация по дате и размеру, хранение 14 дней, выключение через TELEHARNESS_ACCESS_LOG=0. (трекер: TASK-12.20)

#### Scenario: Запрос к API

- **WHEN** клиент вызывает /teleharness/api/session
- **THEN** в журнале появляется строка со статусом и длительностью, без токена и cookie
