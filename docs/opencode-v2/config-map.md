---
type: research
updated: 2026-11-07
area: opencode-v2, config, migration
status: draft
---

# Карта переноса конфига opencode 1.x → 2.2.6

Исследование: как наш `D:\Portal\zai\ops\opencode\opencode.json` (формат 1.x) выражается в формате opencode 2.2.6. Прод (:4096, :4170) и стенд (:4097, :4172) не трогались; все живые проверки — только GET на изолированный сервер **:4099** (opencode 2.2.6, Basic `opencode:***`).

Источники:

- Наш конфиг 1.x: `D:\Portal\zai\ops\opencode\opencode.json` (прочитан полностью; API-ключей в файле **нет** — маскировать нечего).
- Живой сервер :4099: `GET /api/config`, `GET /openapi.json` (точные типы установленного 2.2.6), `GET /api/provider`, `GET /api/model`, `GET /api/agent`, `GET /api/mcp`, `GET /api/skill`, `GET /api/command`, `GET /api/location`, `GET /api/info`, лог `D:\zai-tmp-scripts\oc2-run\data\opencode\log\opencode.log`.
- Доки v2: [config](https://opencode.ai/docs/config), [permissions](https://opencode.ai/docs/permissions), [policies](https://opencode.ai/docs/policies), [mcp-servers](https://opencode.ai/docs/mcp-servers), [migrate-v1](https://opencode.ai/docs/migrate-v1).
- Типы: `@opencode/sdk@2.2.6` через unpkg ([package.json](https://unpkg.com/@opencode/sdk@2.2.6/package.json)); схемы конфига — из живого `/openapi.json` (:4099), они соответствуют `@opencode/schema@2.2.6`.
- Changelog: [releases anomalyco/opencode](https://github.com/anomalyco/opencode/releases) (v2.2.1–v2.2.6).

---

## Формат v2 кратко

Полный набор верхнеуровневых полей (из живой схемы `Config.InfoEncoded` в `/openapi.json` на :4099 и [доков config](https://opencode.ai/docs/config)):

| Поле v2 | Тип/форма | Примечание |
|---|---|---|
| `$schema` | `"https://opencode.ai/config.json"` | тот же URL схемы, что и в 1.x |
| `model` | `"provider/model"` (объектная форма тоже есть) | корневой default **не сохраняет** `#variant` |
| `default_agent` | string | есть в v2, как в 1.x |
| `update` | `disable` \| `notify` \| `auto` | замена 1.x `autoupdate`; default `notify` |
| `share` | `manual` \| `auto` \| `disabled` | как в 1.x |
| `permissions` | **массив** правил `{action, resource, effect: allow\|deny\|ask}` | замена 1.x map `permission`; последний совпавший выигрывает |
| `policies` | **массив** `{action, resource, effect: allow\|deny}` | provider.use, tool.use, mcp.use, skill.use, plugin.use, integration.connect/use, websearch.use; жёсткие deny без промпта |
| `agents` | map имя → `{model, system, description, mode, hidden, color, steps, disabled, permissions, request}` | замена 1.x `agent`/`mode`; `prompt`→`system` |
| `providers` | map id → `{package, settings, headers, body, models, compatibility}` | замена 1.x `provider`; `npm`→`package`, `api`→`settings.baseURL` |
| `mcp` | `{timeout: {startup, catalog, execution}, servers: {имя: {type: local\|remote, ...}}}` | серверы **вложены в `servers`**; `enabled` → `disabled`; у сервера есть `codemode`, `protocol`, `pool` |
| `compaction` | `{auto, keep: {tokens}, buffer: число\|"15%"}` | 1.x `preserve_recent_tokens`→`keep.tokens`, `reserved`→`buffer`; `prune`/`tail_turns` игнорируются с warning |
| `skills` | массив путей/URL + автодискавери `.opencode/skills/` | 1.x `skills: {paths, urls}` → один массив |
| `commands` | map имя → `{template, description, agent, model, subagent}` | замена 1.x `command`; `subtask`→`subagent` (алиас работает) |
| `instructions` | массив файлов/globs/HTTP(S) URL | как в 1.x |
| `references` | map имя → путь / `{path, description}` / git-репозиторий | замена 1.x `reference` |
| `plugins` | массив строк или `{package, options}` | замена 1.x `plugin`; **V1-плагины не запускаются** — нужен порт |
| `snapshots` | boolean | переименование 1.x `snapshot` |
| `watcher` | `{ignore: [...]}` | как в 1.x |
| `formatter` | boolean \| map | как в 1.x |
| `lsp` | boolean \| map | принимается, но LSP **не запускается** в v2 |
| `media` | `{image: {auto_resize, max_width, max_height, max_base64_bytes}}` | переименование 1.x `attachment` |
| `tool_output` | `{max_lines, max_bytes}` | как в 1.x |
| `websearch` | `false` \| `{provider}` | новое |
| `worktree` | `{directory}` | новое |
| `warming` | boolean \| `{prompt, interval, duration}` | новое |
| `enterprise` | `{url}` | новое |
| `username`, `timezone`, `shell` | string | как в 1.x |
| `experimental` | `{todo, subagent_depth, background_compaction, image_generate, schedules, artifacts, codemode_vm, location_idle_timeout, policies(deprecated), ...}` | новое; 1.x top-level `subagent_depth` → сюда |

Живая цитата схем (фрагмент `Config.InfoEncoded` из `/openapi.json` :4099):

```json
"update": { "type": "string", "enum": ["disable", "notify", "auto"] },
"policies": { "type": "array", "items": { ... "action": ["provider.use","tool.use","integration.connect",
  "integration.use","mcp.use","skill.use","plugin.use","websearch.use"], "effect": ["allow","deny"] } },
"agents": { "type": "object", "additionalProperties": { "$ref": "Config.AgentEncoded" } },
"mcp": { "properties": { "timeout": {...}, "servers": { "additionalProperties": { "anyOf":
  [ {"$ref":"Mcp.LocalConfigEncoded"}, {"$ref":"Mcp.RemoteConfigEncoded"} ] } } } },
"compaction": { "properties": { "auto": bool, "keep": {"tokens": int}, "buffer": "15%"|int } }
```

Правило совместимости из [migrate-v1](https://opencode.ai/docs/migrate-v1): **«V2 normalizes supported V1 and native V2 fields in memory without rewriting the source file»** — поддерживаемые V1-поля нормализуются в памяти, файл не переписывается; V1- и V2-поля могут сосуществовать на верхнем уровне, но внутри одного агента/провайдера/команды смешивать форматы нельзя.

---

## Карта переноса: поле 1.x → v2

Источником значений 1.x служит `D:\Portal\zai\ops\opencode\opencode.json`. Статусы: **прямо** — имя и форма совпадают; **авто** — v2 принимает V1-синтаксис и нормализует сам (рекомендуемая native-форма другая); **нет аналога** — v2 поле игнорирует (с warning) или действия не существует.

| # | Поле 1.x (путь, значение кратко) | Поле/структура v2 (источник) | Статус |
|---|---|---|---|
| 1 | `$schema` = `https://opencode.ai/config.json` | тот же URL ([config](https://opencode.ai/docs/config)) | **прямо** |
| 2 | `model` = `zai-coding-plan/glm-5.3` | `model` — тот же синтаксис `provider/model`; `#variant` в корневом default не сохраняется (doc config → Model) | **прямо** |
| 3 | `small_model` = `zai-coding-plan/glm-5.3-flash` | native: `agents.title.model`; V1-поле нормализуется автоматически ([migrate-v1 → Providers](https://opencode.ai/docs/migrate-v1)) | **авто** |
| 4 | `default_agent` = `orchestrator` | `default_agent` (живая схема `Config.InfoEncoded`) | **прямо** (поле), но агент `orchestrator` в файле не определён — см. примечание ниже |
| 5 | `enabled_providers` = `["zai-coding-plan"]` | policies: `{action:"provider.use",resource:"*",effect:"deny"}` + `{action:"provider.use",resource:"zai-coding-plan",effect:"allow"}`; миграция автоматическая ([migrate-v1](https://opencode.ai/docs/migrate-v1); подтверждено живьём, см. «Живая проверка») | **авто** |
| 6 | `autoupdate` = `false` | `update: "disable"` (false→disable, "notify"→notify, true→auto; [migrate-v1](https://opencode.ai/docs/migrate-v1); подтверждено живьём) | **авто** |
| 7 | `share` = `"disabled"` | `share` без изменений (enum `manual|auto|disabled`; живая схема) | **прямо** |
| 8 | `snapshot` = `false` | `snapshots` ([migrate-v1 → Snapshots](https://opencode.ai/docs/migrate-v1)) | **авто** (переименование) |
| 9 | `instructions` = `[D:\Obsidian\agents\_index.md, C:\Users\USER\.config\opencode\prompts\glm-rules.md]` | `instructions` — массив файлов/globs/URL ([config → Instructions](https://opencode.ai/docs/config)) | **прямо** |
| 10 | `plugin` = `["oh-my-opencode-slim@3.0.7", "./vault-cache.ts"]` | `plugins` (массив строк/`{package, options}`). ⚠️ **V1-плагины не выполняются в v2** — нужен порт кода ([migrate-v1 → Plugins](https://opencode.ai/docs/migrate-v1)); локальный путь должен стать директорией (`./vault-cache/index.ts`) | **авто** (имя) + обязательный порт |
| 11 | `provider` → `zai-coding-plan` | `providers` → `zai-coding-plan`; `npm`→`package` (у нас не задан), `api`→`settings.baseURL` (не задан), `options`→`settings`/`headers`/`body` по роли ([migrate-v1 → Providers](https://opencode.ai/docs/migrate-v1)) | **авто** |
| 11а | `provider.zai-coding-plan.whitelist` = `["glm-5.3","glm-5.3-flash"]` | нет поля: V1 `whitelist` — в списке «accepted but unsupported» ([migrate-v1](https://opencode.ai/docs/migrate-v1)), игнорируется с warning. Замена по смыслу — `policies` (deny-всё-кроме-разрешённых уже даёт `enabled_providers`) | **нет аналога** |
| 11б | `provider.zai-coding-plan.options.timeout` = `600000` | `providers.zai-coding-plan.settings.timeout` (число мс; живая схема `Config.Provider.Settings`: `timeout`, `headerTimeout`, `chunkTimeout`) | **авто** |
| 11в | `provider.zai-coding-plan.models.glm-5.3-flash.limit.{context: 262144, output: 131072}` | `providers.zai-coding-plan.models.glm-5.3-flash.limit.{context, input, output}` (живая схема `Config.ModelEncoded`; [migrate-v1 → Models](https://opencode.ai/docs/migrate-v1)) | **прямо** внутри переименованной ветки |
| 12 | `compaction` = `{auto: true, prune: true}` | `compaction.auto` — прямо; `keep.tokens`, `buffer` — новые опции; **`prune` игнорируется с warning** («compaction.tail_turns and compaction.prune» в unsupported; [migrate-v1 → Compaction](https://opencode.ai/docs/migrate-v1)) | **авто** + `prune`: **нет аналога** |
| 13 | `agent` (map, 2 агента) | `agents` (map): `prompt`→`system`, `disable`→`disabled`, `variant`→`model#variant`, `permission`→`permissions`, `maxSteps`→`steps`; `description`, `mode: primary`, `color` сохраняются ([migrate-v1 → Agents](https://opencode.ai/docs/migrate-v1); живая схема `Config.AgentEncoded`) | **авто** |
| 13а | `agent."Hephaestus - deep worker".prompt` = `"{file:./prompts/hephaestus.md}"` | `agents."Hephaestus - deep worker".system`; подстановка `{file:...}` поддерживается в v2 ([config → Variables](https://opencode.ai/docs/config)) | **авто** |
| 13б | `agent.*.variant` = `"high"` | `model: "zai-coding-plan/glm-5.3#high"` или массив `variants` модели ([migrate-v1 → Models and variants](https://opencode.ai/docs/migrate-v1)) | **авто** |
| 13в | `agent.Sandbox.permission` (map, ~18 правил) | `agents.Sandbox.permissions` — упорядоченный массив `{action, resource, effect}`; поэлементно см. ниже | **авто**, частично **нет аналога** |
| 14 | `mcp.playwright` = `{type: local, command: [npx...], enabled: true}` | `mcp.servers.playwright` = `{type: "local", command: [...], disabled: false}`; `enabled` → инвертированный `disabled` ([mcp-servers](https://opencode.ai/docs/mcp-servers); [migrate-v1 → MCP](https://opencode.ai/docs/migrate-v1)) | **авто** |
| 15 | `mcp.marketplace` = `{type: local, command: [python...], enabled: true, environment: {MARKETPLACE_SOURCES}}` | `mcp.servers.marketplace`; `environment` — то же поле (только `{env:NAME}` подстановки, шелл-выражения не разворачиваются) | **авто** |
| 16 | `watcher.ignore` = `[6 glob-ов]` | `watcher.ignore` без изменений ([config → Watcher](https://opencode.ai/docs/config)) | **прямо** |
| 17 | `permission.edit` = `allow` | `permissions: [{action: "edit", resource: "*", effect: "allow"}]` ([permissions](https://opencode.ai/docs/permissions); [migrate-v1 → Permissions](https://opencode.ai/docs/migrate-v1)) | **авто** |
| 18 | `permission.webfetch` = `allow` | `permissions: [{action: "webfetch", resource: "*", effect: "allow"}]` (действие `webfetch` есть в v2, [permissions → Actions](https://opencode.ai/docs/permissions)) | **авто** |
| 19 | `permission.doom_loop` = `ask` | **нет аналога**: «`doom_loop` and `lsp` are not current V2 Core permission actions» ([permissions → Actions](https://opencode.ai/docs/permissions)); действие шло от плагина | **нет аналога** |
| 20 | `permission.bash` (map: `"*": allow` + 16 ask-паттернов: `rm -rf *`, `git push -f*`, `format *`, `shutdown*`, ...) | массив `permissions` с `action: "shell"` (**bash → shell**), последний совпавший выигрывает: broad `shell *`→allow первым, ask-паттерны после ([permissions → Matching](https://opencode.ai/docs/permissions)) | **авто** |

### Правила Sandbox (`agent.Sandbox.permission`) поэлементно

| Правило 1.x | v2 | Статус |
|---|---|---|
| `"*": "deny"` | `{action:"*", resource:"*", effect:"deny"}` (первым в массиве) | **авто** |
| `read/glob/grep/edit/question/webfetch/websearch: allow` | те же имена действий существуют в v2: `read`, `glob`, `grep`, `edit`, `question`, `webfetch`, `websearch` ([permissions → Actions](https://opencode.ai/docs/permissions)) | **авто** |
| `list: "allow"` | действия `list` в v2 нет (нет в таблице Actions) | **нет аналога** (не критично: read/glob покрывают) |
| `todowrite/todoread: "allow"` | действий нет; todos в v2 — experimental-флаг `experimental.todo`, не permission action | **нет аналога** |
| `context7_*`, `grep_app_*`, `marketplace_*: allow` | MCP-инструменты именуются `<server>_<tool>` с нормализацией символов → правила-паттерны переносятся как есть: `{action:"context7_*", resource:"*", effect:"allow"}` | **прямо** (форма правила) |
| `skill: {"*": deny, "zai-*": allow}` | два правила: `{action:"skill",resource:"*",effect:"deny"}`, `{action:"skill",resource:"zai-*",effect:"allow"}` | **авто** |
| `external_directory: {"*": deny, "D:\Obsidian\tenants\*": allow}` | те же два правила с `action:"external_directory"`. ⚠️ В v2 external_directory **по умолчанию разрешён** (V1 спрашивал) — наши правила сохраняют старое поведение ([migrate-v1 → Permissions warning](https://opencode.ai/docs/migrate-v1)) | **авто** |
| `bash: "allow"` | `{action:"shell", resource:"*", effect:"allow"}` | **авто** |
| `task: "deny"` | `{action:"subagent", resource:"*", effect:"deny"}` (**task → subagent**) | **авто** |

### Пример native-v2 `permissions` для нашего файла

```jsonc
{
  "permissions": [
    { "action": "edit", "resource": "*", "effect": "allow" },
    { "action": "webfetch", "resource": "*", "effect": "allow" },
    { "action": "shell", "resource": "*", "effect": "allow" },
    // ask-паттерны ПОСЛЕ broad allow — последний совпавший выигрывает
    { "action": "shell", "resource": "rm -rf *", "effect": "ask" },
    { "action": "shell", "resource": "rm -fr *", "effect": "ask" },
    { "action": "shell", "resource": "rm -r *", "effect": "ask" },
    { "action": "shell", "resource": "rmdir /s*", "effect": "ask" },
    { "action": "shell", "resource": "rd /s*", "effect": "ask" },
    { "action": "shell", "resource": "del /s*", "effect": "ask" },
    { "action": "shell", "resource": "Remove-Item*-Recurse*", "effect": "ask" },
    { "action": "shell", "resource": "git push*--force*", "effect": "ask" },
    { "action": "shell", "resource": "git push -f*", "effect": "ask" },
    { "action": "shell", "resource": "git reset --hard*", "effect": "ask" },
    { "action": "shell", "resource": "git clean -*", "effect": "ask" },
    { "action": "shell", "resource": "git checkout -- *", "effect": "ask" },
    { "action": "shell", "resource": "git branch -D*", "effect": "ask" },
    { "action": "shell", "resource": "format *", "effect": "ask" },
    { "action": "shell", "resource": "diskpart*", "effect": "ask" },
    { "action": "shell", "resource": "shutdown*", "effect": "ask" },
    { "action": "shell", "resource": "Stop-Computer*", "effect": "ask" },
    { "action": "shell", "resource": "Restart-Computer*", "effect": "ask" },
    { "action": "shell", "resource": "taskkill*opencode*", "effect": "ask" },
    { "action": "shell", "resource": "schtasks*", "effect": "ask" },
    { "action": "shell", "resource": "reg delete*", "effect": "ask" }
  ]
}
// `doom_loop: ask` не переносится — действия нет в v2 core.
```

### Примечание про `default_agent: "orchestrator"`

Агент `orchestrator` не определён в нашем 1.x файле (в `agent` только «Hephaestus - deep worker» и «Sandbox») — он приходил извне (вероятно, из плагина oh-my-opencode-slim). Так как **V1-плагины в v2 не выполняются**, после переноса агента `orchestrator` нужно объявить явно в `agents`, иначе `default_agent` будет указывать на несуществующего агента. Проверить можно на :4099: `GET /api/agent` возвращает только встроенных (`build`, `general`, `plan`, `explore`, `title`, `summary`, `compaction`) — живая выдача содержит `build` и `general`.

---

## Живая проверка /api/config на :4099

Сервер: `http://127.0.0.1:4099`, `GET /api/config` с Basic-авторизацией. Ответ — массив «конфиг-документов» (`Config.Entry` = document | directory).

Его конфиг-файл `D:\zai-tmp-scripts\oc2-run\config\opencode\opencode.json` (прочитан, целиком, секретов нет):

```json
{"enabled_providers":["zai-coding-plan"],"autoupdate":false,"share":"disabled","mcp":{}}
```

Ответ `/api/config` (без параметров и с `?location[directory]=D:/zai-tmp-scripts/oc2-run` — одинаково):

```json
[
  {
    "type": "document",
    "path": "D:\\zai-tmp-scripts\\oc2-run\\config\\opencode\\opencode.json",
    "info": {
      "update": "disable",
      "share": "disabled",
      "policies": [
        { "action": "provider.use", "resource": "*", "effect": "deny" },
        { "action": "provider.use", "resource": "zai-coding-plan", "effect": "allow" }
      ],
      "mcp": {}
    }
  },
  { "type": "directory", "path": "D:\\zai-tmp-scripts\\oc2-run\\config\\opencode" }
]
```

**Что видно** — v2 нормализовал V1-файл в памяти ровно как в доках migrate-v1:

- `enabled_providers` → два `policies`-правила `provider.use` (deny-всё + allow zai-coding-plan);
- `autoupdate: false` → `update: "disable"`;
- `share: "disabled"` → как есть;
- `mcp: {}` → пусто (в файле серверов нет).

**Чего не видно** (в файле этих полей и нет): `model`, `small_model`, `default_agent`, `instructions`, `plugin`, `provider`, `compaction`, `agent`, `watcher`, `permission` — сравнение подтверждает: `/api/config` отражает только то, что задано в файлах конфига, а не всё эффективное состояние.

**Провайдер zai-coding-plan** (секрета маскированы): в конфиг-файле :4099 провайдера **нет**; учётная запись хранится в `D:\zai-tmp-scripts\oc2-run\data\opencode\auth.json` (файл прочитан, значение ключа замаскировано):

```json
{
  "zai":             { "type": "api", "key": "8249…(маскировано)" },
  "zai-coding-plan": { "type": "api", "key": "8249…(маскировано)" }
}
```

При этом в `/api/provider` и `/api/model` `data: []` — пусто на трёх проверенных location (`C:\Windows\System32`, `D:/zai-tmp-scripts/oc2-run`, `D:/Portal/zai`; параметры `location[directory]` deepObject, см. `/openapi.json` → `provider.list`). То есть настроенный провайдер **не виден через эти GET-эндпоинты живьём**; причина не установлена (ленивый резолв каталога моделей / отсутствие активной сессии — не проверено). **Пояснение из позднейшего исследования [api-map.md, раздел 10](api-map.md)**: ключ из `auth.json` в v2 сам не мигрирует — таблица credential пуста, каталоги провайдеров/моделей пусты и ходы падают с `provider.no-route`, пока ключ не добавлен через `POST /api/credential`; на момент этой проверки credential ещё не был добавлен (эти проверки шли до эксперимента api-map).

**MCP**: `/api/mcp` → `data: []` — соответствует пустому `mcp` в файле; playwright/marketplace из нашего 1.x на :4099 не подключены (их там и не конфигурировали).

**Agents**: `/api/agent` → встроенные агенты (в выдаче видны `build` «The default agent…» и `general`), кастомных нет — их нет в файле. Формат правил совпадает со схемой: `{action, resource, effect}` (в живой выдаче: `{action:"*",resource:"*",effect:"allow"}`, `{action:"read",resource:"*.env",effect:"ask"}`, `{action:"browser",resource:"*",effect:"deny"}`, ...).

**Skills/commands**: `/api/skill` → встроенный скилл `opencode` (вопросы про сам opencode); `/api/command` → встроенные `init`, `review`, `goal`.

**Лог сервера** (`data/opencode/log/opencode.log`): watcher мониторит глобальный каталог `D:\zai-tmp-scripts\oc2-run\config\opencode` + `AGENTS.md` + `skill`/`skills`; исторические (10:05) записи:

```text
level=WARN message="configuration normalization diagnostic"
  source="D:\zai-tmp-scripts\oc2-run\config\opencode\opencode.json"
  path=$ kind=invalid action="rejected malformed JSON or JSONC document"
```

— в текущем ране (15:01+) этих warning нет: файл валиден и грузится. Вывод: некорректный конфиг v2 **не игнорирует молча** — пишет WARN в лог (не в API-ответ).

---

## Откуда 2.x читает конфиг

По [config → Locations](https://opencode.ai/docs/config) и [migrate-v1](https://opencode.ai/docs/migrate-v1) v2 читает **те же пути, что 1.x**:

```text
Системный:  Windows: %ProgramData%\opencode\opencode.json(c)   (macOS/Linux аналогично)
Глобальный: ~/.config/opencode/opencode.json(c)
Проектный:  <project>/opencode.json(c)  и  <project>/.opencode/opencode.json(c)
            (поиск от cwd вверх до корня; macOS также Managed Preferences)
```

Приоритет обычных настроек (снизу вверх): global → project-файлы (внешние каталоги раньше внутренних; `.opencode/opencode.json` перекрывает прямые `opencode.json`) → системный файл. Для **policies порядок обратный** — глобальные/системные правила сильнее проектных ([policies → Precedence](https://opencode.ai/docs/policies)).

**Почему наш 1.x файл «молча не применяется»**: `D:\Portal\zai\ops\opencode\opencode.json` лежит **вне всех зон поиска** (не system, не global, не project-цепочка от cwd). Для сервера :4099 подтверждено живьём:

- location по умолчанию — `C:\Windows\System32` (`GET /api/location` → `project.directory`), а глобальный каталог перенаправлен env в `D:\zai-tmp-scripts\oc2-run\config\opencode` (watcher в логе сидит именно там, `/api/config` возвращает именно этот документ). Точный механизм переопределения (XDG_CONFIG_HOME/OPENCODE_CONFIG у процесса) по GET-запросам не определяется — **не проверено**;
- в `/api/config` наш файл не фигурирует ни как document, ни как warning — v2 его просто **не находит** и не ругается: «молчание» — это отсутствие файла в зоне поиска, а не игнорирование формата.

Если бы файл был в зоне поиска, формат 1.x сам по себе **поддерживается**: «Existing supported server config fields, agent definitions, command definitions, skills... should continue to work without changes» ([migrate-v1](https://opencode.ai/docs/migrate-v1)). Неподдерживаемые поля (наш `whitelist`, `compaction.prune`, `doom_loop` и т.п.) дают warning в лог, а не падение. Для рабочего портала файл нужно разместить как `D:\Portal\zai\opencode.json` или `D:\Portal\zai\.opencode\opencode.json` (либо global) — тогда он применится.

---

## Новое в v2 (agents, policies, skills, compaction, команды)

Чего в нашем 1.x файле нет, а в v2 появилось (все поля подтверждены живой схемой `/openapi.json` :4099 и доками):

- **`agents`** вместо `agent`/`mode`: поля `system`, `permissions` (массив), `steps`, `disabled`, `hidden`, `request.headers/body` (в v1 `request.body` не доходил до модели — теперь настройки сэмплинга идут через `variants` модели). Файловые агенты: `.opencode/agents/<name>.md` (v1 каталоги `agent/`, `mode/`, `modes/` тоже дисковериются).
- **`policies`** — упорядоченный массив `{action, resource, effect: allow|deny}`: `provider.use`, `tool.use` (жёсткий deny поверх permissions), `mcp.use`, `skill.use`, `plugin.use`, `integration.connect/use`, `websearch.use` (последнее — с 2.2.6; клиенты старее 2.2.6 игнорируют). «Последний выигрывает», без правила — разрешено. Заменяет 1.x `enabled_providers`/`disabled_providers`.
- **`skills`** — массив доп. путей/URL скиллов + автодискавери `.opencode/skills/<id>/SKILL.md`; скиллы управляются правилами `skill` и политиками `skill.use`.
- **`commands`** — map слэш-команд `{template, description, agent, model ("provider/model#variant"), subagent}`; маркдаун-файлы `.opencode/commands/<name>.md` поддерживаются.
- **`compaction.keep.tokens`** и **`compaction.buffer`** (число или `"15%"` — процент окна модели, с 2.2.5), native-компакция провайдера через `providers.*.settings.compaction`, экспериментальная фоновая `experimental.background_compaction`.
- **`permissions`** — новый формат массива (см. выше); действия `execute` (Code Mode), `opencode_list_mcp_resources`, `opencode_read_mcp_resource`.
- Прочее новое: `references` (локальные/git-репо как именованный контекст), `warming`, `media.image`, `tool_output`, `websearch`, `worktree.directory`, `formatter`, `enterprise`, `experimental.*` (todo, subagent_depth, background_compaction, image_generate, schedules, artifacts, codemode_vm, location_idle_timeout), объектная форма `plugins` с `options`, `update` вместо `autoupdate`, `mcp.timeout.{startup,catalog,execution}`, `codemode`, `protocol` (`legacy|auto|2026-07-28`), `pool` у MCP-серверов.
- **Не переносится по умолчанию**: `external_directory` — в v1 спрашивал, в v2 разрешён без промпта (нужно явное правило); todos выключены (нужен `experimental.todo: true`); LSP принимается в конфиг, но не запускается.

---

## Пул MCP: как включить

Настройка — **поле конфига `pool: true` у конкретного сервера** в `mcp.servers` (не env и не CLI-флаг). Живая схема :4099 (`Mcp.LocalConfigEncoded` / `Mcp.RemoteConfigEncoded`) содержит `pool: boolean` у обоих типов.

```jsonc
{
  "mcp": {
    "servers": {
      "cloudflare": { "type": "remote", "url": "https://mcp.cloudflare.com/mcp", "pool": true }
    }
  }
}
```

- **Версия: пул появился в v2.2.6** — release notes v2.2.6: «Added opt-in MCP connection sharing through `pool: true`» ([PR #61185](https://github.com/anomalyco/opencode/pull/61185), highlights «Shared MCP Connections»). В release notes 2.2.3–2.2.5 пул не упоминается.
- Смысл: один сервер opencode может держать много каталогов (locations); с `pool: true` каталоги с одинаковыми настройками сервера делят **одно подключение и один список инструментов** ([mcp-servers → Shared connections](https://opencode.ai/docs/mcp-servers)).
- Ограничения: шарятся только подключения протокола **2026-07-28** — при `pool: true` незаданный `protocol` означает `auto`; сервер, ответивший старой ревизией или `legacy`, остаётся по подключению на каталог. Всё, что меняет подключение (url/headers/oauth/команда/cwd/environment, timeout, protocol), должно совпадать; имя сервера — нет, но OAuth-сервер шарится только под одним именем. Локальный сервер шарится только между каталогами **одной машины** и требует фиксированного `cwd` (иначе — свой процесс в каждом проекте + warning). У общего подключения нет roots; запросы ввода показываются в каталоге-инициаторе; подключение закрывается, когда его покидает последний каталог.

---

## Итог по нашему файлу

- 16 полей верхнего уровня в `ops\opencode\opencode.json`:
  - **прямо (без изменений)** — 6: `$schema`, `model`, `share`, `instructions`, `watcher.ignore`, `provider.…models…limit` (внутри переименованной ветки);
  - **авто-нормализация / реструктуризация (V1-синтаксис v2 принимает сам, native-форма другая)** — 9: `small_model`, `enabled_providers`, `autoupdate`, `snapshot`, `plugin`, `provider` (включая `options.timeout`), `compaction.auto`, `agent`, `mcp`, `permission` (последние три — переименование/перестройка в `agents`/`mcp.servers`/`permissions`-массив);
  - **нет аналога** — 3 сущности: `provider.zai-coding-plan.whitelist` (unsupported, заменяется политиками), `compaction.prune` (unsupported), `permission.doom_loop` (не core-действие v2); плюс внутри Sandbox-агента — `list`, `todowrite`, `todoread` (действий в v2 нет).
- Два содержательных риска переноса: **плагины v1 не запускаются в v2** (нужен порт `oh-my-opencode-slim` и `vault-cache`, иначе `default_agent: orchestrator` и `vault-cache` отваливаются) и **`external_directory` в v2 разрешён по умолчанию** (наши deny-правила Sandbox сохраняют старое поведение — их надо переносить обязательно).
- Живая проверка :4099 подтвердила миграцию `enabled_providers`→policies и `autoupdate`→`update` в памяти без перезаписи файла; провайдер из `auth.json` через `/api/provider`/`/api/model` не отображается (причина не установлена, не проверено).
