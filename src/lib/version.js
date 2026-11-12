// Single source of truth for the UI version shown in Настройки → «О приложении».
// Bump together with the project-note status entry in the vault.
// 1.19.2 (2026-11-12, FEAT-11.18 step C): Relay — a chat continues on another engine or model (Claude Code <-> opencode): «Продолжить в …» on the limit banner, «Продолжить в другом движке» in the chat menu, a relay mark in the feed, one merged feed of both engines, the new engine is pointed at the chat journal; a «quota is running out» strip where the remainder is known (z.ai, under 15%).
// 1.18.1 (2026-11-12, FEAT-11.18 step B): the chat journal — the portal writes the full history of every chat (both engines) to the knowledge base (journal/<date>-<chat>.md) after each turn; the agent gets one system-prompt line with the path and reads it on demand.
// 1.18.0 (2026-11-12, FEAT-11.18 step A): Settings → «Подписки» for every user — a card per connected model provider (z.ai quota windows; OpenRouter key limit; DeepSeek / Moonshot / SiliconFlow balance; OpenAI and Anthropic API spend with an org admin key; an honest «no official API» card otherwise). Official documented endpoints only; keys never reach the client.
// 1.17.7 (2026-11-12, TASK-01.82): the visible product name is «Teleharness» (drawer, login, tab title, installed app name, push title, About); new mark «>» with link arcs and a new app icon; brand accent is indigo in both themes (the orange Claude engine mark stays). Internal ids (/zai/, cookie, storage keys) are unchanged — nobody is logged out.
// 1.17.6 (2026-11-12, TASK-12.31): server low findings of the 2026-11-10 review — capped command cache, turn undo never overwrites a file changed after the plan, 400 on a broken %-code in admin token route, /mcp answers within a time budget, one status recount for parallel requests, relative ?directory= refused, push presence reset on subscription takeover.
// 1.17.5 (2026-11-12): BUG-223 the open «Чаты» list learns about a chat created or renamed in another tab (opencode 2.x session events carried no id — the adapter adds id, folder, time and the parent of subagent sessions); BUG-225 voice mode with browser speech recognition starts recognition as soon as the session opens.
// 1.17.4 (2026-11-12, BUG-229): a Claude agent run without a task status is no longer shown as working forever — runs without zaiRun count as working only in the live turn tail, finished turns render them done (times from state.time) or stopped; the server stamps a definite outcome on parts without a status when a turn is cut (stopRuns) and restart recovery stops stale running zaiRuns in stored history. Server changed — zai-web restart required.
// 1.17.3 (2026-11-11, FEAT-05.29): a file the user asked for is always shown in the chat — the agent presents it as [name](absolute path), the portal shows a file card straight from where the file lies (no copy; access is checked by the server), server paths are removed from the answer text, an inaccessible file is a «Файл недоступен в этом чате» row; the 8 cards per message limit is lifted (cap 40). Both engines get the portal rule in the system prompt.
// 1.17.2 (2026-11-11, TASK-01.81): subagent cards closer to the mockup — tokens line for both engines, a folder read is «Список файлов», agent answer headings in body size, «фоном» pill only for real background runs in Claude chats, no background bar duplicating the «Работают агенты» indicator when detail is off.
// 1.17.1 (2026-11-11): review wave 3 — BUG-17.14 path comparisons by platform in one place (lib/paths.js: tenant folder removal guard, vault zone, file roots; lowercase keys on win32 only; binary defaults by platform), BUG-01.75 the composer keeps the typed text when a send is refused, «Свой ответ» has an accessible name; BUG-228 a stale cached /status no longer flips a finished chat back to busy.
// 1.17.0 front-only update (2026-11-11, TASK-01.79): subagent cards brought to the approved mockup — «Работают агенты» indicator as a sign + two lines, steps grouped with result notes, agent answer rendered as markdown without wrapper tags, file names visible in Claude steps (BUG-227). No version bump: healthz reads the version at server start.
// 1.17.0 (2026-11-11): FEAT-01.77 — subagents inside the chat: agent cards with live steps and a «now» line, a per-turn summary, the preloader waits for subagents when «Детализация выполнения» is off (with agent names), a «Фоном работает агент» bar above the composer; opencode 2.x (tool `subagent`, child session feeds) and Claude (Agent tool: task_* events and parent_tool_use_id traffic land in the tool part); tool input is visible while a tool runs.
// 1.16.6 (2026-11-11): review wave 2 (reliability) — BUG-218 per-chat lock for binding/prompt mark/revert, exclusive upload file creation, dispose race logged; BUG-224 stand guard knows :4196; TASK-13.27 claude store written deferred + flushed on shutdown; TASK-16.31 v2 stall contract (internal message.updated from the adapter, hub keeps them off clients); TASK-12.29 healthz mem/errors/degraded/lastCrashAt + push after an unclean restart; TASK-04.15 session sweep, lastSeenAt, login limits (429/413/400), legacy cookie deadline.
// 1.16.5 (2026-11-10): review wave 1 — BUG-212 empty-chat gc on opencode 2.x, BUG-213 hub keeps a dialog/busy record until the engine confirms, BUG-214 v2 event stream backoff reset + bounded rewriter maps, BUG-215 claude turn: unsaved attachment note, 400 on a broken body, BUG-216 deleting a running chat from the lists stops the turn, BUG-217 test guard knows :4196.
// 1.16.4 (2026-11-10): FEAT-11.17 — Claude Fable 5.2 in the catalog, context windows as claude CLI reports
// them (1M for 4.8/5.x, 200k for Sonnet 4.6/4.5, Haiku 4.5); claude CLI 2.1.322. Also ships TASK-17.1
// (c5ecc7d, POSIX branches; Windows behaviour unchanged).
// 1.16.3 (2026-11-08): TASK-16.7 wave 2 on opencode 2.x — stability: BUG-195 opencode instances per chat folder
// released when idle and no longer re-created by the hub's dialog poll (prod had ~200 MCP processes);
// tenants: BUG-196 own turn events, BUG-197 unknown v2 events not leaked, BUG-198 zai-* skills, BUG-199 chat
// folder, BUG-200 turn undo backups, BUG-201 reject-only permissions; chat: BUG-202 stop ≠ error, BUG-203/204
// agent questions (forms), BUG-205 permission card, BUG-206 «Вернуть», BUG-207 image after reload, BUG-208
// attachment chip, BUG-209 user system prompt reaches the model on every step, BUG-210 deleted chat folder.
// 1.16.2 (2026-11-08): TASK-16.7 wave 1 on opencode 2.x — BUG-191 history limit > 200 (upstream cap 200),
// BUG-192 MCP status shape (+ «подключается»), BUG-193 voice hint hidden from the user bubble,
// BUG-194 the model sees the KB snapshot again (plugin-v2 context hook on the real 2.2.6 message shape).
// 1.16.1 (2026-11-08): BUG-189 — opencode 1.x chat history migrated into the 2.x db
// (ops/opencode/oc2-migrate-v1.mjs) and the v2 chat list walks the cursor (was capped at 50);
// BUG-190 — «О приложении» shows the opencode 2.x version (/api/info) and the slim harness.
// 1.16.0 (2026-11-08): FEAT-16.3 — z.ai chats on opencode 2.2.6 (adapter lib/oc-client.js, ZAI_OC_API=v2,
// tenant sandbox plugin-v2 with a fail-closed plugin gate); opencode 1.19.5 stays installed for rollback.
// 1.15.1 (2026-11-07): BUG-188 — slash commands of admin GLM chats expand via opencode /command
// (slim has no auto-slash hook); BUG-186 — a chat deleted mid-turn no longer stays busy in the hub.
// 1.15.0 (2026-11-07): FEAT-16.2 — z.ai chats on oh-my-opencode-slim (orchestrator) instead of OmO;
// a chat or a saved default on an agent gone from the catalog continues on the default agent.
// 1.14.11 (2026-11-07): FEAT-04.12 stage B — every new tenant chat works in its own
// subfolder <tenant>\chats\<id> (both engines); parallel chats no longer overwrite files.
// 1.14.10 (2026-11-07): BUG-184 — a Claude turn closes on the CLI's result even if
// a background task of the agent keeps the process alive; the next message starts
// at once, a round the CLI runs on the task's notification is one more answer.
// 1.14.10 (2026-11-07): FEAT-07.22 — no client «Ответа долго нет — агент мог
// зависнуть» banner with «Прервать»: the activity line + ■ in the composer do it.
// 1.14.9 (2026-11-06): FEAT-04.12 / BUG-181 — tenants render their documents
// (zai-render: LibreOffice/Edge → page pictures + PDF), pip, WebFetch and subagents
// in Claude chats, `cd /d` in commands; the result file of a busy turn gets its card.
// 1.14.8 (2026-11-06): BUG-180 — a GLM-5.3 turn without a variant runs on
// ZAI_GLM_VARIANT (default max); a stalled-turn replay keeps the variant.
// 1.14.7 (2026-11-06): BUG-179 — a front-only deploy reaches a phone app resumed
// from background (app.js ETag checked on return, reload unless typing).
// 1.14.6 (2026-11-06): BUG-177 by the 1.14.5 device traces — the predicted shell
// height no longer jumps ahead of the keyboard: it rides along (.kb-move, 300 ms).
// 1.14.5 (2026-11-06): BUG-178 — Settings show the running app version; a server
// left behind by a front-only deploy is shown separately («сервер 1.14.3»).
// 1.14.4 (2026-11-05): BUG-177 by the device trace — Safari reports the keyboard
// height ~130–150 ms late; the shell now predicts it (learned height on focus,
// full height on blur) — no header jump, no mid-screen composer.
// 1.14.3 (2026-11-05): BUG-177 device trace — admin keyboard transitions are
// recorded per frame and posted to /zai/api/diag/kb (numbers only).
// 1.14.2 (2026-11-05): BUG-177 — the shell follows the visual viewport every
// frame while the iOS keyboard slides (no header jump / mid-screen composer).
// 1.14.1 (2026-11-05): step-by-step dogfood of П31/П32 — wide ‹ steps back in
// history, old #/access waits for the role, notices sit under the header,
// a fresh login drops stale notices, narrow (<380) settings rows stack.
// 1.14.0 (2026-11-05): chat menu «⋯» in the chat header — pin/unpin, rename,
// delete; pinned chats per user on the server (GET/PUT /me/pins), group
// «Закреплённые» on Чаты and in the side panel (FEAT-01.69). Nested settings:
// root with groups, #/settings/<section>, back/forward, two columns from
// 1024 px, admin sections absent for users (FEAT-03.23).
// 1.13.2 (2026-11-05): BUG-12.24 — the tenant GLM agent (Sandbox) reads and writes
// notes of its own Obsidian zone (external_directory allow under the tenant vault root).
// 1.13.1 (2026-11-05): review 212 — a tenant picture on a text-only GLM runs
// that turn on the vision GLM (BUG-04.12); knowledge-base rules: a question
// about the user is searched in Obsidian first (BUG-01.67); tenant Claude reads
// its own zone (--add-dir); queued-message label by engine (BUG-01.68).
// 1.13.0 (2026-11-05): tenant Settings without admin-only placeholders
// (BUG-03.20), tenant MCP list (FEAT-03.21), own system prompt for every
// user (FEAT-03.22).
// 1.12.3 (2026-11-05): BUG-167 — «ссылка https://…» is spoken «ссылка в чате»
// (no doubled word).
// 1.12.2 (2026-11-05): FEAT-06.3 natural speech — the voice worker reads numbers,
// units, dates, money, abbreviations and terms like a person (case/gender
// agreement), restores «ё» and fixes stress where Piper is wrong.
// 1.12.1 (2026-11-05): voice mode prod dogfood fixes — answers in the user's
// language (BUG-165), first sentence cut from 60 chars (BUG-166).
// 1.12.0 (2026-11-05): FEAT-06.2 voice mode like Claude — full-screen hands-free
// talk: local STT (GigaAM v2) + TTS (Piper) on the server, auto-send on a
// pause, answers spoken sentence by sentence, barge-in, particle-swarm orb,
// «голосом»/«озвучено» tags, Настройки → «Голосовой режим».
// 1.11.4 (2026-11-05): BUG-164 — a reload/resync during a Claude turn keeps the
// work done so far (history serves the running answer), and a finished turn
// of the open chat re-reads its history once, so the answer shows without a
// manual reload.
// 1.11.3 (2026-11-05): ревью и dogfood ролей — GET тенанта не тратят лимит запросов (BUG-158), привязка тенанта только к моделям своего каталога (BUG-159); выкат 1.11.2 повторён скриптом на ops/deploy/zai-deploy-lib.ps1 (BUG-157).
// 1.11.2 (2026-11-04): точечные фиксы — маска «*.svg» не становится карточкой файла (BUG-155), Claude-чат тенанта правит файлы своей папки (BUG-144), «Отменить ход» в git-папке без снапшотов opencode, только файлы хода (BUG-145).
// 1.11.1 (2026-11-04): прелоадер хода заменён на v3 владельца — робот бросает жетон «ai» в корзину, светлый и тёмный варианты (FEAT-03.19). Только фронт.
// 1.11.0 (2026-11-04): «Детализация выполнения» в Настройках (по умолчанию выкл.) — прелоадер «человечек бросает ai в корзину» до готовности ответа, затем только полноценный ответ (FEAT-03.19). Только фронт.
// 1.10.2 (2026-11-04): dogfood-фиксы — тап-цели (BUG-151), «О приложении» переносится (BUG-152), frontmatter с вложенным YAML (BUG-153), «работает» под заголовком (BUG-154).
// 1.10.1 (2026-11-04): «Отменить ход» в opencode вне git откатывает файлы (бэкап в плагине vault-cache, BUG-146).
// 1.10.0 (2026-11-04): «Изменить» / «Сгенерировать заново» (FEAT-01.57), «Отменить ход» (FEAT-01.58), push-уведомления (FEAT-07.20); BUG-145 — откат opencode в git-папке отключён.
// 1.9.1 (2026-11-04): «О приложении» — версия zai с сервера, opencode + OmO, Claude Code с версией (BUG-143).
// 1.9.0 (2026-11-04): выверка всей истории — vision-фолбэк, ранние заголовки Claude, routes/*, постраничная история, kbContext, MCP для Claude.
// 1.8.6 (2026-11-03): dogfood прода по всем клиентским путям — BUG-093
// («Новый чат» из меню внутри чата удалял новый чат), BUG-094 (карточки чужих
// файлов из HOME), BUG-095/097 (меню: пункт текущего экрана, модальность),
// BUG-096 (ложная «Связь восстановлена»), BUG-098 (пути /d/…), BUG-099
// (мигание шапки). Только фронт — рестарт не нужен.
// 1.8.5 (2026-11-03): BUG-091, итерация 2 — при открытой клавиатуре
// компактный композер (поле 48 px, кнопки 40, отступы меньше). Только фронт.
// 1.8.4 (2026-11-03): BUG-091 — место под ленту на iPhone: при открытой
// клавиатуре и при диалоге на коротком экране пилюли модели/агента скрыты;
// поле ввода без синей рамки фокуса. Только фронт — рестарт не нужен.
// 1.8.3 (2026-11-03): BUG-092 — файлы, созданные в папке чата за ход любым
// способом (скриптом тоже), — карточками в обоих движках; угаданные картинки
// только после подтверждения сервером (GET /zai/api/turn-files). Рестарт сервера.
// 1.8.2 (2026-11-03): FEAT-13.19 — ход Claude-чата по шагам, как в opencode:
// размышления, карточки инструментов, «Шаг N» (lib/claude-transcript.js;
// openspec claude-turn-steps); закрывает BUG-13.15. Нужен рестарт сервера.
// 1.8.1 (2026-11-03): FEAT-05.17 — файлы в ответе карточками как в
// приложении Claude (плашка типа, имя без расширения, «Тип · РАСШ»; у
// картинки — миниатюра), стопкой перед текстом ответа (openspec
// file-cards-iphone-safari). Только фронт — рестарт сервера не нужен.
// 1.8.0 (2026-11-03): FEAT-09.20 — стиль приложения Claude (iOS): тёплые
// светлая/тёмная темы, боковое меню вместо таббара/рейла, приветствие
// пустого чата, ответы антиквой Source Serif 4 (openspec claude-app-look).
// 1.7.3 (2026-11-03): prod dogfood 1.7.2 low fixes (openspec fixes-1.7.3) —
// $PWD/%CD% in bash image paths, Claude answers signed «model · agent»,
// chat title never flashes back to the default, GC lists/removes empty
// ownerless tenant folders.
// 1.7.2 (2026-11-03): bugfix-1.7.2 — auto titles for Claude chats and
// instead of snapshot-derived opencode titles (rename wins), account deletion
// removes its chats then folders and reports leftovers (retried by gc),
// empty-chat gc, prompt without model → default model, empty turn → «Модель
// вернула пустой ответ» + «Повторить», previews of pictures made by bash,
// quiet 404s, a11y (row actions by Tab, modal focus).
// Also in 1.7.2 — Claude agents (FEAT-13.17, openspec claude-agents): Claude
// chats pick a portal agent (shared/ + data/claude-agents/*.md, re-read
// without a restart; GET /zai/api/claude/agents, admin only) or «Без агента»
// — the default everywhere (new chats, Настройки «Агент для новых чатов ·
// Claude», old chats); the first agent is Workflow (task through the full
// dev flow). The agent rides --agents/--agent (+ --system-prompt-snapshot
// off, so it can change between turns of the same claude session); without
// an agent the CLI argv is unchanged. Header «Claude Opus 5.5 · Workflow».
// 1.7.1 (2026-11-03): prod dogfood fixes, client-only — long chat title no
// longer covers «Назад», opencode messages queued before the first answer
// are really held, missing relative image previews hidden, rename errors stay
// in the modal, pretty model id before the catalog loads.
// 1.7.0 (2026-11-02): full-review implementation (groups G1–G8 + integration).
// Server: config schema with fail-fast (ADR-006), access log + healthz
// (ADR-007), session cookies with server-side revoke, CSRF/edge headers
// (ADR-009), tenant policy — no shell agents / Claude only if enabled,
// redacted tool parts incl. SSE, quotas and rate limit; one path policy
// (system dirs on any drive); stand guard ZAI_ENV. Hub: epoch event ids +
// resync (ADR-005), replay counters survive restarts, loop abort, «turn
// incomplete», prompt unstick, dialogs never auto-rejected by default,
// paginated history, admin sessions report. Claude CLI: prompt via stdin,
// clean env, admin/tenant permission profiles, queued follow-ups, idle
// timeout + liveness, orphan recovery after restart, multi-step answers.
// Client: store split into modules, self-healing event stream + offline bar,
// turn-error banners, «В очереди»/delivery state, real upload progress and
// cancel, xlsx/docx viewer, Russian number format, one «Назад», token
// self-rotation and Claude per-user switch in «Доступ», compact chat stack
// on short screens, swipe actions only on keyboard focus.
// 1.6.1 (2026-11-02): dogfood UI review fixes (openspec dogfood-ui-fixes,
// BUG-008…017) — cache snapshot no longer leaks into the user bubble, no
// false «ход завис» after an answer, absolute-only project paths, abandoned
// empty chats removed, opaque chat bottom stack, «Повторить» on failed sends.
// 1.6.0 (2026-11-02): two engines, one binding per chat — the portal fronts
// opencode (GLM) AND the claude CLI; every chat is bound server-side to its
// engine + model (+ agent for opencode) (lib/binding.js, data/session-
// bindings.json). Settings defaults seed NEW chats only (BUG-11.1: picking
// Claude in Settings used to re-route open z.ai chats); claude chats never
// show an opencode agent (BUG-11.2). Model/agent pills above the composer:
// any engine before the first message, same-engine only afterwards.
// 1.5.2 (2026-11-02): honest temperature — the board's ACPI thermal zone is a
// firmware stub (27.9°C frozen across 15↔100% CPU load swings); host.js now
// detects a frozen reading (trackTempStuck: 5 min identical, or ≥60 s + load
// swing ≥25pp) and the «Компьютер» card shows «нет живого датчика» with an
// explanatory tooltip instead of a confident lie (+ tests).
// 1.5.1 (2026-11-02): artifact chips scoped to the session folder only —
// write/edit chips for files outside it (vault notes, portal sources, system
// paths) no longer surface as downloadable; copy action moved BELOW the
// message it copies («Копировать ответ», was: ambiguous icon next to the
// author name); tool rows and agent cards show stage start times
// («14:32 · 22с»); new normalize helpers isUnderPath/fmtClock (+ tests).
// 1.5.0 (2026-11-01): message queueing while busy — typing during a running
// turn keeps the send action (arrow, «встанет в очередь»): the message queues
// upstream and plays after the current turn. Empty input keeps the stop face;
// stopping/uploading still block sending.
// 1.4.1 (2026-11-01): false «Ход завис» banner fixed at the wire — /zai/api/status
// now carries only prompts that sat past the replay window (stalledSnapshot);
// a freshly queued prompt or a between-turns gap is no longer reported as a
// hang. Exhausted prompts stay visible for the manual «Отправить снова» exit.
// 1.4.0 (2026-11-01): full redesign on the data-terminal direction — Golos Text
// + JetBrains Mono (self-hosted), phosphor-teal accent, dual-theme tokens,
// «живая линия» signature; leak fixes: artifact chips only from write/edit,
// humanized tool rows (raw command/path/exit only when expanded), quiet
// unknown-parts, date-only home meta; FAB → header action; fixed undefined
// onTouchMove/onTouchCancel crash in MessageBubble (probe-caught).
// 1.3.1 (2026-11-01): login screen — portal-colored matrix rain background
// (canvas, theme-aware, reduced-motion static scatter).
// 1.3.0 (2026-10-31): artifacts preview/download, orchestration-directive cards,
// typing indicator, multi-agent AgentCard, theme boot fix, overlay fill-mode
// hardening, home junk filter, subscription credit units.
export const VERSION = "1.19.2";
