// Why a definition cannot run on this portal.
// Shared by the editor readiness panel, the version list and the start form.
import { t } from "../../lib/i18n.js";
const LABELS = new Set(["model", "approval", "timer", "condition", "parallel", "artifact", "command"]);
export const RUNNABLE_TYPES = ["model", "approval", "timer", "parallel", "condition", "artifact", "command"];
export function unsupportedReasons(definition, subscriptionModels, opts = {}) {
  const out = [];
  const { ledger, commands } = opts ?? {};
  for (const s of definition.steps ?? []) {
    const name = t("temporal.quote", { text: s.name || s.id });
    if (!RUNNABLE_TYPES.includes(s.type)) out.push(t("temporal.ready.notRunnable", { name, type: LABELS.has(s.type) ? t("temporal.type." + s.type) : s.type }));
    else if (s.when) out.push(t("temporal.ready.oldWhen", { name }));
    else if (Object.keys(s.mapping ?? {}).length) out.push(t("temporal.ready.oldMapping", { name }));
    else if (s.type === "condition" && !s.check) out.push(t("temporal.ready.noCheck", { name }));
    else if (s.type === "parallel" && s.join !== "all-success") out.push(t("temporal.ready.joinAll", { name }));
    else if (s.type === "model" && ledger === "none") out.push(t("temporal.ready.noLedger", { name }));
    else if (s.type === "model" && subscriptionModels && !subscriptionModels[s.engine]?.includes(s.model)) out.push(t("temporal.ready.noModel", { name }));
    else if (s.type === "command" && !s.command) out.push(t("temporal.ready.noCommand", { name }));
    else if (s.type === "command" && Array.isArray(commands) && !commands.some((c) => c.id === s.command)) out.push(t("temporal.ready.missingCommand", { name, id: s.command }));
  }
  return out;
}
