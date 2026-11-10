// AccessSection: admin-only tenant management, rendered inside Настройки
// (the «Доступ» tab is gone — user request 2026-11-01). Create users (the
// plaintext token is shown ONCE in a modal and auto-copied), per-account
// labelled actions: «Выключить», «Перевыпустить токен», «Удалить» — each
// confirmed with its consequences spelled out (FEAT-03.11).
// Everything here mirrors server-side admin routes — the UI is convenience,
// the 403 wall is server-side. The token modal portals to <body>: fixed
// overlays inside a touch scroller drift on iOS (vault lesson).
//
// Server stores only token HASHES — plaintext is never retrievable, so there
// is no «copy token» action: «Перевыпустить токен» replaces it (the old one
// stops working — said before the second tap) and shows the new one once.
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { admin, me, rotateOwnToken } from "../../lib/store.js";
import { copyText } from "../../lib/clipboard.js";
import { locale, t } from "../../lib/i18n.js";
import { Glyph, useModalFocus } from "../Pickers.jsx";
import "../views.css";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,31}$/;

const CREATE_ERR_RU = {
  400: () => t("access.err.name"),
  409: (n) => t("access.err.taken", { name: n }),
};

// A-8: network failure vs server refusal.
// Server codes (BUG-12.10 / ADR-004): 403 refusal, 429 rate limit, 400 bad
// field (e.g. a directory the path policy rejects).
export function actionErrorText(err) {
  if (err?.status === 403) return t("access.err.403");
  if (err?.status === 429) return t("access.err.429");
  if (err?.status === 400) return t("access.err.400");
  if (err?.status === 404) return t("access.err.404");
  return t("access.err.other");
}

// Engines of an account (ADR-004): opencode always; Claude only when the
// admin enabled it (the tenant then runs the CLI in its restricted profile).
export function enginesOfUser(u) {
  const list = Array.isArray(u?.engines) && u.engines.length ? u.engines : ["opencode"];
  return u?.role === "admin" ? ["opencode", "claude"] : list;
}

// BUG-04.6 / BUG-077: DELETE answers {ok, removedSessions, removedDirs,
// warnings}. The account is gone either way; what stayed behind is said
// plainly (which folders, whether the server retries). null = nothing to say.
export function deleteWarningsText(name, res) {
  const warnings = Array.isArray(res?.warnings) ? res.warnings : [];
  if (warnings.length === 0) return null;
  const lines = [];
  const folders = warnings.filter((w) => w?.kind === "folder");
  const retried = folders.filter((w) => w.retry);
  const manual = folders.filter((w) => !w.retry);
  const list = (ws) => ws.map((w) => w.path || t("access.del.folder")).join(", ");
  if (retried.length) {
    lines.push(t("access.del.retried", { label: t(retried.length === 1 ? "access.del.folderLeft" : "access.del.foldersLeft"), list: list(retried) }));
  }
  if (manual.length) lines.push(t("access.del.manual", { list: list(manual) }));
  const chats = warnings.filter((w) => w?.kind === "session");
  if (chats.length) lines.push(t("access.del.chats", { n: chats.length }));
  for (const w of warnings) {
    if (w?.kind !== "folder" && w?.kind !== "session" && w?.reason) lines.push(`${w.reason[0].toUpperCase()}${w.reason.slice(1)}.`);
  }
  return { title: t("access.del.title", { name }), lines };
}

function fmtDate(iso) {
  try {
    return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
  } catch {
    return "";
  }
}

function baseName(p) {
  return String(p ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
}

// Select the token text so a manual copy is one gesture when the clipboard
// API is unavailable (plain-http LAN, denied permission — A-6).
function selectNode(el) {
  try {
    const sel = globalThis.getSelection?.();
    if (!sel || !el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {}
}

// kind: "create" | "regen". The token is shown exactly once (FEAT-03.11):
// the server keeps only its hash, so the texts say so plainly.
export function TokenModal({ title, token, autoCopied, kind = "create", userName = "", onClose }) {
  const [copied, setCopied] = useState(Boolean(autoCopied));
  const [failed, setFailed] = useState(!autoCopied);
  const tokenRef = useRef(null);
  const boxRef = useRef(null);
  // BUG-01.38: focus inside the dialog (Tab cycles there, the page behind is
  // inert), back to «Создать»/«Новый токен» on close.
  useModalFocus(boxRef, { inertShell: true });
  useEffect(() => {
    boxRef.current?.focus({ preventScroll: true });
    if (!autoCopied) selectNode(tokenRef.current);
  }, []);
  const copy = async () => {
    if (await copyText(token)) {
      setCopied(true);
      setFailed(false);
    } else {
      setFailed(true);
      selectNode(tokenRef.current);
    }
  };
  const after = kind === "regen"
    ? t("access.token.afterRegen")
    : t("access.token.afterCreate", { name: userName || t("access.token.owner") });
  return createPortal(
    <div class="access-modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={boxRef}>
      <div class="access-modal-card">
        <div class="access-modal-title">{title}</div>
        <code class={"access-token" + (failed ? " is-selected" : "")} ref={tokenRef} onclick={(e) => e.stopPropagation()}>{token}</code>
        {failed ? (
          <div class="access-modal-note is-warn" role="alert">
            {t("access.token.copyFailed")}
          </div>
        ) : copied ? (
          <div class="access-modal-note is-ok" role="status">
            <Glyph name="check" size={16} />{t("access.token.copied")}
          </div>
        ) : null}
        {!failed && <div class="access-modal-note">{after}</div>}
        <div class="access-modal-actions">
          {copied ? (
            <>
              <button class="access-btn" type="button" onClick={copy}>
                <Glyph name="copy" size={16} />{t("access.token.copyAgain")}
              </button>
              <button class="access-btn is-primary" type="button" onClick={onClose}>{t("common.done")}</button>
            </>
          ) : (
            <>
              <button class="access-btn is-primary" type="button" onClick={copy}>
                <Glyph name="copy" size={16} />{t("access.token.copy")}
              </button>
              <button class="access-btn" type="button" onClick={onClose}>{t("common.close")}</button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// What each action does, said BEFORE it happens (A-3). warn = reversible.
export function confirmText(kind, u) {
  if (kind === "self") return { tone: "warn", text: t("access.confirm.self") };
  const name = u.name;
  if (kind === "claude") {
    return enginesOfUser(u).includes("claude")
      ? { tone: "warn", text: t("access.confirm.claudeRevoke", { name }) }
      : { tone: "warn", text: t("access.confirm.claudeGrant", { name }) };
  }
  if (kind === "delete") return { tone: "danger", text: t("access.confirm.delete", { name }) };
  if (kind === "regen") return { tone: "warn", text: t("access.confirm.regen", { name }) };
  return u.disabled
    ? { tone: "warn", text: t("access.confirm.enable", { name }) }
    : { tone: "warn", text: t("access.confirm.disable", { name }) };
}

const ACTION_LABEL = {
  toggle: (u) => (u.disabled ? [t("access.action.enable"), t("access.action.enableYes")] : [t("access.action.disable"), t("access.action.disableYes")]),
  regen: () => [t("access.action.regen"), t("access.action.regenYes")],
  delete: () => [t("common.delete"), t("access.action.deleteYes")],
  claude: (u) => (enginesOfUser(u).includes("claude")
    ? [t("access.action.claudeRevoke"), t("access.action.claudeRevokeYes")]
    : [t("access.action.claudeGrant"), t("access.action.claudeGrantYes")]),
  self: () => [t("access.action.self"), t("access.action.selfYes")],
};
const ACTION_GLYPH = { toggle: "power", regen: "key", delete: "trash", claude: "power", self: "key" };

// Per-account LABELLED actions (A-1/A-2, FEAT-03.11): «Выключить»,
// «Перевыпустить токен» (not a copy icon — the old token cannot be copied,
// only replaced), «Удалить». First tap arms: the button says «Да, …», a
// consequences block with «Отмена» appears and the other buttons lock.
function UserCard({ u, mine, armed, onArm, onRegen, onToggle, onDelete, onClaude, onSelfToken, busy }) {
  const isArmed = armed?.id === u.id;
  const arm = (kind) => onArm({ id: u.id, kind });
  const exec = (kind) =>
    kind === "regen" ? onRegen(u)
      : kind === "toggle" ? onToggle(u)
        : kind === "claude" ? onClaude(u)
          : kind === "self" ? onSelfToken(u)
            : onDelete(u);
  const confirm = isArmed ? confirmText(armed.kind, u) : null;
  const confirmId = `acct-confirm-${u.id}`;
  const actionBtn = (kind) => {
    const armedNow = isArmed && armed.kind === kind;
    const [label, armedLabel] = ACTION_LABEL[kind](u);
    const danger = kind === "delete";
    const armedCls = armedNow ? (confirm?.tone === "danger" ? " is-armed" : " is-warn-armed") : "";
    return (
      <button
        class={"access-btn" + (danger ? " is-danger" : "") + armedCls}
        type="button"
        disabled={busy === u.id || (isArmed && !armedNow)}
        aria-describedby={armedNow ? confirmId : undefined}
        onClick={() => (armedNow ? exec(kind) : arm(kind))}
      >
        {busy === u.id && armedNow ? <span class="btn-spin" aria-hidden="true" /> : <Glyph name={ACTION_GLYPH[kind]} size={16} />}
        {armedNow ? armedLabel : label}
      </button>
    );
  };

  return (
    <li class="card">
      <div class="set-row is-host access-user">
        <div class="set-main">
          <div class="row-title">
            {u.name}
            {u.role === "admin" && <span class="access-badge is-admin">{t("access.badge.admin")}</span>}
            {u.disabled && <span class="access-badge is-off">{t("access.badge.disabled")}</span>}
            {mine && <span class="access-badge">{t("access.badge.you")}</span>}
          </div>
          <div class="access-meta">
            <span title={u.directories?.[0] ?? ""}>
              {t("access.meta.chats", { v: u.directories?.length ? baseName(u.directories[0]) : "—" })}
              {u.directories?.length > 1 ? ` (+${u.directories.length - 1})` : ""}
            </span>
            <span title={u.obsidianRoot ?? ""}>obsidian: {u.obsidianRoot ? baseName(u.obsidianRoot) : t("access.meta.wholeVault")}</span>
            <span>{t("access.meta.engines", { v: enginesOfUser(u).map((e) => (e === "claude" ? "Claude" : "z.ai")).join(", ") })}</span>
            {u.createdAt && <span>{t("access.meta.since", { date: fmtDate(u.createdAt) })}</span>}
          </div>
          {(u.role !== "admin" || mine) && (
            <>
              <div class="acct-actions">
                {u.role !== "admin" && actionBtn("toggle")}
                {u.role !== "admin" && actionBtn("claude")}
                {u.role !== "admin" && actionBtn("regen")}
                {mine && actionBtn("self")}
                {u.role !== "admin" && actionBtn("delete")}
              </div>
              {confirm && (
                <div class={"acct-confirm" + (confirm.tone === "warn" ? " is-warn" : "")} id={confirmId} role="status">
                  <Glyph name="alert" size={16} />
                  <span>
                    {confirm.text}{" "}
                    <button class="link-btn" type="button" onClick={() => onArm(null)}>{t("common.cancel")}</button>
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

export default function AccessSection() {
  const [list, setList] = useState(null);
  const [loadErr, setLoadErr] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState("");
  const [modal, setModal] = useState(null); // {title, token, autoCopied}
  const [armed, setArmed] = useState(null); // {id, kind} — two-tap confirm
  const [busy, setBusy] = useState(null); // user id with an in-flight action
  const [actErr, setActErr] = useState("");
  const [delNote, setDelNote] = useState(null); // deleteWarningsText() of the last delete

  const refresh = async () => {
    try {
      const users = await admin.users();
      setList(users);
      setLoadErr(false);
    } catch {
      setLoadErr(true);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const arm = (next) =>
    setArmed((cur) => (next == null || (cur?.id === next.id && cur.kind === next.kind) ? null : next));

  const create = async (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || creating) return;
    if (!NAME_RE.test(n)) {
      setCreateErr(CREATE_ERR_RU[400](n));
      return;
    }
    setCreating(true);
    setCreateErr("");
    try {
      const { user, token } = await admin.create({ name: n });
      const ok = await copyText(token);
      setModal({ title: t("access.modal.token", { name: user.name }), token, autoCopied: ok, kind: "create", userName: user.name });
      setName("");
      await refresh();
    } catch (err) {
      setCreateErr(CREATE_ERR_RU[err?.status]?.(n) ?? t("access.err.create"));
    } finally {
      setCreating(false);
    }
  };

  const withBusy = async (u, fn) => {
    setBusy(u.id);
    try {
      await fn();
      setArmed(null);
      setActErr("");
      await refresh();
    } catch (err) {
      setActErr(actionErrorText(err));
    } finally {
      setBusy(null);
    }
  };

  const regenerate = (u) =>
    withBusy(u, async () => {
      const { token } = await admin.regenerateToken(u.id);
      const ok = await copyText(token);
      setModal({ title: t("access.modal.newToken", { name: u.name }), token, autoCopied: ok, kind: "regen", userName: u.name });
    });

  const toggle = (u) => withBusy(u, () => admin.update(u.id, { disabled: !u.disabled }));
  const toggleClaude = (u) =>
    withBusy(u, () => {
      const has = enginesOfUser(u).includes("claude");
      return admin.update(u.id, { engines: has ? ["opencode"] : ["opencode", "claude"] });
    });
  // FEAT-03.11: the caller's own token (admin included). The server sets a
  // fresh cookie for this device; other devices are logged out.
  const selfToken = (u) =>
    withBusy(u, async () => {
      const { token } = await rotateOwnToken();
      const ok = await copyText(token);
      setModal({ title: t("access.modal.ownToken"), token, autoCopied: ok, kind: "regen", userName: u.name });
    });
  const remove = (u) =>
    withBusy(u, async () => {
      setDelNote(null);
      const res = await admin.remove(u.id);
      setDelNote(deleteWarningsText(u.name, res));
    });

  return (
    <>
      <h2 class="settings-section-title">
        {t("access.title")}
        <span class="access-badge is-admin">{t("access.badge.adminShort")}</span>
      </h2>
      {actErr && (
        <div class="access-acterr" role="alert">
          {actErr}{" "}
          <button type="button" class="link-btn" onClick={refresh}>{t("access.refreshList")}</button>
        </div>
      )}
      {delNote && (
        <div class="acct-confirm is-warn access-delwarn" role="alert">
          <Glyph name="alert" size={16} />
          <span>
            <b>{delNote.title}</b>
            {delNote.lines.map((l) => (
              <span class="access-delwarn-line" key={l}>{l}</span>
            ))}
            <button type="button" class="link-btn" onClick={() => setDelNote(null)}>{t("access.gotIt")}</button>
          </span>
        </div>
      )}

      <ul class="card-list">
        <li class="card">
          <form class="set-row access-create" onSubmit={create}>
            <div class="set-main">
              <div class="row-title">{t("access.newUser")}</div>
              <input
                class={"access-input" + (createErr ? " is-invalid" : "")} type="text" autocomplete="off" spellcheck={false}
                placeholder={t("access.namePlaceholder")} aria-label={t("access.nameLabel")}
                aria-invalid={createErr ? "true" : undefined}
                aria-describedby={createErr ? "access-create-err" : undefined}
                value={name}
                onInput={(e) => {
                  setName(e.currentTarget.value);
                  setCreateErr("");
                }}
              />
              {createErr && <div class="set-value is-error" id="access-create-err" role="alert">{createErr}</div>}
              <div class="access-meta">
                {t("access.createNote")}
              </div>
            </div>
            <button class="access-btn is-primary" type="submit" disabled={creating || !name.trim()} aria-busy={creating ? "true" : undefined}>
              {creating && <span class="btn-spin" aria-hidden="true" />}
              {creating ? t("access.creating") : t("access.create")}
            </button>
          </form>
        </li>

        {list == null ? (
          loadErr ? (
            <li class="card">
              <div class="set-row">
                <div class="set-main">
                  <div class="set-value is-error" role="alert">
                    {t("access.loadFailed")}{" "}
                    <button type="button" class="link-btn" onClick={refresh}>{t("common.retry")}</button>
                  </div>
                </div>
              </div>
            </li>
          ) : (
            <li class="card">
              <div class="set-row">
                <div class="sk-lines" role="status" aria-label={t("access.loading")}>
                  <span class="sk sk-line" />
                  <span class="sk sk-line sk-line-60" />
                </div>
              </div>
            </li>
          )
        ) : (
          list.map((u) => (
            <UserCard
              key={u.id}
              u={u}
              mine={me.value?.id === u.id}
              armed={armed}
              onArm={arm}
              onRegen={regenerate}
              onToggle={toggle}
              onDelete={remove}
              onClaude={toggleClaude}
              onSelfToken={selfToken}
              busy={busy}
            />
          ))
        )}
      </ul>

      {modal && (
        <TokenModal
          title={modal.title} token={modal.token} autoCopied={modal.autoCopied}
          kind={modal.kind} userName={modal.userName} onClose={() => setModal(null)}
        />
      )}
    </>
  );
}
