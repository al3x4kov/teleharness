---
title: Матрица паритета движков — claude CLI ↔ opencode
date: 2026-11-04
item: FEAT-13.1 (REQ-E009 73/U003, REQ-E030 79/U005, REQ-X4010 73/U003)
версия: zai 1.8.6
источники: tracker/BACKLOG.md, tracker/epics/EPIC-13-claude-engine-parity.md, tests/claude*.test.js, tests/components/claude-*.test.js, qa-manage/runs, dogfood-output (прод 1.7.2–1.8.6)
---

# Матрица паритета: Claude-чат (claude CLI) ↔ opencode-чат

Чат = движок + модель + агент (EPIC-11). Модели `anthropic/*` обслуживает раннер `lib/claude.js` (claude CLI в режиме `-p`
со stream-json), остальные — `opencode serve` 1.19.5. Строка — возможность, которую пользователь видит в opencode-чате.

Статусы: **есть** — сделано и подтверждено (автотест + живая проверка стенда/прода); **есть, без живого ретеста** — автотест есть,
живого RUN нет; **частично**; **нет**; **не делаем** — решение записано в item. «verified»/«done» — статус item в BACKLOG на 2026-11-04.

| # | Возможность | opencode | claude CLI | Статус Claude | Item | Доказательство (тест / RUN) |
|---|---|---|---|---|---|---|
| 1 | Маршрутизация по модели, движок закреплён за чатом | да | да | есть | FEAT-13.1, EPIC-11, TASK-13.13 | binding.test «engineOf», «patchBinding: engine locked»; claude-server.test «claude-bound chat ignores a glm model», «engine switch … 409»; RUN-2026-11-02-model-binding PASS |
| 2 | Стрим ответа (дельты) | да | да | есть | FEAT-13.1 | claude.test «runner turn: 204, event sequence, store, resume»; claude-transcript.test «text without block events … deltas join» |
| 3 | Ход по шагам: размышления, инструменты, шаги | да | да | есть | FEAT-13.19 (verified) | claude-transcript.test (8), claude.test «streams and stores reasoning + tool parts», components/claude-steps.test; прод 1.8.2 dogfood 18/0, RUN-2026-11-03-claude-steps |
| 4 | Многошаговый ответ не теряет начало | да | да | есть, без живого ретеста | BUG-13.8 (done) | claude.test «multi-step answer keeps every step, live and stored» |
| 5 | История после перезагрузки | да (opencode) | да (`data/claude-sessions.json`) | есть | FEAT-13.1, BUG-13.6 | claude-server.test «runs claude, merges history»; claude.test «store: a corrupt claude-sessions.json is moved aside»; binding.test «BindingStore … quarantined» |
| 6 | Кириллица и длинный промпт (stdin, без argv-лимита) | да | да | есть | BUG-13.2 (verified) | claude.test «prompt via stdin — UTF-8, option-looking text, 100K chars, clean env»; claude-server.test «stdin UTF-8 text, no ZAI_* in the CLI env»; FD П4 PASS |
| 7 | Вложения: картинки | да | да (файл в `.zai-uploads`, CLI читает Read) | есть | FEAT-13.1 | claude.test «buildTurn … materializes images and stores refs, not data URLs» |
| 8 | Вложения: документы (pdf/xlsx/…) | да | да (сервер материализует до раннера) | есть, без живого ретеста | FEAT-13.1 | tests/attach.test.js (общий путь загрузки); живого RUN на Claude нет |
| 9 | Файлы ответа карточками, превью картинок из команд | да | да | есть | BUG-13.15 (verified), BUG-05.18 / BUG-092 (verified) | turn-files.test, components/claude-steps.test «картинка, записанная Claude», components/turn-files.test; прод 1.8.3 TC-FILE-007 Claude 5/5, RUN-2026-11-03-turn-files |
| 10 | Очередь досылок во время хода | да | да (FIFO до 5, переполнение → 409) | есть, без живого ретеста | BUG-13.7 (done), BUG-13.14 / BUG-061 (done) | claude.test «concurrent prompt is QUEUED», «queue is bounded»; final-fixes.test «ISSUE-003: a queued question is accepted by its own answer» |
| 11 | «Остановить» ход | да | да | есть | FEAT-13.1, FEAT-13.19 е | claude.test «abort marks the partial answer, cancels the queue», «stop during a tool call → the card ends as error»; прод 1.8.2 dogfood (е) PASS |
| 12 | Длинный ход без жёсткого лимита | да (watchdog 900 с на тишину) | да (лимита нет) | есть | FEAT-13.4 (verified) | claude.test «default has NO run timeout», «opt-in runTimeoutMs still kills» |
| 13 | Живость хода / тихий ход | watchdog + stall-replay | idle-таймаут 30 мин, keepalive, «Работает N мин» | есть, без живого ретеста | BUG-13.3 (done) | claude.test «idle timeout kills a SILENT turn, never a talking one»; store-chat.test (строка живости); hub: claude.test «markManaged keeps pending/replay away» |
| 14 | Восстановление после рестарта портала | ходы живут в serve | ход прерывается: «[Прервано рестартом портала]», сироты убиваются, сессия сохраняется | частично (by design: ход не продолжается) | BUG-13.5 (done) | claude.test «restart: orphaned CLI run is killed», «foreign process on a reused PID is never killed», «live run is mirrored to claude-runs.json»; на стенде не проверялся |
| 15 | Продолжение сессии (контекст между ходами) | да | да (`--resume`) | есть, без живого ретеста на стенде | FEAT-13.12 (done) | claude.test «resume on the next turn»; локальный smoke настоящим CLI (impl-G3); ретест на стенде — openspec 10.4 |
| 16 | Автозаголовок чата | да | да (серверный автотитлер) | есть | BUG-083 (ID BUG-13.14 дублирован — BUG-136), BUG-01.27 | bugfix-172-server.test, bugfix-172-units.test, components/titles-a11y.test; прод 1.7.2 dogfood PASS |
| 17 | Чат поднимается наверх списка | да | да | есть | BUG-13.16 / BUG-085 (verified) | claude.test «BUG-13.16: a claude turn records activity … session.updated»; прод 1.7.2 dogfood PASS |
| 18 | Выбор агента | агенты opencode/OmO | агенты Claude портала (`--agents`), по умолчанию «Без агента», Workflow | есть | FEAT-13.17 (verified), BUG-11.2 (verified) | claude-agents.test (14), claude-server.test «Claude chat agent: default none; pick Workflow…», components/claude-agents.test; прод 1.7.2 dogfood PASS |
| 19 | Подпись агента у ответа | да | да | есть | BUG-13.18 / BUG-087 (verified) | chat-display.test (BUG-087); прод 1.7.3 точечный ретест PASS |
| 20 | Диалоги разрешений (permission) | инлайн-кнопки | нет интерактива в `-p`: admin — `bypassPermissions` + `--add-dir`, тенант — Claude недоступен | не делаем (решение) | FEAT-13.9 (done) | claude.test «permissionArgs: admin bypass + portal dir, tenant restricted», «access profile reaches the CLI flags» |
| 21 | Вопросы агента (question tool) | инлайн-диалог | нет (CLI `-p` не спрашивает) | не делаем (следствие FEAT-13.9) | FEAT-13.9 | — |
| 22 | Секреты портала не уходят в процесс движка | да | да (env allow-list) | есть | BUG-13.2 | claude.test «childEnv: allow-list only, ZAI_* secrets never pass» |
| 23 | Тенант (не-admin) | да, только shell-free агенты, sandbox | Claude-движок недоступен (403) | не делаем до OS-изоляции | BUG-12.5, FEAT-13.9, BUG-12.20/BUG-100 | auth.test «engine not allowed» (403 тенанту), claude-server.test «tenant → 403» (каталог агентов) |
| 24 | MCP (Playwright) | да (конфиг opencode) | `--mcp-config` только admin | частично | FEAT-13.10 (in-progress) | claude.test «permissionArgs» (флаг); живой кейс «скриншот» не прогонялся |
| 25 | Кэш Obsidian (снапшот, rules, дайджест) | да (плагин vault-cache) | нет инъекции в раннере | нет | FEAT-13.11 (in-progress), FEAT-01.32 | стенд: CACHE_SEEN/RULES_PRESENT на Claude — FAIL (impl-G8 §4) |
| 26 | Каталог моделей и их живость | WORKING_MODELS | каталог `shared/engine.js` + `data/claude-models.json` | частично (живость не прогнана) | FEAT-11.10 (done), TASK-14.10 (in-progress), FEAT-03.2 | claude.test «catalog override from claude-models.json», binding.test «shared/engine.js is the single source»; `zai-qa/claude-models-probe.mjs` не прогонялся |
| 27 | Лимиты подписки в Настройках | z.ai Coding Plan (`lib/usage.js`) | нет | нет | — (кандидат, см. gap-analysis) | — |
| 28 | Токены хода в мета-строке ответа | да | нет (раннер не сохраняет usage) | нет | — (кандидат) | — |
| 29 | Ошибка CLI / нет бинарника — понятный ответ, не зависание | да | да | есть | FEAT-13.1 | claude.test «CLI failure surfaces as the assistant text», «spawn failure (missing binary) is an answer, not a hang», «unknown model → 400» |

## Итог по критерию FEAT-13.1

Критерий: по каждой строке — тест или RUN-кейс на стенде. Покрыто тестами: 1–20, 22–24, 26, 29. Не закрыто:
- **нет** — 25 (кэш Obsidian, FEAT-13.11), 27 (лимиты подписки), 28 (токены хода);
- **частично** — 14 (рестарт не проверен на стенде), 24 (живой кейс MCP), 26 (живая матрица моделей TASK-14.10);
- **без живого ретеста** — 4, 8, 10, 13, 15 (RUN-кейсы паритета на стенде — очередь «Очереди работ» FEAT-13.1, P1).

Пока эти строки открыты, FEAT-13.1 остаётся in-progress; матрицу обновлять при закрытии каждой строки (openspec full-review 3.9).
