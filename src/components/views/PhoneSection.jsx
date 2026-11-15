// FEAT-18.2: Настройки → «Подключить телефон». Opening the section mints a
// one-time sign-in link for the CURRENT user (POST /auth/pair) and shows it
// as a QR code (shared/qr.js, drawn as SVG — no dependencies), the link with
// «Скопировать», «Действует до HH:MM» and «Новый код». Without
// TELEHARNESS_PUBLIC_URL the server mints nothing: the screen names the setting and
// shows no QR (never a loopback address the phone cannot reach).
import { useEffect, useRef, useState } from "preact/hooks";
import { pairPhone } from "../../lib/store.js";
import { copyText } from "../../lib/clipboard.js";
import { qrEncode, qrSvgPath } from "../../../shared/qr.js";
import { locale, t } from "../../lib/i18n.js";

export const phoneHint = () => t("phone.hint");
export const notConfiguredText = () => t("phone.notConfigured");

export function pairIssueError(err) {
  if (err?.status === 429) return t("phone.tooMany");
  if (!err?.status) return t("phone.offline");
  return t("phone.failed", { status: err.status });
}

export const timeHM = (iso) => new Date(iso).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });

const QUIET = 4; // quiet zone in modules (ISO/IEC 18004)

export function QrSvg({ text, label = t("phone.qrLabel") }) {
  let qr = null;
  try {
    qr = qrEncode(text);
  } catch {
    return null; // longer than version 10 — the link below still works
  }
  const n = qr.size + QUIET * 2;
  return (
    <svg class="pair-qr" viewBox={`0 0 ${n} ${n}`} role="img" aria-label={label} shape-rendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={qrSvgPath(qr.modules, QUIET)} fill="#000" />
    </svg>
  );
}

export default function PhoneSection({ request = pairPhone, copy = copyText }) {
  // phase: loading | ready | expired | unconfigured | error
  const [st, setSt] = useState({ phase: "loading" });
  const [copied, setCopied] = useState(false);
  const live = useRef(true);
  const timer = useRef(0);

  async function load() {
    clearTimeout(timer.current);
    setCopied(false);
    setSt({ phase: "loading" });
    try {
      const r = await request();
      if (!live.current) return;
      if (!r?.configured || !r.url) return setSt({ phase: "unconfigured" });
      setSt({ phase: "ready", url: r.url, expiresAt: r.expiresAt });
      const left = Date.parse(r.expiresAt) - Date.now();
      if (left > 0 && left < 2 ** 31) timer.current = setTimeout(() => live.current && setSt((s) => (s.url === r.url ? { ...s, phase: "expired" } : s)), left);
    } catch (err) {
      if (live.current) setSt({ phase: "error", text: pairIssueError(err) });
    }
  }

  useEffect(() => {
    live.current = true;
    load();
    return () => {
      live.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  if (st.phase === "unconfigured") {
    return (
      <ul class="card-list" data-feat="FEAT-18.2">
        <li class="card">
          <div class="set-row">
            <div class="set-main">
              <div class="row-title">{t("phone.unsetTitle")}</div>
              <div class="set-value is-wrap pair-unset">{notConfiguredText()}</div>
            </div>
          </div>
        </li>
      </ul>
    );
  }

  const busy = st.phase === "loading";
  return (
    <ul class="card-list" data-feat="FEAT-18.2">
      <li class="card">
        <div class="pair-box">
          <p class="hint pair-hint">{phoneHint()}</p>
          {busy && <div class="pair-qr pair-qr-wait" role="status" aria-label={t("phone.loading")} />}
          {(st.phase === "ready" || st.phase === "expired") && (
            <div class={"pair-qr-wrap" + (st.phase === "expired" ? " is-expired" : "")}>
              <QrSvg text={st.url} />
            </div>
          )}
          {st.phase === "ready" && <div class="pair-until">{t("phone.validUntil", { time: timeHM(st.expiresAt) })}</div>}
          {st.phase === "expired" && <div class="pair-until is-expired" role="status">{t("phone.expired")}</div>}
          {st.phase === "error" && <div class="pair-error" role="alert">{st.text}</div>}
          {st.phase === "ready" && (
            <div class="pair-link">
              <input class="pair-url" type="text" readOnly value={st.url} aria-label={t("phone.linkLabel")} onFocus={(e) => e.currentTarget.select()} />
              <button class="access-btn" type="button" onClick={async () => setCopied(await copy(st.url))}>
                {copied ? t("phone.copied") : t("phone.copy")}
              </button>
            </div>
          )}
          <button class="access-btn is-primary pair-new" type="button" disabled={busy} aria-busy={busy ? "true" : undefined} onClick={load}>
            {busy ? t("phone.getting") : t("phone.newCode")}
          </button>
        </div>
      </li>
    </ul>
  );
}
