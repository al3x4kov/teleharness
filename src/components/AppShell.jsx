// AppShell: route container + navigation. FEAT-09.20 (стиль приложения
// Claude): навигация — боковое меню Drawer (телефон: выезжает по ☰ в шапке
// экрана; десктоп >=900px: закреплённая левая панель). Нижний таббар и рейл
// удалены. Views re-mount on path change -> enter animation.
//
// Auth gate: boot() resolves the session cookie → me signal. null = checking,
// false = anonymous (LoginView instead of the shell), user = normal shell.
// Tenant management lives in Настройки (admin-only AccessSection, 2026-11-01):
// the «Доступ» tab is gone; /access deep links redirect there.
import { useEffect } from "preact/hooks";
import { accessTarget, useRoute, navigate } from "../lib/router.js";
import { startKbTrace } from "../lib/kb-trace.js";
import { installAppUpdate } from "../lib/app-update.js";
import { KB_KEY, KB_MOVE_MS, learnKbH, predictFor, shellFrame } from "../lib/kb-predict.js";
import { boot, connection, me, notice, noticeAction, onUnauthorized, setNavigate, setNotice } from "../lib/store.js";
import HomeView from "./views/HomeView.jsx";
import ProjectsView from "./views/ProjectsView.jsx";
import ProjectView from "./views/ProjectView.jsx";
import SettingsView from "./views/SettingsView.jsx";
import LoginView from "./views/LoginView.jsx";
import ChatView from "./views/ChatView.jsx";
import Drawer from "./Drawer.jsx";
import { t } from "../lib/i18n.js";

const VIEWS = { home: HomeView, projects: ProjectsView, project: ProjectView, settings: SettingsView, chat: ChatView };

export default function AppShell() {
  const { view, path, params } = useRoute();

  // Navigation wiring lives here, not in HomeView: createAndOpen() is also
  // called from ProjectView (and any future screen) — AppShell is the only
  // always-mounted component, so the store's navigate is never a no-op.
  // boot() rides the same mount: it resolves /auth/me before anything renders.
  useEffect(() => {
    setNavigate(navigate);
    // A dead/expired/overwritten cookie used to leave the shell fully
    // rendered with every API call failing 401 in the background («dead
    // button»). Drop to the login screen on the FIRST unauthorized answer.
    onUnauthorized(() => {
      me.value = false;
    });
    boot();
    // BUG-179: новая сборка фронта подхватывается при возврате в приложение.
    return installAppUpdate();
  }, []);

  // Pin the shell to the visual viewport (CSS: .shell height: var(--vvh)).
  // iOS Safari overlays the keyboard without resizing the layout viewport and
  // pans the page to reveal the focused input — the tab bar floated above a
  // blank strip. Following visualViewport.height removes the need to pan.
  // .kb marks «keyboard open» (typing + viewport shrank well past its tallest
  // state): the tab bar's safe-area strip collapses (.kb .tabbar). Pinch-zoom
  // also resizes the visual viewport — ignored via scale !== 1.
  //
  // Device hardening (BUG-003, iPhone 17 Pro Max / iOS 26, репорт 2026-11-02):
  // в сессии клавиатуры Safari может ЗАМОРОЗИТЬ vv.height (или не прислать
  // resize вовсе) — --vvh оставался до-клавиатурным, документ не сжимался,
  // iOS панорамировал страницу до низа: композер-щелчок вверху экрана, под
  // ним таббар, ниже чернота до клавиатуры. Два слоя защиты:
  //  1) высота = min(vv.height, innerHeight) пока typing — если один сигнал
  //     застыл, второй честно уменьшается;
  //  2) опрос 300мс, пока фокус в поле: работает даже если НИ одного события
  //     resize не пришло (kb-shell диспатчит их сам и ловить такое не умеет).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const root = document.documentElement;
    let tall = vv.height;
    let pred = null;
    let kbH = null;
    try {
      kbH = Number(localStorage.getItem(KB_KEY)) || null;
    } catch {}
    let raf = 0;
    const timers = [];
    let poll = 0;
    const apply = () => {
      // Pinch-zoom тоже ресайзит visual viewport — это транзитное состояние,
      // его пропускаем; пропуск НЕ теряет обновление навсегда: расписание
      // ниже перезапускает apply, когда жест уляжется (scale вернётся в 1).
      if (vv.scale !== 1) return;
      if (vv.height > tall) tall = vv.height;
      const tag = document.activeElement?.tagName;
      const typing = tag === "TEXTAREA" || tag === "INPUT";
      // BUG-177 (запись с iPhone): Safari сообщает новую высоту с опозданием
      // ~130–150 мс — пока предсказание в силе, верим ему (src/lib/kb-predict.js).
      const now = performance.now();
      const { h, kb } = shellFrame({ vvH: vv.height, innerH: window.innerHeight || vv.height, tall, typing, pred, now });
      if (pred && (now >= pred.until || Math.abs(vv.height - pred.base) >= 2)) pred = null;
      if (kb && !pred) {
        const k = learnKbH(tall, h);
        if (k && k !== kbH) {
          kbH = k;
          try {
            localStorage.setItem(KB_KEY, String(k));
          } catch {}
        }
      }
      root.style.setProperty("--vvh", `${h}px`);
      // The offset matters as much as the height: WebKit shifts the visual
      // viewport down the document (offsetTop > 0, scrollY === 0) instead of
      // scrolling — .shell anchors at top: var(--vv-top) to follow it.
      root.style.setProperty("--vv-top", `${vv.offsetTop}px`);
      root.classList.toggle("kb", kb);
      // Legacy pan (actual window scroll): undo it — nothing to scroll anymore.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    const stopPoll = () => {
      if (poll) {
        clearInterval(poll);
        poll = 0;
      }
    };
    // BUG-177 (видео владельца 2026-11-05): клавиатура iOS едет ~0,3 с, а
    // visualViewport меняется ПОКАДРОВО при редких событиях — один apply()
    // через кадр оставлял шелл на 12–14 кадров мимо видимой области (шапка
    // уезжала, поле ввода прыгало на середину). Теперь: apply() сразу на
    // событии и покадровый цикл ещё ~0,8 с после последнего сигнала.
    let follow = 0;
    const tick = () => {
      apply();
      raf = performance.now() < follow ? requestAnimationFrame(tick) : 0;
    };
    const schedule = () => {
      apply();
      follow = performance.now() + 800;
      if (!raf) raf = requestAnimationFrame(tick);
      timers.push(setTimeout(apply, 900));
    };
    apply();
    // Named handlers: the cleanup must remove exactly these (CC-22 — the old
    // anonymous ones leaked and doubled the 300ms poll on every remount).
    // BUG-177: admin device trace of the keyboard transition (src/lib/kb-trace.js).
    const trace = (e, kind) => {
      const tag = e?.target?.tagName;
      if (me.value?.role === "admin" && (tag === "TEXTAREA" || tag === "INPUT")) startKbTrace(kind);
    };
    const isText = (e) => e?.target?.tagName === "TEXTAREA" || e?.target?.tagName === "INPUT";
    // BUG-177: предсказанный переход не прыжком, а вместе с клавиатурой (.kb-move → transition).
    let moveTimer = 0;
    const move = () => {
      if (!pred) return;
      root.classList.add("kb-move");
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => root.classList.remove("kb-move"), KB_MOVE_MS + 50);
    };
    const onFocusOut = (e) => {
      trace(e, "blur");
      if (isText(e)) pred = predictFor("close", { vvH: vv.height, tall, kbH, now: performance.now() });
      move();
      stopPoll();
      schedule();
    };
    const onFocusIn = (e) => {
      trace(e, "focus");
      if (isText(e)) pred = predictFor("open", { vvH: vv.height, tall, kbH, now: performance.now() });
      move();
      stopPoll();
      if (poll === 0) poll = setInterval(apply, 300);
      schedule();
    };
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      stopPoll();
      cancelAnimationFrame(raf);
      clearTimeout(moveTimer);
      root.classList.remove("kb-move");
      for (const id of timers) clearTimeout(id);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("focusin", onFocusIn);
      root.style.removeProperty("--vvh");
      root.classList.remove("kb");
    };
  }, []);

  // The «Доступ» tab is gone; old deep links land in Настройки, where the
  // admin section now lives (AccessSection, admin-only server-side too).
  // Up here with the other hooks — after-conditional hooks break Preact.
  // FEAT-03.23 (П32.Н11): /access → «Пользователи» for admin, the settings
  // root for everyone else (no hint that such a section exists).
  useEffect(() => {
    if (view !== "access") return;
    const to = accessTarget(me.value);
    if (to) navigate(to, { replace: true });
  }, [view, me.value]);

  // Login gate: the cookie check runs first; the splash avoids a flash of
  // the whole portal for anonymous devices (SSE would also 401-loop).
  const user = me.value;
  if (user === null) {
    return (
      <div class="login-splash" role="status" aria-label={t("shell.checkingLogin")}>
        <span class="login-splash-dot" />
      </div>
    );
  }
  if (user === false) return <LoginView />;
  if (view === "access") return null; // one frame until the redirect lands

  const View = VIEWS[view] ?? HomeView;
  const conn = connection.value; // R-20: offline / «Связь восстановлена»
  return (
    <div class="shell">
      <Drawer view={view} chatId={view === "chat" ? params.id : null} />
      {/* FEAT-03.23: the settings sections share one mount — a section change
          keeps the layout (and unsaved input across a resize, П32.Н8). */}
      <main class={"view" + (conn.state === "offline" || conn.restoredAt ? " has-conn" : "")} key={view === "settings" ? "settings" : path}>
        {conn.state === "offline" ? (
          <div class="conn-bar is-offline" role="status">{t("shell.offline")}</div>
        ) : conn.restoredAt ? (
          <div class="conn-bar is-restored" role="status">{t("shell.restored")}</div>
        ) : null}
        {notice.value && (
          <div class="notice-bar global" role="status">
            <span class="notice-text">{notice.value}</span>
            {noticeAction.value && (
              <button class="notice-action" type="button" onClick={() => {
                const a = noticeAction.value;
                setNotice(null);
                a?.run?.();
              }}>{noticeAction.value.label}</button>
            )}
            <button class="notice-close" type="button" aria-label={t("shell.closeNotice")} onClick={() => setNotice(null)}>×</button>
          </div>
        )}
        <View {...params} />
      </main>
    </div>
  );
}
