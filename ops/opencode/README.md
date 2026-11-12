# ops/opencode — конфигурация opencode serve (:4096 прод, :4097 стенд)

Источник истины для файлов, которые живут вне репозитория:

| Файл | Куда ставится (прод) | Стенд |
|---|---|---|
| `opencode.json` | `C:\Users\USER\.config\opencode\opencode.json` | `D:\zai-stage\opencode\config\opencode\opencode.json`, но `instructions` → `D:\zai-stage\vault\agents\_index.md` |
| `vault-cache.ts` | `C:\Users\USER\.config\opencode\vault-cache.ts` | то же имя в конфиге стенда |
| `prompts/*.md` | `C:\Users\USER\.config\opencode\prompts\` | `…\config\opencode\prompts\` |
| `oh-my-opencode-slim.json` | `C:\Users\USER\.config\opencode\oh-my-opencode-slim.json` | `D:\zai-stage\opencode\config\opencode\oh-my-opencode-slim.json` |
| `omo.jsonc` (только источник отката на OmO, FEAT-16.2) | раньше `C:\Users\USER\.omo\omo.jsonc` | раньше `D:\zai-stage\home\.omo\omo.jsonc` |

## opencode 2.x (FEAT-16.3): `opencode.v2.json` и стенд :4101/:4174

Нативный конфиг opencode 2.2.6 — `opencode.v2.json` (значения перенесены из `opencode.json` 1.x по `docs/opencode-v2/config-map.md`; детали — design §8). Отличия от 1.x-файла, важные при правке:

- `whitelist` провайдера заменён policies (`provider.use`: deny всем + allow zai-coding-plan); `small_model` → `agents.title.model`; `variant` → суффикс модели (`glm-5.3#high`); `autoupdate:false` → `update:"disable"`; `snapshot` → `snapshots`; `permission`-карты → массивы `permissions` (broad allow строго ДО ask-паттернов, last-match-wins; имена v2: `bash`→`shell`, `task`→`subagent`); `plugin` → `plugins` (slim пиннут точной версией, наш плагин — директория `./plugin-v2`); `mcp` → `mcp.servers` (`enabled` → инвертированный `disabled`); `compaction.prune` выброшен (v2 игнорирует с warning).
- Без аналога в v2 (осознанно выброшены): `doom_loop`, внутри Sandbox — `list`, `todowrite`, `todoread` (read/glob покрывают).
- Агент `orchestrator` объявлен в `agents` явно: V1-плагины в v2 не выполняются, и без явного объявления `default_agent` указывал бы несуществующего агента.
- Sandbox переносит все запреты 1.x поэлементно, включая `external_directory`: deny всем + allow только зоне тенантов (в v2 внешние папки разрешены по умолчанию — правило обязательно). Тест проверяет изоляцию через `lib/policy.js` (`agentIsSandboxed`) на форме, которую v2 отдаёт в `GET /api/agent`.

Тест: `node --test ops/opencode/tests/opencode-v2-config.test.mjs` (форма + Sandbox + сверка с 1.x бит в бит).

### Раскладка стенда v2

| Что | Значение |
|---|---|
| serve opencode 2.2.6 | :4101, бинарник `D:\zai-tmp-scripts\oc2-dl\bin\opencode.exe` (SHA256 `oc2.zip` сверяется с `SHA256SUMS` при каждом запуске) |
| XDG-зона serve | `D:\zai-stage\oc2\{config,data,state,home,logs}`; конфиг — `oc2\config\opencode\opencode.json`, рядом `plugin-v2\`, `prompts\`, `skills\zai-*`, `oh-my-opencode-slim.json` |
| портал | тот же `D:\Portal\zai\server.js` на :4174: `ZAI_OC_API=v2`, `ZAI_UPSTREAM=http://127.0.0.1:4101`, `ZAI_DATA_DIR=D:\zai-stage\stand2-data` (users.json — копия стенда v1, чатов нет), `ZAI_PUBLIC_DIR=D:\zai-stage\public`, `ZAI_COOKIE_NAME=zai_t_stage2`, `ZAI_ENV=stand` |
| зоны тенантов | свои, не v1: `ZAI_TENANT_HOME=D:\zai-stage\oc2\tenants\home`, `ZAI_TENANT_VAULT=D:\zai-stage\oc2\tenants\vault` (скрипт патчит allow-зону Sandbox в копии конфига на этот путь; изоляция данных между стендами важнее общего файла). База владельца — общая, только чтение: `VAULT_CACHE_ROOT=D:\Obsidian\agents`, `VAULT_CACHE_PROTECT=D:\Obsidian`, `ZAI_KB_ROOT` тот же |
| jail/Python | общие бинарники без состояния: `ZAI_JAIL_EXE=D:\Portal\zai\ops\sandbox\zai-jail.exe`, `ZAI_SANDBOX_PY=D:\zai-sandbox\python`; `ZAI_TURN_UNDO_ROOT=oc2\data\turn-undo` — свой |
| пароль serve | `D:\zai-stage\oc2\secrets\password.txt` (генерируется при первом запуске, ACL — только текущий пользователь, вне git); процессам — только env: `OPENCODE_SERVER_PASSWORD` (serve), `ZAI_OC_PASSWORD` (портал); нигде не печатается |

Скрипт: `D:\zai-stage\stand-v2.ps1` (источник — `ops/opencode`, ставит Claude; логика как у `stand.ps1`, только порты 4101/4174):

```
powershell -File D:\zai-stage\stand-v2.ps1                # старт (перечитывает конфиг/плагин при каждом запуске)
powershell -File D:\zai-stage\stand-v2.ps1 -Detach        # то же в фоне
powershell -File D:\zai-stage\stand-v2.ps1 -RestartOpencode  # перечитать конфиг/плагин serve, портал не трогать
powershell -File D:\zai-stage\stand-v2.ps1 -Stop
```

Первый запуск: SHA256 → создание папок → копия users.json из `stand-data` → генерация пароля → serve → портал → проверка `/healthz` и подсказка про ключ. Ключ провайдера из auth.json в v2 сам не мигрирует (api-map §10) — ставится один раз:

```
$env:ZAI_OC_PASSWORD = (Get-Content D:\zai-stage\oc2\secrets\password.txt -Raw).Trim()
node ops/deploy/oc2-credential.mjs --url=http://127.0.0.1:4101 --auth=D:\zai-stage\opencode\data\opencode\auth.json
```

Скрипт печатает только статусы: ответ `/api/credential` эхом возвращает ключ открытым текстом — тело не печатается и не логируется (тест `node --test tests/oc2-credential.test.js` гоняет скрипт против фейка, который эхо-ответ возвращает и в ошибке). Повторный запуск безопасен: 409 → DELETE+POST (обновление, design §9).

Проверки после подъёма стенда: `GET :4174/healthz` → 200; `GET :4101/api/config` (Basic `opencode:<пароль>`) содержит наш документ; `GET :4101/api/agent` содержит `orchestrator` и `Sandbox` с `permissions`-массивом; `/api/provider` непуст после credential. Пробы песочницы/jail — `D:\Portal\zai-qa\probes\` (tasks 6.3–6.4).

### Откат стенда/прода на 1.x

- Стенд v2 → v1: `stand-v2.ps1 -Stop`, затем `D:\zai-stage\stand.ps1` (стенд 1.x не трогался всё время работы v2). Данные v2 остаются в `oc2\` и `stand2-data\`.
- Прод (когда будет переключён): смена `ZAI_OC_API=v1` + рестарт `zai-web` — решение владельца № 1, 1.x serve не удаляется до закрытия FEAT-16.3.

### Прод v2: комплект переключения (FEAT-16.3, подготовлен 2026-11-08, не применён)

Файлы в репозитории; запуск установки и переключение — только вручную (скрипты ничего не стартуют и не рестартуют):

| Файл | Роль |
|---|---|
| `ops/opencode/serve-v2.cmd` | opencode 2.2.6 serve на **:4196**, XDG-зона `D:\Portal\zai-oc2\{config,data,state,home,logs}`; бинарник — аргумент 1 (по умолчанию копия `D:\Portal\zai-oc2\bin\opencode.exe`, SHA256 проверяет `oc2-install.ps1`); `OPENCODE_SERVER_PASSWORD` из `D:\Portal\zai\data\oc2-password.txt` (`set /p`, нигде не печатается); `OPENCODE_DISABLE_PROJECT_CONFIG=1` и `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=65536` — как в 1.x `serve.cmd`; вывод — `zai-oc2\logs\serve-v2.log`. Env плагина не задаётся: дефолты `plugin-v2`/`sandbox-core` уже равны прод-путям 1.x (users.json `D:\Portal\zai\data\users.json`, зоны тенантов `C:\Users\USER\.zai-tenants` + `D:\Obsidian\tenants`, vault `D:\Obsidian\agents`, jail `ops\sandbox\zai-jail.exe`, turn-undo → `data\turn-undo`) |
| `ops/web-v2.cmd` | тот же `server.js` с прод-умолчаниями (порт 4170, data dir, users.json); добавлены только `ZAI_OC_API=v2`, `ZAI_UPSTREAM=http://127.0.0.1:4196`, `ZAI_OC_PASSWORD` из того же файла пароля |
| `ops/deploy/oc2-install.ps1` | разовая подготовка прода v2 (ASCII, идемпотентен, БЕЗ рестартов): копия бинарника с проверкой SHA256 (пин — параметром `-ExpectedSha256`), генерация пароля при отсутствии (64 hex, без перевода строки) + `icacls` только текущему пользователю, XDG-папки, `opencode.v2.json → config\opencode\opencode.json` (единственный патч — путь glm-rules на копию в зоне, как на стенде), `plugin-v2` + `sandbox-core` (sibling-импорт `../sandbox-core/index.mjs`) + `prompts` + `skills\zai-*` + `oh-my-opencode-slim.json`, agent-skills тем же установщиком в каталог v2, регистрация S4U-задачи `zai-opencode-v2` (не запускается) |

Порядок переключения (решение владельца): `oc2-install.ps1` → старт задачи `zai-opencode-v2` → ключ провайдера (`ops/deploy/oc2-credential.mjs`, как на стенде §выше) → рестарт `zai-web` с env из `web-v2.cmd`. Откат: обычный `node server.js` без env + рестарт `zai-web`; v2-задачу погасить; 1.x serve всё время не трогается. Тест комплекта: `node --test tests/oc2-cutover.test.js` (порт/XDG, пароль только `set /p` и не печатается, ASCII всех трёх файлов, parse PS 5.1).



**Фреймворк агентов — oh-my-opencode-slim (FEAT-16.2 / EPIC-16, 2026-11-07; до этого OmO).** Плагин `oh-my-opencode-slim@3.0.7` (закреплён), `default_agent: orchestrator`, конфиг `oh-my-opencode-slim.json` рядом с `opencode.json`: orchestrator Flash max → glm-5.3 high; explorer Flash low; oracle glm-5.3 max → Flash; designer Flash max; fixer Flash high; observer Flash low; `fallback.enabled`, `image_routing: auto`. Тест: `node --test ops/opencode/tests/slim-config.test.mjs`. Чаты, привязанные к агентам OmO, портал переводит на агента по умолчанию (lib/policy.js `adminAgentFor`).
Переключение и откат: `node ops/deploy/slim-switch.mjs <apply|rollback|status> --config-dir=<…\opencode> --omo-file=<…\.omo\omo.jsonc> --rollback-dir=<бандл>` (бандл создаётся один раз при первом apply; rollback возвращает opencode.json и omo.jsonc байт в байт). После apply/rollback — рестарт opencode (стенд: `D:\zai-stage\stand.ps1 -RestartOpencode`; прод — только отложенной задачей). Стенд переключён 2026-11-07, бандл `D:\zai-stage\rollback\slim-2026-11-07`.
Абзацы ниже про OmO и omo.jsonc описывают прежнюю конфигурацию (история и откат).
Профиль: только GLM Coding Plan (`enabled_providers: [zai-coding-plan]`), OmO закреплён (`oh-my-openagent@5.1.62`, с 2026-11-06; было 5.1.60), автообновления выключены.
Агенты: OmO-набор на GLM (omo.jsonc, формат `models: [{model, reasoning}]`). «Hephaestus - deep worker» — GLM-замена OmO-hephaestus, который работает только на GPT. `Sandbox` — агент тенантов.

Песочница тенантов (BUG-100 / BUG-12.20) — `vault-cache.ts`, хук `tool.execute.before`. Тесты:

    node --test ops/opencode/tests/*.test.mjs

Снапшот базы знаний (FEAT-01.32 / BUG-01.27, 2026-11-04): текст сообщения пользователя не меняется, снапшот лежит в `metadata.kbContext` текстовой части; модели он подставляется хуком `experimental.chat.messages.transform`. Модуль экспортирует только `default` — opencode вызывает каждый экспорт как плагин. Портал (zai-web ≥ этой версии) показывает строку «Контекст из базы знаний» из metadata; старый портал с новым плагином просто не покажет строку (текст чистый) — выкатывать портал первым или одновременно.

Выкат этой версии плагина: (1) `copy ops\opencode\vault-cache.ts D:\zai-stage\opencode\config\opencode\vault-cache.ts` → `D:\zai-stage\stand.ps1 -RestartOpencode` → новый чат «Привет» на стенде: в `GET :4097/session/<id>/message` текст части = «Привет», `metadata.kbContext` начинается с `[obsidian-cache]`, ответ видит кэш, в `vault-cache.log` — `snapshot injected`; tenant-sandbox-probe зелёный; (2) `copy` в `C:\Users\USER\.config\opencode\vault-cache.ts` → отложенный рестарт задачи `zai-opencode-serve` (плагин читается только при старте serve). Откат — прежний файл из `backup-*` и тот же рестарт.

«Отменить ход» opencode вне git (BUG-146 / FEAT-01.58, 2026-11-04): хук `tool.execute.before` (после проверки песочницы, только для разрешённого вызова) перед write/edit/multiedit/patch/apply_patch копирует первое состояние файла хода в `<ZAI_TURN_UNDO_ROOT>/<sessionID>/<messageID вопроса>/`; без env — `<dirname(ZAI_USERS_FILE)>/turn-undo` (прод: `D:\Portal\zai\data\turn-undo`, стенд: `D:\zai-stage\stand-data\turn-undo`) — тот же каталог, что `ZAI_TURN_UNDO_ROOT` портала (по умолчанию `<ZAI_DATA_DIR>/turn-undo`). Формат — как у хука Claude (`lib/turn-undo-hook.mjs`). Субагенты пишут в ход корневой сессии; новый вопрос удаляет бэкапы прежнего хода; `session.idle` пишет `<key>.after.json`. Откатывает файлы портал (lib/turn-undo.js), opencode revert только скрывает сообщения. Тест: `ops/opencode/tests/vault-cache-turn-undo.test.mjs`.

Выкат BUG-146 (портал первым или одновременно: портал 1.10.0 с новым плагином отката файлов не делает, а его gc удаляет opencode-бэкапы как «чужие» — безвредно; новый портал со старым плагином — превью «не откатится», как в 1.10.0):
1. Стенд: `copy ops\opencode\vault-cache.ts D:\zai-stage\opencode\config\opencode\vault-cache.ts` (прежний — в `D:\zai-stage\rollback\`) → `D:\zai-stage\stand.ps1 -Stop` → `-Detach`; в `vault-cache.log` строка `loaded: … turnUndo=D:\zai-stage\stand-data\turn-undo`; opencode-чат вне git: «создай oc.txt с A» → «замени A на B» → «Отменить ход» → A → «Вернуть» → B.
2. Прод, портал: выкат zai-web этой версии (server.js, lib/config.js) — рестарт задачи `zai-web`.
3. Прод, плагин: прежний `C:\Users\USER\.config\opencode\vault-cache.ts` → `backup-*`; `copy` новой версии → отложенный рестарт задачи `zai-opencode-serve` (плагин читается только при старте serve; рестарт обрывает идущие ходы — в тихое время). Проверка: `vault-cache.log` → `loaded: … turnUndo=D:\Portal\zai\data\turn-undo`; dogfood как на стенде в папке вне git.
4. Откат: прежний файл из `backup-*` и тот же рестарт `zai-opencode-serve`; портал можно не откатывать (без бэкапов он ведёт себя как 1.10.0).

Shell и Python тенантов (FEAT-04.9, 2026-11-04): агент `Sandbox` — `bash: allow`, `context7_*`/`grep_app_*: allow`; плагин переписывает каждую команду bash тенанта в вызов `ops\sandbox\zai-jail.exe` (Windows AppContainer тенанта, `cmd.exe`, Python `D:\zai-sandbox\python`; подробно — `ops/sandbox/README.md`). opencode 1.19.5 исполняет bash-инструмент через Git Bash (`/usr/bin/bash`, проверено на стенде): в переписанной строке только `[A-Za-z0-9_-./:]`, исходная команда — base64url. env serve: `ZAI_JAIL_EXE` (по умолчанию `D:/Portal/zai/ops/sandbox/zai-jail.exe`), `ZAI_SANDBOX_PY` (`D:/zai-sandbox/python`); нет любого — bash тенанту запрещён. Портал (`lib/policy.js`) допускает тенанту агента с bash, но `task` и `external_directory` обязаны быть deny.

Выкат FEAT-04.9:
1. `ops\sandbox\setup-python.ps1` (идемпотентно) → `ops\sandbox\build.ps1` в основном каталоге (`D:\Portal\zai\ops\sandbox\zai-jail.exe`) → `node --test ops/sandbox/tests/jail-live.test.mjs`.
2. Стенд: `vault-cache.ts`, `prompts\sandbox.md` и агент `Sandbox` из `opencode.json` (только этот блок: `instructions` стенда свои) → `D:\zai-stage\opencode\config\opencode\`, прежние — в `D:\zai-stage\rollback\`; `stand.ps1 -RestartOpencode`; портал стенда — с `lib/policy.js` этой версии; проба `D:\Portal\zai-qa\probes\tenant-jail-probe.mjs`.
3. Прод: портал (`lib/policy.js`) — рестарт `zai-web`; те же три файла в `C:\Users\USER\.config\opencode\` (прежние — `backup-*`) — отложенный рестарт `zai-opencode-serve`. Порядок любой: старый портал прячет агента Sandbox с bash от тенантов (tenantAgents), старый плагин режет bash тенанта.
4. Откат: прежние файлы из `backup-*`/`rollback` и те же рестарты; `zai-jail.exe` и `D:\zai-sandbox` можно оставить.

Скиллы документов и marketplace тенантов (FEAT-04.10, 2026-11-04): `skills/zai-{xlsx,docx,pptx,pdf,images,html}/SKILL.md` — рецепты Python для песочницы (cmd.exe + `python файл.py`), ставятся в `<config>/opencode/skills/`. Хелпер-скриптов в каталогах скиллов нет намеренно: агент копирует рецепт в .py в папке тенанта, поэтому контейнеру не нужен доступ к `~/.config/opencode` (ACL не меняется), а инструмент `read` тенанта и так не выходит из его папки. Рецепты проверяет `ops/sandbox/tests/skills-live.test.mjs` (выполняет блоки `# Рецепт`/`# Проверка` из SKILL.md в zai-jail). Агент `Sandbox`: `skill: {"*": "deny", "zai-*": "allow"}` (opencode 1.19.5 фильтрует по нему список скиллов в промпте и спрашивает `permission: skill, patterns: [имя]`), `marketplace_*: allow`. Плагин (tenant): `skill` — только `name` вида `zai-*` (у opencode и OmO аргумент `name`; OmO снимает ведущий `/` и не различает регистр), иначе «Доступ запрещён: скилл … недоступен»; `skill_mcp` — нет; MCP `marketplace_*` — да, кроме `marketplace_compare_browser_snapshot` (скриншот страницы из браузера владельца). Имена MCP-инструментов в opencode — `<сервер>_<инструмент>`: `marketplace_wb_search`, `marketplace_ozon_search`, `marketplace_compare_prices`, …

Выкат FEAT-04.10:
1. `ops\sandbox\setup-python.ps1` (досоставит пакеты; окружение общее для стенда и прода) → `node --test ops/sandbox/tests/skills-live.test.mjs`.
2. Стенд: `skills\zai-*` → `D:\zai-stage\opencode\config\opencode\skills\`, `vault-cache.ts`, `prompts\sandbox.md`, блок агента `Sandbox` в `opencode.json` (прежние — `D:\zai-stage\rollback\`); `stand.ps1 -RestartOpencode`; проба `D:\Portal\zai-qa\probes\tenant-skills-probe.mjs` и `tenant-jail-probe.mjs`.
3. Прод: те же файлы в `C:\Users\USER\.config\opencode\` (прежние — `backup-*`; ACL не нужен) → отложенный рестарт `zai-opencode-serve`. Портал не меняется.
4. Откат: удалить `skills\zai-*`, вернуть три файла из `backup-*`, тот же рестарт. Пакеты в `D:\zai-sandbox` можно оставить.

Проектный конфиг отключён (безопасность, 2026-11-04): тенант из песочницы может создать в своей папке `.opencode/plugins/*.js` или `opencode.json` с `mcp`. opencode загрузил бы их с правами владельца (воспроизведено на стенде). Поэтому serve запускается с `OPENCODE_DISABLE_PROJECT_CONFIG=1`: прод — задача `zai-opencode-serve` → `ops\opencode\serve.cmd`, стенд — `stand.ps1`. Действует только глобальный конфиг `C:\Users\USER\.config\opencode`. Команды и скиллы openspec (`opsx-*`, `openspec-*`) скопированы из `D:\Portal\zai\.opencode` в глобальные `commands\` и `skills\`. Плагин дополнительно запрещает запись в `.opencode`, `.omo`, `.claude`, `.agents`, `opencode.json(c)` и `.mcp.json`; после каждой bash-команды тенанта такие записи переименовываются. OmO читает `.mcp.json` и `.claude/settings*.json` только из cwd процесса serve, а не из папки сессии.

Инженерные скиллы agent-skills (addyosmani/agent-skills 0.6.15, 2026-11-07, только admin):
- Источник — Claude-плагин `agent-skills@addy-agent-skills` (user scope, `claude plugin marketplace add https://github.com/addyosmani/agent-skills.git` → `claude plugin install agent-skills@addy-agent-skills`). Claude-чаты admin получают его сами: CLI идёт с `~/.claude` (скиллы `agent-skills:*`, команды `/agent-skills:spec` и т. д.).
- opencode: с 1.15.0 (FEAT-16.2, oh-my-opencode-slim) Claude-плагины не загружаются. При OmO скиллы приходили из плагина под именами `agent-skills:*`, на slim пропали (BUG-187). Поэтому плагин ставится нативно, `agent-skills-opencode.mjs`: 25 скиллов под именами без префикса — в `<config>/skills/`, `references/` — в `<config>/references/` (скиллы ссылаются на `../../references/`), 4 персоны — субагенты `<config>/agents/as-{code-reviewer,security-auditor,test-engineer,web-performance-auditor}.md`, 9 команд — `<config>/commands/as-{spec,plan,build,test,review,code-simplify,constraints,webperf,ship}.md`. В текстах команд и персон имена переписаны под opencode. Префикс `as-` нужен, потому что `/review` занят, а `build` и `plan` — имена агентов.
- Тенанты их не получают: у Sandbox `skill: {"*": "deny", "zai-*": "allow"}` и `task: deny`, vault-cache пропускает только `zai-*` (`TENANT_SKILL`), `policy.tenantAgents` скрывает субагентов.
- Обновление: `claude plugin update agent-skills@addy-agent-skills` → `node ops/opencode/agent-skills-opencode.mjs %USERPROFILE%\.claude\plugins\cache\addy-agent-skills\agent-skills\<версия> %USERPROFILE%\.config\opencode` (стенд — `D:\zai-stage\opencode\config\opencode`) → рестарт serve (§3 runbook). Проверка: `D:\Portal\zai-qa\probes\agent-skills-probe.mjs`.
- Слэш-команды из GLM-чата портала на slim раскрываются только через `POST /session/:id/command` — BUG-188 (FEAT-16.2, 1.15.1).
- Frontmatter `SKILL.md` opencode разбирает строгим YAML и молча пропускает скилл, если тот не разобрался (BUG-185: `zai-pptx` пропал после 1.14.9). Значение с `: ` бери в кавычки. Проверяет `tests/skills-frontmatter.test.js`.

Порядок изменения: правка здесь → тест → копия на стенд → `D:\zai-stage\stand.ps1 -RestartOpencode` → `D:\Portal\zai-qa\probes\tenant-sandbox-probe.mjs` → копия в прод → отложенный рестарт задачи `zai-opencode-serve`. Проверка: `opencode debug config`, `oh-my-opencode.js doctor`, `GET :4096/agent`.
Секретов здесь нет и не должно быть: ключи провайдеров — в `~/.local/share/opencode/auth.json`.

Окружение GLM-5.3-Flash (BUG-180 / BUG-11.16, 2026-11-06; аудит `C:\Users\USER\glm-5.3-flash-opencode-report.html`):
- `omo.jsonc`: запасная модель — `glm-5.3-flash` (была `glm-5.2`: в models.dev `deprecated`, opencode 1.19.5 её не видит — `ProviderModelNotFoundError`); `visual-engineering` — первой Flash (зрение).
- `opencode.json`: `provider.zai-coding-plan.whitelist = [glm-5.3, glm-5.3-flash]`; `models.glm-5.3-flash.limit.context = 262144` — автокомпакция Flash ≈ 196K (порог = context − min(output, OUTPUT_TOKEN_MAX)), раньше ≈ 968K и ни одной компакции; `compaction: {auto, prune}`; `instructions` + `prompts/glm-rules.md` (язык ответа, без CJK-вставок, широкий поиск — в explore). Стенд: путь правил — `D:\zai-stage\opencode\config\opencode\prompts\glm-rules.md`.
- `serve.cmd` (и `stand.ps1`): `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=65536` (по умолчанию opencode режет max_tokens до 32000).
- `vault-cache.ts`: (1) хук `chat.params` — OmO ≤ 5.1.62 держит для «glm» лестницу GLM-5.2 (`reasoningEfforts: high|max`, `low → high`), из-за чего каждый `low` (title, explore, librarian, multimodal-looker, quick, явный variant low) уходил в API как `high`; плагин стоит после OmO и возвращает запрошенный эффорт для `zai-coding-plan/glm-5.3*` (лог `effort: … -> low`); (2) страж CJK для write/edit/multiedit/patch (лог `cjk guard blocked|override`).
- Портал 1.14.8: ход на glm-5.3* без `variant` получает `ZAI_GLM_VARIANT` (по умолчанию `max`, `off` — не задавать).
Тесты: `node --test ops/opencode/tests/*.test.mjs` (glm-config, vault-cache-cjk, vault-cache-effort), портал `tests/glm-variant*.test.js`, `tests/hub-recovery.test.js`. Живая проба стенда: `D:\Portal\zai-qa\probes\glm-flash-probe.mjs` — истину о запросе к API даёт логирующий прокси `D:\zai-tmp-scripts\zai-tap-proxy.mjs` (временный `options.baseURL` стенда; после пробы — убрать).

Выкат BUG-180:
1. Стенд (сделано 2026-11-06): `opencode.json` (instructions/external_directory стенда), `vault-cache.ts`, `prompts\glm-rules.md` → `D:\zai-stage\opencode\config\opencode\`, `omo.jsonc` → `D:\zai-stage\home\.omo\`, env в `stand.ps1`; прежние — `D:\zai-stage\rollback\bug180-2026-11-06\`.
2. Прод, одним окном (рестарт обрывает идущие ходы — в тихое время): прежние `opencode.json`, `vault-cache.ts`, `~/.omo/omo.jsonc`, `serve.cmd` → `backup-*`; копии из ops (`opencode.json`, `vault-cache.ts`, `prompts\glm-rules.md` в `C:\Users\USER\.config\opencode\`, `omo.jsonc` в `C:\Users\USER\.omo\`); портал 1.14.8 (server.js, lib/glm-variant.js, lib/config.js, lib/hub.js, сборка фронта) — рестарт `zai-web`; рестарт `zai-opencode-serve` (serve.cmd с новым env).
3. Проверка прода: `opencode models zai-coding-plan` → glm-5.3, glm-5.3-flash; `GET :4096/config/providers` → у Flash `limit.context 262144`, variants low/high/max; `vault-cache.log` → `loaded`, на первом ходе `effort: glm-5.3-flash high -> low (agent title)`; ход «Привет» в портале — ответ; tenant-sandbox-probe / tenant-jail-probe (стенд-версии) зелёные.
4. Откат: файлы из `backup-*`, те же рестарты; портал 1.14.8 со старым конфигом безопасен (variant max = прежнее значение API).

Второй выкат BUG-180 (2026-11-06 вечер, только ops; портал 1.14.8 не меняется):
- `opencode.json`: `oh-my-openagent@5.1.62` (было 5.1.60): исправлены ссылки на несуществующие скиллы, из-за которых OpenCode отклонял весь вызов `task`. Реестр эффортов GLM тот же, хук `chat.params` в vault-cache остаётся. opencode 1.19.5 — последняя версия.
- `omo.jsonc`: runtime_fallback OmO считает текущей моделью `models[0]` агента, а не модель, которую прислал портал. Чат на Flash (дефолт портала) при 429/5xx у Flash «переключался» на ту же Flash и уводил glm-5.3 в cooldown, и ответа не было вообще (стенд: 10 минут). Теперь у primary-агентов (sisyphus, prometheus, atlas) цепочка `glm-5.3 → flash → glm-5.3`, а `cooldown_seconds: 0`. Проверка — симулятор в `tests/glm-config.test.mjs` и живые пробы с инъекцией 429 через прокси.
- Агенты вне списка OmO (Sandbox, Hephaestus - deep worker): fallback OmO к ним не применяется (жёсткий список имён в OmO), opencode сам повторяет запрос на той же модели с растущей паузой — ответ приходит после восстановления (проверено: 60 с 429 → «Рим»).
- Общий сбой обеих моделей: OmO тратит обе попытки за секунду, ход заканчивается пустым, портал показывает «Модель завершила ход без ответа… Повторите запрос» (детектор пустого хода). Известное ограничение.
Выкат: `D:\zai-stage\deploy-oc-5.1.62.ps1` (opencode.json + omo.jsonc → рестарт zai-opencode-serve в тихом окне, проверки, автооткат).

После каждого рестарта `zai-opencode-serve` (BUG-183 / BUG-12.25, 2026-11-07) — проверка MCP: `. ops\deploy\zai-deploy-lib.ps1; $m = Test-ZaiOpencodeMcp; L "$($m.Text)"`. Если `/mcp` экземпляра по умолчанию (cwd задачи serve, `C:\Windows\System32`) отвечает 499 или пусто, функция делает `POST /instance/dispose` и проверяет ещё раз. `$m.Ok` — в условие VERDICT. Портал с 1.14.9+BUG-183 спрашивает `/mcp` для папки чатов пользователя (`directory`) и на отказ отвечает 503 `mcp_unavailable`, а не 499.
