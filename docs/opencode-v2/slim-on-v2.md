# oh-my-opencode-slim 3.0.7 на opencode 2.x

Исследование (только чтение кода/документации, без живого запуска). Дата: 2026-11-07.
Пакет: `oh-my-opencode-slim@3.0.7` (npm), репозиторий: https://github.com/alvinunreal/oh-my-opencode-slim

Источники: unpkg.com (опубликованный тарболл 3.0.7), локальная установка
`C:\Users\USER\.cache\opencode\packages\oh-my-opencode-slim@3.0.7\node_modules\oh-my-opencode-slim\`
(далее «локально»), GitHub-репозиторий по тегу `v3.0.7`.

---

## Версия и метаданные пакета

- `package.json` (unpkg: https://unpkg.com/oh-my-opencode-slim@3.0.7/package.json; совпадает с локальным):
  `"name": "oh-my-opencode-slim"`, `"version": "3.0.7"`, описание —
  «Lightweight agent orchestration plugin for OpenCode - a slimmed-down fork of oh-my-opencode».
- **Runtime-зависимости от plugin/SDK (поле `dependencies`)** — пиннуты точно:
  - `"@opencode-ai/plugin": "1.18.32"` — плагин-пакет **линии v1** (у него есть сабпасы `./tool`, `./tui`, `./v2/effect`, `./v2/promise`; unpkg: https://unpkg.com/@opencode-ai/plugin@1.18.32/package.json);
  - `"@opencode-ai/sdk": "1.18.32"`.
  - `@opencode/plugin` (новый скоуп линии 2.x, репо `anomalyco/opencode`, версия 2.2.0 — https://unpkg.com/@opencode/plugin@2.2.0/package.json) в `dependencies` **отсутствует**; он есть только в `devDependencies` (`"@opencode/plugin": "2.2.0"`, `"@opencode/client": "2.2.0"`).
  - `peerDependencies`: только `zod`.
- Экспорты: `"."` → `dist/index.js` (главный вход), `"./server"` → `dist/server/index.js` (v2 server-вход), `"./tui"` → `dist/tui2.js` (v2 TUI-вход), `"./marketplace-contract"`.
- В `files` входят `dist`, `src/skills`, схемы и README; каталога `docs/` в npm-тарболле нет — документация совместимости берётся из GitHub.
- **Локальная установка = опубликованной**: `sha256(dist/index.js)` локально и по `curl https://unpkg.com/oh-my-opencode-slim@3.0.7/dist/index.js` совпадают (`47ec8c7070c648c8860ab4becfb2391257cf833957c4b56ccf3cbaad5e6f5052`, 1 674 561 байт). Структура `dist/` (index.js, tui.js, tui2.js, server/, v2/, chunks/) тоже совпадает.
  (Глоб-инструменты к локальному каталогу были заблокированы permissions — сверка сделана через bash: `ls`, `node -e require(package.json)`, `sha256sum`.)

## Заявленная поддержка версий opencode (README/repo)

- **README в пакете** (unpkg: https://unpkg.com/oh-my-opencode-slim@3.0.7/README.md) различает v1 и v2 как оба поддерживаемых варианта хоста, без объявления одной «основной» версии:
  - «On OpenCode v2, use `opencode models` instead» (шаг `opencode models --refresh`);
  - «On OpenCode v2 hosts, panes work with the shared background service or an explicit `--server`; `--standalone` hosts cannot host panes … use v2's native subagent surfaces instead»;
  - «On v2, `/preset` lets you apply … Current session or … Global default» и «On v1, reload OpenCode after applying a preset»;
  - «v2 walks to the filesystem root; v1 stops at the Git worktree boundary» (наследование проектных конфигов);
  - «On OpenCode v2 hosts this needs one extra hop of nesting … set `"experimental": { "subagent_depth": 2 }`».
- **Выделенный документ совместимости** — `docs/opencode-v2-compatibility.md` в репо, по тегу **v3.0.7**:
  https://github.com/alvinunreal/oh-my-opencode-slim/blob/v3.0.7/docs/opencode-v2-compatibility.md
  - «oh-my-opencode-slim installs and runs on **both** OpenCode v1 (`opencode`) and OpenCode v2 (`opencode2`) from a single published package»;
  - «The plugin requires OpenCode **v2.0.7+** on v2 hosts; older v2 hosts are unsupported» (базис работы — v3.0.5 пакета, живая проверка — «historical live host verification on OpenCode v2.0.7»);
  - «source-checked against OpenCode v2.0.18 and v2.0.32; they do not represent a new live-host certification» (права shell/MCP);
  - «Verified live on OpenCode v2 (all bridges green — health check `bridges:11`, +1 on hosts that accept the `session.model.request` hook name …)»;
  - контракт v2 фиксирован «compile-time mirror guard … pinned to `@opencode/plugin` 2.2.0».
- **Релиз v3.0.7** (https://github.com/alvinunreal/oh-my-opencode-slim/releases/tag/v3.0.7, 2026-11-04) содержит множество v2-PR: `fix(v2): sync live session model into the sidebar` (#1664), `feat(v2): server-side /preset command` (#1691), `feat(v2): /preset <name> binds the current session` (#1703), `fix(v2): enforce tool permissions, keep child variants and profiles, open /subagent` (#1776), `fix(cli): align install, doctor and skill migration with v1 and v2` (#1766) и др. — v2-поддержка развивается в самом этом релизе.
- **Issues**: поиск `is:issue is:open v2` по репо даёт 13 открытых, среди них прямо про работу на v2: [#1822](https://github.com/alvinunreal/oh-my-opencode-slim/issues/1822) «[Bug]: v2 resumed background child strands admission before terminal-gate reconciliation (3.0.7)», [#1759](https://github.com/alvinunreal/oh-my-opencode-slim/issues/1759) «bug(companion): window survives OpenCode exit on v2». Открытого тикета формата «slim не работает на opencode 2.x вообще» в этой выдаче нет.
- Контекст из задания (у «большого» OmO — code-yeongyu — 2.x не работает: баг #10089, PR #10106/#10905) **не проверялся** — по условию проверялся только slim. Репозитории разные; slim называет себя отдельным форком.

## Как slim грузит плагин (какой пакет, какие хуки, ветвление по версии)

**Точка входа — двойной дефолт-экспорт.** Конец `dist/index.js` (локально, строки 46262–46271; unpkg: https://unpkg.com/oh-my-opencode-slim@3.0.7/dist/index.js):

```js
var src_default = {
  id: "oh-my-opencode-slim",
  server: OhMyOpenCodeLite,   // v1 plugin-фабрика (PluginInput) => Promise<Hooks>
  setup: createV2Setup(),     // v2 promise-plugin setup(ctx) => Promise<cleanup>
};
export { ..., src_default as default };
```

Это ровно та форма, что задокументирована в `docs/opencode-v2-compatibility.md` (раздел «How it works»):

- **Загрузчик v1** («readV1Plugin in `packages/opencode/src/plugin/shared.ts`») видит объект с полем `server` и вызывает `plugin.server(input)` с полным v1 `PluginInput`; лишние ключи (`setup`) на этом пути игнорируются.
- **Загрузчик v2** («`PluginModule` schema in `packages/core/src/plugin/supervisor.ts`») декодирует `default` как `{ id, setup }` и вызывает `setup(ctx)`. Резолвер v2 сначала пробует сабпас `./server` (`subpaths: ["server", ""]`) → `dist/server/index.js`; TUI-рунтайм v2 отдельно грузит `./tui` → `dist/tui2.js`.
- **Регистрация на v2** (там же, раздел «Installing on v2»): в `~/.config/opencode/opencode.json` добавить `"plugin": ["oh-my-opencode-slim@<exact-version>"]` — версия **точно пиннится**, потому что «v2 auto-refreshes unpinned npm plugins on every startup». Внутри v2 сам мигрирует ключ `plugin:` в `plugins:`. `~/.config/opencode2/` для конфига плагина не читается.

**Какой plugin-пакет импортируется.** В рантайме — **только `@opencode-ai/plugin`** (v1-линия, пин 1.18.32): все статические импорты в бандле — `import { tool } from "@opencode-ai/plugin"` (например, строки 35952, 36568 бандла) — плюс `@opencode-ai/sdk` для клиента. Поверхность v2-плагина **не импортируется из пакета вовсе**: она «hand-mirrored» в `src/v2/types.ts` и сверяется типами через `src/v2/mirror-conformance.ts` против devDependency `@opencode/plugin@2.2.0` («v1 host must be able to load the main build with no v2 package installed» — docs/opencode-v2-compatibility.md). `@opencode/plugin` в рантайм-коде бандла не встречается (grep по `dist/index.js` находит его только в строках встроенной копии package.json).

**Ветвление по версии хоста есть и оно обширное.** v2-адаптер (`src/v2/setup.ts`, в бандле `createV2Setup`) строит из v2-контекста v1-образный `PluginInput` через client-shim и помечает его: «The shim marks the input `hostFlavor: 'v2'`» (docs/opencode-v2-compatibility.md, раздел «The v2 adapter»). Дальше вся фабрика ветвится по `hostFlavor` — в `dist/index.js` больше 100 вхождений `hostFlavor === "v2"`, например:

- параметр делегирования: `function controlParamName(hostFlavor) { return hostFlavor === "v2" ? "sessionID" : "task_id"; }` (строка 18984);
- словарь промптов: `delegationVocabulary(hostFlavor)` (18987);
- состав тулов/прав: `applyDefaultPermissions(..., hostFlavor, ...)` (19861) и `minimumExpectedToolCount(..., hostFlavor, ...)` (21670).

Внутри setup на v2 мосты v1-хуков в v2-регистрации (цитаты из docs/opencode-v2-compatibility.md):

- `agent` → `ctx.agent.transform`; `tool` → `ctx.tool.transform` (каждый тул получает `options: {codemode: false}`); `mcp` → `ctx.mcp.transform` (**обязателен**: «a host without `ctx.mcp.transform` is unsupported and setup fails»); `command` → `ctx.command.transform`;
- сессионные хуки `ctx.session.hook("context")`, `hook("prompt")`, `hook("model.request")`, `hook("compaction")` — регистрируются безусловно, отказ хоста = падение setup;
- `tool.execute.before/after` → `ctx.tool.hook` (`createToolExecuteBridges`, нормализация `subagent`→`task`);
- `event` → `ctx.event.subscribe()` + `mapV2EventToV1` (аддитивный синтез v1-форм событий);
- всё, что хост не дал (capability probing: `s.switchModel`, `ctx.generate`, …), деградирует одной фичей с логом, а не ломает загрузку.

**Хуки v1, которые вертит фабрика** (grep по локальному `dist/index.js`): `"chat.message"` (45995), `"chat.headers"` (45978; определение 24036), `"tool.execute.before"` (45948), `"tool.execute.after"` (46248), `"command.execute.before"` (45962), `"experimental.session.compacting"` (45983), `event` (45744), плюс `config()`-хук для агентов/слэш-команд и `dispose` (шаги 3 и «dispose → returned cleanup» в доке).

## Совместимость с 2.x: вывод и ограничения

**Вердикт: да — поддержка opencode 2.x заявлена явно и кодом.** Это не «случайно работает»: отдельный документ совместимости в теге v3.0.7 говорит «runs on both … from a single published package», задаёт нижнюю границу **v2.0.7** (старее — «unsupported»), v2-загрузка идёт через `setup(ctx)` из `./server`-сабпаса, релиз 3.0.7 наполнен `fix(v2)`/`feat(v2)`-PR, а в выдаче открытых issues нет тикета «на 2.x не грузится». Позиционирование противоположное «большому» OmO из контекста задания — здесь v2 не просто «работает», а является целевой поверхностью для части функций (`/preset` с скоупом сессии, нативные субагенты).

**Ограничения на v2** (feature matrix из docs/opencode-v2-compatibility.md, тег v3.0.7):

- `task_revive`, `task_message`, `wait_for_user` — **только v1**; на v2 удержание сессий — через нативный `subagent(sessionID, prompt)`, блокирующий ввод — через нативный `question`/Form;
- Foreground model fallback: «⚠️ replay disabled; retry-hook steering active» — автореплей упавшего хода на v2 отключён (неатомарный `session.switchModel`);
- Orchestrator-wake scheduler: «❌ not created» на v2 (первый результат доставляет нативный нотификатор);
- Companion-приложение на v2: «⚠️ unverified» у авторов; открытый баг [#1759](https://github.com/alvinunreal/oh-my-opencode-slim/issues/1759) как раз про v2;
- Multiplexer на v2: поддерживаются shared background service и `--server`; `--standalone` — fail-closed без панелей;
- `permission.assert` существует с **v2.0.29**: на более старых v2 хостах per-call `ask` только логируется, не принуждается;
- требуется `ctx.mcp.transform` (есть во всех стабильных v2.0.x, иначе setup падает);
- навыки на v2 регистрируются in-process (`ctx.skill` + `add`), на v1 — путями в дисковый сканер;
- `/goal` на v2.2.1+ принадлежит хосту (slim убрал свой `/loop`);
- открытый баг [#1822](https://github.com/alvinunreal/oh-my-opencode-slim/issues/1822): на 3.0.7 возобновлённый v2-background-child может «зависнуть» до терминальной сверки — известная незакрытая шероховатость именно на v2.

Чего в источниках **нет**: нижней границы вида «протестировано на 2.2.x» (живой сертификации свежих 2.x нет — только source-check против v2.0.18/v2.0.32 и контрактное зеркало против `@opencode/plugin` 2.2.0; «live-host smoke baseline» — v2.0.7). Отдельно: как slim ведёт себя на конкретно *нашем* билде 2.x — не проверено (по условию живой запуск запрещён).

## Что проверить живым экспериментом позже

1. Установка на наш opencode 2.x: `"plugin": ["oh-my-opencode-slim@3.0.7"]` (точная версия, не `@latest` — v2 автообновляет unpinned npm-плагины) и проверка загрузки командой из документации: `opencode2 run "list your specialist agents" --standalone`.
2. Health check в логах: строки вида «bridges: 11» (или 12, если хост принимает `session.model.request`) и отсутствие `[v2] … failed`.
3. Воспроизводимость открытого бага #1822 (v2 resumed background child) на нашем сценарии фоновых субагентов.
4. Компаньон на v2 (авторы сами пометили «unverified») — если он нам нужен.
5. Поведение `task_reply`/вопросов на v2: по документу Form-flow синтезируется, но `task_reply` «must honestly reject v2 form-question replies» — проверить UX на практике.
6. Не конфликтует ли in-process регистрация skills на v2 с нашими локальными скиллами в `~/.config/opencode/skills/` (переопределение по имени).

---

### Приложение: как искали

- Код загрузки: скачан полный `dist/index.js` (1.67 МБ) с unpkg, grep по `@opencode-ai/plugin`, `@opencode/plugin`, `import(`, `hostFlavor`, `export default`, именам хуков; конец файла сверён с документом «How it works».
- Динамические импорты внутри бандла — только внутренние чанки (`./chunks/...`), ни одного условного `import("@opencode/plugin")` — не найдено.
- Документ совместимости в npm-тарболле отсутствует (нет в `files`), взят с GitHub по тегу v3.0.7; README — из тарболла.
- GitHub: release notes v3.0.7 и API-поиск issues (`is:issue is:open v2`, 13 результатов).
