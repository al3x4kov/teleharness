// Shared UI primitives for the zai views: inline SVG glyphs, the bottom-sheet
// chrome (PickerSheet) and the data-driven Model/Agent pickers. Data comes
// from the store signals (providerCfg, agents); selection is controlled via
// value/onPick so callers decide where the choice lands (prefs, draft state).
import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import {
  agents, agentsError, claudeAgents, claudeAgentsError, providerCfg, providerError, refreshAgents, refreshClaudeAgents, refreshProvider,
} from "../lib/store.js";
import { ENGINE_LABEL, engineOf, WORKING_MODELS, workingModels } from "../lib/engine.js";
import { locale, t } from "../lib/i18n.js";
import "./views.css";

const GLYPHS = {
  plus: ["M12 5v14", "M5 12h14"],
  close: ["M18 6 6 18", "M6 6l12 12"],
  check: ["M20 6 9 17l-5-5"],
  chevron: ["m9 18 6-6-6-6"],
  pencil: ["M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M10 11v6", "M14 11v6"],
  power: ["M18.36 6.64a9 9 0 1 1-12.73 0", "M12 2v10"],
  copy: ["M9 9h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
  key: ["M21 12a9 9 0 0 1-15.5 6.2L3 16", "M3 21v-5h5", "M3 12a9 9 0 0 1 15.5-6.2L21 8", "M21 3v5h-5"],
  alert: ["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"],
  image: [
    "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
    "M11 11a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
    "m21 15-4.35-4.35a1.5 1.5 0 0 0-2.12 0L6 19",
  ],
};

export function Glyph({ name, size = 20 }) {
  return (
    <svg class="glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {GLYPHS[name].map((d) => <path d={d} />)}
    </svg>
  );
}

// ---- modal focus (BUG-01.38) -------------------------------------------------
// Every modal/sheet: Tab and Shift+Tab cycle INSIDE the dialog (never under
// the backdrop), and on close focus returns to the control that opened it.
// inertShell: a dialog portaled to <body> also makes the app shell behind it
// inert (a dialog rendered INSIDE the shell must not — it would go inert too).
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), ' +
  'select:not([disabled]), iframe, video[controls], audio[controls], [tabindex]:not([tabindex="-1"])';

export function focusablesIn(root) {
  if (!root) return [];
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest("[hidden], [inert], [aria-hidden='true']"));
}

// Focus back to the control that opened a modal (BUG-01.38). A row's ✎/🗑
// are revealed only by :focus-visible inside the row (stand dogfood 1.7.2):
// once focus moved into the modal they went visibility:hidden and a plain
// focus() was refused — focus fell to <body>. The opener is revealed for the
// time it holds the focus (the row's :has(:focus-visible) did not keep it
// shown reliably in Chromium once hidden).
// → false when there is nothing to return to.
export function restoreFocus(opener) {
  if (!opener || opener === document.body || !opener.isConnected || typeof opener.focus !== "function") return false;
  try {
    opener.focus({ preventScroll: true });
    if (document.activeElement !== opener && getComputedStyle(opener).visibility === "hidden") {
      const prev = opener.style.visibility;
      opener.style.visibility = "visible";
      opener.focus({ preventScroll: true });
      // Shown while it holds the focus; hidden again with the row.
      opener.addEventListener("blur", () => (opener.style.visibility = prev), { once: true });
    }
  } catch {}
  return true;
}

export function useModalFocus(ref, { inertShell = false } = {}) {
  useEffect(() => {
    const opener = document.activeElement;
    const shell = inertShell ? document.querySelector(".shell") : null;
    const wasInert = shell?.hasAttribute("inert");
    if (shell && !wasInert) {
      shell.setAttribute("inert", "");
      shell.setAttribute("aria-hidden", "true");
    }
    const onKey = (e) => {
      const box = ref.current;
      if (e.key !== "Tab" || !box) return;
      const items = focusablesIn(box);
      const cur = document.activeElement;
      if (items.length === 0) {
        e.preventDefault();
        box.focus?.();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!box.contains(cur)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (cur === first || cur === box)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && cur === last) {
        e.preventDefault();
        first.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      if (shell && !wasInert) {
        shell.removeAttribute("inert");
        shell.removeAttribute("aria-hidden");
      }
      if (restoreFocus(opener)) {
        // A save that re-renders the list (rename → the row re-sorts) may
        // knock the focus off right after: one more try on the next tick.
        setTimeout(() => {
          const a = document.activeElement;
          if (!a || a === document.body) restoreFocus(opener);
        }, 0);
      }
    };
  }, []);
}

// Bottom sheet: backdrop (blur + rgba) closes on click and Escape, drag handle,
// safe-area padding, 200ms slide-up. Content scrolls in .sheet-body; a sticky
// footer can be passed as part of children.
export function PickerSheet({ title, onClose, children }) {
  const sheetRef = useRef(null);
  useModalFocus(sheetRef, { inertShell: true }); // before the focus below: remembers the opener
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    addEventListener("keydown", onKey);
    const body = document.body;
    const prev = body.style.overflow;
    body.style.overflow = "hidden"; // lock page scroll behind the sheet
    sheetRef.current?.focus();
    return () => {
      removeEventListener("keydown", onKey);
      body.style.overflow = prev;
    };
  }, []);
  // Portal to <body>: sheets mounted inside a scrollable view inherit the
  // iOS "fixed inside a touch scroller" anchoring bug (same as FileViewer,
  // fixed 2026-10-31) — at body level the backdrop is viewport-anchored.
  return createPortal(
    <div class="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={sheetRef}>
        <div class="sheet-handle" aria-hidden="true" />
        <header class="sheet-head">
          <h2 class="sheet-title">{title}</h2>
          <button class="icon-btn" type="button" aria-label={t("common.close")} onClick={onClose}>
            <Glyph name="close" />
          </button>
        </header>
        <div class="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// The working-model list (FEAT-03.2) lives in lib/engine.js since BUG-137:
// the store checks the saved default model against it too.
export { WORKING_MODELS, workingModels };

const availableModels = (cfg) => workingModels(cfg);

// Preselect order: the plan's own providers first, then any connected default.
export function pickDefaultModel(cfg) {
  const pool = availableModels(cfg);
  if (pool.length === 0) return null;
  // Same pairing as store DEFAULT_MODEL: the upstream plan default
  // (glm-5.3-highspeed) hung at the provider on 2026-10-31.
  const mandated = pool.find((m) => m.providerID === "zai-coding-plan" && m.id === "glm-5.3-flash");
  if (mandated) return mandated;
  const isDefault = (m) => cfg?.defaults?.[m.providerID] === m.id;
  for (const pid of ["zai-coding-plan", "zai", "opencode"]) {
    const hit = pool.find((m) => m.providerID === pid && isDefault(m));
    if (hit) return hit;
  }
  return pool.find(isDefault) ?? pool[0];
}

function modelTitle(m) {
  const suffix = ` (${m.providerID})`;
  return m.label.endsWith(suffix) ? m.label.slice(0, -suffix.length) : m.label;
}

// Inside the z.ai group: the user's plan first, then the vision add-on —
// alphabetical order buried the paid GLM models (BUG-11.11).
const PROVIDER_ORDER = ["zai-coding-plan", "zai", "opencode"];
const providerRank = (pid) => {
  const i = PROVIDER_ORDER.indexOf(pid);
  return i === -1 ? PROVIDER_ORDER.length : i;
};

// BUG-11.11: the first level is the ENGINE — exactly two groups with a
// human subtitle; provider ids never reach the headings. z.ai goes first
// (≈4 rows), so Claude is visible without scrolling.
export const ENGINE_GROUPS = [
  { engine: "opencode", title: ENGINE_LABEL.opencode, get sub() { return t("pickers.engine.opencode"); } },
  { engine: "claude", title: ENGINE_LABEL.claude, get sub() { return t("pickers.engine.claude"); } },
];

// Pure: catalog → [{engine, title, sub, models}] (empty groups dropped).
export function modelGroups(cfg, { engine = null, query = "", keep = null } = {}) {
  const q = query.trim().toLowerCase();
  const pool = workingModels(cfg, { keep }).filter(
    (m) => (!engine || engineOf(m.providerID) === engine) && (!q || m.label.toLowerCase().includes(q)),
  );
  const isDefault = (m) => cfg?.defaults?.[m.providerID] === m.id;
  return ENGINE_GROUPS.map((g) => ({
    engine: g.engine,
    title: g.title,
    sub: g.sub,
    models: pool
      .filter((m) => engineOf(m.providerID) === g.engine)
      .sort((a, b) =>
        providerRank(a.providerID) - providerRank(b.providerID) ||
        (g.engine === "claude" ? Number(isDefault(b)) - Number(isDefault(a)) : 0) ||
        modelTitle(a).localeCompare(modelTitle(b), locale(), { numeric: true })),
  })).filter((g) => g.models.length > 0);
}

// Catalog state for the sheet (PK-7): a failed /provider used to leave the
// sheet on «Загрузка моделей…» forever. The store's providerError signal
// says «failed, nothing loaded»; «Повторить» refreshes through the store.
function useCatalog() {
  const [state, setState] = useState(providerCfg.value ? "ready" : "loading");
  const load = async () => {
    setState("loading");
    const ok = providerCfg.value ? true : await refreshProvider();
    setState(ok || providerCfg.value ? "ready" : "error");
  };
  useEffect(() => {
    if (!providerCfg.value) load();
  }, []);
  if (providerCfg.value) return ["ready", load];
  return [state === "loading" && providerError.value ? "error" : state, load];
}

function SkeletonRows({ label, rows = 5 }) {
  const widths = ["40%", "58%", "36%", "34%", "50%", "44%"];
  return (
    <div class="sk-pick" role="status" aria-label={label}>
      {widths.slice(0, rows).map((w, i) => (
        <span key={i} class="sk" style={`height:${i % 3 === 0 ? 12 : 15}px;width:${w}`} />
      ))}
    </div>
  );
}

function NothingFound({ query, onReset }) {
  return (
    <p class="picker-empty" role="status">
      {t("pickers.nothingFound", { query: query.trim() })}{" "}
      <button class="link-btn" type="button" onClick={onReset}>{t("pickers.reset")}</button>
    </p>
  );
}

// engine: restrict to one engine (a chat with messages cannot cross engines);
// note: explanatory line on top of the list (why the other engine is gone).
export function ModelPicker({ value, onPick, engine = null, note = null }) {
  const [query, setQuery] = useState("");
  const [catalog, retry] = useCatalog();
  const cfg = providerCfg.value;
  const groups = cfg ? modelGroups(cfg, { engine, query, keep: value }) : [];
  const isActive = (m) => value?.providerID === m.providerID && (value?.modelID ?? m.id) === m.id;

  return (
    <div class="picker">
      <input
        class="search picker-search" type="search" placeholder={t("pickers.searchModel")}
        aria-label={t("pickers.searchModel")} autocomplete="off" spellcheck={false}
        value={query} autofocus
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
      {note && <p class="picker-note">{note}</p>}
      {catalog === "error" ? (
        <div class="picker-fail" role="alert">
          <strong>{t("pickers.modelsFailed")}</strong>
          <span class="hint">{t("pickers.modelUnchanged")}</span>
          <button class="btn" type="button" onClick={retry}>{t("common.retry")}</button>
        </div>
      ) : !cfg ? (
        <SkeletonRows label={t("pickers.loadingModels")} />
      ) : groups.length === 0 ? (
        <NothingFound query={query} onReset={() => setQuery("")} />
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.engine} aria-label={g.title}>
              <h3 class="engine-group">
                <span class={"engine-dot" + (g.engine === "claude" ? " is-claude" : "")} aria-hidden="true" />
                <span class="eg-name">{g.title}</span>
                <span class="eg-sub">{g.sub}</span>
              </h3>
              {g.models.map((m) => (
                <button
                  key={m.providerID + "/" + m.id} type="button"
                  class={"picker-row" + (isActive(m) ? " active" : "")}
                  aria-pressed={isActive(m) ? "true" : "false"}
                  onClick={() => onPick?.({ providerID: m.providerID, modelID: m.id })}
                >
                  <span class="picker-row-main">
                    <span class="picker-row-title">
                      <span class="picker-row-name">{modelTitle(m)}</span>
                      {m.imageInput && (
                        <span class="glyph-label" title={t("pickers.imageInputTitle")}>
                          <Glyph name="image" size={15} />{t("pickers.imageInput")}
                        </span>
                      )}
                    </span>
                  </span>
                  {isActive(m) && (
                    <span class="picker-check">
                      <Glyph name="check" size={18} />
                    </span>
                  )}
                </button>
              ))}
            </section>
          ))}
          <p class="picker-foot">{t("pickers.modelsFoot")}</p>
        </>
      )}
    </div>
  );
}

export function AgentPicker({ value, onPick }) {
  const [query, setQuery] = useState("");
  // configs can list the same agent twice; first description wins
  const byName = new Map();
  for (const a of agents.value) if (!byName.has(a.name)) byName.set(a.name, a);
  const q = query.trim().toLowerCase();
  const list = [...byName.values()]
    .filter((a) => !q || `${a.name}\n${a.description ?? ""}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  // PK-9: «Основные» (primary/all) above «Вспомогательные» (subagents).
  const groups = [
    { key: "main", label: t("pickers.agents.main"), items: list.filter((a) => a.mode !== "subagent") },
    { key: "aux", label: t("pickers.agents.aux"), items: list.filter((a) => a.mode === "subagent") },
  ].filter((g) => g.items.length > 0);

  return (
    <div class="picker">
      <input
        class="search picker-search" type="search" placeholder={t("pickers.searchAgent")}
        aria-label={t("pickers.searchAgent")} autocomplete="off" spellcheck={false}
        value={query}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
      {agents.value.length === 0 && agentsError.value ? (
        <div class="picker-fail" role="alert">
          <strong>{t("pickers.agentsFailed")}</strong>
          <span class="hint">{t("pickers.agentUnchanged")}</span>
          <button class="btn" type="button" onClick={() => { agentsError.value = false; refreshAgents(); }}>{t("common.retry")}</button>
        </div>
      ) : agents.value.length === 0 ? (
        <SkeletonRows label={t("pickers.loadingAgents")} rows={4} />
      ) : groups.length === 0 ? (
        <NothingFound query={query} onReset={() => setQuery("")} />
      ) : (
        groups.map((g) => (
          <section key={g.key} aria-label={g.label}>
            <h3 class="agent-group-label">{g.label}</h3>
            {g.items.map((a) => (
              <button
                key={a.name} type="button"
                class={"picker-row" + (value === a.name ? " active" : "")}
                aria-pressed={value === a.name ? "true" : "false"}
                onClick={() => onPick?.(a.name)}
              >
                <span class="picker-row-main">
                  <span class="picker-row-title">{a.name}</span>
                  {a.description && <span class="picker-row-desc">{a.description}</span>}
                </span>
                {value === a.name && (
                  <span class="picker-check">
                    <Glyph name="check" size={18} />
                  </span>
                )}
              </button>
            ))}
          </section>
        ))
      )}
    </div>
  );
}


// FEAT-13.17 (pickers.html frames 10–11): the Claude-chat agent sheet. The
// first row «Без агента» (Claude Code as is) is the default and is always
// available — even while the catalog loads or after it failed; below it the
// portal's Claude agents with descriptions. value: agent id or null.
export const claudeAgentFoot = () => t("pickers.claudeAgentFoot");

export function ClaudeAgentPicker({ value = null, onPick }) {
  const list = claudeAgents.value;
  useEffect(() => {
    if (list == null) refreshClaudeAgents();
  }, []);
  const row = (id, title, desc) => {
    const on = (value ?? null) === id;
    return (
      <button key={id ?? "-"} type="button" class={"picker-row" + (on ? " active" : "")} aria-pressed={on ? "true" : "false"} onClick={() => onPick?.(id)}>
        <span class="picker-row-main">
          <span class="picker-row-title">{title}</span>
          {desc && <span class="picker-row-desc">{desc}</span>}
        </span>
        {on && (
          <span class="picker-check">
            <Glyph name="check" size={18} />
          </span>
        )}
      </button>
    );
  };
  const items = Array.isArray(list) ? list : [];
  return (
    <div class="picker">
      {row(null, t("pickers.noAgent"), t("pickers.noAgentDesc"))}
      <section aria-label={t("pickers.claudeAgents")}>
        <h3 class="agent-group-label">{t("pickers.claudeAgents")}</h3>
        {list == null && claudeAgentsError.value ? (
          <div class="picker-fail" role="alert">
            <strong>{t("pickers.agentsFailed")}</strong>
            <span class="hint">{t("pickers.agentUnchanged")}</span>
            <button class="btn" type="button" onClick={() => { claudeAgentsError.value = false; refreshClaudeAgents(); }}>{t("common.retry")}</button>
          </div>
        ) : list == null ? (
          <SkeletonRows label={t("pickers.loadingAgents")} rows={4} />
        ) : items.length === 0 ? (
          <p class="picker-empty" role="status">{t("pickers.noAgents")}</p>
        ) : (
          items.map((a) => row(a.id, a.name, a.description))
        )}
      </section>
      <p class="picker-foot">{claudeAgentFoot()}</p>
    </div>
  );
}
