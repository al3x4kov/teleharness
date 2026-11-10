---
id: ADR-005
title: Восстановление SSE после рестарта — эпоха сервера и resync
status: accepted
date: 2026-11-02
release: 1.6.2
sources: docs/reviews/2026-11-02/architecture.md S7 (R8, R9); code-correctness.md #3, #4, #6, #21
---

# ADR-005. Восстановление SSE после рестарта — эпоха сервера и resync

## Контекст

- `EventHub` нумерует события счётчиком `#seq`, который после старта
  процесса начинается с 0. Ring (1000 событий) живёт в памяти.
- Клиент после рестарта переподключается с `Last-Event-ID=N`, где N
  велико. Проверка `last < oldest - 1` (hub.js:929–941) ложна, ring пуст,
  поэтому клиент не получает **ни replay, ни `zai.resync`**. События,
  пропущенные за время простоя (`session.idle`, финальные части ответа),
  потеряны.
- Пока 4170 лежит, edge отвечает 502. По спецификации EventSource на
  ответ не-200 переходит в CLOSED без повторов. В `openEvents` (api.js:172–186)
  нет `onerror` и переоткрытия — живые обновления отключаются до
  перезагрузки страницы.
- `pollBusy` переводит чат только idle → busy; обратного перехода нет.
  Открытый чат остаётся «busy» с устаревшей лентой, через 120 с — ложный
  баннер «ход завис».

## Решение

1. **Эпоха сервера.** При старте хаб получает `bootEpoch` (например,
   `Date.now().toString(36)`). id события на проводе: `<epoch>.<seq>`.
2. **Сервер, `handleClient`:**
   - `Last-Event-ID` без точки или с чужой эпохой → сразу кадр
     `zai.resync`;
   - своя эпоха и `seq > #seq` (невозможно) → `zai.resync`;
   - своя эпоха и `seq < oldest - 1` → `zai.resync` (как сейчас);
   - иначе — replay из ring.
3. **Клиент, `openEvents`:** обработчик `onerror`; если
   `readyState === CLOSED` — переоткрыть EventSource с backoff 1–30 с
   (как у хаба) и после успешного `onopen` вызвать `resync()`. Клиент
   формат id не разбирает: `Last-Event-ID` браузер подставляет сам.
4. **Клиент, `pollBusy`:** если `/status` говорит idle, а открытый чат в
   сигналах busy — перевести в idle и вызвать `refreshMessages` для
   открытого чата. Это страховка от любой потери `session.idle`.
5. **`/status` отдаёт `epoch`** в заголовке `x-zai-epoch`: клиент,
   заметивший смену эпохи по опросу, тоже делает `resync()` (на случай,
   если EventSource ещё не переподключился).

```mermaid
sequenceDiagram
  participant C as Клиент
  participant E as edge
  participant S as server.js (новая эпоха B)
  Note over S: рестарт: эпоха A → B, ring пуст
  C->>E: EventSource reconnect, Last-Event-ID: A.4211
  E-->>C: 502 (портал ещё не поднялся)
  Note over C: onerror, readyState=CLOSED → backoff
  C->>E: new EventSource, Last-Event-ID: A.4211
  E->>S: GET /zai/api/event
  S-->>C: retry: 3000; data: zai.resync (эпоха A ≠ B)
  C->>S: resync(): /session, /dialogs, /status, history открытого чата
  S-->>C: живые события с id B.1, B.2, …
```

## Последствия

- Плюсы: после любого рестарта портала (watchdog, выкат, падение) открытые
  вкладки сами возвращаются к актуальному состоянию; исчезают «вечный busy»
  и ложные баннеры.
- Минусы: формат id меняется (клиент его не разбирает, тесты хаба —
  обновить); после рестарта все клиенты одновременно делают resync — при
  текущем числе пользователей нагрузка несущественна.
- Тесты: hub.test.js — чужая эпоха → resync; своя эпоха → replay;
  store.test.js — `pollBusy` busy→idle; L4 — рестарт стенда при открытом
  чате.
- Не решает потерю самого Claude-хода при рестарте — это ADR-010.
