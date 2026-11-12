# Карта API opencode: 1.19.5 → 2.2.6 (для миграции портала)

Обновлено: 2026-11-08.
Метод: инвентаризация вызовов opencode 1.x в коде портала (`server.js`, `lib/*.js`, `routes/*.js`) + живые проверки на изолированном opencode 2.2.6 `http://127.0.0.1:4099` (Basic: `opencode:***`) и рабочем стенде `http://127.0.0.1:4100` (`oc2-exp.ps1`, Basic: `opencode:***`; раздел «Команды», FEAT-16.3). Правила: каждое утверждение о v2 — либо живая проверка (команда + фрагмент ответа), либо ссылка на источник. Непроверенное помечено «не проверено».

Источники:

- Живой сервер 2.2.6 на :4099 (не перезапускался, второй serve не поднимался);
- OpenAPI-спека самого сервера: `GET /openapi.json` на :4099 (139 путей, `info.title: "opencode HttpApi"`) — первоисточник форм;
- Доки: <https://docs.opencode.ai/docs/server> (redirect с opencode.ai/v2/docs/server), <https://docs.opencode.ai/docs/sdk>;
- CLI-справка `D:\zai-tmp-scripts\oc2-dl\bin\opencode.exe --help` и `api|serve|session --help` (только help);
- Пакет SDK: npm `@opencode-ai/sdk` (dist-tags: `latest: 1.19.5`, экспорты `./v2`, `./v2/client`, `./client`) — типы не устанавливались, сверка по registry.npmjs.org.

---

## 0. Базовые отличия v2

1. **Весь API под `/api/*`** с HTTP Basic-авторизацией (`OPENCODE_SERVER_PASSWORD`, пользователь по умолчанию `opencode`). Старые пути без `/api` отвечают 404 (проверено: `/config/providers` → 404, `/global/health` → 404).
2. **Конверт ответов**: списки и объекты — `{location: {directory}, data}`; постраничные — `{data, cursor: {previous, next}}`. Голые массивы/объекты 1.x больше не возвращаются.
3. **Адресация папки (location)** — то, из-за чего прошлый тест (TASK-12.23) получил ответ для `C:\Windows\System32`:
   - у **instance-маршрутов** (mcp, provider, model, config, form, permission/request, agent/{id}, integration…) папка передаётся query-параметром **`location` в стиле deepObject**: `?location[directory]=C:\путь` (спека: `style: deepObject, explode: true`, схема `{directory: string}`). Обычный `?directory=` там **игнорируется** — живьём: `GET /api/mcp?directory=...ws` вернул `{"location":{"directory":"C:\\Windows\\System32"},"data":[]}`, а `?location[directory]=...ws` — `{"location":{"directory":"...\\ws"},"data":[]}`;
   - у **`GET /api/session`** `directory` — обычный query-параметр-фильтр списка (живьём: фильтрует, см. п. 1 таблицы);
   - у **`POST /api/session`** папка — поле `location: {directory}` **в теле** (живьём);
   - у **сессии** папка — поле `location` в самой записи `Session.Info` (не `directory`, как в 1.x);
   - события `/api/event` — **глобальный поток без параметра папки**: каждое событие несёт `location` в самом конверте (см. раздел SSE).
4. **Ошибки**: не-2xx — `{"_tag":"InvalidRequestError","message":"Expected a valid JSON body","kind":"Payload"}` (живой пример при битом JSON в POST /api/session).
5. **204 No Content** для мутаций (PATCH/DELETE/reply) — тело пустое, подтверждение через повторный GET или события (v1 возвращал объекты).

---

## 1. Таблица: эндпоинт 1.x → эквивалент v2

Использование в портале — файл:строка. Статусы: **есть аналог** / **есть аналог (другая семантика)** / **нет аналога**.

| № | 1.x (метод, путь) | Использование в портале | v2 (метод, путь) | location / тело / ответ | Статус |
|---|---|---|---|---|---|
| 1 | `GET /session` | server.js:166 (индекс сессий), server.js:1529 (список), lib/hub.js:297 | `GET /api/session` | фильтры `?directory=` (обычный query, работает), `?project=`, `?subpath=`, `?limit=`, `?order=`, `?search=`, `?parentID=`, `?archived=`, `?cursor=`; ответ `{data:[Session.Info], cursor}` | **есть аналог** (форма записи другая: `location` вместо `directory`, `model` с `variant`) |
| 2 | `POST /session?directory=` `{title?, model?, agent?}` | server.js:1591 (создание чата) | `POST /api/session` | тело `{id?, parentID?, title?, agent?, model?, location:{directory}, metadata?, permissions?}`; ответ `{data: Session.Info}` (живьём) | **есть аналог** (папка в теле, не в query; model/agent можно задать сразу при создании) |
| 3 | `GET /session/:id?directory=` | server.js:1320 (запись сессии) | `GET /api/session/{sessionID}` | ответ `{data: Session.Info}`; живой фрагмент: `{"data":{"id":"ses_…","model":{"id":"glm-5.3-flash","providerID":"zai-coding-plan","variant":"max"},"cost":0,"tokens":{…},"time":{"created":…,"updated":…,"busy":…,"idle":…},"title":"…","location":{"directory":"…"}}}` | **есть аналог** |
| 4 | `PATCH /session/:id?directory=` `{title}` | server.js:1481 (переименование), lib/title.js:326 | `PATCH /api/session/{sessionID}` | тело `{title?, metadata?, permissions?, archived?}`; ответ **204 пустой**; факт переименования — повторный GET или событие `session.renamed` (живьём: 204, title изменился) | **есть аналог** |
| 5 | `DELETE /session/:id?directory=` | server.js:1488, server.js:484 | `DELETE /api/session/{sessionID}` | ответ 204 (живьём); дочерние удаляются вместе с сессией (CLI-справка session.delete) | **есть аналог** |
| 6 | `GET /session/:id/message?directory=` | server.js:1049,1053 (история, пагинация на стороне портала из-за 400 на `before`), server.js:1239, server.js:1731 (`limit=1` для счётчика), lib/hub.js:608 (хвост для replay), lib/claude.js:590, lib/title.js:296 | `GET /api/session/{sessionID}/message` | параметры `?limit=`, `?order=asc|desc`, `?cursor=`, `?type=` (фильтр по типу сообщения); ответ `{data:[Сообщение], cursor}`; **сообщения плоские** (не `{info, parts}`) — см. раздел «Части сообщений» | **есть аналог** (форма принципиально другая; `before`-курсор по messageID заменён opaque-курсором) |
| 7 | `POST /session/:id/prompt_async?directory=` `{parts:[…], model?, agent?, variant?, system?}` | server.js:1179 (ход), lib/hub.js:719 (replay зависшего промпта) | `POST /api/session/{sessionID}/prompt` | тело `{text, files?, agents?, skills?, metadata?, delivery?: "steer"\|"queue", resume?, id?}` — **обязателен `text`**; ответ сразу `{data: Inbox.User}` (асинхронно, как prompt_async); execution идёт в фоне; синхронное ожидание — `POST /api/experimental/session/{sessionID}/wait` (204 по завершении, живьём) | **есть аналог** (тело другое: `text`+вложения вместо `parts`; **`model`/`agent`/`variant` в теле хода НЕТ** — модель и агент сессии задаются отдельными вызовами, см. после таблицы; `system` в теле нет — см. риски) |
| 8 | `POST /session/:id/abort?directory=` | server.js:1183 («Стоп»), lib/hub.js:698, lib/hub.js:970 (авто-аборты) | `POST /api/session/{sessionID}/interrupt` | query `?resume=`; ответ `{interrupted: true}` (живьём); события `session.step.failed` → `session.execution.interrupted {reason:"user"}` | **есть аналог** (другое имя и ответ) |
| 9 | `GET /session/status?directory=` | routes/catalog.js:66 (fan-out по папкам), lib/instance-health.js:58, lib/hub.js:321 | `GET /api/session/active` | **без location** — глобальная карта занятых: `{data: {sessionID: {type:"running"}}}`; пустой `{}` когда ничего не идёт (живьём во время хода и после) | **есть аналог** (в 1.x были `busy`/`retry`/`idle` — в карте v2 по спеке только `running`) |
| 10 | `GET /session/:id/diff?directory=&messageID=` | server.js:1270 (файлы реверта) | `GET /api/session/{sessionID}/diff` | query `?from=`, `?to=`, `?context=` (ID сообщений); ответ `{data:[FileDiff.Info]}`, `FileDiff.Info = {file, patch, additions, deletions, status: added\|deleted\|modified, more?}` | **есть аналог (другая семантика)** — `messageID` заменён парой `from/to`; из спеки, живьём не вызывался |
| 11 | `POST /session/:id/revert?directory=` `{messageID}` | server.js:1428 | `POST /api/session/{sessionID}/revert/stage` + `POST /api/session/{sessionID}/revert/commit` | stage: тело `{messageID, files?: boolean}` → `{data:{messageID, files:[FileDiff.Info]}}` (живьём: `{"data":{"messageID":"msg_…","files":[]}}`) — это и превью, и постановка границы; commit: 204, скрывает сообщения (живьём: 13 → 12 сообщений) | **есть аналог (другая семантика)** — двухфазный; превью из 1.x `GET /session/:id/revert` заменяется ответом stage |
| 12 | `POST /session/:id/unrevert?directory=` | server.js:1389 | `DELETE /api/session/{sessionID}/revert` | 204; восстанавливает скрытое (живьём: 12 → 13 сообщений); поле `revert` исчезает из Session.Info | **есть аналог** (DELETE вместо POST) |
| 13 | `GET /event?directory=` (SSE) | lib/hub.js:1241 (по одному соединению на папку) | `GET /api/event` (SSE) | **без location** — один глобальный поток; фильтр `?types=a,b`; каждое событие — `{id, created, type, location:{directory}, data, metadata?}`; первым идёт `server.connected` (живьём) | **есть аналог** (другая топология: хабу портала хватит ОДНОГО соединения + клиентский фильтр по `location`; replay по Last-Event-ID в спеке нет — см. SSE-раздел) |
| 14 | `GET /permission?directory=` | lib/hub.js:887 (открытые запросы) | `GET /api/permission/request?location[directory]=…` | ответ `{location, data:[Permission.Request]}`; живой фрагмент: `{"data":[{"id":"per_…","sessionID":"ses_…","action":"read","resources":[".env"],"save":["*"],"source":{"type":"tool","messageID":"msg_…","id":"call_…"}}]}` | **есть аналог** (deepObject-location) |
| 15 | `GET /question?directory=` | lib/hub.js:887 | `GET /api/form?location[directory]=…` (все) или `GET /api/session/{sessionID}/form` (по сессии) | `Form.Info = {id, sessionID, title, metadata, fields:[Form.Field]}` (поля string/number/integer/boolean/multiselect…) | **есть аналог (другая семантика)** — «вопросы» стали формами; живьём не вызывался |
| 16 | `POST /permission/:id/reply?directory=` `{reply:"once"\|"always"\|"reject"}` | server.js:1636 (диалоги), lib/hub.js:938 (авто-reject) | `POST /api/session/{sessionID}/permission/{requestID}/reply` | тело `{decision: "once"\|"always"\|"reject", message?}`; ответ 204; событие `permission.replied {sessionID, requestID, reply:"once"}` (всё живьём) | **есть аналог** (в пути нужен sessionID, тело — `decision`) |
| 17 | `POST /question/:id/reply?directory=` | server.js:1636 | `POST /api/session/{sessionID}/form/{formID}/reply` | тело `{answer: …}` | **есть аналог (другая семантика)** — формы; живьём не проверено |
| 18 | `POST /question/:id/reject?directory=` | lib/hub.js:938 (авто-dismiss) | `DELETE /api/session/{sessionID}/form/{formID}?message=…` | по спеке; 204 | **есть аналог (другая семантика)** — не проверено живьём |
| 19 | `POST /instance/dispose?directory=` | server.js:532 (disposeInstance при удалении аккаунта/GC), lib/instance-health.js:77 (heal) | `DELETE /api/debug/location?location[directory]=…` | 204 (живьём: до — локация в `GET /api/debug/location`, после удаления — исчезла из списка) | **есть аналог** (другой метод/путь; лежит под `/debug` — публичность пути не гарантирована) |
| 20 | `GET /mcp?directory=` | routes/catalog.js:24, lib/instance-health.js:42,68 | `GET /api/mcp?location[directory]=…` | ответ `{location, data:[Mcp.Server]}`; `Mcp.Server = {name, status: connected\|pending\|disabled\|failed{error}\|needs_auth{error}, title?, integrationID?}`; живьём: `{"location":{"directory":"…"},"data":[]}` (в изолированном конфиге mcp пуст) | **есть аналог** (в 1.x — объект-карта `{name: {status}}`, в v2 — массив) |
| 21 | `GET /agent` | server.js:219 (policy-кэш), routes/catalog.js:151 (прокси) | `GET /api/agent` (+ `GET /api/agent/{agentID}`) | `{location, data:[Agent]}`; агент несёт ruleset разрешений: `{"id":"build","name":"Build","mode":"primary","hidden":false,"permissions":[{"action":"*","resource":"*","effect":"allow"},…]}` (живьём) | **есть аналог** (форма богаче: `permissions`-ruleset, `mode`, `hidden`) |
| 22 | `GET /provider` | lib/claude.js:1439 (каталог моделей портала) | `GET /api/provider` (+ `GET /api/provider/{providerID}`) | `{location, data:[Provider.Info]}` (`{id, name, activation: auto\|enabled\|disabled, …}`); живьём после подключения ключа: `providers: zai-coding-plan:auto` | **есть аналог** (форма другая: в 1.x `{all, default, connected}`; подключённость теперь через credentials — см. раздел «Провайдеры») |
| 23 | `GET /config` (config-объект: `default_agent`, `model`, `snapshot`) | server.js:573 (default_agent), server.js:593 (model по умолчанию), server.js:1219 (`snapshot: false` для реверта) | `GET /api/config?location[directory]=…` | ответ — **массив документов конфига**: `[{type:"document", path, info:{…}}, {type:"directory", path}]` (живьём: 2 записи; в `info` ключи `update, share, policies, mcp`); `default_agent`/`model` из него не получены — см. раздел «Конфиг» | **есть аналог (другая семантика)** — слоёный конфиг вместо одного объекта |
| 24 | `GET /config/providers?directory=` | lib/instance-health.js:41,68 (прогрев папки) | **нет** (`GET /api/config/providers` → 404 живьём) | заменяется парой `GET /api/provider` + `GET /api/model?location[directory]=…` (для прогрева папки — любой «дорогой» instance-запрос, например `/api/mcp`) | **нет аналога** (функциональная замена есть, маршрута нет) |
| 25 | `GET /project?…` | routes/catalog.js:165-167 | `GET /api/project` | параметры `?archived=`; ответ — массив `Project` без конверта: `[{"id":"…","canonical":"D:\\Portal\\zai","vcs":"git","time":{…},"sandboxes":[]}]` (живьём); проект определяется по `canonical`, не по `worktree` 1.x | **есть аналог** (форма другая; фильтр по папке — сравнением `canonical`) |
| 26 | `GET /global/health` | lib/host.js:125 (версия для «О приложении») | `GET /api/info` | `{version, pid, hostname, urls, paths:{tmp}, capabilities}`; живой фрагмент: `{"version":"2.2.6","pid":2632,…}` | **есть аналог** |
| 27 | `GET /command` + `POST /session/:id/command` (BUG-188: server.js:246 список, server.js:1353 ход) | lib/oc-client.js listCommands/runCommand | `GET /api/command` + `POST /api/session/{sessionID}/command` | список: deepObject-location, конверт `{location, data:[{name, description}]}` (живьём); ход: тело **`{name, text}`** (не `{command, arguments}` 1.x), ответ **204 сразу**, execution в фоне; 404 `{_tag:"CommandNotFoundError"}` на неизвестную команду (живьём). Подробно — раздел «Команды» | **есть аналог (тело переводит адаптер; ход асинхронный — не как в 1.x)** |

**Итог: 27 эндпоинтов 1.x. Есть аналог — 20, есть аналог с другой семантикой — 6 (№ 10, 11, 15, 17, 18, 23), нет аналога — 1 (№ 24).**

### Дополнительно: смена модели/агента чата (аналог PATCH-binding портала)

- `POST /api/session/{sessionID}/model` — тело `{model: {id, providerID, variant?}}` (спека); **живьём**: 204, сессия получила `model.variant:"max"`, в истории появился маркер `model-switched`.
- `POST /api/session/{sessionID}/agent` — тело `{agent}` (спека, не проверено живьём).
- `POST /api/session/{sessionID}/fork` — `{messageID?}` → `Session.Info` (спека).
- `GET /api/session/{sessionID}/context`, `GET /api/session/{sessionID}/inbox` (живьём: `{"data":[]}`) — контекст и «входящие» ходы сессии.

---

## 1а. Команды (слэш, BUG-188) — живой эксперимент на :4100

РЕГРЕССИЯ ЗАКРЫТА: `/command` в v2 ЕСТЬ (в спеке :4099 — те же 139 путей, `command.list` и `session.command`; ранее в api-map записано «нет» — пути искали по строке `/command`, а эндпоинт называется `/api/command`).

**Где v2 берёт команды** ([docs → commands](https://opencode.ai/docs/commands); всё, кроме последнего пункта, подтверждено живьём на :4100):

1. Глобально: `~/.config/opencode/commands/*.md` (на стенде — `XDG_CONFIG_HOME\opencode\commands\as-test.md`, у процессу задан через env);
2. Проектно: `.opencode/commands/<name>.md` (доки; на стенде проект-конфиг отключён `OPENCODE_DISABLE_PROJECT_CONFIG=1` — не проверено);
3. `commands`-map в любом opencode.json: `{template (обязателен), description, agent, model: "provider/model#variant", subagent}` — живьём: команда `as-json` из конфига видна в списке и выполняется;
4. Формат md: YAML-frontmatter (`description`, `agent`, `model`) + тело = шаблон; `$ARGUMENTS` — вся строка аргументов (живьём: подставилось); позиционные `$1`/`$2` и shell-блоки — по докам, живьём не проверено;
5. Вложенные каталоги → имя команды со слэшем: живьём получено случайно (копирование каталога внутрь себя) — в списке появились `commands/as-agent`, `commands/as-test`;
6. Hot-reload по докам («reloads command files … automatically») на стенде НЕ подтвердился: md-файл, добавленный после старта, в `GET /api/command` в течение секунд не появился; после рестарта есть. Для портала: команды кладутся при выкате, до старта serve.

**Список**: `GET /api/command?location[directory]=…` → `{location, data:[{name, description}]}` — живой фрагмент:

```json
{"location":{"directory":"D:\\…\\ws-cmd"},"data":[
  {"name":"init","description":"guided AGENTS.md setup"},
  {"name":"review","description":"review changes [commit|branch|pr], defaults to uncommitted"},
  {"name":"goal","description":"keep working until an objective is met [pause|resume|clear]"},
  {"name":"as-json","description":"Команда из commands-map конфига (эксперимент FEAT-16.3)"},
  {"name":"as-agent","description":"Пробная команда с привязкой агента и модели (FEAT-16.3)"},
  {"name":"as-test","description":"Пробная команда стенда (эксперимент FEAT-16.3)"}]}
```

Без `location` — дефолтная папка процесса. Нюанс: **сразу после старта на неинициализированной локации `data` может прийти пустым** (на стенде пустой список до прогрева, полный — после) — перед чтением грейте локацию любым instance-запросом (`/api/location`, `/api/mcp`), как в warmup (BUG-183).

**Выполнение**: `POST /api/session/{sessionID}/command`, тело `{name (обязателен), text (обязателен), files?, agents?, skills?, delivery?}` → **204 за 16–31 мс**, execution идёт в фоне (`/api/session/active` показывает `running` сразу после ответа; события/история — как у обычного хода). Это НЕ синхронный ход 1.x: v1 держал запрос весь ход (BUG-183), v2 отвечает сразу — fire-and-forget портала валиден без изменений, ход обрывается через `/interrupt` как обычный.

**Раскрытие и ход команды** (живьём, команда `as-test`, шаблон «Ответь словом КОМАНДА-ОК и повтори аргументы: $ARGUMENTS», вызов `{name:"as-test", text:"арг один два"}`):

- user-сообщение в истории — **раскрытый шаблон**: `"Ответь словом КОМАНДА-ОК и повтори аргументы: арг один два"`; запись плоская `{id, time, text, type:"user"}` — флага `expanded` в v2 нет (в 1.x был);
- ответ модели: `"КОМАНДА-ОК. Аргументы: арг один два"`, маркер `idle {outcome:"succeeded"}`.

**Привязка агента/модели** (в теле вызова НЕТ полей agent/model — в отличие от 1.x `commandBody`):

- frontmatter команды применяется к ходу: команда с `agent: orchestrator, model: zai-coding-plan/glm-5.3-flash` дала assistant-запись `agent:"orchestrator"`, `model:{…,"variant":"default"}` (живьём);
- без frontmatter — **модель сессии**: после `POST /api/session/{sid}/model {"model":{"providerID":"zai-coding-plan","id":"glm-5.3","variant":"high"}}` ход команды шёл на `glm-5.3/high` — в истории `model-switched` и `model` в assistant-записи (живьём). Для портала: привязка чата в v2 — через `setSessionModel`/`setSessionAgent` перед ходом (тот же механизм, что для prompt, tasks 3.5); поля model/variant тела 1.x адаптер v2 отбрасывает.

**Обычный prompt НЕ раскрывает команды** (вопрос 3): `POST /api/session/{sid}/prompt {"text":"/as-test прямой тест"}` — payload остался сырым (`"text":"/as-test прямой тест"`), модель ответила, что команда не определена и «сообщение дошло как обычный текст». Раскрытие — только через `/command`. Семантика BUG-188 сохраняется: портал обязан сам перехватывать «/имя аргументы» и звать runCommand (gate в server.js:241 для v2 теперь можно снимать — адаптер v2 реализует listCommands/runCommand).

**Ошибки** (живьём + спека): неизвестная команда → `404 {"_tag":"CommandNotFoundError","command":"no-such-cmd","message":"Command not found: no-such-cmd"}`; спека 404 также допускает `SessionNotFoundError`/`LocationNotFoundError`, 500 — `CommandExecutionError`. Ответы 4xx/5xx адаптер возвращает вызывателю как `{status, json, text}` (не бросок) — различение «400/404» портала работает и в v2.

**Не проверено живьём**: `files/agents/skills/delivery` в теле, subagent-команды (фоновые), позиционные `$1`/`$2`, shell-блоки шаблона, legacy-каталог `command/` (доки: дисковерится), project-зона `.opencode/commands/`.

---

## 2. SSE-поток событий v2 (живой эксперимент)

Эксперимент: сессия создана в `…\Temp\opencode\apimap\ws`, ход моделью `zai-coding-plan/glm-5.3-flash` (variant max) через `POST /api/session/{sid}/prompt {"text":"ответь одним словом: привет"}`; слушатель — node-скрипт на `GET /api/event` (скрипты в `C:\Users\USER\AppData\Local\Temp\opencode\apimap\`, не в репозитории).

**Конверт события** (живой пример):

```json
{"id":"evt_1b695e4c9001jnDa5Z9bU7Rpz2","created":1794064639233,
 "type":"session.inbox.enqueued",
 "location":{"directory":"C:\\Users\\USER\\AppData\\Local\\Temp\\opencode\\apimap\\ws"},
 "data":{…}}
```

Поля `properties` (1.x) нет — полезная нагрузка в `data`. События без привязки к папке (например, `session.execution.*`) приходят **без** `location`.

**Хронология минимального хода** (реальная последовательность, 9 секунд):

```
session.inbox.enqueued      → data:{inboxID, sessionID, item:{type:"user", payload:{text}, delivery:"steer"}}
project.updated
session.execution.started   → data:{sessionID}
session.inbox.delivered
session.step.started        → data:{sessionID, agent:"build", model:{id,providerID,variant}, assistantMessageID, started}
session.reasoning.started   → data:{sessionID, assistantMessageID, ordinal:0, native:{reasoningField:"reasoning_content"}}
session.reasoning.delta ×5  → data:{…, ordinal, delta:"The user asked me to reply"}
session.reasoning.ended
session.text.started        → data:{sessionID, assistantMessageID, ordinal:0}
session.text.delta          → data:{…, delta:"Привет"}
session.text.ended          → data:{…, ordinal, text:"Привет"}
session.step.streamed
session.step.ended          → data:{…, finish:"stop", rawFinish:"stop", tokens:{input,output,reasoning,cache}, cost}
session.usage.updated       → data:{sessionID, cost, tokens}
session.execution.succeeded → data:{sessionID}
```

Дельты — **инкрементальные куски текста** (`delta`), а не полные обновления части, как `message.part.updated` в 1.x. Для рендера порталу нужно накапливать `delta` по `assistantMessageID`+`ordinal`; финальный текст даёт `session.text.ended` (`text`) и запись в истории.

**Не найдено**: replay пропущенных событий (Last-Event-ID) — в спеке `/api/event` единственный параметр `types`; переподключение = потеря событий между соединениями. Кольцевой буфер портала (lib/hub.js) остаётся нужным, но теперь без per-directory соединений.

**Tool-события в ходе** (живой ход с чтением .env):

```json
session.tool.input.started → {sessionID, assistantMessageID, id:"call_…", name:"read"}
session.tool.input.ended   → {…, id:"call_…", text:"{\"path\":\"…\\\\.env\"}"}
session.tool.called        → {…, id, input:{path:"…"}, executed:false}
session.tool.success       → {…, id, content:[{type:"text","text":"Read file …"}], metadata:{truncated:false}, executed:false}
```

**Полный список типов** — enum в спеке `/api/event` (97 значений, приводить целиком здесь избыточно; ключевые для портала): `server.connected` (первое событие потока), `session.created, session.renamed, session.model.selected, session.agent.selected, session.moved, session.deleted, session.forked, session.inbox.enqueued, session.inbox.delivered, session.inbox.cancelled, session.inbox.delivery.changed, session.execution.started, session.execution.succeeded, session.execution.failed, session.execution.interrupted, session.step.started, session.step.streamed, session.step.ended, session.step.failed, session.text.started, session.text.delta, session.text.ended, session.reasoning.started, session.reasoning.delta, session.reasoning.ended, session.tool.input.started, session.tool.input.delta, session.tool.input.ended, session.tool.called, session.tool.progress, session.tool.success, session.tool.failed, session.retry.scheduled, session.usage.updated, session.permissions, permission.asked, permission.replied, form.created, form.replied, form.cancelled, session.status, session.idle, session.revert.staged, session.revert.cleared, session.revert.committed, mcp.status.changed, config.updated, provider.updated, model.updated, agent.updated, credential.updated, project.updated, location.shutdown`. Соответствие событиям 1.x: `message.updated` → прямого нет (состояние сообщения собирается из `session.step.*`/`session.text.*` или берётся из истории), `message.part.updated` → `session.text.delta`/`session.reasoning.delta`/`session.tool.*`, `session.updated` → `session.created`/`session.renamed`/`session.model.selected`/…, `session.error` → `session.execution.failed` (+ `session.step.failed`), `question.asked` → `form.created`.

---

## 3. Prompt / отмена / занятость (живой эксперимент)

**Отправка хода**: `POST /api/session/{sid}/prompt` с `{"text":"…"}` → 200 и сразу `{data:{id:"msg_…", sessionID, time:{created}, type:"user", payload:{text}, delivery:"steer"}}`. Модельной привязки в теле нет — модель сессии (`POST /model`) применяется на старте execution; без неё ход падает (см. риски).

**Занятость** (`GET /api/session/active`, опрос каждые 1.5 с во время хода):

```
0.0s {}
3.0s {"ses_…":{"type":"running"}}
4.2s session.execution.succeeded
4.6s {}
```

**Отмена**: ход с bash `sleep 45`; на 3-й секунде `POST /api/session/{sid}/interrupt` → 200 `{"interrupted":true}`; события: `session.step.failed` → `session.execution.interrupted` c `data:{sessionID, reason:"user"}`; `/api/session/active` очистился. Повторная отправка после interrupt работает (проверено последующими ходами).

**Ошибки хода**: без модели — `session.execution.failed` c `data.error={type:"provider.no-route", message:"No model is available for session ses_…"}`; в историю попадает сообщение типа `idle` с `outcome:"failed"` и тем же `error`. Тишины нет — ошибка всегда и в событии, и в истории.

---

## 4. Части сообщений (форма истории)

`GET /api/session/{sid}/message` возвращает **плоские сообщения** (не `{info, parts}` 1.x), новые раньше старых, с курсором:

```json
{"id":"msg_…","time":{"created":…},"text":"ответь одним словом: привет","type":"user"}

{"id":"msg_…","time":{"created":…,"streamed":…,"completed":…},"type":"assistant",
 "agent":"build","model":{"id":"glm-5.3-flash","providerID":"zai-coding-plan","variant":"max"},
 "content":[
   {"type":"reasoning","text":"…","native":{"reasoningField":"reasoning_content"},"time":{"created":…,"completed":…}},
   {"type":"text","text":"Привет"}],
 "finish":"stop","rawFinish":"stop","cost":0,"tokens":{"input":5843,"output":4,"reasoning":27,"cache":{"read":0,"write":0}}}

{"id":"msg_…","time":{"created":…},"type":"idle","outcome":"succeeded"}
{"id":"msg_…","type":"idle","outcome":"failed","error":{"type":"provider.no-route","message":"…"}}
{"id":"msg_…","type":"model-switched","model":{…},"previous":{…}}
```

Типы сообщений (спека `Session.Message.Info`): `agent-switched, model-switched, location-switched, user, synthetic, system, skill, shell, assistant, compaction, idle`. Ролям `user/assistant` 1.x соответствуют типы `user`/`assistant`; служебные маркеры (`idle`, `*-switched`), которые в 1.x были событиями, теперь — записи в истории. Tool-часть в списке сообщений отдельным типом в живом примере не встретилась (в ходовом примере tool виден только в событиях `session.tool.*`); форма tool-части в истории не проверена (нужен ход с файловой правкой) — «не проверено».

Для рендера старой истории `{info, parts}` порталу нужен конвертер: `info` — поля сообщения, `parts` — `content[]` + tool из `session.tool.*`.

---

## 5. Permissions (живой эксперимент)

Запрос разрешения пришёл на чтение `.env` (агент `build`: `read *.env → ask`):

```json
{"type":"permission.asked",
 "location":{"directory":"…\\ws"},
 "data":{"id":"per_1b696e889001qvC2hgLRgkkVAL","sessionID":"ses_…",
         "action":"read","resources":[".env"],"save":["*"],
         "source":{"type":"tool","messageID":"msg_…","id":"call_6f223408be9d4cd3b18537fe"}}}
```

Списки открытых запросов (оба живьём, оба с этим же объектом):

- `GET /api/session/{sid}/permission` → `{"data":[Permission.Request]}`;
- `GET /api/permission/request?location[directory]=…` → `{"location":{…},"data":[…]}`.

Ответ:

```
POST /api/session/{sid}/permission/per_…/reply  {"decision":"once"}  → 204
→ событие {"type":"permission.replied","data":{"sessionID":"ses_…","requestID":"per_…","reply":"once"}}
```

- Допустимые `decision`: `once | always | reject` (спека `Permission.Reply`; «once» проверен живьём). `always`, по-видимому, запоминает по списку `save:["*"]` из запроса (предположение по форме — живьём не проверено).
- Ход после ответа продолжился сам: `session.tool.success`, новый шаг, финальный текст, `session.execution.succeeded` — пауза и продолжение работают без дополнительных вызовов.
- Авто-reject портала (`{reply:"reject"}` в 1.x) → `{"decision":"reject"}`.

---

## 6. Вопросы (questions) → формы (forms)

- Список: `GET /api/form?location[directory]=…`, по сессии: `GET /api/session/{sid}/form`.
- Ответ: `POST /api/session/{sid}/form/{formID}/reply` c `{answer: …}` (схема `Form.Answer` в спеке — пустой объект; ключи ответа определяются полями формы).
- Отмена/отклонение: `DELETE /api/session/{sid}/form/{formID}?message=…`.
- События: `form.created`, `form.replied`, `form.cancelled`.
- Живых примеров нет (форму создаёт инструмент или плагин в ходе; в экспериментах вопросов не возникало) — «не проверено», маршруты и схемы из спеки.

---

## 7. Dispose экземпляра папки (живой эксперимент)

`DELETE /api/debug/location?location[directory]=…`:

```
GET  /api/debug/location → [{"directory":"C:\\Windows\\System32"},{"directory":"…\\ws"},…]  (до)
GET  /api/location?location[directory]=…dispose-test → {"directory":"…","project":{…}}     («прогрев» папки)
DELETE /api/debug/location?location[directory]=…dispose-test → 204
GET  /api/debug/location → dispose-test в списке больше нет
```

Есть также `POST /api/location/reload` (перезагрузка локации, не проверено) и событие `location.shutdown`. Для портала: `disposeInstance` (server.js:532) и heal (lib/instance-health.js:77) переезжают на этот маршрут; семантика «отпустить папку» сохраняется, но путь лежит под `/debug` — при обновлениях v2 на него стоит смотреть внимательнее.

---

## 8. MCP-статус

`GET /api/mcp?location[directory]=…` → `{"location":{…},"data":[]}` (живьём; в изолированном конфиге `mcp:{}`). Форма сервера из спеки:

```json
{"name":"…","status":"connected"}
{"name":"…","status":"failed","error":"…"}
{"name":"…","status":"needs_auth","error":"…"}
{"name":"…","status":"pending"}
{"name":"…","status":"disabled"}
```

Живой факт из лога изолированного инстанса: `WARN "mcp connect failed" server=slow status.status=failed status.error="Request timed out"` — статус failed реально случается. Динамическое управление: `PUT /api/experimental/mcp/{server}`, `POST /api/experimental/mcp/{server}/connect|disconnect` (спека, не проверено). Событие `mcp.status.changed`. Порталу (routes/catalog.js:24, tenantMcpView) нужно перейти с карты `{name: status}` на массив `{name, status}`.

---

## 9. Агенты

`GET /api/agent` (живьём) → `{location, data:[…]}`. Форма агента:

```json
{"id":"build","name":"Build","request":{"settings":{},"headers":{},"body":{}},
 "description":"The default agent. Executes tools based on configured permissions.",
 "mode":"primary","hidden":false,
 "permissions":[{"action":"*","resource":"*","effect":"allow"},
                {"action":"read","resource":"*.env","effect":"ask"},…]}
```

- `mode`: `primary | subagent` (в живом списке: build, plan, compaction, title, summary — primary; general, explore — subagent; `hidden:true` у compaction/title/summary — их портал должен скрывать, как в 1.x фильтровал по своим правилам).
- Отдельный агент: `GET /api/agent/{agentID}` (живьём для build).
- Поле `permissions` — ruleset правил; policy-фильтрам портала (lib/policy.js) придётся читать `mode`/`hidden`/`permissions`.
- Смена агента сессии: `POST /api/session/{sid}/agent {agent}` (спека).
- Событие `agent.updated`.

---

## 10. Провайдеры, модели, варианты (effort) — важное открытие

**Модели**: `GET /api/model?location[directory]=…` (живьём после подключения ключа):

```
models: 3
glm-5.3-flash | variants: low,high,max
glm-5.3-highspeed | variants: low,high,max
glm-5.3 | variants: low,high,max
```

`Model.Info` содержит `variants:[{id, settings, headers, body}]`, `capabilities:{tools, input, output, temperature}`, `cost`, `limit:{context, input, output}`, `status: alpha|beta|deprecated|active`, `enabled`. Варианты GLM = **effort low|high|max** (совпадают с ZAI_GLM_VARIANT портала). В 1.x вариант передавался в теле каждого хода (`variant` — lib/glm-variant.js); в v2 вариант — часть **выбора модели сессии**: `POST /api/session/{sid}/model {"model":{"providerID":"zai-coding-plan","id":"glm-5.3-flash","variant":"max"}}` (живьём: 204; в истории появился `model-switched` с `variant:"max"`; `variant` виден живьём и в `session.step.started`, и в записи assistant-сообщения).

**Критическое отличие — подключение провайдера**. В 1.x ключи читались из `~/.local/share/opencode/auth.json`, и `/provider` показывал подключённых. В 2.2.6:

- таблица `credential` БД v2 была пуста, `GET /api/provider` и `GET /api/model` возвращали **пустые списки**, а ход падал с `provider.no-route` — даже при валидном `auth.json` в data-каталоге инстанса (миграция `GET /api/experimental/migration/v1` отвечала `{"status":"completed"}`, но ключи она не переносит);
- ключ появился в системе только после `POST /api/credential` c `{id:"zai-coding-plan", integrationID:"zai-coding-plan", value:{type:"key", key:"***"}, activate:true}` (живьём; после этого `provider: zai-coding-plan:auto`, модели появились, ход прошёл);
- **предупреждение о секретах**: ответ `POST /api/credential` **эхом возвращает ключ открытым текстом** (`{"data":{…,"value":{"type":"key","key":"8249…"}}}` — здесь маска); логировать этот ответ нельзя;
- «модель по умолчанию»: `GET /api/model/default?location[directory]=…` → `{"data":null}` (живьём, пока модель не выбрана) — источник модели по умолчанию для портала (server.js:584-607) нужно перепроектировать: в 1.x её давали `config.model` + каталог провайдеров.

`GET /api/provider` (живьём) → `{location, data:[Provider.Info]}`; поле `activation: auto|enabled|disabled` вместо 1.x-разделения all/connected. Также есть `GET /api/integration` (каталог методов авторизации провайдеров), `GET /api/credential`, `PATCH/DELETE /api/credential/{id}`, `POST /api/credential/{id}/activate`.

Для миграции портала это означает отдельный шаг «перенос ключей из auth.json в credential API v2».

---

## 11. Конфиг

`GET /api/config?location[directory]=…` (живьём; ключей в ответе не было):

```json
[{"type":"document","path":"D:\\zai-tmp-scripts\\oc2-run\\config\\opencode\\opencode.json",
  "info":{"update":{…},"share":"disabled","policies":{…},"mcp":{…}}},
 {"type":"directory","path":"D:\\zai-tmp-scripts\\oc2-run\\config\\opencode"}]
```

- Это **слоёный** ответ (документы по цепочке наследования), а не один объект 1.x. Поля `default_agent`, `model`, `snapshot` в живом ответе отсутствовали (в изолированном конфиге их нет; схема `Config.InfoEncoded` их допускает: `$schema, shell, model, default_agent, …, snapshots, …`).
- Портальные чтения конфига 1.x: `default_agent` (server.js:573) → в v2 надёжнее `GET /api/model/default` и события `session.model.selected`; `snapshot: false` (server.js:1219) → поле `snapshots` в `Config.InfoEncoded` (живьём не проверено).
- Изменение конфига: `PATCH /api/experimental/config` (спека, не проверено). Событие `config.updated`.

---

## 12. Не проверено / риски миграции (сводка)

**Не проверено живьём** (только спека или доки): `GET /api/session/{sid}/diff` (параметры from/to), `revert/commit` с реальными правками файлов (без правок files пуст), `POST /api/session/{sid}/agent`, формы questions (создание/ответ/отмена), tool-часть в истории сообщений (нужен ход с edit/write), `POST /api/location/reload`, `PATCH /api/experimental/config`, `PUT /api/experimental/mcp/*`, фильтр `?types=` в реальном стриме (перечень типов из спеки), `decision:"always"` в permission reply, `delivery:"queue"` (ход во время другого хода), `POST /api/session/{sid}/fork`, поле `snapshots` конфига, `files/agents/skills/delivery` в теле `/api/session/:id/command`, subagent-команды и позиционные `$1`/`$2` (раздел 1а).

**files[] в теле prompt — форма 2.2.6 (v2fix3, 2026-11-08)**: `PromptInput.FileAttachment = {uri (обязателен), name?, description?, source?}` (schema/prompt-input.ts anomalyco/opencode; приложение шлёт `{uri: data:URL, name}`). Поля `mime` в теле нет — upstream синтезирует mime из data: URL; `filename`/`url` из частей 1.x в v2-форме не существуют (upstream: 400 `Missing key at ["files"][0]["uri"]`, поймано на стенде :4174 батареей vision). Адаптер (lib/oc-client.js) переводит: `url → uri` (data:/file:/http(s) как есть, голый абсолютный путь → file:// URI — вложения .zai-uploads, BUG-140/163), `filename → name`; часть без источника uri не шлётся.

**Риски, обнаруженные при проверках**:

1. **Ключи провайдера не мигрируют сами** — без `POST /api/credential` все ходы падают с `provider.no-route`, а каталоги `/api/provider`/`/api/model` пусты (раздел 10). Для стенда и прода нужен план переноса auth.json → credential API и правило «ключ из ответа /api/credential не логировать».
2. **Прогрев/самочувствие папки** (BUG-183, lib/instance-health.js): `/config/providers` больше нет; прогрев папки перед первым ходом придётся строить на `/api/mcp` + `/api/model`, или убрать вовсе — требуется отдельная проверка, отравляется ли instance в 2.2.6 при прерванной инициализации («не проверено»).
3. **`system` в теле хода больше нет** (FEAT-03.22, lib/user-prompt.js): в схеме prompt-тела поля `system` нет. Кандидаты на замену: synthetic-сообщение `POST /api/session/{sid}/synthetic` (спека) или метаданные хода; требует проработки («не проверено»).
4. **Стриминг дельт** инкрементальный — рендер (public/) и redactEventForTenant рассчитаны на полные части `message.part.updated`; нужен переписыватель событий.
5. **Пагинация истории** — opaque-курсор; серверная пагинация портала (lib/proxy.js paginateMessages) заменяется курсором, контракт `x-zai-has-more`/`x-zai-next-before` для клиента меняется.
6. **Занятость**: `GET /api/session/active` без папки отдаёт всё сразу — fan-out по папкам (routes/catalog.js:62-76) не нужен; но в карте только `running`, поэтому состояния «retry» 1.x портал должен выводить из событий (`session.retry.scheduled`).
7. **Hub**: одно соединение вместо пула per-directory; фильтрация тенантов — по `event.location.directory`; часть событий приходит без `location`.
8. **204-ответы** мутаций — подтверждения только через GET/события; логика «PATCH вернул объект» в портале переписывается.
9. **Вопросы (question) исчезли как отдельная сущность** — модальное окно портала должно уметь `Form.Info` с типизированными полями (string/number/integer/boolean/multiselect/select и др.).
10. **Слэш-команды в v2** (раздел 1а): hot-reload файлов команд на стенде не подтвердился (кладётся до старта serve); `GET /api/command` на неинициализированной локации может вернуть пустой список (грейте локацию); ход команды асинхронный — ошибки execution не видны в ответе вызова, портал узнаёт о них из событий/истории, как о ходе prompt; привязка модели чата — `setSessionModel` до хода (commandBody-поля model/variant адаптер v2 отбрасывает).

**Другой конфиг для будущих проверок** (только описание, не применялось): изолированный serve с конфигом, приближенным к продовому портала — `opencode.json` с заполненными `model`, `default_agent`, `snapshots:false`, настроенным MCP и заранее заполненной credential-таблицей; отдельный data-каталог, чтобы не смешивать с текущим инстансом на :4099. Цели: проверить слоёный конфиг (раздел 11), поведение `snapshots:false` при реверте и необходимость прогрева (риск № 2).
