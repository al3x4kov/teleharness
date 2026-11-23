// FEAT-19.32: pure DAG helpers shared between server resume planner and UI preview.

export function topologicalOrder(steps) {
  if (!Array.isArray(steps) || !steps.length) return null;
  const byId = new Map();
  for (const step of steps) {
    if (!step || typeof step.id !== "string" || byId.has(step.id)) return null;
    byId.set(step.id, step);
  }
  const ordered = [];
  const seen = new Set();
  while (ordered.length < steps.length) {
    let progressed = false;
    for (const step of steps) {
      if (seen.has(step.id)) continue;
      const deps = Array.isArray(step.dependsOn) ? step.dependsOn : [];
      if (deps.some((d) => !byId.has(d))) return null;
      if (deps.every((d) => seen.has(d))) {
        seen.add(step.id);
        ordered.push(step.id);
        progressed = true;
      }
    }
    if (!progressed) return null;
  }
  return ordered;
}

export function downstreamOf(steps, startId) {
  const dependents = new Map();
  for (const step of steps ?? []) {
    for (const dep of step.dependsOn ?? []) {
      let list = dependents.get(dep);
      if (!list) {
        list = [];
        dependents.set(dep, list);
      }
      list.push(step.id);
    }
  }
  const excluded = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift();
    for (const next of dependents.get(cur) ?? []) {
      if (!excluded.has(next)) {
        excluded.add(next);
        queue.push(next);
      }
    }
  }
  return excluded;
}

export function previewResumeSelection({ steps, reusableSteps, fromStepId }) {
  const order = topologicalOrder(steps) ?? (steps ?? []).map((s) => s.id);
  const reusable = new Set(reusableSteps ?? []);
  const excluded = fromStepId ? downstreamOf(steps ?? [], fromStepId) : new Set();
  const reusedSteps = order.filter((id) => reusable.has(id) && !excluded.has(id));
  const reusedSet = new Set(reusedSteps);
  const rerunSteps = order.filter((id) => !reusedSet.has(id));
  return { fromStepId: fromStepId ?? rerunSteps[0] ?? order[order.length - 1] ?? null, reusedSteps, rerunSteps };
}
