// Localized view model for an MCP server status: shared by SettingsView and
// the desktop RightPanel so tones and labels stay consistent across the UI.
import { t } from "./i18n.js";

const MCP_STATUS = {
  connected: { key: "settings.mcp.connected", tone: "on" },
  pending: { key: "settings.mcp.pending", tone: "idle" },
  disabled: { key: "settings.mcp.disabled", tone: "idle" },
  failed: { key: "settings.mcp.failed", tone: "bad" },
  needs_auth: { key: "settings.mcp.needsAuth", tone: "warn" },
  needs_client_registration: { key: "settings.mcp.needsRegistration", tone: "warn" },
};

export function mcpView(s) {
  const known = MCP_STATUS[s?.status];
  const text = t(known?.key ?? "settings.mcp.unknown");
  const tone = known?.tone ?? "idle";
  let why = null;
  if (typeof s?.error === "string" && s.error.trim()) {
    // Strip the raw JSON-RPC error prefix ("MCP error -32000: ...") for readability.
    why = s.error.trim().replace(/^MCP error\s*-?\d+:\s*/i, "").split("\n")[0];
  } else if (s?.status === "failed") {
    why = t("settings.mcp.failedWhy");
  }
  return { text, tone, why, full: s?.error ?? null };
}
