<div align="center">

<img src="docs/screenshots/ru/social-preview.png" alt="Teleharness: единый веб-пульт для Claude Code, Codex, Gemini (ACP) и opencode, с опциональной мобильной PWA" width="100%">

## Единый веб-пульт для ваших AI-агентов кода

**Запускайте Claude Code, Codex, Gemini (ACP) и opencode из одного self-hosted веб-пульта — на тех подписках, которые вы уже оплачиваете. Ревью диффов и изолированные git worktrees, передача чата на другой CLI при лимите подписки и устойчивые пайпы на Temporal. Нужен доступ вдали от стола? Тот же интерфейс работает как опциональная мобильная PWA.**

**Чат** · **Доска внимания** · **Ревью диффов и Worktrees** · **Relay** · **Пайпы Temporal** · **Self-Hosted**

[![Релиз](https://img.shields.io/github/v/release/al3x4kov/teleharness?style=flat-square&color=6366f1)](https://github.com/al3x4kov/teleharness/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/al3x4kov/teleharness/ci.yml?branch=main&style=flat-square&label=tests)](https://github.com/al3x4kov/teleharness/actions/workflows/ci.yml)
[![Лицензия: MIT](https://img.shields.io/badge/license-MIT-yellow?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Платформы](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-0ea5e9?style=flat-square)](#поддержка-платформ)

[Попробовать за 10 с](#попробовать-за-10-секунд) •
[Сравнение](#сравнение-с-альтернативами) •
[Что умеет](#что-умеет) •
[Визуальный тур](docs/tour.ru.md) •
[Быстрый старт](#быстрый-старт) •
[Безопасность](#модель-безопасности) •
[Архитектура](#архитектура) •
[Конфигурация](#конфигурация) •
[English](README.md)

<img src="docs/screenshots/ru/desktop-demo.gif" alt="Демо Teleharness на десктопе: чат с 4 CLI, Доска внимания, ревью диффов, Git Worktrees, Relay по лимиту и пайпы Temporal" width="880">

</div>

---

## Попробовать за 10 секунд

Без движков, без API-ключей и без записи в домашнюю папку — открывает полный интерфейс на синтетических чатах:

**Вариант 1 — Одной командой (Node.js ≥ 22):**
```bash
npx teleharness --demo
# или напрямую с GitHub до публикации в npm:
npx github:al3x4kov/teleharness --demo
# → http://127.0.0.1:4180/teleharness/  (токен входа: demo-demo-demo-demo)
```

**Вариант 2 — Docker Compose:**
```bash
git clone https://github.com/al3x4kov/teleharness.git && cd teleharness
docker compose up
# → http://127.0.0.1:4180/teleharness/  (токен входа: demo-demo-demo-demo)
```

**Вариант 3 — Облачная песочница в 1 клик (бесплатный тариф, read-only демо):**
Разверните собственное временное демо из [`render.yaml`](render.yaml):

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/al3x4kov/teleharness)

---

## Сравнение с альтернативами

Teleharness работает поверх **настоящих локальных CLI** (со всеми их скиллами, MCP-серверами, хуками и памятью проекта), а не ходит в платный API за токены.

| Возможность | Teleharness | Claude Code Web | OpenCode Web | Cursor | Vibe Kanban |
|---|:---:|:---:|:---:|:---:|:---:|
| Работает на оплаченных CLI-подписках (не платный API) | **Да** | Только Claude | Свой API / OAuth | Свой тариф | Да |
| Claude Code + Codex + Gemini/ACP + opencode в одном UI | **Да (4 семейства)** | Нет | Только opencode | Модели IDE | Частично |
| Перехват чата другим CLI при лимите (ручной и Авто-Relay) | **Да** | Нет | Нет | Нет | Нет |
| Доска внимания + инлайн-ревью диффов + Plan-First | **Да** | Частично | Частично | IDE | Частично |
| Изолированные Git Worktrees с проверкой конфликтов | **Да** | Нет | Нет | Фон | Да |
| Устойчивые мультиагентные пайпы, переживающие рестарт (Temporal) | **Да** | Нет | Нет | Нет | Нет |
| Self-hosted, 0 зависимостей бэкенда, опциональная PWA | **Да** | Облако | Локально | Десктоп | Локально |

---

## Что умеет

- **Единое рабочее место для 4 семейств CLI** — **Claude Code**, **Codex**, **Gemini / Copilot (ACP)** и **opencode** рядом в одном окне: живые шаги и субагенты, правая панель MCP / Скиллов / Плана, полнотекстовый поиск SQLite FTS5, встроенный просмотр Office/PPTX, активный кэш Obsidian и локальный CPU-голос.
- **Доска внимания, ревью диффов и Plan-First** — единый входящий список по всем чатам и пайпам (*Ждут вас*, *В работе*, *Готово*, *Ошибки*) с боковым превью, инлайн-комментариями по строкам диффа и read-only планом до первой правки файла.
- **Изолированные Git Worktrees и учёт экономии** — параллельные чаты на отдельных ветках с ранней проверкой пересечений и dry-run конфликтов, а также расчёт API-эквивалента расходов относительно фиксированных подписок.
- **Передача чата между CLI (Relay и Авто-Relay)** — закончилась квота Claude или Codex посреди задачи? Продолжите тот же чат в той же папке на другом CLI в один клик — или автоматически по списку резервных моделей. ([Подробнее](docs/cross-cli-handoff.md))
- **Устойчивые пайпы на Temporal и фоновые агенты GitHub** *(опционально)* — связывайте Claude, Codex, Gemini (ACP), opencode, allowlist-команды и одобрения человеком в многошаговые запуски, которые переживают рестарт, продолжаются с любого шага и запускаются по GitHub Issues/CI. ([Подробнее](docs/temporal.md))

> **Хотите увидеть все экраны?** Откройте полный **[Визуальный тур и каталог возможностей (`docs/tour.ru.md`)](docs/tour.ru.md)** — все десктопные и мобильные скриншоты, анимации и полная таблица функций.

---

## Быстрый старт

> [!TIP]
> **Пошаговая установка всех возможностей на Linux, macOS и Windows** (все 4 движка, Worktrees, Obsidian, Temporal, GitHub Background Agents, HTTPS + QR PWA, автозапуск): **[`docs/installation.ru.md`](docs/installation.ru.md)** ([English](docs/installation.md)).

### Требования

| | Версия | Зачем |
|---|---|---|
| [Node.js](https://nodejs.org) | ≥ 22.5 (22 LTS / 24 LTS) | сервер портала и встроенный SQLite FTS5 |
| [Git](https://git-scm.com) | ≥ 2.20 | экран Git, ревью диффов, Worktrees |
| [opencode](https://opencode.ai) | 2.x (проверено на 2.2.6) | движок opencode |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | 2.x | движок Claude |
| [Codex CLI](https://github.com/openai/codex) | 0.169+ | опционально, движок Codex |
| ACP CLI (`gemini` / `copilot` / свой) | актуальная | опционально, настраивается в Настройки → ACP-агенты |
| Python | 3.11+ | опционально, локальный CPU-голос и воркер Temporal |

Достаточно **хотя бы одного** движка (или ни одного для `--demo`).

### Одной командой

```bash
npx teleharness                                # → http://127.0.0.1:4180/teleharness/
# или напрямую с GitHub:
npx github:al3x4kov/teleharness
```

Проверяет Node, хранит данные в `~/.teleharness`, использует предсобранный фронт (или собирает при необходимости), находит установленные движки и печатает токен администратора. Флаги: `--demo`, `--port N`, `--host 0.0.0.0`, `--rebuild`.

### Установка из исходников

<details open>
<summary><b>macOS / Linux</b></summary>

```bash
git clone --branch v2.13.1 https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci && npm run build

cp .env.example .env               # все поля необязательны

# движки (нужен хотя бы один)
opencode auth login                # добавьте нужных провайдеров
claude setup-token                 # положите токен в .env как CLAUDE_CODE_OAUTH_TOKEN

./ops/opencode/serve-v2.sh &       # opencode 2.x на 127.0.0.1:4196
./ops/web-v2.sh                    # → http://127.0.0.1:4170/teleharness/
```
</details>

<details>
<summary><b>Windows (PowerShell)</b></summary>

```powershell
git clone --branch v2.13.1 https://github.com/al3x4kov/teleharness.git
cd teleharness
npm ci; npm run build

Copy-Item .env.example .env        # все поля необязательны

opencode auth login
claude setup-token

$env:OPENCODE_SERVER_PASSWORD = [guid]::NewGuid().ToString('N')
Start-Process opencode -ArgumentList 'serve','--hostname','127.0.0.1','--port','4196'

$env:TELEHARNESS_OC_API = 'v2'; $env:TELEHARNESS_UPSTREAM = 'http://127.0.0.1:4196'; $env:TELEHARNESS_OC_PASSWORD = $env:OPENCODE_SERVER_PASSWORD
node server.js                     # → http://127.0.0.1:4170/teleharness/
```
</details>

<details>
<summary><b>Docker (self-hosted профиль)</b></summary>

```bash
docker compose --profile selfhosted up -d teleharness
```
</details>

> [!NOTE]
> Портал раздаётся по пути `/teleharness/`; все настройки — переменные `TELEHARNESS_*` ([`.env.example`](.env.example)). Чек-лист для Mac (launchd): [`docs/macos.md`](docs/macos.md). Systemd-сервис Linux: [`ops/linux/teleharness.service`](ops/linux/teleharness.service).

### Поддержка платформ

| | macOS | Linux | Windows |
|---|:---:|:---:|:---:|
| Портал, opencode, Claude, Codex, ACP, диффы, worktrees, push | да | да | да |
| Пайпы Temporal и фоновые агенты GitHub (опционально) | да | да | — |
| Активный кэш Obsidian, локальный CPU-голос | да | да | да |
| Песочница shell для обычных пользователей (multi-user) | откл. (fail-closed) | опц. per-user runner | AppContainer |

---

## Модель безопасности

- **Для одного пользователя на `localhost` / Tailscale (основной сценарий):** Teleharness работает как локальный веб-пульт поверх ваших собственных CLI под вашим пользователем ОС. **Песочница не требуется**, все движки работают одинаково на macOS, Linux и Windows.
- **Общий сервер для нескольких пользователей:** обычные пользователи ограничены своими папками, квотами и набором MCP; выполнение shell-команд закрыто по умолчанию (fail-closed), пока вы не включите Linux per-user runner (`ops/sandbox/linux`) или Windows AppContainer. Подробнее — [SECURITY.md](SECURITY.md).

---

## Архитектура

<p align="center"><img src="docs/architecture-components.ru.png" alt="Компоненты Teleharness: десктопный веб-интерфейс и опциональная мобильная PWA, портал с SQLite FTS5/расходами/доской, 4 семейства CLI-движков, Obsidian, голос, песочница, GitHub и пайпы Temporal" width="880"></p>

- **Портал (`server.js`, `lib/`, `routes/`)** — zero-dep бэкенд на стандартной библиотеке Node.js: авторизация, SSE-хаб с реплеем, поиск SQLite FTS5, доска внимания, учёт расходов, Git/Worktrees и по одному адаптеру на каждое семейство CLI (`lib/oc-client.js`, `claude` CLI, `codex-shim.mjs`, `lib/acp-chat.js`).
- **Фронт (`src/` → `public/`)** — Preact + Signals (сборка esbuild), светлая и тёмная темы, EN/RU, опциональная мобильная PWA.
- **Опциональные модули** — активный кэш Obsidian, локальный Python CPU-голос (Piper TTS / GigaAM STT), воркер пайпов Temporal ([`docs/temporal.md`](docs/temporal.md)).

Послойная схема и конвейер поиска: [`docs/tour.ru.md#схемы-архитектуры`](docs/tour.ru.md#схемы-архитектуры). Полное описание архитектуры: [`docs/architecture.md`](docs/architecture.md), спеки: [`openspec/specs/`](openspec/specs/).

---

## Конфигурация

Все параметры описаны и валидируются схемой в [`lib/config.js`](lib/config.js); шаблон — [`.env.example`](.env.example).

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | `4170` (`4180` в CLI) | порт портала |
| `TELEHARNESS_DEMO` | `0` | `1` включает мгновенный демо-режим |
| `TELEHARNESS_UPSTREAM` | `http://127.0.0.1:4196` | адрес `opencode serve` 2.x |
| `TELEHARNESS_OC_API` | `v1` | `v2` для opencode 2.x |
| `TELEHARNESS_OC_PASSWORD` | — | пароль HTTP Basic для opencode 2.x |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | токен подписки Claude (`claude setup-token`) |
| `TELEHARNESS_ADMIN_TOKEN` | генерируется | токен входа администратора |
| `TELEHARNESS_PUBLIC_URL` | — | HTTPS-адрес для опционального QR подключения телефона |
| `TELEHARNESS_KB_ROOT` | `off` | путь к vault Obsidian для активного кэша |

Примеры конфигов агентов (Claude Code + opencode): [`config/`](config/) (`./config/install.sh` / `./config/install.ps1`).

---

## Разработка

```bash
npm test                 # unit, UI-компоненты (happy-dom), сервер и edge
npm run build            # esbuild → public/app.js, public/app.css
npm run demo             # синтетическое демо на fixtures-demo/
```

Как участвовать — [CONTRIBUTING.md](CONTRIBUTING.md), история изменений — [CHANGELOG.md](CHANGELOG.md).

## Собрано с помощью

[opencode](https://opencode.ai) · [Claude Code](https://docs.anthropic.com/en/docs/claude-code) · [Codex CLI](https://github.com/openai/codex) · [Temporal](https://temporal.io) ·
[Preact](https://preactjs.com) · [esbuild](https://esbuild.github.io) · [marked](https://marked.js.org) · [DOMPurify](https://github.com/cure53/DOMPurify) · [highlight.js](https://highlightjs.org)

## Лицензия

[MIT](LICENSE). Сторонние файлы сохраняют свои лицензии: `openspec-*` / `opsx-*` — MIT ([OpenSpec](https://github.com/Fission-AI/OpenSpec)), `dogfood` — Apache-2.0.
