// Single source of truth for the UI version shown in Настройки → «О приложении».
// Bump together with the project-note status entry in the vault.
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
export const VERSION = "1.15.1";
