// FEAT-07.20: Настройки → «Уведомления» (BRIEF-06, design/mockups-v2/settings.html
// кадры 10–14). Переключатель на устройство (подписка этого браузера),
// «Проверить», статус словами; iPhone вне экрана «Домой» — пояснение.
import { useEffect, useState } from "preact/hooks";
import * as pushLib from "../../lib/push.js";
import { t } from "../../lib/i18n.js";

// Texts resolve in the active language at call time (language switch re-renders).
export const hintText = () => t("notify.hint");
export const iosText = () => t("notify.ios");
export const deniedText = () => t("notify.denied");

const VALUE = {
  loading: "notify.state.loading",
  on: "notify.state.on",
  off: "notify.state.off",
  denied: "notify.state.denied",
  "ios-browser": "notify.state.iosBrowser",
  insecure: "notify.state.insecure",
  unsupported: "notify.state.unsupported",
  "server-off": "notify.state.serverOff",
  enabling: "notify.state.enabling",
  disabling: "notify.state.disabling",
};

export function enableErrorText(err) {
  if (err?.code === "denied") return null; // the state itself says it
  if (err?.code === "dismissed") return t("notify.err.dismissed");
  if (err?.code === "server-off") return t("notify.err.serverOff");
  if (err?.code === "push-service") return t("notify.err.pushService");
  if (err?.status === 400) return t("notify.err.rejected");
  return t("notify.err.enable");
}

export function testResultText(r, err) {
  if (r?.ok) return { ok: true, text: t("notify.test.sent") };
  if (err?.status === 409) return { ok: false, text: t("notify.test.notFound") };
  if (err?.status === 502 || r?.ok === false) return { ok: false, text: t("notify.test.notSent") };
  return { ok: false, text: t("notify.test.noConnection") };
}

export default function NotificationsRow({ lib = pushLib }) {
  const [state, setState] = useState("loading");
  const [note, setNote] = useState(null); // {ok, text}
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let live = true;
    lib.pushState().then((s) => live && setState(s)).catch(() => live && setState("off"));
    return () => {
      live = false;
    };
  }, []);

  const on = state === "on";
  const busy = state === "loading" || state === "enabling" || state === "disabling";
  const blocked = ["ios-browser", "insecure", "unsupported", "server-off", "denied"].includes(state);

  async function toggle() {
    if (busy || blocked) return;
    setNote(null);
    if (on) {
      setState("disabling");
      setState(await lib.disablePush().catch(() => "off"));
      return;
    }
    setState("enabling");
    try {
      setState(await lib.enablePush());
    } catch (err) {
      setState(err?.code === "denied" ? "denied" : err?.code === "server-off" ? "server-off" : "off");
      const text = enableErrorText(err);
      if (text) setNote({ ok: false, text });
    }
  }

  async function check() {
    setTesting(true);
    setNote(null);
    try {
      setNote(testResultText(await lib.testPush(), null));
    } catch (err) {
      setNote(testResultText(null, err));
    } finally {
      setTesting(false);
    }
  }

  return (
    <li class="card" data-feat="FEAT-07.20">
      <div class="set-row notif-row">
        <div class="set-main">
          <div class="row-title" id="notif-title">{t("notify.title")}</div>
          <div class={"set-value" + (state === "denied" ? " is-error" : "")}>{t(VALUE[state] ?? VALUE.off)}</div>
          {!blocked && <div class="set-hint">{hintText()}</div>}
        </div>
        <button
          class="switch" type="button" role="switch" aria-labelledby="notif-title"
          aria-checked={on ? "true" : "false"}
          aria-busy={busy ? "true" : undefined}
          disabled={blocked || busy}
          onClick={toggle}
        />
        {state === "ios-browser" && <p class="notif-ios">{iosText()}</p>}
        {state === "denied" && <p class="notif-ios">{deniedText()}</p>}
        {(on || note) && (
          <div class="notif-actions">
            {on && (
              <button class="access-btn" type="button" disabled={testing} aria-busy={testing ? "true" : undefined} onClick={check}>
                {testing ? t("notify.state.loading") : t("notify.test")}
              </button>
            )}
            {note && (
              <span class={"notif-status " + (note.ok ? "is-ok" : "is-error")} role={note.ok ? "status" : "alert"}>
                {note.text}
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
