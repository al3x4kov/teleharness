// Single source of truth for the Teleharness version shown in Settings → About and /api/healthz.
// 2.5.2 (2026-11-22): FEAT-19.31 — модельный шаг OpenCode (GLM-5.3-Flash / GLM-5.3)
// в пайпах Temporal через temporalChatSteps (доступ к файлам/инструментам, каталог
// подключённых OpenCode-провайдеров, OutcomeObserver error → quota_wait, неинтерактивные
// permission/question, подпись OpenCode в RunDetail); FEAT-11.23 — динамическая
// автоподгрузка моделей opencode в пикере (группы провайдеров, кнопка «Обновить список»,
// фильтрация платных моделей тенантам).
export const VERSION = "2.5.2";
