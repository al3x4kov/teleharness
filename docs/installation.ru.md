# Полное руководство по установке

Это руководство описывает настройку **Teleharness** со **всем функционалом** — от мобильного
веб-портала до всех четырёх семейств движков, правой панели MCP/Skills, Git worktrees,
встроенного предпросмотра Office/PPTX, HTTPS/PWA и Web Push, фоновых агентов GitHub,
переживающих перезапуск пайпов Temporal, памяти Obsidian, локального голоса и изоляции пользователей.

> **Хотите сначала посмотреть интерфейс без установки движков?** Запустите `npm run demo` (или
> `npx teleharness` для быстрого локального старта). Вернитесь сюда, когда будете готовы к
> полноценной постоянной установке.

---

## Матрица «возможность → что нужно»

Базовый портал, поиск, Git, просмотр файлов и чаты работают из коробки, как только установлены
Node.js, Git и хотя бы один CLI-движок. Дополнительные подсистемы включаются автоматически при
настройке и аккуратно скрыты, пока не подключены.

| Возможность | Что нужно | Платформы |
|---|---|---|
| **Портал, чаты, файлы, встроенный предпросмотр** (`.pptx`, `.docx`, `.xlsx`, `.csv`, `.pdf`, `.md`, `.html`, код, медиа) | Node.js ≥ 22.5 + 1 CLI-движок | Linux, macOS, Windows |
| **Полнотекстовый поиск, Доска внимания, учёт расходов** | Node.js ≥ 22.5 (встроенный `node:sqlite` FTS5 — без нативной сборки) | Linux, macOS, Windows |
| **Экран Git, мобильное ревью диффов, Git worktrees** | Git ≥ 2.20 в `PATH` | Linux, macOS, Windows |
| **Движок: Claude Code CLI** | `claude` CLI + подписка Anthropic (`claude setup-token` / `claude login`) | Linux, macOS, Windows |
| **Движок: OpenCode 2.x** (любой провайдер + субагенты slim) | `opencode` 2.x (`serve-v2.sh` / `serve-v2.cmd`) + ключ провайдера (`opencode auth login`) | Linux, macOS, Windows |
| **Движок: OpenAI Codex CLI** | `@openai/codex` + подписка ChatGPT (`codex login`) | Linux, macOS, Windows |
| **Движок: агенты ACP** (Gemini CLI, Antigravity, GitHub Copilot CLI) | Установка и вход прямо из **Настройки → Агенты ACP** | Linux, macOS, Windows |
| **Правая панель: MCP-серверы, Скиллы (`SKILL.md`), живой план** | Настроенные MCP / скиллы в OpenCode или `TELEHARNESS_CLAUDE_MCP_CONFIG` | Linux, macOS, Windows |
| **Мобильный PWA, вход по QR, скачивание/Share, Web Push** | HTTPS reverse proxy (Tailscale Serve / Caddy / nginx / `ops/portal-server.js`) + `TELEHARNESS_PUBLIC_URL` | Любые (iOS Safari 16.4+, Android Chrome, десктоп) |
| **Активный кэш Obsidian и журнал переключения движков** | Путь к папке в `TELEHARNESS_KB_ROOT` | Linux, macOS, Windows |
| **Фоновые агенты GitHub** | Fine-grained PAT в **Настройки → Фоновые агенты** (webhook требует HTTPS; polling работает за NAT) | Linux, macOS, Windows |
| **Пайпы Temporal** (переживают перезапуск) | Temporal server + `temporal` CLI + PostgreSQL + Python 3.11+ воркер | Linux, macOS |
| **Локальный голосовой режим (Piper TTS + GigaAM v2 STT)** | Python 3.11+ venv + офлайн-модели (только CPU) | Linux, macOS, Windows |
| **Многопользовательская песочница команд** | Linux per-user runner (`ops/sandbox/linux/`) или Windows AppContainer (`ops/sandbox/`) | Linux, Windows (macOS: shell обычных пользователей запрещён) |
| **Опциональный серверный рендер PDF/Office** | LibreOffice + Playwright Chromium (`ops/render/`) | Linux, Windows |

---

## 1. Базовые требования

1. **Node.js ≥ 22.5** (рекомендуется Node.js 24 LTS).
   У сервера **нет runtime-зависимостей npm** — встроенный `node:sqlite` обеспечивает полнотекстовый
   поиск FTS5, Доску внимания, журнал расходов и триггеры GitHub без нативной компиляции.
2. **Git ≥ 2.20** в `PATH` (нужен для экрана Git, мобильного ревью и изолированных `git worktree`).
3. **Инструменты сборки:** только `npm ci` (для сборки фронта через `esbuild`), компилятор C++ не нужен.

Проверьте версии на сервере:

```bash
node --version    # v22.5.0 или новее (рекомендуется v24.x LTS)
git --version     # 2.20 или новее
```

---

## 2. Установка и сборка портала

Клонируйте релизный тег (`v2.13.1`), поставьте dev-зависимости сборки, соберите фронтенд и создайте `.env`:

```bash
git clone --branch v2.13.1 https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci
TELEHARNESS_BUILD_PROD=1 npm run build
cp .env.example .env
```

В Windows PowerShell:

```powershell
git clone --branch v2.13.1 https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci
$env:TELEHARNESS_BUILD_PROD = "1"; npm run build
Copy-Item .env.example .env
```

> **Важно про булевые флаги в `.env`:** все переключатели принимают `1` (вкл) или `0` (выкл).
> При старте `lib/config.js` проверяет все переменные и при опечатке сразу выводит понятную причину.

---

## 3. Подключение всех движков

Для старта достаточно **одного** движка, но можно подключить все четыре семейства рядом и
переключаться между ними прямо посреди диалога.

### 3.1 Claude Code CLI

1. Установите Claude Code официальным установщиком (<https://docs.anthropic.com/en/docs/claude-code>).
   Нативный установщик кладёт `claude` в `~/.local/bin/claude` (или `%USERPROFILE%\.local\bin\claude.exe`).
2. Войдите по подписке Claude:
   ```bash
   claude setup-token
   ```
   Запишите выданный токен в `.env` как `CLAUDE_CODE_OAUTH_TOKEN=...` (либо один раз войдите интерактивно через `claude`).
3. Полезные опции `.env`:
   - `TELEHARNESS_CLAUDE_BIN=/путь/к/claude` (если бинарник не в `~/.local/bin` и не в `PATH`)
   - `TELEHARNESS_CLAUDE_MCP_CONFIG=/путь/к/claude-mcp.json` (подключает MCP-серверы в админских Claude-чатах)
   - `TELEHARNESS_TITLE_LLM=1` и `TELEHARNESS_TITLE_MODEL=claude-haiku-4-5` (автозаголовки чатов)

### 3.2 OpenCode 2.x (рекомендуемый режим `v2`)

OpenCode даёт доступ к любым провайдерам (Z.ai GLM, OpenRouter, Anthropic, OpenAI, Google, локальные
Ollama/LM Studio), субагентам `oh-my-opencode-slim` и скиллам.

1. Установите **OpenCode 2.x** (<https://opencode.ai>, проверено на `2.2.6`) и подключите провайдеров:
   ```bash
   opencode --version
   opencode auth login
   ```
2. Запускайте OpenCode через встроенный скрипт — он слушает только `127.0.0.1:4196` с HTTP Basic-авторизацией:
   - **Linux / macOS:**
     ```bash
     ./ops/opencode/serve-v2.sh
     ```
   - **Windows:**
     ```cmd
     ops\opencode\serve-v2.cmd
     ```
   При первом запуске `serve-v2` создаст случайный пароль (48 символов, права `0600`) в
   `~/.teleharness/oc2-password`, выставит `OPENCODE_DISABLE_PROJECT_CONFIG=1` (защита от чужих конфигов
   в папках чатов) и поднимет `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=65536`.
3. Запускайте портал парным скриптом `web-v2` — он сам прочитает пароль и включит `TELEHARNESS_OC_API=v2`:
   - **Linux / macOS:** `./ops/web-v2.sh`
   - **Windows:** `ops\web-v2.cmd`
4. **Опционально — скиллы и плагин OpenCode:**
   В `ops/opencode/` лежат готовые скиллы (`teleharness-docx`, `teleharness-pdf`, `teleharness-pptx`,
   `teleharness-xlsx`, `teleharness-html`) и плагин `vault-cache.ts`. Скопируйте нужные скиллы в
   `~/.config/opencode/skills/`, чтобы агенты создавали аккуратные офисные файлы, а вы могли читать
   их `SKILL.md` в правой панели.

### 3.3 OpenAI Codex CLI

1. Установите Codex CLI и войдите по подписке ChatGPT:
   ```bash
   npm install -g @openai/codex
   codex login
   ```
2. Перезапустите Teleharness. Codex обнаружится автоматически после входа.
   Если `codex` лежит вне `PATH`, укажите `TELEHARNESS_CODEX_BIN`; чтобы скрыть движок — `TELEHARNESS_CODEX=off`.

### 3.4 Агенты ACP (Gemini CLI, Google Antigravity, GitHub Copilot CLI)

В Teleharness встроен менеджер **Agent Client Protocol (ACP)** — ручная правка конфигов не нужна:

1. Войдите в портал под учётной записью **администратора**.
2. Откройте **Настройки → Агенты ACP**.
3. Выберите агента из каталога (**Gemini CLI**, **Google Antigravity**, **GitHub Copilot CLI**) и нажмите **Установить**.
4. Нажмите **Войти** и пройдите пошаговый мастер (ссылка OAuth, код Device Flow или API-ключ).
5. После входа модели агента автоматически появятся в выборе моделей рядом с Claude, OpenCode и Codex.

Чтобы полностью отключить ACP, задайте `TELEHARNESS_ACP=off` в `.env`.

---

## 4. Первый запуск и вход администратора

Если используете OpenCode 2.x, запустите оба скрипта (если только Claude/Codex/ACP — достаточно `node server.js`):

```bash
# Терминал 1 (нужен только при использовании OpenCode 2.x)
./ops/opencode/serve-v2.sh

# Терминал 2
./ops/web-v2.sh
```

При первом старте Teleharness создаст `data/users.json` с администратором и запишет токен входа в
**`data/admin-token.txt`**.

1. Откройте <http://127.0.0.1:4170/teleharness/> в браузере.
2. Вставьте токен из `data/admin-token.txt`.
3. Проверьте состояние сервера:
   ```bash
   curl -s http://127.0.0.1:4170/teleharness/healthz
   ```
   В ответе должно быть `"ok":true` и `"version":"2.12.0"`.

---

## 5. HTTPS, мобильный PWA, вход по QR и Web Push

Локально `http://127.0.0.1:4170/teleharness/` работает сразу. Чтобы на телефоне работал **весь
мобильный функционал** (установка PWA на экран «Домой», системный буфер обмена, скачивание через
Web Share, Web Push и микрофон), опубликуйте портал по **HTTPS**.

### Вариант А: Tailscale Serve (самый быстрый для личного доступа)

```bash
tailscale serve --bg 4170
```

Tailscale сам выпустит валидный сертификат Let's Encrypt для `https://<хост>.<tailnet>.ts.net` и
проксирует трафик на `127.0.0.1:4170`.

### Вариант Б: Caddy или nginx

**Caddy (`Caddyfile`):**

```caddy
agents.example.com {
    reverse_proxy 127.0.0.1:4170 {
        flush_interval -1
    }
}
```

**nginx (критично отключить буферизацию для SSE `/teleharness/api/event`):**

```nginx
location /teleharness/ {
    proxy_pass http://127.0.0.1:4170;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    client_max_body_size 512M;
}
```

### Вариант В: встроенный edge-сервер (`ops/portal-server.js`)

Задайте в `.env` пути `TELEHARNESS_TLS_CERT`, `TELEHARNESS_TLS_KEY`, список разрешённых хостов
`TELEHARNESS_EDGE_ALLOWED_HOSTS` и `TELEHARNESS_HTTPS_ONLY=1`, затем запустите `node ops/portal-server.js`.

### Подключение телефона по одному QR-коду

1. Укажите публичный HTTPS-адрес в `.env` (должен оканчиваться на `/teleharness/`):
   ```dotenv
   TELEHARNESS_PUBLIC_URL=https://agents.example.com/teleharness/
   TELEHARNESS_PUSH=1
   TELEHARNESS_PUSH_SUBJECT=https://agents.example.com/teleharness/
   ```
2. Перезапустите Teleharness.
3. На компьютере откройте **Настройки → Подключить телефон** и сгенерируйте одноразовый QR-код.
4. Отсканируйте его камерой телефона — вход выполнится автоматически.
5. **Установите как PWA:**
   - **iOS Safari (16.4+):** кнопка «Поделиться» → **На экран «Домой»** (обязательно для Web Push на iOS).
   - **Android Chrome:** меню `⋮` → **Установить приложение**.
6. Откройте **Настройки → Уведомления** на телефоне и включите **Push-уведомления** (ключи VAPID генерируются автоматически в `data/`).

---

## 6. Правая панель: MCP-серверы, Скиллы и живой план

На десктопе (≥ 1120 px) и на телефоне/планшете (кнопка в шапке чата) правая панель показывает
подключённые **MCP-серверы**, доступные **Скиллы** (по клику открывается полный `SKILL.md`) и живой
**План** шагов агента.

- **MCP для OpenCode:** настраиваются в `~/.config/opencode/opencode.json` в секции `"mcp"`.
- **MCP для Claude Code (только админ):** укажите `TELEHARNESS_CLAUDE_MCP_CONFIG=/путь/к/mcp.json` в `.env`.
- **Видимость обычным пользователям:** тенантам показываются только MCP-серверы и скиллы с префиксом `teleharness-`.
- **Каталог скиллов:** положите папки `<имя-скилла>/SKILL.md` в `~/.config/opencode/skills/` (примеры офисных скиллов лежат в `ops/opencode/skills/`).

---

## 7. Файлы, встроенный предпросмотр Office/PPTX и опциональный LibreOffice

**Работает из коробки в браузере без дополнительного софта:**

- Клик по карточке файла открывает предпросмотр `.pptx` (слайды, заголовки, списки, таблицы, встроенные изображения, заметки докладчика), `.docx`, `.xlsx`/`.xlsm`, `.csv`/`.tsv`, `.pdf`, `.md`, `.html` (в песочнице `iframe`), кода с подсветкой, картинок, аудио и видео.
- В iOS/Android standalone PWA нажатие **Скачать** загружает файл через авторизованный `fetch` и передаёт его в системное меню «Поделиться» / Blob-скачивание.
- Список доступных корней для проектов задаётся через `TELEHARNESS_FILE_ROOTS` в `.env` (через `;`, по умолчанию — домашняя папка).

**Опциональный серверный рендер (`ops/render/`):** нужен только если вы хотите, чтобы агенты
конвертировали HTML/офисные документы в PDF/PNG на сервере. См. [`ops/render/README-linux.md`](../ops/render/README-linux.md) (Linux) или `ops/render/setup-render.ps1` (Windows).

---

## 8. Активный кэш Obsidian (память агентов и журнал переключений)

Укажите папку внутри вашего хранилища Obsidian в `.env`:

```dotenv
TELEHARNESS_KB_ROOT=/home/you/Obsidian/agents
```

Teleharness автоматически ведёт в ней:
- `journal/` — журнал каждого чата, чтобы при переключении с Claude на Codex/OpenCode/ACP контекст не терялся;
- `sessions/` — дайджесты ходов от плагина OpenCode;
- `_index.md`, `lessons/`, `decisions/`, `tasks/` — заметки, которые подмешиваются в снимок первого хода новых чатов.

---

## 9. Фоновые агенты GitHub

Автоматический запуск ревью, разбора issues или пайпов Temporal по событиям GitHub:

1. Создайте в GitHub **Fine-grained Personal Access Token** с минимальными правами на нужные репозитории (`Issues`, `Pull requests`, `Contents`).
2. В Teleharness (от администратора) откройте **Настройки → Фоновые агенты**.
3. Вставьте PAT (шифруется в `data/github-triggers.sqlite` ключом `data/secrets.key` с правами `0600`), выберите репозитории и добавьте правила.
4. Выберите **Polling** (работает за NAT без открытых портов) или настройте **GitHub Webhook** на `https://<ваш-хост>/teleharness/api/github/webhook` с выданным HMAC-секретом.
5. Для GitHub Enterprise Server задайте `TELEHARNESS_GITHUB_API=https://github.corp.example/api/v3` в `.env`.

---

## 10. Пайпы Temporal (Linux и macOS)

Многошаговые сценарии с точками подтверждения человеком, таймерами, ветвлением по условию,
расписаниями и продолжением с выбранного шага. Подробный справочник: [`docs/temporal.md`](temporal.md).

1. **Установите Temporal server и CLI** (<https://docs.temporal.io/cli>):
   - Для пробы: `temporal server start-dev --db-filename ~/.teleharness/temporal.db`
   - Для прода: self-hosted Temporal Server на PostgreSQL (или Temporal Cloud).
2. **Инициализируйте таблицы PostgreSQL для воркера:**
   ```bash
   createdb teleharness_temporal
   psql -d teleharness_temporal -f lib/temporal/ledger.sql
   psql -d teleharness_temporal -f lib/temporal/permits.sql
   ```
   Задайте лимиты параллельности в `temporal_limits` (`scope='provider'` для `claude` / `codex` / `acp` / `opencode`, `scope='tenant'` для пользователей или `'*'`).
3. **Установите и запустите Python-воркер** (от **того же пользователя ОС**, что и портал, для доступа к `<data>/temporal-private/worker.sock`):
   ```bash
   python3 -m venv ~/.teleharness/temporal-venv
   ~/.teleharness/temporal-venv/bin/pip install -r worker/temporal/requirements.txt
   PGHOST=127.0.0.1 PGDATABASE=teleharness_temporal PGUSER=teleharness \
   TELEHARNESS_TEMPORAL_MODEL_SOCKET="$(pwd)/data/temporal-private/worker.sock" \
   ~/.teleharness/temporal-venv/bin/python3 worker/temporal/pipeline_worker.py
   ```
   > Держите путь к каталогу коротким: длина пути Unix-сокета ограничена **103 байтами на macOS** и **107 байтами на Linux**.
4. **Включите в `.env`** и перезапустите Teleharness:
   ```dotenv
   TELEHARNESS_TEMPORAL_PIPELINES=1
   TELEHARNESS_TEMPORAL_MODELS=claude,codex,acp,opencode
   TELEHARNESS_TEMPORAL_SUBSCRIPTION_ATTESTED=1
   ```

---

## 11. Локальный голосовой режим (Piper TTS + GigaAM v2 STT, опционально)

Работает полностью локально на CPU без облачных API. Подробности: [`ops/voice/README.md`](../ops/voice/README.md).

```bash
mkdir -p ~/.teleharness/voice/models
python3 -m venv ~/.teleharness/voice/venv
~/.teleharness/voice/venv/bin/pip install piper-tts sherpa-onnx numpy
```

Положите голосовые модели Piper (`.onnx` + `.onnx.json`) в `~/.teleharness/voice/models/piper/` и
модель GigaAM v2 (`model.int8.onnx`, `tokens.txt`) в
`~/.teleharness/voice/models/gigaam/sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19/`.
Перезапустите Teleharness — в пустом поле ввода автоматически появится значок голосового режима.

---

## 12. Многопользовательский доступ и песочница команд (опционально)

Создавайте пользователей в **Настройки → Пользователи**. У каждого обычного пользователя своя папка
в `TELEHARNESS_TENANT_HOME` (`~/.teleharness-tenants/<имя>`), своя зона Obsidian в
`TELEHARNESS_TENANT_VAULT` и квоты (`TELEHARNESS_TENANT_*`).

Чтобы обычные пользователи могли безопасно запускать команды оболочки агентом внутри своей папки:
- **Linux:** настройте раннер на пользователя из [`ops/sandbox/README.md`](../ops/sandbox/README.md) (`ops/sandbox/linux/teleharness-tenant-run`).
- **Windows:** соберите песочницу AppContainer (`ops/sandbox/build.ps1`, см. [`ops/sandbox/README.md`](../ops/sandbox/README.md)).
- **macOS:** команды оболочки для не-админов намеренно запрещены (fail-closed); чат и работа с файлами в своей папке доступны.

---

## 13. Автозапуск в фоне

### Linux (`systemd`)

1. Скопируйте [`ops/linux/teleharness.service`](../ops/linux/teleharness.service) в `/etc/systemd/system/teleharness.service`, укажите свои `User`, `Group`, `WorkingDirectory` и `ExecStart` (при использовании OpenCode 2.x — `/opt/teleharness/ops/web-v2.sh`).
2. Обязательно оставьте **`OOMPolicy=continue`**, чтобы нехватка памяти в тяжёлом процессе агента (браузер/тесты) не останавливала весь портал.
3. При работе с OpenCode 2.x создайте отдельный unit `teleharness-opencode.service` для `/opt/teleharness/ops/opencode/serve-v2.sh` и добавьте `After=teleharness-opencode.service`.
4. Включите службу:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now teleharness
   ```

### macOS (`launchd`)

Готовые шаблоны `~/Library/LaunchAgents/*.plist` и команды `launchctl` приведены в [`docs/macos.md`](macos.md#5-keep-it-running).

### Windows (Планировщик задач)

Зарегистрируйте задачи планировщика (`LogonType S4U` или при старте системы):
- `ops\opencode\serve-v2.cmd` (если нужен OpenCode 2.x)
- `ops\web-v2.cmd` (сам портал)
- Опционально `ops\watchdog-teleharness.ps1` раз в 2 минуты для автоматического перезапуска упавшей службы.

---

## 14. Чек-лист проверки после установки

После запуска пробегитесь по этим пунктам:

- [ ] **Healthz:** `curl -s http://127.0.0.1:4170/teleharness/healthz` возвращает `{"ok":true,"version":"2.12.0",...}`.
- [ ] **Движки:** в **Новый чат → выбор модели** видны модели всех подключённых вами движков (Claude / OpenCode / Codex / ACP).
- [ ] **Поиск:** строка поиска на главном экране находит сообщения (значит, активен встроенный SQLite FTS5 в Node ≥ 22.5).
- [ ] **Git и Worktrees:** в проекте с git-репозиторием вкладка **Git** показывает диффы, а **Worktrees** создаёт изолированную ветку.
- [ ] **Файлы и PPTX:** карточка `.pptx` или `.docx` открывает встроенный предпросмотр слайдов/документа; кнопка **Скачать** работает в мобильном PWA.
- [ ] **Правая панель:** в чате открывается правая панель с MCP-серверами и списком скиллов; по клику на скилл открывается его `SKILL.md`.
- [ ] **HTTPS и телефон:** портал открывается по `TELEHARNESS_PUBLIC_URL`, вход по QR работает, PWA добавлен на экран «Домой», тестовый push из **Настройки → Уведомления** приходит.
- [ ] **Опциональные модули:** при включении **Temporal** показывает подключённый воркер, **Фоновые агенты** проверяют GitHub PAT, а в пустом поле ввода виден значок **Голоса**.
