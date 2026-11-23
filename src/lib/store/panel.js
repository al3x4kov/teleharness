// Desktop right-panel environment state: MCP servers and Skills for the
// currently open chat directory. Kept separate from SettingsView's default
// catalog signals so switching chats never mutates Settings.
import { signal } from "@preact/signals";
import { api } from "../api.js";
import { normalizeMcp } from "../normalize.js";
import { MCP_EMPTY_RETRY } from "./catalog.js";
import { me, sessionDir } from "./state.js";

export const panelMcp = signal(null);
export const panelMcpError = signal(false);
export const panelSkills = signal(null);
export const panelSkillsError = signal(false);

let mcpToken = 0;
let skillsToken = 0;
let envDir = null;
let mcpRetryTimer = null;
let skillsRetryTimer = null;

export function panelDirOf(id) {
  if (me.value?.role !== "admin") return null;
  return sessionDir(id);
}

function normalizeSkills(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr
    .filter((s) => s && typeof s === "object")
    .map((s) => ({
      id: typeof s.id === "string" ? s.id : "",
      name: typeof s.name === "string" && s.name ? s.name : typeof s.id === "string" ? s.id : "",
      description: typeof s.description === "string" ? s.description : "",
      ...(typeof s.path === "string" && s.path ? { path: s.path } : {}),
    }))
    .filter((s) => s.id || s.name);
}

const retryDelay = (attempt) => (attempt < 6 ? MCP_EMPTY_RETRY.delayMs : MCP_EMPTY_RETRY.delayMs * 2);

async function loadPanelMcp(directory, attempt, token) {
  try {
    const list = normalizeMcp(await api.getMcp(directory));
    if (token !== mcpToken) return;
    panelMcpError.value = false;
    const settled = list.length > 0 && !list.some((s) => s.status === "pending");
    if (!settled && attempt < MCP_EMPTY_RETRY.tries) {
      if (list.length > 0) panelMcp.value = list;
      clearTimeout(mcpRetryTimer);
      mcpRetryTimer = setTimeout(() => loadPanelMcp(directory, attempt + 1, token), retryDelay(attempt));
      mcpRetryTimer?.unref?.();
      return;
    }
    panelMcp.value = list;
  } catch {
    if (token !== mcpToken) return;
    panelMcpError.value = true;
  }
}

async function loadPanelSkills(directory, attempt, token) {
  try {
    const list = normalizeSkills(await api.getSkills(directory));
    if (token !== skillsToken) return;
    panelSkillsError.value = false;
    if (list.length === 0 && attempt < MCP_EMPTY_RETRY.tries) {
      clearTimeout(skillsRetryTimer);
      skillsRetryTimer = setTimeout(() => loadPanelSkills(directory, attempt + 1, token), retryDelay(attempt));
      skillsRetryTimer?.unref?.();
      return;
    }
    panelSkills.value = list;
  } catch {
    if (token !== skillsToken) return;
    panelSkillsError.value = true;
  }
}

export function refreshPanelEnvironment(directory = null) {
  mcpToken += 1;
  skillsToken += 1;
  envDir = directory ?? null;
  clearTimeout(mcpRetryTimer);
  mcpRetryTimer = null;
  clearTimeout(skillsRetryTimer);
  skillsRetryTimer = null;
  panelMcp.value = null;
  panelMcpError.value = false;
  panelSkills.value = null;
  panelSkillsError.value = false;
  loadPanelMcp(envDir, 0, mcpToken);
  loadPanelSkills(envDir, 0, skillsToken);
}

export function stopPanelEnvironment() {
  mcpToken += 1;
  skillsToken += 1;
  clearTimeout(mcpRetryTimer);
  mcpRetryTimer = null;
  clearTimeout(skillsRetryTimer);
  skillsRetryTimer = null;
}

export function retryPanelMcp() {
  mcpToken += 1;
  clearTimeout(mcpRetryTimer);
  mcpRetryTimer = null;
  panelMcp.value = null;
  panelMcpError.value = false;
  loadPanelMcp(envDir, 0, mcpToken);
}

export function retryPanelSkills() {
  skillsToken += 1;
  clearTimeout(skillsRetryTimer);
  skillsRetryTimer = null;
  panelSkills.value = null;
  panelSkillsError.value = false;
  loadPanelSkills(envDir, 0, skillsToken);
}
