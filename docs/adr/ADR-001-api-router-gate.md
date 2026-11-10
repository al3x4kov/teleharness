---
id: ADR-001
title: Маршрутизатор API с единым порядком «проверка прав → действие»
status: accepted
date: 2026-11-02
release: шаг 1 — 1.6.2; шаги 2–4 — 1.7
sources: docs/reviews/2026-11-02/architecture.md S11, S5, S14 (R5, R7, R14); code-security.md #7, #15, #24; code-correctness.md #16
---

# ADR-001. Маршрутизатор API с единым порядком «проверка прав → действие»

## Контекст

- Все маршруты `/zai/api/*` обрабатывает одна функция `handleApi()`
  (server.js:295–712, около 420 строк). В графе graphify это god-узел №1
  (55 рёбер). Маршруты распознаются цепочкой `if`/regex.
- Права проверяются вручную в каждой ветке: 13 вызовов `dirAllowed(` и
  несколько вариантов «найти каталог сессии» (`resolveSessionDir`,
  `claude.dirOf`, `?directory=`, `defaultDir`, HOME).
- Порядок «гейт → действие» нигде не закреплён. Следствие — R5/SEC-7:
  `DELETE /session/:id` вызывает `claude.forget` и `bindings.forget` **до**
  проверки скоупа (server.js:446–449). Тенант стирает чужую историю Claude и
  привязку и убивает живой ход, получая в ответ 403.
- Админская ветка prompt берёт каталог из query или HOME без
  `isAbsoluteDir` (R7, SEC-24). Проверка абсолютного пути есть только в
  `POST /session`.
- Тенанту доступны глобальные каталоги владельца (`/mcp`, `/host`), потому
  что «только admin» тоже проставляется вручную (SEC-15).

## Решение

1. **Шаг 1 (1.6.2, сразу, ~1 ч + тест).** В DELETE: сначала проверка
   скоупа и upstream DELETE; `claude.forget` и `bindings.forget` — только
   после ответа 2xx. Тест в `auth.test.js`: чужой DELETE → 403, привязка и
   Claude-история целы.
2. **Шаг 2 (1.7).** Ввести декларативную таблицу маршрутов:

   ```js
   { method: "POST", pattern: /^\/zai\/api\/session\/([^/]+)\/prompt$/,
     scope: "session", handler: prompt }
   ```

   `scope` — одно из:
   - `none` — без пользователя (только auth-маршруты);
   - `user` — любой вошедший;
   - `admin` — только admin;
   - `session` — id из пути → каталог из серверного индекса (для всех ролей,
     включая admin; query — только подсказка для ещё не проиндексированной
     сессии) → `dirAllowed`;
   - `dirQuery` — `?directory=` обязателен или берётся `defaultDir`, затем
     `isAbsoluteDir` и `dirAllowed`.

   Общий гейт выполняется **до** вызова handler и передаёт ему уже
   разрешённый контекст `{user, admin, id, dir}`. Handler не может получить
   каталог иначе, кроме как из контекста.
3. **Шаг 3 (1.7).** Разнести handler'ы по модулям `routes/admin.js`,
   `routes/session.js`, `routes/files.js`, `routes/catalog.js`
   (provider/agent/mcp/project/host/usage), `routes/events.js`. `server.js`
   остаётся точкой сборки: конфиг, хранилища, хаб, сервер.
4. **Шаг 4 (1.7).** Пересмотреть скоупы каталожных маршрутов: `/mcp` и
   `/host` — `admin`; `/agent` и `/provider` для тенантов — отфильтрованные
   (связано с ADR-004).

Переход — по одной группе маршрутов за зелёными L3-тестами
(`server.test.js`, `auth.test.js`, `claude-server.test.js`). Wire-контракт
`/zai/api/*` не меняется.

## Последствия

- Плюсы: побочный эффект до гейта становится структурно невозможен; новая
  ветка не может «забыть» проверку; `handleApi` перестаёт быть god-узлом;
  админский prompt больше не запускает Claude в HOME из-за пустого индекса.
- Минусы: 2–3 дня работы; риск регресса в редких админских сценариях с
  каталогами вне индекса — нужна явная проверка на стенде.
- Тесты: на каждый scope — табличный тест «роль × маршрут → статус»
  (L3), плюс тест «handler не вызывается при отказе гейта».
- Метрика успеха: в `server.js` и `routes/*` нет прямых вызовов
  `dirAllowed`, кроме гейта; степень `handleApi` в графе < 15.

## Ход миграции (TASK-12.18)

**2026-11-04, группа C — шаг 2 и начало шага 3, без изменения поведения.**

- `routes/router.js` — таблица маршрутов и общий гейт: `matchRoute`, `validateTable` (старт сервера падает на записи без `scope`/handler), `dispatchRoute`. Скоупы: `user`, `admin` (403 `admin only`), `dirQuery` (`?directory=` или `dirDefault`; без дефолта — абсолютный путь обязателен, 400 `directory required`; затем `dirAllowed` → 403 `outside your scope`). Handler получает уже разрешённый `ctx.dir`.
- Перенесены группы: `routes/files.js` — `/dircheck`, `/file` (GET/HEAD), `/file/exists`, `/turn-files`; `routes/catalog.js` — `/usage`. Ответы (статусы и тела) те же; тест «роль × маршрут → статус» и «handler не вызывается при отказе гейта» — `tests/routes-table.test.js`; полный server-e2e зелёный (213/0, 5 skipped).
- `handleApi` вызывает таблицу сразу после общего гейта формы `?directory=` (BUG-141); не найденный в таблице запрос идёт по прежней if-цепочке.

**2026-11-04, группа C, продолжение: все маршруты `/zai/api/*` в таблице, без изменения поведения.** Коммит на группу; после каждого — server-e2e 213/0 (5 skipped).

| Группа | Модуль | Маршруты | Скоупы |
|---|---|---|---|
| каталог | `routes/catalog.js` | `/status`, `/dialogs`, `/provider`, `/claude/agents`, `/agent`, `/project`, `/mcp`, `/host`, `/about`, `/usage` | `user`; `admin` — `/claude/agents`, `/mcp`, `/host`, `/usage` |
| admin | `routes/admin.js` | `/admin/users`, `/admin/users/:id`, `/admin/users/:id/token`, `/admin/sessions`, `/admin/gc` GET/POST, `/auth/token` | `admin`; `/auth/token` — `user` |
| файлы | `routes/files.js` | `/upload` POST/DELETE, `/file`, `/file/exists`, `/turn-files`, `/dircheck` | `dirQuery` (`/file*`, `/turn-files`); `user` (`/upload`, `/dircheck` — свои правила каталога) |
| сессии | `routes/session.js` | `/session/:id/binding`, `/session/:id/(message\|prompt\|abort)`, `/session/:id` PATCH/DELETE, `/session` GET/POST, `/(permission\|question)/:id/reply`, `/event` | `user` |

`handleApi` теперь: гейт формы `?directory=` (BUG-141) → таблица → `404 unknown route`. Прокси-фолбэка у API нет: неизвестный маршрут всегда был 404, переносить нечего. Метод `"*"` у записи — для веток, которые раньше сопоставляли путь, а метод проверяли внутри (405 отвечает handler, как было). Тест: `tests/routes-table.test.js` — у каждой записи есть скоуп; роль × маршрут → статус; при отказе гейта handler не вызывается; разбор путей группы сессий и fall-through.

**Где остановились и почему (без изменения поведения не переносится):**

1. **Скоуп `session` в общем гейте не введён.** Каждый сессионный маршрут разрешает каталог по-своему: `binding` у admin пускает Claude-only чаты и чаты только с привязкой (каталог `null`); `message` Claude-чата проверяет каталог Claude-стора, а не индекса; `prompt` у admin берёт каталог из `adminSessionDir` (query как подсказка); `PATCH/DELETE` и `abort` у admin каталог не проверяют вовсе; `reply` у тенанта ищет открытый диалог, а не сессию. Единый гейт «id → каталог индекса → `dirAllowed` для всех ролей» (шаг 2 выше) поменял бы ответы admin (404 вместо 200 у Claude-only чатов, проверки там, где их не было). Это изменение поведения: отдельный шаг с тестом на каждый вариант и решением владельца. Пока скоуп `user`, проверка внутри handler, ответы прежние.
2. **Тела сессионных handler'ов — функции в `server.js`** (`sessionBindingRoute`, `sessionActionRoute`, `sessionPatchDeleteRoute`, `sessionListRoute`, `sessionCreateRoute`, `dialogReplyRoute`, `eventStreamRoute`); в `routes/session.js` — только таблица. Им нужно ~35 общих объектов сервера (индекс сессий, привязки, titler, хаб, раннер Claude, `imagesInline`, `adminSessionDir` …). Физический перенос механический, но большой — делать вместе с п.1, когда эти объекты станут сервисом (`lib/sessions.js`).
3. **Шаг 4 ADR** (фильтрация `/agent` и `/provider` для тенантов сверх нынешней) — изменение поведения, не делался. `/mcp` и `/host` уже `admin`.
4. Метрика «нет прямых `dirAllowed` вне гейта» не достигнута: они остались в handler'ах сессий, `/upload`, `/dircheck`, а в `/status`, `/dialogs`, `/project` это фильтрация списков (останется).
