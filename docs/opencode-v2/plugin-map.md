# Карта переноса vault-cache.ts на plugin-API opencode 2.x

Дата: 2026-11-07. Пакет: `@opencode/plugin` **2.2.6** (последняя 2.x на unpkg на момент исследования).
Исходник: `ops/opencode/vault-cache.ts` (opencode 1.x, пакет `@opencode-ai/plugin`).

Главный вывод: **V1-код плагина в V2 не запускается вообще** — «V1 plugin implementations do not run in V2. Moving a file or renaming its config entry is not enough» (https://opencode.ai/docs/build/plugins/migrate-v1). Нужна портированная реализация: точка входа `Plugin.define({ id, setup })`, хуки регистрируются в `setup` через домены (`ctx.tool.hook(...)`, `ctx.session.hook(...)`, `ctx.event.subscribe()`).

Все хуки vault-cache.ts имеют аналог в 2.x, но у большинства изменилась семантика. Полных «нет аналога» среди хуков нет; две механики (metadata на part для снапшота, источник variant для effort) прямого эквивалента в сигнатурах не имеют — см. разделы особых пунктов.

---

## Часть 1. Что использует vault-cache.ts (opencode 1.x)

Точка входа: `export default (async ({ client }: PluginInput) => { … return { хуки } }) satisfies Plugin` (vault-cache.ts:45, 1064–1402). Плагин — функция, получающая `{ client }` и возвращающая объект хуков по строковым ключам.

### Хуки

| Хук 1.x | Строки | Что делает наш код |
|---|---|---|
| `chat.message` | 1152–1213 | (а) BUG-146: первое сообщение корневой сессии открывает «ход» для undo (`turns` map + `undoStartTurn`, 1156–1169); (б) снапшот базы знаний: фильтр внутренних агентов (`INTERNAL_AGENTS` = title/summary/compaction, 1172–1173), `getSession` + проверка корневой сессии (1175–1176), проверка «первое ли это сообщение» по истории (1188–1192), `zoneOf` + `buildSnapshot` (1194–1196), запись снапшота в `textPart.metadata.kbContext` текстовой части пользователя — текст не меняется (FEAT-01.32, 1208) |
| `experimental.chat.messages.transform` | 1215–1229 | То, что видит МОДЕЛЬ: для user-частей `withKbContext` — снапшот из metadata подставляется перед текстом («снапшот --- текст», 1222, утилита 350–355); для assistant-частей `unjailPart` — заключённая в jail bash-команда показывается модели как введённая (1224, утилиты 899–922) |
| `chat.params` | 1231–1244 | BUG-180: исправление reasoning effort GLM-5.3*: `glmEffort(input)` (574–581) смотрит `input.model.providerID/modelID`, `input.agent`, `input.message.model.variant`; пишет `output.options.reasoningEffort` (1236–1240). Рассчитан на порядок плагинов: выполняется после chat.params OmO и восстанавливает запрошенный effort (low/high/max) |
| `experimental.chat.system.transform` | 1246–1264 | Только для тенантов: `effectiveZone` (1249), `stripAdminRules` — вырезание admin-блока «Instructions from: …/_index.md» из `output.system` (1251, утилита 459–473), добавление правил зоны тенанта (1252) и строки про рабочую папку чата (1254–1259) |
| `tool.execute.before` | 1266–1338 | Центральный хук песочницы: (1) fail-closed: зона сессии не определена → `throw` (1281–1285); (2) FEAT-04.12: `pointToChat` — относительные пути → рабочая папка чата (1276–1277, утилита 110–116); (3) `sandboxViolation` — allowlist инструментов, realpath-проверка путей, запрет записи в конфиги агента, проверка URL вебфотча (1278, утилиты 701–753); (4) `forbiddenPaths` — пути вне зоны vault (1279, утилита 479–501); блокировка = **`throw new Error("Доступ запрещён: …")`** (1286–1295); (5) FEAT-04.9: jail bash — `splitCd` (1304), `renderCommand`/`jailCommand` (1306), при ошибке `throw` (1310–1313), иначе **подмена аргумента** `output.args.command = jailed.command` (1318) + `blockPlants` до вызова (1319); (6) BUG-180: CJK-страж записи — `cjkGuard`, блокировка `throw` (1322–1331, утилиты 584–640); (7) BUG-146: `backupForTool` — бэкап файлов хода перед правкой (1332–1337, утилиты 1125–1147) |
| `tool.execute.after` | 1340–1353 | После bash тенанта: `blockPlants` («after») — карантин подсаженных конфигов агента (1347, утилиты 828–896); найденное дописывается в `output.output` строкой «[песочница] …» (1348–1349) |
| `event` | 1355–1381 | Только `session.idle` (1357): BUG-146 `undoSeal` — фиксация результата хода (1363–1364); дайджест: `enqueue` по сессии (1369–1377) → `getSession` + `getMessages` + `isPrimary` + `extractDigest` + `writeDigest` (359–453) |
| `experimental.session.compacting` | 1383–1400 | При компакции: `getSession` + `zoneOf`, если дайджест сессии существует — в `output.context.push(...)` ссылка на файл дайджеста и правила сохранения ссылок на заметки (1392–1396) |

### Клиентские вызовы к opencode из плагина

| Вызов | Строки | Что делает |
|---|---|---|
| `client.session.get({ path: { id } })` | 223–231 (`getSession`) | Данные сессии: `directory`, `parentID`, `title` — основа зон тенантов и фильтра субагентов; кэш в `zones` map (1067–1077) |
| `client.session.messages({ path: { id } })` | 235–243 (`getMessages`) | История сообщений: фильтр «первого сообщения» в `chat.message`, определение текущего хода (`currentTurn`, 1113–1123), извлечение дайджеста (`extractDigest`), `isPrimary` (246–252: `parentID` + agent первого user-сообщения) |

Внутри хуков `sessionID` берётся из `input.sessionID` (tool.execute.before/after, system.transform, compacting) или `input.sessionID` события `chat.message`; agent — из `output.message.agent ?? input.agent` (1158, 1172). `event`-хук берёт `sessionID` из `event.properties.sessionID` (1358).

Чтение/запись файлов — напрямую `node:fs`/`node:fs/promises` (vault, users.json, turn-undo, лог), стейт плагина — in-memory (`injected`, `zones`, `turns`, `queues`, `cjkOverrides`); API стейта плагина opencode не используется.

---

## Часть 2. Эквиваленты в `@opencode/plugin` 2.x

### Формат плагина и хуков (общая механика)

Точка входа 2.x — объект с `id` и `setup` (https://unpkg.com/@opencode/plugin@2.2.6/dist/promise/plugin.d.ts):

```ts
export interface Plugin {
    readonly id: string;
    readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void;
}
export declare function define(plugin: Plugin): Plugin;
```

Хуки регистрируются в `setup` через домены. Тип регистрации (https://unpkg.com/@opencode/plugin@2.2.6/dist/promise/registration.d.ts):

```ts
export type Hooks<Spec> = <Name extends keyof Spec>(name: Name, callback: (input: Spec[Name]) => Promise<void> | void) => Promise<Registration>;
export type Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>;
```

«The callback receives one mutable event instead of separate `input` and `output` objects» (https://opencode.ai/docs/build/plugins/migrate-v1). Хуки одного домена выполняются в порядке плагинов: «Multiple plugins can register the same hook. OpenCode runs them in plugin order, so later hooks see changes made by earlier hooks» (https://opencode.ai/docs/build/plugins/server, раздел Hooks).

### Главная таблица соответствий

| 1.x (vault-cache.ts) | 2.x | Сигнатура 2.x (источник) | Статус | Примечание о переносе |
|---|---|---|---|---|
| `chat.message` (1152–1213) | `ctx.session.hook("prompt", …)` | `readonly prompt: SessionPrompt` — `{ readonly sessionID; readonly messageID; prompt: DeepMutable<PromptInput.Prompt>; metadata?: Record<string, unknown>; delivery }` (dist/promise/session.d.ts, `SessionHooks`/`SessionPrompt`) | **изменилась семантика** | Официальная таблица миграции: `chat.message` → `ctx.session.hook("prompt", …)`. Но prompt-хук — «prompt admission» ДО персистентной записи: «Edits become the canonical persisted user input», «The hook runs once during admission, not before every model call». Снапшот теперь кладётся в `event.metadata` (admission metadata) или прямо в `event.prompt.text`; фильтр `INTERNAL_AGENTS` и «первое ли сообщение» частично не нужен: «Synthetic messages, shell messages, compaction controls, and move controls do not run the hook», а title-генерация — отдельный хук. Подстановка «модель видит снапшот, хранится текст» — через `context`-хук, как сейчас делает `messages.transform`. Сохраняется ли `metadata` на part сообщения для `kbContext` — **не проверено** (в доках не сказано прямо) |
| `experimental.chat.messages.transform` (1215–1229) | `ctx.session.hook("context", …)`, правка `event.messages` | `messages: Array<Message>` (mutable) в `SessionRequest` (dist/promise/session.d.ts) | **изменилась семантика** | Отдельного хука нет — миграция в `context`: «`experimental.chat.messages.transform` → `ctx.session.hook("context", ...)` and edit `event.messages`» (migrate-v1). `withKbContext`/`unjailPart` переносятся сюда; точная структура `Message`/parts 2.x (тип `Message` из `@opencode/ai/effect`) — **не вычитана, не проверено** |
| `chat.params` (1231–1244) | `ctx.session.hook("context", …)`, правка `event.options` | `options: SessionRequestOptions` = `DeepMutable<GenerationOptionsFields> & Record<string, unknown>` (dist/promise/session.d.ts) | **изменилась семантика** | Официально: `chat.params` → `ctx.session.hook("context", ...)`. Провайдерские опции передаются семантическими именами: «For example, OpenAI Responses uses `reasoningEffort`» — пример в доках прямо пишет `event.options.reasoningEffort = "high"` с опцией `{ providerID: "openai" }` (https://opencode.ai/docs/build/plugins/server). Ключевое отличие: «`options` starts empty for each model call; it does not contain resolved model settings» — текущее значение effort (как в 1.x `output.options.reasoningEffort`) прочитать нельзя. Источник желаемого variant (`input.message.model.variant` в 1.x) в событии отсутствует — `SessionContext.model` это `Model.Ref` (`providerID`, `id`) без variant; обход — `ctx.session.get({ sessionID })` (в `Session.Info` есть `model.variant`) или собственный стейт. Не проверено на стенде |
| `experimental.chat.system.transform` (1246–1264) | `ctx.session.hook("context", …)`, правка `event.system` | `system: Array<SystemPart>` (mutable) в `SessionRequest` | **изменилась семантика** | Официально: → `ctx.session.hook("context", ...)` and edit `event.system` (migrate-v1); пример: `event.system.push({ type: "text", text: "Focus on correctness." })`. Бонус: «The `system` part … lists each source in `metadata.experimental.instructions` as `{ key, text }` … so a hook can tell the sources apart» — `stripAdminRules` можно переписать на различение источников вместо регэкспов по путям. Но `context` выполняется перед КАЖДЫМ запросом agent-loop, а 1.x-хук — тоже на каждый запрос; для остальных kinds (`compaction`/`title`/`generate`) надо регистрировать отдельно: «Register `context`, `compaction`, `generate`, and `title` separately if a transformation must apply to every model request kind» |
| `tool.execute.before` (1266–1338) | `ctx.tool.hook("execute.before", …)` | `readonly "execute.before": { tool: string; readonly sessionID: Session.ID; readonly agent: Agent.ID; readonly messageID: SessionMessage.ID; readonly id: Tool.CallID; input: unknown }` (dist/promise/tool.d.ts, `ToolHooks`) | **есть аналог** | Официальная таблица: `tool.execute.before` → `ctx.tool.hook("execute.before", ...)`. Блокировка — `throw` (подтверждено примером миграции, см. особый пункт 1). Переписывание аргументов (jail, `pointToChat`) остаётся: `input` и `tool` в событии мутабельны. Бонусы: `agent` и `messageID` теперь приходят в событии напрямую (в 1.x messageID для turn-undo приходилось вычислять через историю, 1113–1123). `sandboxViolation`/`forbiddenPaths`/`cjkGuard`/`backupForTool` переносятся как есть, только меняется доступ к аргументам (`event.input` вместо `output.args`) |
| `tool.execute.after` (1340–1353) | `ctx.tool.hook("execute.after", …)` | `readonly "execute.after": { readonly tool; readonly sessionID; readonly agent; readonly messageID; readonly id; readonly input } & ({ readonly status: "completed"; result: Tool.Result } \| { readonly status: "error"; error: Tool.Error })` (dist/promise/tool.d.ts) | **есть аналог** (форма результата другая) | Официальная таблица: `tool.execute.after` → `ctx.tool.hook("execute.after", ...)`. Отличия: вместо одного `output.output` — ветка `status: "completed" \| "error"`; `result: Tool.Result` мутабелен («if (event.status === "completed") event.result = { … }» — пример в https://opencode.ai/docs/build/plugins/server). Дописывание строки «[песочница] …» в вывод bash теперь требует правки `result` (структура `Tool.Result` из `@opencode/schema/tool` — не вычитана детально). `blockPlants("after")` переносится без изменений |
| `event` → `session.idle` (1355–1381) | `ctx.event.subscribe()` | `readonly subscribe: <Type>(options?: SubscribeOptions<Type>) => AsyncIterable<SelectedEvent<OpenCodeEvent, Type>>` (dist/promise/event.d.ts, `EventDomain`) | **есть аналог** | Официальная таблица: `event` → `ctx.event.subscribe()`. Пример миграции прямо с `session.idle`: `for await (const event of ctx.event.subscribe({ signal })) { if (event.type === "session.idle") … }` (migrate-v1). Подписка — async-итератор, гасится через cleanup `setup`. Логика дайджеста и `undoSeal` переносится как есть. Альтернатива: `ctx.session.hook("experimental.idle", …)` — richer событие `{ sessionID, background }` до ухода сессии в idle (dist/promise/session.d.ts, `SessionIdle`) — экспериментальное, семантика шире (не запускается после прерывания/ручной компакции) |
| `experimental.session.compacting` (1383–1400) | `ctx.session.hook("compaction", …)` | `readonly compaction: SessionCompaction` = `SessionContext & { result?: SessionCompactionResult }` (dist/promise/session.d.ts) | **изменилась семантика** | Официальная таблица: → `ctx.session.hook("compaction", ...)`. В 1.x контекстная строка клалась в `output.context`; в 2.x такого поля нет — `SessionCompaction` наследует `system`/`messages`/`options`, ссылка на дайджест добавляется в `event.system.push({ type: "text", text: … })`. Новое: можно подставить готовый `result: { summary, … }` и пропустить запрос модели. «`compaction` runs for checkpoint summaries. `messages` is the transcript being summarized; OpenCode appends its summary prompt after hooks run» |
| `client.session.get({ path: { id } })` (223–231) | `ctx.session.get({ sessionID })` | `get(input: SessionGetInput): Promise<SessionInfo>` (dist/promise/session.d.ts, `SessionDomain = Pick<SessionApi, …>`; пример `ctx.session.get({ sessionID })` в https://opencode.ai/docs/build/plugins/server) | **изменилась семантика** | Форма входа `{ path: { id } }` → `{ sessionID }`. В ответе 2.x (`Session.Info`, https://unpkg.com/@opencode/schema@2.2.6/dist/session.d.ts) нет top-level `directory` — он в `location: { directory, workspaceID }`; `parentID`, `title`, `model` (с `variant`), `agent` — есть. `zoneOf` должен читать `s.location.directory` вместо `s.directory`. Форма ответа (обёртка `.data` из 1.x) — не проверена |
| `client.session.messages({ path: { id } })` (235–243) | `ctx.session.context({ sessionID })` | `context(input: SessionContextInput, …): Promise<readonly SessionMessageInfo[]>` (dist/promise/session.d.ts; пример в доках сервера) | **изменилась семантика** | Другой метод и, вероятно, другая форма элементов (`SessionMessageInfo` — не вычитана). Нужен для: проверка «первое сообщение» (если останется нужной), `currentTurn` (частично заменяется `messageID` из событий), `extractDigest`, `isPrimary`. Точная структура — не проверено |
| Точка входа: `export default async ({ client }) => ({ хуки })` (1064–1402), `import type { Plugin, PluginInput } from "@opencode-ai/plugin"` (45) | `export default Plugin.define({ id, async setup(ctx) { … } })`, `import { Plugin } from "@opencode/plugin"` | `Plugin`/`define` из dist/promise/plugin.d.ts; пример в https://opencode.ai/docs/build/plugins | **изменилась семантика** | V1-реализация в V2 не выполняется. `client` из `PluginInput` исчез — контекст сам является клиентом («The V2 context is both an OpenCode client and the plugin API»). Инициализация (лог «loaded», кэши) — в `setup`; `Cleanup` вместо `dispose` |

### Хуки 1.x, которых у нас нет и в 2.x не искали
`chat.headers`, `permission.ask`, `command.execute.before`, `shell.env`, `tool.definition`, `config`, `provider`, `auth` — vault-cache.ts их не использует; карта на них не распространяется.

---

## Особый пункт 1. Блокировка вызова инструмента ДО выполнения (песочница тенантов) — критично

**1.x**: `tool.execute.before` блокирует вызов через `throw new Error("Доступ запрещён: …")` (vault-cache.ts:1284, 1288, 1292, 1312, 1329); fail-closed при неизвестной зоне — тоже `throw` (1284).

**2.x**: тот же механизм. Официальный пример миграции переносит блокирующий V1-хук в V2 один в один (https://opencode.ai/docs/build/plugins/migrate-v1):

```ts
await ctx.tool.hook("execute.before", (event) => {
  const input = event.input as { filePath?: string }
  if (event.tool === "read" && input.filePath?.includes(".env")) {
    throw new Error("Do not read .env files")
  }
})
```

Дополнительное подтверждение, что ошибка доходит до модели: «A deny rule or a rejection with feedback rejects with a `Tool.Error` that carries the reason, so the model sees it and continues» (https://opencode.ai/docs/build/plugins/server, раздел Permissions — о том же механизме ошибок инструментов).

Ключевые факты для песочницы (dist/promise/tool.d.ts, `ToolHooks`):

```ts
readonly "execute.before": {
    tool: string;                    // мутабельно
    readonly sessionID: Session.ID;
    readonly agent: Agent.ID;        // агент приходит напрямую
    readonly messageID: SessionMessage.ID;
    readonly id: Tool.CallID;
    input: unknown;                  // мутабельно
};
```

- Блокировка: `throw` из колбэка — инструмент не выполняется. **Есть прямой аналог 1.x-семантики.**
- Подмена аргументов (jail bash, `pointToChat`): `input` мутабелен — перезапись команды остаётся возможной; `tool` тоже мутабелен (нам не нужен).
- `sessionID`, `agent`, `messageID` в событии — снимает нужду 1.x-обходов: messageID для turn-undo больше не надо доставать из истории (`currentTurn`, 1113–1123), agent — из сообщений.
- Отдельный хук `ctx.shell.hook("create.before", …)` (`{ command, cwd, timeout, shell, env }`, docs/build/plugins/server) существует, но его отношение к инструменту `bash` (vs нативному shell opencode) — **не проверено**; jail остаётся в `execute.before`.

## Особый пункт 2. Подмена параметров запроса к модели (effort / chat.params)

**2.x**: `ctx.session.hook("context", (event) => { event.options.reasoningEffort = "low" }, { providerID: "zai-coding-plan" })`.

Прямой пример из доков (https://opencode.ai/docs/build/plugins/server, Provider options):

```ts
await ctx.session.hook(
  "context",
  (event) => { event.options.reasoningEffort = "high" },
  { providerID: "openai" },
)
```

Правила опций (там же): «`options` starts empty for each model call; it does not contain resolved model settings»; «Typed keys are generation settings; any other key is passed to the selected protocol as a provider option»; «Hooks run in registration order and see overrides made by earlier hooks» (порядок плагинов сохраняется — зависимость «после OmO» воспроизводима, если OmO в 2.x тоже пишет в `context`).

Изменения относительно 1.x:
- нельзя прочитать текущее значение (`output.options.reasoningEffort` в 1.x) — options стартует пустым; лог «старое → новое» теряет «старое»;
- источника `input.message.model.variant` в событии нет (`SessionContext.model` = `Model.Ref { providerID, id }`; в событии есть `agent`, который 1.x брал так же). Обход: желаемый effort определять из `event.agent` + `event.model` + `ctx.session.get` (`Session.Info.model.variant`, проверено в @opencode/schema@2.2.6/dist/session.d.ts) — **схема не проверена на стенде**;
- title-агент (`LOW_EFFORT_AGENTS = {"title"}`): в 2.x у title-генерации отдельный хук `ctx.session.hook("title", …)` с `result?: string` и своими `options` — low effort для title задаётся там отдельно.

## Особый пункт 3. Системный промпт и сообщения

**2.x**: оба 1.x-хука (`experimental.chat.system.transform`, `experimental.chat.messages.transform`) сливаются в `ctx.session.hook("context", …)`: `event.system: Array<SystemPart>` и `event.messages: Array<Message>` мутабельны (dist/promise/session.d.ts, `SessionRequest`). «Modify assembled system instructions, messages, tools, or request options immediately before model dispatch» (docs/build/plugins/server). Пример:

```ts
await ctx.session.hook("context", (event) => {
  event.system.push({ type: "text", text: "Focus on correctness." })
  delete event.tools.write
  event.options.temperature = 0.2
})
```

- «Changes affect only the outgoing model call, not persisted history or configuration» — ровно наша модель FEAT-01.32 (хранимое не трогаем, модель видит снапшот).
- Источники инструкций различимы: `metadata.experimental.instructions` на system-part содержит `{ key, text }` каждого источника — `stripAdminRules` можно переписать точнее, чем регэкспами по «Instructions from:». Список — копия: правка `text` его не обновляет. Пометка «Experimental».
- Для всех kinds запросов надо регистрировать хуки отдельно (`context`, `compaction`, `generate`, `title`) — иначе transform применится только к agent-loop.
- Точная структура `Message`/parts 2.x (нужна для `withKbContext`/`unjailPart`) — **не вычитана** (тип из `@opencode/ai/effect`), помечено как не проверено.

## Особый пункт 4. Сессия и агент внутри хука

- В 2.x `agent` и `messageID` приходят прямо в событиях: `tool.execute.before/after` — `readonly agent: Agent.ID; readonly messageID: SessionMessage.ID` (dist/promise/tool.d.ts); в `context`-хуке — `readonly agent: Agent.ID` (dist/promise/session.d.ts, `SessionContext`). В 1.x agent доставался из `output.message.agent ?? input.agent` или из истории.
- `sessionID` — в каждом событии (`readonly sessionID`).
- Данные сессии — `ctx.session.get({ sessionID })`: `Session.Info` содержит `parentID` (опционально), `location.directory`, `title`, `agent`, `model.variant`, `metadata` (@opencode/schema@2.2.6/dist/session.d.ts). Значит `zoneForSession`/`effectiveZone`/`rootSession` переносятся, но: `s.directory` → `s.location.directory`; API-ответ может отличаться формой от схемы — **не проверено на живом клиенте**.
- История сообщений — `ctx.session.context({ sessionID })` (docs/build/plugins/server: «The messages = await ctx.session.context({ sessionID })»). Для `extractDigest`/`isPrimary` — структура `SessionMessageInfo` **не проверена**.

---

## Регистрация и загрузка плагина в 2.x

Источник: https://opencode.ai/docs/plugins и https://opencode.ai/docs/build/plugins (+ migrate-v1).

- Поле конфига переименовано: **`plugin` → `plugins`** (migrate-v1: «Rename `plugin` to `plugins`»). Элементы: имя пакета (с версией/диапазоном), локальный путь, `{ "package": …, "options": { … } }`. Опции читаются в `ctx.options` (`PluginOptions = Readonly<Record<string, any>>`, dist/options.d.ts).
- **Локальные пути — только директории**: «Configured local paths must name directories… a configured `./plugin/local.ts` file is skipped with a warning in the log» (migrate-v1). Файл `vault-cache.ts`, зарегистрированный в 1.x как путь к файлу, в 2.x так не загрузится — нужен `vault-cache/index.ts` (или авто-дискавери).
- Дискавери: `.opencode/plugins/` проекта (1.x-каталог `.opencode/plugin/` тоже читается, но для V2 использовать `plugins/`), глобальные — `<config dir>/plugins/`. Прямые `.ts`/`.js`-файлы в этих каталогах загружаются (docs/plugins, Discover).
- Экспорт: default export `Plugin.define({ id, setup })`; `id` обязателен и стабильн («Every V2 plugin needs a stable `id`. Plugin storage is scoped by this ID»). Вариант поддержки V1+V2 из одного пакета: `{ ...Plugin.define({…}), async server() { return { V1-хуки } } }` — V1 ветка нужна только для старых 1.x.
- Включение/выключение: префикс `-` и wildcard `*`/`.*` в массиве `plugins` (docs/plugins, Control).
- Релоад: правки в watched-каталогах конфигов перегружаются; `opencode service restart` (docs/plugins, Reload).
- Порядок хуков между плагинами сохраняется: «Hooks run in registration order» — условие «vault-cache после OmO» (vault-cache.ts:566–569) переносимо, **реальный порядок плагинов OmO в 2.x не проверен**.
- Наша защита `OPENCODE_DISABLE_PROJECT_CONFIG=1` (serve.cmd, против подсаженных проектных конфигов) — переменная 1.x; её существование/эффект в 2.x — **не проверено** (плагинный карантин `quarantinePlants` остаётся актуальным независимо).

---

## Что не нашлось / не проверено

- Структура `Message`, `SystemPart`, `Tool.Result` в 2.x (пакеты `@opencode/ai`, `@opencode/schema/tool`) — не вычитана; влияет на точные правки `withKbContext`/`unjailPart`/«[песочница]»-дописывание в `execute.after`.
- Сохраняется ли `metadata` из `session.hook("prompt")` на персистентной части сообщения (ключ `kbContext` для портала) — в доках не сказано; требует стенда.
- Источник `model.variant` внутри `context`-хука — в событии отсутствует; обход через `ctx.session.get` не проверен.
- Форма ответа `ctx.session.get`/`ctx.session.context` на живом сервере (обёртки `.data` из 1.x-клиента) — не проверена.
- `ctx.shell.hook("create.before")` — покрывает ли инструмент `bash` — не проверено.
- Порядок/наличие плагинов OmO в 2.x и живучесть `OPENCODE_DISABLE_PROJECT_CONFIG` в 2.x — не проверено.

## Источники

- Пакет 2.2.6: https://unpkg.com/@opencode/plugin@2.2.6/package.json (version, exports `.` → `dist/promise/index.js`)
- Типы: dist/promise/plugin.d.ts (Plugin, define, Context), dist/promise/registration.d.ts (Hooks/Transform/Registration), dist/promise/tool.d.ts (ToolHooks, ToolDomain), dist/promise/session.d.ts (SessionHooks, SessionRequest/Context/Prompt/Compaction/Idle, SessionDomain), dist/promise/event.d.ts (EventDomain), dist/promise/storage.d.ts (StorageDomain), dist/options.d.ts (PluginOptions) — все по базовому URL https://unpkg.com/@opencode/plugin@2.2.6/
- Схема сессии: https://unpkg.com/@opencode/schema@2.2.6/dist/session.d.ts (Session.Info: parentID, location.directory, model.variant)
- Доки: https://opencode.ai/docs/plugins (конфигурация/дискавери), https://opencode.ai/docs/build/plugins (части пакета, загрузка), https://opencode.ai/docs/build/plugins/migrate-v1 (таблица миграции, примеры блокировки), https://opencode.ai/docs/build/plugins/server (домены, session hooks, provider options, tool hooks)
- Исходник 1.x: `D:\Portal\zai\ops\opencode\vault-cache.ts` (строки в тексте)
