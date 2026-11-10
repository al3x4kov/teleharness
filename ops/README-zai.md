# zai — scaffold state

Claude-mobile-app-style web UI for opencode. This scaffold contains the
**server/tooling layer only** — no frontend code yet (frontend agents add
`src/main.jsx` and `public/index.html` later).

## What exists

| Path | Purpose |
|---|---|
| `package.json` | name `zai`, private; devDeps: esbuild, preact, @preact/signals, marked, dompurify, highlight.js. Runtime deps: none (node stdlib only). |
| `build.mjs` | esbuild bundler: `src/main.jsx` → `public/app.js` (preact JSX, iife, es2020, minified). Exits 0 with a message when `src/main.jsx` doesn't exist yet. |
| `server.js` | zero-dep `node:http` server on `127.0.0.1`, `PORT` env or 4170. `/zai/api/*` → mock (if `ZAI_MOCK=1`) or 501 "real proxy not implemented yet". Everything else → static from `public/` (`/zai/` prefix stripped, `index.html` default). |
| `lib/mock.js` | `mockHandler(req,res) → boolean`. Replays fixtures for GET `/zai/api/session`, `/zai/api/session/:id/message`, `/zai/api/provider`, `/zai/api/agent`, `/zai/api/project`. GET `/zai/api/event` streams `fixtures/events.sse` frames paced 150 ms, then stays open with `: ping` comments every 10 s. Any POST `/zai/api/*` → `{"mock":true}` and appends `{ts,url,body}` to `fixtures/_captured.jsonl`. Unknown → false (falls through). |
| `tests/mock.test.js` | node:test contract tests: fixture round-trip for session + message, POST capture to `_captured.jsonl`, SSE content-type + at least one `data:` frame. Spawns the real `server.js` on an ephemeral port with `ZAI_MOCK=1`. |
| `fixtures/` | Live-recorded from opencode 1.19.5 at `http://127.0.0.1:4096` (GET + SSE capture only), raw and untrimmed. |

## Run

```cmd
cd D:\Portal\zai
npm install
set ZAI_MOCK=1 && node server.js       :: mock API + static UI on http://127.0.0.1:4170
npm test                                :: 4 contract tests
npm run build                           :: bundles src/main.jsx once it exists
```

Without `ZAI_MOCK=1`, `/zai/api/*` answers `501 {"error":"real proxy not implemented yet"}` until the real proxy task lands (it will forward to opencode at `http://127.0.0.1:4096`).

## Where fixtures came from

Recorded 2026-10-31 against the live `opencode serve` on `127.0.0.1:4096`, read-only:

- `sessions.json` — GET `/session` (27 sessions)
- `messages-ses_*.json` — GET `/session/:id/message` for the 3 most recently updated sessions
- `provider.json` — GET `/provider`; `agents.json` — GET `/agent`; `projects.json` — GET `/project`
- `events.sse` — GET `/event` captured for 45 s (raw chunk bytes): `server.connected`, one `message.part.updated`, several `server.heartbeat` frames

`fixtures/_captured.jsonl` (created at runtime) accumulates every POST the mock receives — handy for seeing what the frontend sends without spending tokens. It is safe to delete anytime.
