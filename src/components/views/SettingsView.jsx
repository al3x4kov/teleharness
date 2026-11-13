// Settings (FEAT-03.23): a root with groups and nested sections at
// #/settings/<section>[/<sub>] — default model/agent, system prompt, voice,
// theme (localStorage 'zai.theme' — lib/theme.js), notifications, MCP and the
// admin-only sections; see the «nested settings» block below.
import { useEffect, useRef, useState } from "preact/hooks";
import "../views.css";
import "../voice.css";
import {
  about, admin, agents, busyMap, claudeAgents, connection, effectivePrefs, host, staleModelText, hostError, init, mcp, mcpError, me, prefs, providerCfg,
  refreshAbout, refreshHost, refreshMcp, refreshUsage, refreshSubscriptions, logout, sessions, setPrefs, usage, usageError, subscriptions, subscriptionsError, execDetailOn,
  refreshVoice, voiceApi, voiceInfo, voicePrefs, VOICE_PAUSES, VOICE_RATES,
} from "../../lib/store.js";
import { browserTtsSupported, createPlayer, speakBrowser, unlockAudio } from "../../lib/voice-audio.js";
import { displayTitle, fmtClock } from "../../lib/normalize.js";
import { AgentPicker, ClaudeAgentPicker, Glyph, ModelPicker, PickerSheet, pickDefaultModel } from "../Pickers.jsx";
import { ENGINE_SHORT, claudeAgentName, engineOf, modelName } from "../../lib/engine.js";
import { applyTheme, storedTheme } from "../../lib/theme.js";
import { LANGS, fmtNumber, lang, locale, setLang, t } from "../../lib/i18n.js";
import { VERSION } from "../../lib/version.js";
import AccessSection from "./AccessSection.jsx";
import NotificationsRow from "./NotificationsRow.jsx";
import { promptHint, SystemPromptEditor, loadPrompt, promptState } from "./SystemPromptRow.jsx";
import { disablePush, pushState } from "../../lib/push.js";
import { Modal } from "./HomeView.jsx";
import { backIsHistory, canGoForward, navigate, prevPath, setLeaveGuard } from "../../lib/router.js";

const THEMES = ["system", "dark", "light"].map((id) => ({
  id,
  get label() {
    return t(`settings.theme.${id}`);
  },
}));

// Raw upstream statuses (needs_auth, needs_client_registration…) are engine
// strings; the UI says them in words (C2). tone drives the dot colour: a
// disabled server is not a broken one (S-6).
const MCP_STATUS = {
  connected: { key: "settings.mcp.connected", tone: "on" },
  pending: { key: "settings.mcp.pending", tone: "idle" }, // BUG-192: opencode 2.x — the server is still starting
  disabled: { key: "settings.mcp.disabled", tone: "idle" },
  failed: { key: "settings.mcp.failed", tone: "bad" },
  needs_auth: { key: "settings.mcp.needsAuth", tone: "warn" },
  needs_client_registration: { key: "settings.mcp.needsRegistration", tone: "warn" },
};

// BUG-03.13: status in Russian words; the raw upstream error never takes the
// status column — it becomes a short second line («why», ellipsized, the full
// text in title) and failed servers get the actionable hint.
export function mcpView(s) {
  const known = MCP_STATUS[s?.status];
  const text = t(known?.key ?? "settings.mcp.unknown");
  const tone = known?.tone ?? "idle";
  let why = null;
  if (typeof s?.error === "string" && s.error.trim()) {
    // «MCP error -32000: Connection closed» → «Connection closed»: the code
    // prefix is noise for a person.
    why = s.error.trim().replace(/^MCP error\s*-?\d+:\s*/i, "").split("\n")[0];
  } else if (s?.status === "failed") {
    why = t("settings.mcp.failedWhy");
  }
  return { text, tone, why, full: s?.error ?? null };
}

// Quota windows: the provider returns epoch-ms instants — shown in the viewer's own time zone
// and locale, like every other time in the app.
const resetFmt = () => new Intl.DateTimeFormat(locale(), {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const KIND_RU = {
  hours: (n) => t("settings.quota.hours", { n: n ?? 5 }),
  week: () => t("settings.quota.week"),
  month: () => t("settings.quota.month"),
  day: (n) => t("settings.quota.day", { n: n ?? 1 }),
};

// Unit by upstream limit type: modern plans meter CREDITS (docs.z.ai/devpack:
// Max = 28 000 per 5 h / 140 000 weekly; a credit = weighted tokens ÷ 10 000,
// MCP calls at flat rates). Legacy plans meter TOKENS.
const KIND_UNIT = {
  hours: "settings.quota.credits",
  week: "settings.quota.credits",
  month: "settings.quota.credits",
  day: "settings.quota.credits",
};

function windowLabel(w) {
  const unit = w.type === "TOKENS_LIMIT" ? t("settings.quota.tokens") : KIND_UNIT[w.kind] ? t(KIND_UNIT[w.kind]) : "";
  const win = (KIND_RU[w.kind] ?? (() => w.kind))(w.number);
  return unit ? `${unit} · ${win.charAt(0).toLowerCase()}${win.slice(1)}` : win;
}

// Token quotas (legacy TOKENS_LIMIT) reach the millions — compact units;
// credit counts stay exact integers («кред.» lives in the row label).
function fmtQuota(n, type) {
  if (n == null) return "—";
  if (type === "TOKENS_LIMIT") {
    if (n >= 1e9) return t("settings.quota.billion", { n: (Math.round(n / 1e8) / 10).toLocaleString(locale()) });
    if (n >= 1e6) return t("settings.quota.million", { n: (Math.round(n / 1e5) / 10).toLocaleString(locale()) });
    return fmtInt(n);
  }
  return fmtInt(n);
}

function quotaUnitSuffix(type) {
  return type === "TOKENS_LIMIT" ? t("settings.quota.tokSuffix") : "";
}

// NBSP between every number and its unit: «1 ч 58 / мин» split mid-pair on
// phones (BUG-01.41 п.2, regression of BUG-03.7).
const NB = " ";

export function countdown(ms) {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return t("settings.dur.min", { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("settings.dur.hourMin", { h, m: m % 60 });
  const d = Math.floor(h / 24);
  return t("settings.dur.dayHour", { d, h: h % 24 });
}

// Two atomic pieces under the window's own bar (S-1/S-2): «сброс 2 нояб.,
// 17:31» and «через 1 ч 50 мин», each rendered nowrap, lower-case — the
// window name is already the row label above.
export function resetParts(w, now = Date.now()) {
  if (w?.resetAt == null) return null;
  const when = t("settings.quota.reset", { date: resetFmt().format(new Date(w.resetAt)) });
  const left = w.resetAt - now;
  return { when, left: left <= 60_000 ? t("settings.quota.now") : t("settings.quota.in", { d: countdown(left) }) };
}

// z.ai answered but without quotas: say why and that it heals itself (S-11).
export function usageUnavailableText(sub) {
  if (sub?.error === "no-key") return t("settings.quota.noKey");
  return t("settings.quota.noQuota");
}

// Visible temperature line + the reason as text, not only a tooltip (S-7,
// BUG-03.5). Priority: a live CPU-zone reading → SMART disk temperature (a
// real, load-dependent sensor) → honest «нет живого датчика» with the cause.
export function tempView(h) {
  if (!h) return null;
  const cpuLive = h.tempC != null && !h.tempStuck;
  if (cpuLive) return { label: t("settings.temp.cpu"), value: `${h.tempC}${NB}°C`, note: null };
  const disk = Number.isFinite(h.diskTempC) ? `${h.diskTempC}${NB}°C` : null;
  const why = h.tempStuck ? t("settings.temp.stuck") : t("settings.temp.noDriver");
  if (disk) return { label: t("settings.temp.disk"), value: disk, note: t("settings.temp.diskNote", { why }) };
  return { label: t("settings.temp.plain"), value: t("settings.temp.noSensor"), note: why };
}

// «О приложении»: the opencode version comes from the server (/host →
// opencodeVersion, read from opencode's /global/health), never a literal.
// BUG-143: the zai version is the running server's (/about.version) — the
// bundled constant only until /about answers; harness versions from /about.
// BUG-178 (2026-11-06: версия на проде не совпадала с ожидаемой): показываем версию
// ПРИЛОЖЕНИЯ, которое реально запущено; фронт выкатывается без рестарта сервера,
// поэтому отставание сервера пишем отдельно, а не выдаём за версию портала.
// TASK-01.82: видимое название продукта.
export const BRAND = "Teleharness";

export function appVersionLabel(app, server) {
  return server && server !== app ? t("settings.about.versionServer", { app, server }) : t("settings.about.version", { app });
}

export function aboutLine(version, host) {
  const str = (v) => (typeof v === "string" && v ? v : null);
  const appLabel = appVersionLabel(version, str(host?.version));
  const ocv = str(host?.opencodeVersion);
  // BUG-190: обвязка с именем (slim / OmO); старый ответ — только omoVersion
  const hv = str(host?.harness?.version);
  const hn = hv ? str(host?.harness?.name) : null;
  const omo = str(host?.omoVersion);
  const tag = hn ? `${hn} ${hv}` : omo ? `OmO ${omo}` : null;
  const oc = ocv ? `opencode ${ocv}${tag ? ` (${tag})` : ""}` : "opencode";
  const cc = str(host?.claudeVersion) ? `Claude Code ${host.claudeVersion}` : "Claude Code";
  return `${appLabel} · ${oc} · ${cc}`;
}

export function fmtAge(ms) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return t("settings.dur.lessMin");
  if (m < 60) return t("settings.dur.min", { m });
  const h = Math.floor(m / 60);
  return t("settings.dur.hourMin", { h, m: m % 60 });
}

const fmtInt = (n) => (n == null ? "—" : n.toLocaleString(locale()));

// FEAT-07.16 (UI): admin view of running/parked turns with their age and a
// stop button. Source: GET /status (busy map; claude entries carry `since`);
// for opencode turns the age is counted from the first time this page saw
// them busy (store busyMap) — labelled «не меньше». A dedicated hub API with
// real ages is Г2's part.
export function busyRows(status, { sessionsList = [], seen = {}, now = Date.now() } = {}) {
  const rows = [];
  for (const [id, st] of Object.entries(status ?? {})) {
    if (!st || (st.type === "idle" && !st.pending)) continue;
    const s = sessionsList.find((x) => x.id === id);
    const since = Number(st.since) > 0 ? Number(st.since) : Number(seen[id]) > 0 ? Number(seen[id]) : null;
    rows.push({
      id,
      title: displayTitle(s?.title),
      directory: s?.directory ?? null,
      kind: st.pending ? "stalled" : st.type === "retry" ? "retry" : "busy",
      age: since ? now - since : null,
      exact: Number(st.since) > 0,
    });
  }
  return rows.sort((a, b) => (b.age ?? 0) - (a.age ?? 0));
}

const BUSY_KIND_RU = { busy: "settings.busy.busy", retry: "settings.busy.retry", stalled: "settings.busy.stalled" };

function BusySessions() {
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState(false);
  const [stopping, setStopping] = useState(null);
  const load = async () => {
    try {
      setStatus((await admin.status()) ?? {});
      setErr(false);
    } catch {
      setErr(true);
    }
  };
  useEffect(() => {
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 10_000);
    return () => clearInterval(timer);
  }, []);
  const rows = status ? busyRows(status, { sessionsList: sessions.value, seen: busyMap.value }) : [];
  const stop = async (r) => {
    setStopping(r.id);
    try {
      await admin.abort(r.id, r.directory);
      await load();
    } catch {
      setErr(true);
    } finally {
      setStopping(null);
    }
  };
  return (
    <li class="card">
      <div class="set-row is-host">
        <div class="set-main">
          <div class="row-title">{t("settings.section.active")}</div>
          {status == null ? (
            err ? (
              <div class="set-value is-error" role="alert">
                {t("settings.loadFailed")}{" "}
                <button type="button" class="link-btn" onClick={load}>{t("common.retry")}</button>
              </div>
            ) : (
              <div class="sk-lines" role="status" aria-label={t("settings.busy.loading")}>
                <span class="sk sk-line sk-line-60" />
              </div>
            )
          ) : rows.length === 0 ? (
            <div class="set-value">{t("settings.busy.none")}</div>
          ) : (
            <ul class="busy-list">
              {rows.map((r) => (
                <li key={r.id} class="busy-row">
                  <div class="busy-main">
                    <a class="busy-title" href={"#/chat/" + r.id}>{r.title}</a>
                    <div class="busy-meta">
                      {t(BUSY_KIND_RU[r.kind])}
                      {r.age != null && <> · {r.exact ? "" : t("settings.busy.atLeast")}{fmtAge(r.age)}</>}
                    </div>
                  </div>
                  <button class="access-btn" type="button" disabled={stopping === r.id} onClick={() => stop(r)}>
                    {stopping === r.id ? t("settings.busy.stopping") : t("settings.busy.stop")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </li>
  );
}

// FEAT-06.2 (frame 8): «Голосовой режим» — voice, rate, pause before
// sending, short spoken answers, a sample. Values live in prefs.voice (per
// user); the section shows only when the server has the voice mode.
const ONE_DECIMAL = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
const fmtRate = (r) => `${r.toLocaleString(locale(), ONE_DECIMAL)}×`;
const fmtPause = (ms) => t("settings.voice.seconds", { n: (ms / 1000).toLocaleString(locale(), ONE_DECIMAL) });
export const voiceSample = () => t("settings.voice.sample");

export function VoiceSettings() {
  const info = voiceInfo.value;
  const [sample, setSample] = useState(""); // "" | "loading" | "playing" | error text
  useEffect(() => {
    refreshVoice();
  }, []);
  if (!info?.enabled) return null;
  const v = voicePrefs(prefs.value);
  const voices = info.voices?.length ? info.voices : [{ id: info.defaultVoice ?? "irina", name: t("settings.voice.defaultName") }];
  const cur = v.voice && voices.some((x) => x.id === v.voice) ? v.voice : info.defaultVoice ?? voices[0].id;
  const save = (patch) => setPrefs({ voice: { ...v, ...patch } });
  const playSample = async () => {
    const sampleText = voiceSample();
    const ctx = unlockAudio(); // inside the tap: iOS plays only from a gesture
    setSample("loading");
    try {
      const bytes = await voiceApi.tts({ text: sampleText, voice: cur, rate: v.rate });
      if (!ctx) throw Object.assign(new Error("no audio"), { status: 503 });
      const player = createPlayer(ctx);
      const buf = await player.decode(bytes);
      setSample("playing");
      await player.play(buf);
      setSample("");
    } catch (err) {
      if (err?.status === 503 && browserTtsSupported()) {
        setSample("playing");
        await speakBrowser(sampleText, { rate: v.rate });
        setSample("");
      } else if (err?.status === 429) setSample(t("settings.voice.limit"));
      else setSample(err?.status ? t("settings.voice.noReply") : t("settings.voice.noConnection"));
    }
  };
  const segRow = (title, items, value, fmt, onPick) => (
    <div class="set-row is-theme" role="radiogroup" aria-label={title}>
      <div class="set-main">
        <div class="row-title">{title}</div>
      </div>
      <div class="seg">
        {items.map((it) => (
          <button key={String(it)} type="button" role="radio" class={"seg-btn" + (value === it ? " active" : "")}
            aria-checked={value === it} onClick={() => onPick(it)}>
            {fmt(it)}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <li class="card voice-card" data-feat="FEAT-06.2">
      <div class="set-row">
        <div class="set-main">
          <div class="row-title">{t("settings.section.voice")}</div>
          <div class="set-hint">{t("settings.voice.hint")}</div>
        </div>
      </div>
      {segRow(t("settings.voice.voice"), voices.map((x) => x.id), cur, (id) => voices.find((x) => x.id === id)?.name ?? id, (id) => save({ voice: id }))}
      {segRow(t("settings.voice.rate"), VOICE_RATES, v.rate, fmtRate, (r) => save({ rate: r }))}
      {segRow(t("settings.voice.pause"), VOICE_PAUSES, v.pauseMs, fmtPause, (ms) => save({ pauseMs: ms }))}
      <div class="set-row">
        <div class="set-main">
          <div class="row-title" id="voice-short-title">{t("settings.voice.short")}</div>
          <div class="set-hint">{t("settings.voice.shortHint")}</div>
        </div>
        <button class="switch" type="button" role="switch" aria-labelledby="voice-short-title"
          aria-checked={v.shortAnswers ? "true" : "false"} onClick={() => save({ shortAnswers: !v.shortAnswers })} />
      </div>
      <div class="set-row">
        <div class="set-main">
          <div class="row-title">{t("settings.voice.sampleTitle")}</div>
          <div class={"set-hint" + (sample && sample !== "loading" && sample !== "playing" ? " is-error" : "")} role="status">
            {sample === "loading" ? t("settings.voice.preparing") : sample === "playing" ? t("settings.voice.playing") : sample || t("settings.voice.sampleQuoted", { text: voiceSample() })}
          </div>
        </div>
        <button class="access-btn" type="button" disabled={sample === "loading" || sample === "playing"} onClick={playSample}>
          {t("settings.voice.play")}
        </button>
      </div>
    </li>
  );
}

// ---- FEAT-03.23: nested settings ------------------------------------------
// Root with groups and «icon · title · value · ›» rows; every row opens its
// section at #/settings/<id> (one level deeper: #/settings/models/<sub>).
// Back: «‹ Настройки» (or the parent), a swipe from the left 20 px, the
// browser/system «Назад»; forward: a row tap or the browser «Вперёд».
// ≥ 1024 px: two columns (root list | section) with clickable crumbs and
// ‹ › history arrows. Admin-only sections do not exist for a user: no rows,
// and their address behaves like an unknown one — quietly the root, no hint
// (owner 2026-11-05, BUG-168). Layout: design/mockups-v2/chat-menu-settings
// (кадры 4–6, E6–E9) and chat-menu-settings-wide (D2, T2, T3).

const ICONS = {
  models: ["M12 2.5 20.5 7.25v9.5L12 21.5l-8.5-4.75v-9.5Z"],
  prompt: ["M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z"],
  exec: ["M4 6h16", "M4 12h10", "M4 18h7"],
  voice: ["M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z", "M19 11a7 7 0 0 1-14 0", "M12 18v3"],
  appearance: ["M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11Z"],
  notifications: ["M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
  mcp: ["M9 2v6", "M15 2v6", "M6 8h12v4a6 6 0 0 1-12 0Z", "M12 18v4"],
  subscription: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7v5l3 2"],
  computer: ["M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z", "M8 20h8", "M12 16v4"],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  active: ["M22 12h-4l-3 9L9 3l-3 9H2"],
  about: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 16v-4", "M12 8h.01"],
};

function SetIcon({ name }) {
  return (
    <svg class="set-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {(ICONS[name] ?? []).map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

// group: chats | app | features | admin | bottom; admin: admin-only.
// title: a getter — resolved in the active language at render time.
const withTitle = (key, rest) => ({
  ...rest,
  get title() {
    return key ? t(key) : null;
  },
});
export const SECTIONS = [
  { id: "models", group: "chats" },
  { id: "prompt", group: "chats" },
  { id: "voice", group: "chats" },
  { id: "appearance", group: "app" },
  { id: "notifications", group: "app" },
  { id: "mcp", group: "features" },
  { id: "subscription", group: "features" },
  { id: "computer", group: "features", admin: true },
  { id: "users", group: "admin", admin: true },
  { id: "active", group: "admin", admin: true },
  { id: "about", group: "bottom" },
].map((x) => withTitle(`settings.section.${x.id}`, x));
export const ADMIN_SECTIONS = SECTIONS.filter((x) => x.admin).map((x) => x.id);
const GROUPS = [
  withTitle("settings.group.chats", { id: "chats" }),
  withTitle("settings.group.app", { id: "app" }),
  withTitle("settings.group.features", { id: "features" }),
  withTitle("settings.group.admin", { id: "admin" }),
  withTitle(null, { id: "bottom" }),
];
// One level deeper (П32.У1): the pickers of «Модель и агенты».
export const SUBS = {
  models: {
    get model() {
      return t("settings.sub.model");
    },
    get agent() {
      return t("settings.sub.agent");
    },
    "claude-agent": withTitle("settings.sub.claudeAgent", { admin: true }),
  },
};

// Sections this user has. voice: true/false once /voice answered, null while unknown.
export function sectionsFor({ admin = false, voice = null } = {}) {
  return SECTIONS.filter((x) => (admin || !x.admin) && (x.id !== "voice" || voice !== false));
}

// What an address opens: {section, sub} | null (root) | "unknown" (→ root,
// the address is replaced). An admin section for a user IS unknown.
export function resolveSettings(section, sub, { admin = false, voice = null } = {}) {
  if (!section) return null;
  const known = sectionsFor({ admin, voice }).find((x) => x.id === section);
  if (!known) return "unknown";
  if (sub == null) return { section, sub: null };
  const def = SUBS[section]?.[sub];
  if (!def || (def.admin && !admin)) return "unknown";
  return { section, sub };
}

const subTitle = (section, sub) => {
  const d = SUBS[section]?.[sub];
  return typeof d === "string" ? d : d?.title ?? "";
};

export function settingsParent(section, sub) {
  if (sub) return `/settings/${section}`;
  if (section) return "/settings";
  return "/";
}

// Root-row value of the notifications state (E9: «Запрещены», never «Включены» then).
const NOTIF_SHORT = { on: "on", off: "off", denied: "denied", "ios-browser": "unavailable", insecure: "unavailable", unsupported: "unavailable", "server-off": "off" };

// iOS Safari (not the home-screen app) swipes back by itself: the portal's
// own edge swipe would make it two steps (П32.Н9 / У2).
function nativeEdgeSwipe() {
  if (typeof navigator === "undefined") return false;
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent ?? "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || globalThis.matchMedia?.("(display-mode: standalone)")?.matches === true;
  return ios && !standalone;
}

const offlineNow = () => connection.value?.state === "offline" || (typeof navigator !== "undefined" && navigator.onLine === false);

function SectionError({ onRetry }) {
  return (
    <div class="set-fail" role="alert">
      <p class="set-fail-title">{t("settings.loadFailed")}</p>
      <p class="set-fail-hint">{t("settings.err.hint")}</p>
      <button class="btn" type="button" onClick={onRetry}>{t("common.retry")}</button>
      {offlineNow() && <p class="set-fail-hint">{t("settings.err.offline")}</p>}
    </div>
  );
}

function Skeleton({ label }) {
  return (
    <div class="sk-lines set-sk" role="status" aria-label={label}>
      <span class="sk sk-line" />
      <span class="sk sk-line sk-line-60" />
      <span class="sk sk-line sk-line-40" />
    </div>
  );
}

// ---- section bodies -----------------------------------------------------------

function useDefaults() {
  const eff = effectivePrefs();
  const isAdminUser = me.value?.role === "admin";
  const defModel = eff.model?.modelID
    ? eff.model
    : (() => {
        const m = pickDefaultModel(providerCfg.value);
        return m ? { providerID: m.providerID, modelID: m.id } : null;
      })();
  const defEngine = defModel ? engineOf(defModel.providerID) : "opencode";
  const modelSub = defModel ? `${modelName(providerCfg.value, defModel)} · ${ENGINE_SHORT[defEngine]}` : t("settings.models.opencodeServer");
  const agentSub =
    eff.agent ?? me.value?.defaultAgent ?? agents.value.find((a) => a.mode === "primary")?.name ?? agents.value[0]?.name ?? "build";
  const claudeAgentSub = claudeAgentName(eff.claudeAgent, claudeAgents.value ?? []) ?? t("settings.models.noAgent");
  return { eff, isAdminUser, defModel, defEngine, modelSub, agentSub, claudeAgentSub };
}

function NavRow({ href, title, value, hint, icon = null, side = null, active = false, warn = null }) {
  return (
    <li class="card">
      <a class={"set-row set-link" + (active ? " is-active" : "")} href={href} aria-current={active ? "page" : undefined}>
        {icon}
        <div class="set-main">
          <div class="row-title">{title}</div>
          {value != null && <div class="set-value">{value}</div>}
          {warn}
          {hint && <div class="set-hint">{hint}</div>}
        </div>
        {side}
        <span class="set-chevron">
          <Glyph name="chevron" size={18} />
        </span>
      </a>
    </li>
  );
}

function ModelsSection({ sub, done }) {
  const { eff, isAdminUser, defModel, defEngine, modelSub, agentSub, claudeAgentSub } = useDefaults();
  if (sub === "model") {
    return <ModelPicker value={defModel} onPick={(m) => { setPrefs({ model: m }); done(); }} />;
  }
  if (sub === "agent") {
    return <AgentPicker value={eff.agent} onPick={(a) => { setPrefs({ agent: a }); done(); }} />;
  }
  if (sub === "claude-agent") {
    return <ClaudeAgentPicker value={eff.claudeAgent ?? null} onPick={(a) => { setPrefs({ claudeAgent: a }); done(); }} />;
  }
  return (
    <ul class="card-list">
      <NavRow href="#/settings/models/model" title={t("settings.sub.model")}
        value={<>{defModel && <span class={"engine-dot" + (defEngine === "claude" ? " is-claude" : "")} aria-hidden="true" />}{modelSub}</>}
        warn={eff.staleModel ? <div class="set-warn" role="status">{staleModelText(eff)} {t("settings.models.pickAgain")}</div> : null}
        hint={t("settings.models.modelHint")} />
      <NavRow href="#/settings/models/agent" title={<>{t("settings.models.agentTitle")} <span class="engine-tag">· z.ai</span></>}
        value={agentSub}
        hint={
          defEngine === "claude"
            ? t("settings.models.agentHintClaude")
            : isAdminUser
              ? t("settings.models.agentHintAdmin")
              : t("settings.models.agentHintUser")
        } />
      {isAdminUser && (
        <NavRow href="#/settings/models/claude-agent" title={<>{t("settings.models.agentTitle")} <span class="engine-tag">· Claude</span></>}
          value={claudeAgentSub}
          hint={t("settings.models.claudeHint")} />
      )}
    </ul>
  );
}

function PromptSection({ onDirty }) {
  const st = promptState.value;
  useEffect(() => {
    if (st.status === "idle") loadPrompt();
  }, []);
  if (st.status === "error") return <SectionError onRetry={() => loadPrompt()} />;
  if (st.status !== "ready") return <Skeleton label={t("sysprompt.loading")} />;
  return (
    <div class="card set-card-pad" data-feat="FEAT-03.22">
      <p class="set-hint set-lead">{promptHint()}</p>
      <SystemPromptEditor
        key={st.text}
        initial={st.text}
        offline={offlineNow()}
        onDirty={onDirty}
        onSaved={(text) => (promptState.value = { status: "ready", text })}
      />
    </div>
  );
}

function AppearanceSection({ theme, setTheme }) {
  const cur = lang.value;
  return (
    <ul class="card-list">
      <li class="card">
        <div class="set-row is-theme" role="radiogroup" aria-label={t("settings.theme")}>
          <div class="set-main">
            <div class="row-title">{t("settings.theme")}</div>
          </div>
          <div class="seg">
            {THEMES.map((th) => (
              <button
                key={th.id} type="button" role="radio"
                class={"seg-btn" + (theme === th.id ? " active" : "")}
                aria-checked={theme === th.id}
                onClick={() => {
                  setTheme(th.id);
                  applyTheme(th.id);
                }}
              >
                {th.label}
              </button>
            ))}
          </div>
        </div>
      </li>
      <li class="card">
        <div class="set-row is-theme is-lang" role="radiogroup" aria-label={t("settings.language")}>
          <div class="set-main">
            <div class="row-title">{t("settings.language")}</div>
          </div>
          <div class="seg">
            {LANGS.map((l) => (
              <button
                key={l.id} type="button" role="radio" lang={l.id}
                class={"seg-btn" + (cur === l.id ? " active" : "")}
                aria-checked={cur === l.id}
                onClick={() => setLang(l.id)}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
      </li>
    </ul>
  );
}

function McpSection() {
  const mcpList = mcp.value;
  const isAdminUser = me.value?.role === "admin";
  if (mcpList == null) return mcpError.value ? <SectionError onRetry={() => refreshMcp()} /> : <Skeleton label={t("settings.mcp.loading")} />;
  return (
    <ul class="card-list">
      <li class="card">
        <div class="set-row is-mcp">
          <div class="set-main">
            <div class="row-title">{t("settings.section.mcp")}</div>
            {mcpList.length === 0 ? (
              <div class="set-value">{t("settings.mcp.none")}</div>
            ) : (
              <ul class="mcp-list">
                {mcpList.map((s) => {
                  const v = mcpView(s);
                  return (
                    <li key={s.name} class="mcp-row" title={(isAdminUser && v.full) || undefined}>
                      <span class={"mcp-dot is-" + v.tone} aria-hidden="true" />
                      <span class="mcp-name">{s.name}</span>
                      <span class={"mcp-status" + (v.tone === "bad" ? " is-bad" : v.tone === "warn" ? " is-warn" : "")}>{v.text}</span>
                      {/* FEAT-03.21: a tenant gets status only — no cause (the server strips it too). */}
                      {isAdminUser && v.why && <span class="mcp-why">{v.why}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </li>
    </ul>
  );
}

// FEAT-11.18 (макет design/mockups-v2/relay.html, кадры 4–5): карточка на каждого
// подключённого провайдера; вид зависит от того, что провайдер отдаёт.
const CUR = { USD: "$", CNY: "¥", EUR: "€" };
export function fmtMoney(n, currency = "USD") {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = fmtNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return CUR[currency] ? `${CUR[currency]}${v}` : `${v}${NB}${currency}`;
}
// Периодичность сброса лимита ключа — ключи словаря («раз в день» …)
const RESET_KEY = { daily: "settings.subs.reset.daily", weekly: "settings.subs.reset.weekly", monthly: "settings.subs.reset.monthly" };
const resetWord = (interval) => (RESET_KEY[interval] ? t(RESET_KEY[interval]) : interval);
// Текст карточки без данных — причина словами, без кодов и путей.
export function subscriptionNote(card) {
  switch (card?.state) {
    case "no-api":
      if (card.hint === "claude-subscription") return t("settings.subs.note.claude");
      if (card.hint === "management-key") return t("settings.subs.note.managementKey");
      if (card.hint === "console-only") return t("settings.subs.note.consoleOnly");
      return t("settings.subs.note.noApi");
    case "no-key":
      return t("settings.subs.note.noKey");
    case "need-admin-key":
      return t("settings.subs.note.needAdminKey");
    case "error":
      if (card.reason === "401" || card.reason === "403") return t("settings.subs.note.errKey", { reason: card.reason });
      if (card.reason === "network") return t("settings.subs.note.errNetwork");
      if (card.reason === "no-key") return t("settings.subs.note.noKey");
      return t("settings.subs.note.errOther");
    default:
      return null;
  }
}
// «14:32» — местный часовой пояс браузера, локаль языка интерфейса
const timeOf = (ms) => (ms ? fmtClock(ms) || null : null);

// The server labels a card with a short kind word in Russian; product names ("Coding Plan", "API") pass through.
const BADGE_KEYS = { "подписка": "settings.subs.badge.subscription", "ключ API": "settings.subs.badge.apiKey", "баланс": "settings.subs.badge.balance", "провайдер": "settings.subs.badge.provider" };
export const badgeText = (badge) => (BADGE_KEYS[badge] ? t(BADGE_KEYS[badge]) : badge);

function SubscriptionCard({ card }) {
  const note = subscriptionNote(card);
  const plan = card.plan ? ` · ${String(card.plan)[0].toUpperCase() + String(card.plan).slice(1)}` : "";
  const m = card.money;
  const usedPct = m && m.limit > 0 && m.remaining != null ? Math.max(0, Math.min(100, Math.round(((m.limit - m.remaining) / m.limit) * 100))) : null;
  return (
    <li class={"card sub-card is-" + card.state} data-provider={card.id}>
      <div class="set-row is-host">
        <div class="set-main">
          <div class="row-title sub-head">
            <span class="sub-name">{card.title}</span>
            {card.badge ? <span class="sub-badge">{badgeText(card.badge)}{plan}</span> : null}
            {card.state === "ok" && card.fetchedAt ? <span class="sub-at">{t("settings.subs.updated", { time: timeOf(card.fetchedAt) ?? "" })}</span> : null}
          </div>
          {note ? <div class={"set-value is-wrap" + (card.state === "error" ? " is-error" : "")}>{note}</div> : null}
          {card.state === "ok" && Array.isArray(card.windows) ? <QuotaWindows sub={card} /> : null}
          {card.state === "ok" && m ? (
            <div class="sub-money">
              {m.limit != null ? (
                <>
                  <div class="sub-big"><b>{fmtMoney(m.remaining, m.currency)}</b><span>{t("settings.subs.leftOf", { limit: fmtMoney(m.limit, m.currency) })}{m.resetInterval ? ` · ${t("settings.subs.resets", { interval: resetWord(m.resetInterval) })}` : ""}</span></div>
                  {usedPct != null ? <span class="quota-bar" aria-hidden="true"><span class={"host-bar-fill" + (usedPct >= 90 ? " is-high" : "")} style={`width: ${usedPct}%`} /></span> : null}
                </>
              ) : (
                <div class="sub-big"><b>{fmtMoney(m.spent?.month, m.currency)}</b><span>{t("settings.subs.spentMonthNoLimit")}</span></div>
              )}
              <p class="host-note">{t("settings.subs.spend", { day: fmtMoney(m.spent?.day, m.currency), week: fmtMoney(m.spent?.week, m.currency), month: fmtMoney(m.spent?.month, m.currency) })}</p>
            </div>
          ) : null}
          {card.state === "ok" && Array.isArray(card.balances) ? (
            <div class="sub-money">
              {card.balances.map((b) => (
                <div class="sub-big" key={b.currency}><b>{fmtMoney(b.total, b.currency)}</b><span>{b.granted ? t("settings.subs.granted", { amount: fmtMoney(b.granted, b.currency) }) : t("settings.subs.balance")}</span></div>
              ))}
              {card.available === false ? <p class="host-note is-error">{t("settings.subs.insufficient")}</p> : null}
            </div>
          ) : null}
          {card.state === "ok" && card.spend ? (
            <div class="sub-money">
              <div class="sub-big"><b>{fmtMoney(card.spend.amount, card.spend.currency)}</b><span>{t("settings.subs.spentDays", { count: card.spend.days })}</span></div>
              <p class="host-note">{t("settings.subs.spendOnly")}</p>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function SubscriptionSection() {
  const list = subscriptions.value;
  if (list == null) return subscriptionsError.value ? <SectionError onRetry={() => refreshSubscriptions()} /> : <Skeleton label={t("settings.subs.loading")} />;
  if (list.length === 0) return <ul class="card-list"><li class="card"><div class="set-row"><div class="set-main"><div class="set-value is-wrap">{t("settings.subs.none")}</div></div></div></li></ul>;
  return <ul class="card-list">{list.map((c) => <SubscriptionCard key={c.id} card={c} />)}</ul>;
}

function QuotaWindows({ sub }) {
  return (
              <div class="host-list">
                {sub.windows.map((w) => {
                  const high = (w.percent ?? 0) >= 90;
                  const reset = resetParts(w);
                  return (
                    <div key={w.kind} class={"quota-row" + (high ? " is-high" : "")}>
                      <div class="quota-top">
                        <span class="quota-label">{windowLabel(w)}</span>
                        <span class="quota-value">
                          {w.total != null
                            ? `${fmtQuota(w.used, w.type)} / ${fmtQuota(w.total, w.type)}${quotaUnitSuffix(w.type)}`
                            : `${w.percent ?? 0}%`}
                          {w.total != null && w.percent != null && <span class="quota-pct">{w.percent}%</span>}
                        </span>
                      </div>
                      <span class="quota-bar" aria-hidden="true">
                        <span class={"host-bar-fill" + (high ? " is-high" : "")} style={`width: ${Math.max(0, Math.min(100, w.percent ?? 0))}%`} />
                      </span>
                      {reset && (
                        <div class="quota-reset">
                          <span class="nw">{reset.when}</span>
                          <span class="nw">{reset.left}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
                {sub.id === "zai" && sub.windows.some((w) => w.type !== "TOKENS_LIMIT") && (
                  <p class="host-note">{t("settings.quota.creditsNote")}</p>
                )}
              </div>
  );
}

function ComputerSection() {
  const hostStats = host.value;
  if (hostStats == null) return hostError.value ? <SectionError onRetry={() => refreshHost()} /> : <Skeleton label={t("settings.computer.loading")} />;
  const hostRows = [
    { label: "CPU", value: hostStats.cpu?.loadPct != null ? `${hostStats.cpu.loadPct}%` : t("settings.computer.na"), pct: hostStats.cpu?.loadPct },
    {
      label: t("settings.computer.ram"),
      value: t("settings.computer.gb", { used: hostStats.ram?.usedGb, total: hostStats.ram?.totalGb }),
      pct: hostStats.ram?.totalGb ? Math.round((hostStats.ram.usedGb / hostStats.ram.totalGb) * 100) : null,
    },
    ...(hostStats.disks ?? []).map((d) => ({ label: d.drive, value: t("settings.computer.gb", { used: d.usedGb, total: d.totalGb }), pct: d.usedPct })),
  ];
  const temp = tempView(hostStats);
  return (
    <ul class="card-list">
      <li class="card">
        <div class="set-row is-host">
          <div class="set-main">
            <div class="row-title">{t("settings.section.computer")}</div>
            <div class="host-list">
              {hostRows.map((r) => (
                <div key={r.label} class="host-row">
                  <span class="host-label">{r.label}</span>
                  <span class="host-bar" aria-hidden="true">
                    <span class={"host-bar-fill" + ((r.pct ?? 0) >= 90 ? " is-high" : "")} style={`width: ${Math.max(0, Math.min(100, r.pct ?? 0))}%`} />
                  </span>
                  <span class="host-value">{r.value}</span>
                </div>
              ))}
              <div class="host-temp">
                {temp.label}: <b>{temp.value}</b>
                {hostStats.cpu?.cores != null && <> · {t("settings.computer.cores", { n: hostStats.cpu.cores })}</>}
              </div>
              {temp.note && <p class="host-note">{temp.note}</p>}
            </div>
          </div>
        </div>
      </li>
    </ul>
  );
}

function AboutSection() {
  return (
    <ul class="card-list">
      <li class="card">
        <div class="set-row">
          <div class="set-main">
            <div class="row-title">{t("settings.section.about")}</div>
            <div class="set-value is-wrap">{aboutLine(VERSION, about.value ?? host.value)}</div>
          </div>
        </div>
      </li>
      <li class="card">
        <div class="set-row">
          <div class="set-main">
            <div class="row-title">{t("settings.about.session")}</div>
            <div class="set-value">
              {me.value?.name ?? "—"}
              {" · "}{me.value?.role === "admin" ? t("settings.about.roleAdmin") : t("settings.about.roleMember")}
            </div>
          </div>
        </div>
      </li>
    </ul>
  );
}

// ---- the screen ---------------------------------------------------------------

export default function SettingsView({ section = null, sub = null } = {}) {
  const [theme, setTheme] = useState("system");
  const [, setTick] = useState(0); // re-render for the reset countdown lines
  const [leaving, setLeaving] = useState(false);
  const [notif, setNotif] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState(null); // {proceed} — «Выйти без сохранения?»
  const titleRef = useRef(null);
  const swipe = useRef(null);

  const isAdmin = me.value?.role === "admin";
  const voice = voiceInfo.value == null ? null : !!voiceInfo.value.enabled;
  const res = resolveSettings(section, sub, { admin: isAdmin, voice });
  const cur = res && res !== "unknown" ? res : null;

  useEffect(() => {
    const th = storedTheme();
    setTheme(th);
    applyTheme(th); // bring the attribute in sync with the stored choice
    // ISSUE-008: /host and /usage are the owner's machine — admin-only
    // server-side. A tenant never asks for them (no sure 403 + «Повторить»).
    // /mcp answers every role (a tenant: its own servers, FEAT-03.21).
    const admin = me.value?.role === "admin";
    if (providerCfg.value == null || agents.value.length === 0 || mcp.value == null) init();
    if (about.value == null) refreshAbout();
    refreshVoice();
    if (promptState.value.status === "idle" || promptState.value.status === "error") loadPrompt();
    // «Компьютер»: load on mount, then refresh periodically while visible —
    // background tabs skip the poll (phone battery) and catch up on return.
    if (admin) refreshHost();
    const tick = admin ? setInterval(() => { if (!document.hidden) refreshHost(); }, 10_000) : null;
    // «Подписка z.ai»: server caches for 60s, so polling faster is pointless;
    // the small tick only redraws the «через N мин» countdown.
    if (admin) refreshUsage();
    refreshSubscriptions(); // FEAT-11.18: раздел «Подписки» виден всем
    const usageTick = setInterval(() => { if (!document.hidden) { if (admin) refreshUsage(); refreshSubscriptions(); } }, 60_000);
    const countdownTick = setInterval(() => setTick((x) => x + 1), 30_000);
    const onVisible = () => {
      if (!document.hidden && admin) {
        refreshHost();
        refreshUsage();
      }
      if (!document.hidden) refreshSubscriptions();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(tick);
      clearInterval(usageTick);
      clearInterval(countdownTick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // П32.Н1/Н2: an unknown (or someone else's admin) section → the root, the
  // address replaced — nothing of it was rendered meanwhile.
  useEffect(() => {
    if (res === "unknown") navigate("/settings", { replace: true });
  }, [res === "unknown", section, sub]);

  // Root value of «Уведомления» (refreshed when a section is left).
  useEffect(() => {
    let live = true;
    Promise.resolve(pushState?.())
      .then((s) => live && setNotif(s ?? "off"))
      .catch(() => live && setNotif("off"));
    return () => {
      live = false;
    };
  }, [cur?.section ?? null]);

  // П32.У1: the section heading takes the focus (screen reader says where we are).
  useEffect(() => {
    if (cur) titleRef.current?.focus?.({ preventScroll: true });
  }, [cur?.section ?? null, cur?.sub ?? null]);

  // П32.Н4: unsaved prompt → «Выйти без сохранения?» on ‹, swipe, «Назад»,
  // a row of the left column; a reload asks the browser's own question.
  useEffect(() => {
    if (!dirty) {
      setLeaveGuard(null);
      return undefined;
    }
    setLeaveGuard((_next, proceed) => {
      setConfirm({ proceed });
      return false;
    });
    const onUnload = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    addEventListener("beforeunload", onUnload);
    return () => {
      setLeaveGuard(null);
      removeEventListener("beforeunload", onUnload);
    };
  }, [dirty]);

  // «‹» / swipe: to the parent — a history step back when the previous entry
  // IS the parent (forward stays possible), else a new entry (deep link, Н7).
  const goTo = (target) => {
    if (prevPath() === target) history.back();
    else navigate(target);
  };
  const goUp = () => goTo(settingsParent(cur?.section, cur?.sub));
  // The wide-screen ‹ arrow (макет D2: «назад/вперёд по истории разделов»):
  // a history step when the previous entry is a settings screen — so › can
  // come back; no settings behind (deep link) → up to the parent instead.
  const goBackHist = () => {
    if (backIsHistory()) history.back();
    else goUp();
  };

  const onTouchStart = (e) => {
    const p = e.touches?.[0];
    swipe.current = null;
    if (!cur || !p || p.clientX > 20 || (window.innerWidth || 0) >= 1024 || nativeEdgeSwipe()) return;
    swipe.current = { x: p.clientX, y: p.clientY };
  };
  const onTouchEnd = (e) => {
    const s0 = swipe.current;
    swipe.current = null;
    const p = e.changedTouches?.[0];
    if (!s0 || !p) return;
    const dx = p.clientX - s0.x;
    const dy = Math.abs(p.clientY - s0.y);
    if (dx > 70 && dy < 50) goUp();
  };

  // ---- root values ----
  const { defModel } = useDefaults();
  const v = voicePrefs(prefs.value);
  const voices = voiceInfo.value?.voices ?? [];
  const voiceName = voices.find((x) => x.id === v.voice)?.name ?? voices.find((x) => x.id === voiceInfo.value?.defaultVoice)?.name ?? (voice ? t("settings.voice.defaultName") : "");
  const ps = promptState.value;
  const mcpList = mcp.value;
  // FEAT-11.18: значение строки «Подписки» — из карточек провайдеров (их видят все пользователи)
  const subs = subscriptions.value;
  const sub0 = subs?.find((c) => c.id === "zai" && c.state === "ok") ?? null;
  const maxPct = sub0 ? Math.max(0, ...(sub0.windows ?? []).map((w) => w.percent ?? 0)) : null;
  const busyN = Object.keys(busyMap.value ?? {}).length;
  const values = {
    models: defModel ? modelName(providerCfg.value, defModel) : "",
    prompt: ps.status === "ready" ? (ps.text ? t("settings.prompt.set") : t("sysprompt.notSet")) : ps.status === "error" ? "—" : "",
    voice: voiceName,
    appearance: THEMES.find((th) => th.id === theme)?.label ?? "",
    notifications: notif ? t(`settings.notif.${NOTIF_SHORT[notif] ?? "off"}`) : "",
    mcp: mcpList ? (mcpList.length ? t("settings.mcp.connectedCount", { n: mcpList.filter((x) => x.status === "connected").length }) : t("settings.mcp.none")) : mcpError.value ? "—" : "",
    subscription: sub0 ? `${sub0.plan ? String(sub0.plan)[0].toUpperCase() + String(sub0.plan).slice(1) + " · " : ""}${maxPct}${NB}%` : subs ? (subs.length ? t("settings.subs.count", { n: subs.length }) : "—") : subscriptionsError.value ? "—" : "",
    computer: host.value ? (host.value.cpu?.loadPct != null ? `CPU ${host.value.cpu.loadPct}${NB}%` : "") : hostError.value ? "—" : "",
    active: busyN ? String(busyN) : "",
    users: "",
    about: appVersionLabel(VERSION, about.value?.version ?? null),
  };

  const list = sectionsFor({ admin: isAdmin, voice });
  const root = (
    <div class="settings-root">
      <header class="page-header settings-head">
        <button class="icon-btn float-btn settings-close" type="button" aria-label={t("settings.close")} onClick={() => navigate("/")}>
          <Glyph name="close" size={20} />
        </button>
        <h1>{t("common.settings")}</h1>
        <span aria-hidden="true" />
      </header>
      <div class="set-account card">
        <span class="set-avatar" aria-hidden="true">{String(me.value?.name ?? "?").slice(0, 1).toUpperCase()}</span>
        <div class="set-main">
          <div class="row-title">{me.value?.name ?? "—"}</div>
          <div class="set-value">{isAdmin ? t("settings.about.roleAdmin") : t("settings.about.roleUser")} · {appVersionLabel(VERSION, about.value?.version ?? null)}</div>
        </div>
      </div>
      {GROUPS.map((g) => {
        const items = list.filter((x) => x.group === g.id);
        if (!items.length && g.id !== "chats") return null;
        return (
          <section class="set-group" key={g.id} aria-label={g.title ?? t("settings.group.more")}>
            {g.title && <h2 class="set-group-title">{g.title}</h2>}
            <ul class="card-list">
              {items.map((x) => {
                const row = (
                  <NavRow key={x.id} href={"#/settings/" + x.id} title={x.title} value={null} active={cur?.section === x.id}
                    icon={<SetIcon name={x.id} />}
                    side={values[x.id] ? <span class="set-row-value" title={values[x.id]}>{values[x.id]}</span> : null} />
                );
                if (x.id !== "prompt") return row;
                // FEAT-03.19 (П32.У5): a plain switch stays IN the row.
                return [
                  row,
                  <li class="card" key="exec" data-feat="FEAT-03.19">
                    <div class="set-row">
                      <SetIcon name="exec" />
                      <div class="set-main">
                        <div class="row-title" id="exec-detail-title">{t("settings.exec.title")}</div>
                      </div>
                      <button
                        class="switch" type="button" role="switch" aria-labelledby="exec-detail-title"
                        title={t("settings.exec.tip")}
                        aria-checked={execDetailOn(prefs.value) ? "true" : "false"}
                        onClick={() => setPrefs({ execDetail: !execDetailOn(prefs.value) })}
                      />
                    </div>
                  </li>,
                ];
              })}
              {g.id === "bottom" && (
                <li class="card">
                  <div class="set-row">
                    <div class="set-main">
                      <div class="row-title">{t("settings.signOut")}</div>
                      <div class="set-value">{me.value?.name ?? "—"}</div>
                    </div>
                    <button
                      class="access-btn" type="button" disabled={leaving} aria-busy={leaving ? "true" : undefined}
                      onClick={async () => {
                        setLeaving(true);
                        // FEAT-07.20: a signed-out device stops getting this account's pushes.
                        await Promise.race([disablePush().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
                        logout();
                      }}
                    >
                      {leaving ? t("settings.signingOut") : t("settings.signOut")}
                    </button>
                  </div>
                </li>
              )}
            </ul>
          </section>
        );
      })}
    </div>
  );

  let body = null;
  let title = "";
  if (cur) {
    const def = SECTIONS.find((x) => x.id === cur.section);
    title = cur.sub ? subTitle(cur.section, cur.sub) : def.title;
    const id = cur.section;
    body =
      id === "models" ? <ModelsSection sub={cur.sub} done={goUp} />
      : id === "prompt" ? <PromptSection onDirty={setDirty} />
      : id === "voice" ? (voiceInfo.value == null ? <Skeleton label={t("settings.voice.loading")} /> : <ul class="card-list"><VoiceSettings /></ul>)
      : id === "appearance" ? <AppearanceSection theme={theme} setTheme={setTheme} />
      : id === "notifications" ? <ul class="card-list"><NotificationsRow /></ul>
      : id === "mcp" ? <McpSection />
      : id === "subscription" ? <SubscriptionSection />
      : id === "computer" ? <ComputerSection />
      : id === "active" ? <ul class="card-list"><BusySessions /></ul>
      : id === "users" ? <AccessSection />
      : id === "about" ? <AboutSection />
      : null;
  }
  const parentTitle = cur?.sub ? SECTIONS.find((x) => x.id === cur.section)?.title : t("common.settings");
  const crumbs = cur
    ? [{ href: "#/settings", label: t("common.settings") }, ...(cur.sub ? [{ href: `#/settings/${cur.section}`, label: parentTitle }] : [])]
    : [];

  return (
    <div class={"page settings-page" + (cur ? " has-section" : " at-root")} data-req="FEAT-03.23">
      <div class="settings-cols">
        {root}
        <div class="settings-pane" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          {cur ? (
            <div class="settings-section" key={cur.section + "/" + (cur.sub ?? "")} data-section={cur.section}>
              <header class="settings-section-head">
                <button class="set-back" type="button" onClick={goUp} aria-label={t("settings.backTo", { title: parentTitle })}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
                  <span class="set-back-label">{parentTitle}</span>
                </button>
                <nav class="set-crumbs" aria-label={t("settings.crumbs")}>
                  {crumbs.map((c) => (
                    <span key={c.href} class="set-crumb">
                      <a href={c.href}>{c.label}</a>
                      <span class="set-crumb-sep" aria-hidden="true">›</span>
                    </span>
                  ))}
                </nav>
                <h1 class="settings-section-title-h" tabIndex={-1} ref={titleRef}>{title}</h1>
                <span class="set-hist">
                  <button class="icon-btn set-hist-btn" type="button" aria-label={t("common.back")} onClick={goBackHist}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
                  </button>
                  <button class="icon-btn set-hist-btn" type="button" aria-label={t("settings.forward")} disabled={!canGoForward()} onClick={() => history.forward()}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
                  </button>
                </span>
              </header>
              <div class="settings-section-body">{body}</div>
            </div>
          ) : (
            <p class="settings-empty hint">{t("settings.pickSection")}</p>
          )}
        </div>
      </div>
      {confirm && (
        <Modal title={t("settings.leave.title")} onClose={() => setConfirm(null)}>
          <p class="modal-text">{t("settings.leave.text")}</p>
          <div class="modal-actions">
            <button class="btn" type="button" onClick={() => setConfirm(null)}>{t("settings.leave.stay")}</button>
            <button class="btn-danger" type="button" onClick={() => {
              const p = confirm.proceed;
              setConfirm(null);
              setDirty(false);
              setLeaveGuard(null);
              p?.();
            }}>{t("settings.leave.leave")}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
