// FEAT-03.22: Настройки → «Системный промпт» (BRIEF-06, design/mockups-v2/
// settings.html кадры 15–17). The user's own prompt, stored in the account
// on the server (GET/PUT /zai/api/me/system-prompt), added to the built-in
// system prompt of every turn in every chat of this user (both engines).
import { useEffect, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { Glyph, PickerSheet } from "../Pickers.jsx";
import { api, explainApiError } from "../../lib/api.js";
import { t } from "../../lib/i18n.js";

export const MAX = 4000;
// Texts resolve in the active language at call time (language switch re-renders).
export const promptHint = () => t("sysprompt.hint");
export const promptPlaceholder = () => t("sysprompt.placeholder");

// Code points, as the server counts them (an emoji is one character).
export const charCount = (s) => [...(s ?? "")].length;

// The row's value: the first non-empty line, or «Не задан».
export function promptPreview(text) {
  const line = String(text ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  return line ?? t("sysprompt.notSet");
}

export default function SystemPromptRow({ client = api }) {
  const [state, setState] = useState({ status: "loading", text: "" }); // loading | ready | error
  const [open, setOpen] = useState(false);

  const load = async () => {
    setState((s) => ({ ...s, status: "loading" }));
    try {
      const r = await client.getSystemPrompt();
      setState({ status: "ready", text: typeof r?.text === "string" ? r.text : "" });
    } catch {
      setState((s) => ({ ...s, status: "error" }));
    }
  };
  useEffect(() => {
    load();
  }, []);

  return (
    <li class="card" data-feat="FEAT-03.22">
      {state.status === "error" ? (
        <div class="set-row">
          <div class="set-main">
            <div class="row-title">{t("sysprompt.title")}</div>
            <div class="set-value is-error">
              {t("settings.loadFailed")}{" "}
              <button type="button" class="link-btn" onClick={load}>{t("common.retry")}</button>
            </div>
          </div>
        </div>
      ) : (
        <button class="set-row" type="button" disabled={state.status === "loading"} onClick={() => setOpen(true)}>
          <div class="set-main">
            <div class="row-title">{t("sysprompt.title")}</div>
            {state.status === "loading" ? (
              <div class="sk-lines" role="status" aria-label={t("sysprompt.loading")}>
                <span class="sk sk-line sk-line-60" />
              </div>
            ) : (
              <div class={"set-value" + (state.text ? "" : " is-empty")}>{promptPreview(state.text)}</div>
            )}
            <div class="set-hint">{promptHint()}</div>
          </div>
          <span class="set-chevron">
            <Glyph name="chevron" size={18} />
          </span>
        </button>
      )}
      {open && (
        <SystemPromptSheet
          client={client}
          initial={state.text}
          onClose={() => setOpen(false)}
          onSaved={(text) => {
            setState({ status: "ready", text });
            setOpen(false);
          }}
        />
      )}
    </li>
  );
}

export function SystemPromptSheet({ client = api, initial = "", onClose, onSaved }) {
  return (
    <PickerSheet title={t("sysprompt.title")} onClose={onClose}>
      <SystemPromptEditor client={client} initial={initial} onSaved={onSaved} />
    </PickerSheet>
  );
}

// The editor itself — in the sheet (SystemPromptRow) and inline in the
// «Системный промпт» section of the nested settings (FEAT-03.23, кадр E8).
// onDirty(bool): typed text differs from the saved one (the section asks
// «Выйти без сохранения?», П32.Н4). offline: saving is off with «Нет связи»
// (Н10). A failed save keeps the text and says why under the field (Н5).
export function SystemPromptEditor({ client = api, initial = "", onSaved, onDirty = null, offline = false }) {
  const [text, setText] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const n = charCount(text);
  const tooLong = n > MAX;
  const changed = text.trim() !== initial.trim();
  useEffect(() => {
    onDirty?.(changed);
  }, [changed]);
  useEffect(() => () => onDirty?.(false), []);

  const save = async (value) => {
    setSaving(true);
    setError(null);
    try {
      const r = await client.setSystemPrompt(value);
      const saved = typeof r?.text === "string" ? r.text : value.trim();
      setSaving(false);
      onSaved?.(saved);
    } catch (err) {
      setError(explainApiError(err, t("sysprompt.saveFailed")));
      setSaving(false);
    }
  };

  return (
    <>
      <div class="sysprompt">
        <textarea
          class="sysprompt-input"
          aria-label={t("sysprompt.title")}
          aria-describedby="sysprompt-count"
          rows={8}
          placeholder={promptPlaceholder()}
          value={text}
          disabled={saving}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setError(null);
          }}
        />
        <div class="sysprompt-meta">
          <span>{t("sysprompt.meta")}</span>
          <span id="sysprompt-count" class={"sysprompt-count" + (tooLong ? " is-over" : "")} aria-live="polite">
            {n} / {MAX}
          </span>
        </div>
        {tooLong && (
          <div class="set-warn" role="alert">{t("sysprompt.tooLong", { max: MAX })}</div>
        )}
        {error && (
          <div class="set-warn" role="alert">{error} {t("sysprompt.keepText")}</div>
        )}
      </div>
      <div class="sheet-footer">
        {offline && <span class="set-offline" role="status">{t("sysprompt.offline")}</span>}
        {initial && (
          <button class="access-btn sysprompt-clear" type="button" disabled={saving || offline} onClick={() => save("")}>
            {t("sysprompt.clear")}
          </button>
        )}
        <button class="btn-primary" type="button" disabled={saving || tooLong || !changed || offline} aria-busy={saving ? "true" : undefined} onClick={() => save(text)}>
          {saving ? t("sysprompt.saving") : t("common.save")}
        </button>
      </div>
    </>
  );
}

// FEAT-03.23: the prompt as the nested settings see it — one load shared by
// the root row («Задан / Не задан / —») and the section.
export const promptState = signal({ status: "idle", text: "" }); // idle | loading | ready | error
export async function loadPrompt(client = api) {
  promptState.value = { ...promptState.value, status: "loading" };
  try {
    const r = await client.getSystemPrompt();
    promptState.value = { status: "ready", text: typeof r?.text === "string" ? r.text : "" };
  } catch {
    promptState.value = { ...promptState.value, status: "error" };
  }
}
