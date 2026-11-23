// Current-turn plan state by sessionID (ACP, Claude Code, and opencode).
// Populated from live teleharness.plan SSE events and hydrated once per session
// from GET /session/:id/plan, with an admin fallback from loaded message history.
import { signal } from "@preact/signals";
import { api } from "../api.js";
import { active, me } from "./state.js";

export const plansBySession = signal(new Map());

const planLoaded = new Set();
const planSeq = new Map();
const planEmptyFromServer = new Set();
const seenUserMessages = new Map();

const PLAN_STATUS = new Set(["pending", "in_progress", "completed"]);

function normalizeTodos(todos) {
  if (!Array.isArray(todos)) return [];
  const out = [];
  for (const t of todos) {
    if (!t || typeof t.content !== "string" || !t.content.trim()) continue;
    out.push({
      ...(typeof t.id === "string" && t.id ? { id: t.id } : {}),
      content: t.content,
      status: PLAN_STATUS.has(t.status) ? t.status : "pending",
      ...(t.priority != null ? { priority: t.priority } : {}),
    });
  }
  return out;
}

export function applyPlan(sessionID, todos) {
  if (typeof sessionID !== "string" || !sessionID) return;
  planSeq.set(sessionID, (planSeq.get(sessionID) ?? 0) + 1);
  planEmptyFromServer.delete(sessionID);
  const next = new Map(plansBySession.value);
  next.set(sessionID, normalizeTodos(todos));
  plansBySession.value = next;
}

export function clearPlan(sessionID) {
  if (typeof sessionID !== "string" || !sessionID) return;
  planSeq.set(sessionID, (planSeq.get(sessionID) ?? 0) + 1);
  planEmptyFromServer.delete(sessionID);
  if (!plansBySession.value.has(sessionID)) return;
  const next = new Map(plansBySession.value);
  next.delete(sessionID);
  plansBySession.value = next;
}

export function clearPlanOnUserMessage(sessionID, messageID) {
  if (typeof sessionID !== "string" || !sessionID) return;
  if (typeof messageID === "string" && messageID) {
    let seen = seenUserMessages.get(sessionID);
    const inActive =
      active.value?.id === sessionID &&
      Array.isArray(active.value.messages) &&
      active.value.messages.some((m) => m?.info?.id === messageID);
    if (seen?.has(messageID) || inActive) {
      if (!seen) {
        seen = new Set();
        seenUserMessages.set(sessionID, seen);
      }
      seen.add(messageID);
      return;
    }
    if (!seen) {
      seen = new Set();
      seenUserMessages.set(sessionID, seen);
    }
    seen.add(messageID);
    if (seen.size > 50) seen.delete(seen.values().next().value);
  }
  clearPlan(sessionID);
}

export function forgetPlan(sessionID) {
  if (typeof sessionID !== "string" || !sessionID) return;
  clearPlan(sessionID);
  planLoaded.delete(sessionID);
  planSeq.delete(sessionID);
  seenUserMessages.delete(sessionID);
}

export function planOf(sessionID) {
  return plansBySession.value.get(sessionID) ?? null;
}

function planFromHistory(sessionID) {
  const act = active.value;
  if (!act || act.id !== sessionID || !Array.isArray(act.messages)) return null;
  let lastUser = -1;
  for (let i = 0; i < act.messages.length; i += 1) {
    if (act.messages[i]?.info?.role === "user") lastUser = i;
  }
  let found = null;
  for (let i = lastUser + 1; i < act.messages.length; i += 1) {
    for (const part of act.messages[i]?.parts ?? []) {
      if (part?.type === "tool" && part.tool === "todowrite" && Array.isArray(part.state?.input?.todos) && part.state.input.todos.length > 0) {
        found = part.state.input.todos;
      }
    }
  }
  return found;
}

export async function loadPlan(sessionID, { isAdmin } = {}) {
  if (typeof sessionID !== "string" || !sessionID || planLoaded.has(sessionID)) return;
  planLoaded.add(sessionID);
  const seq = planSeq.get(sessionID) ?? 0;
  let todos = [];
  try {
    const r = await api.getSessionPlan(sessionID);
    todos = Array.isArray(r?.todos) ? r.todos : [];
  } catch {
    todos = [];
  }
  if ((planSeq.get(sessionID) ?? 0) !== seq) return;
  applyPlan(sessionID, todos);
  if (todos.length === 0) {
    planEmptyFromServer.add(sessionID);
    const admin = isAdmin !== undefined ? Boolean(isAdmin) : me.value?.role === "admin";
    if (admin) {
      const fromHistory = planFromHistory(sessionID);
      if (fromHistory) applyPlan(sessionID, fromHistory);
    }
  }
}

export function hydratePlanFromHistory(sessionID) {
  if (typeof sessionID !== "string" || !sessionID) return;
  if (!planEmptyFromServer.has(sessionID)) return;
  const fromHistory = planFromHistory(sessionID);
  if (fromHistory) applyPlan(sessionID, fromHistory);
}

export function resetPlans() {
  planLoaded.clear();
  planSeq.clear();
  planEmptyFromServer.clear();
  seenUserMessages.clear();
  plansBySession.value = new Map();
}
