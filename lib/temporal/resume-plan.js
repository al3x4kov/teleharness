// FEAT-19.32: authoritative planner & seed sanitizer for resuming a pipeline run.
import { DefinitionError } from "./definitions.js";
import { topologicalOrder, previewResumeSelection } from "../../shared/temporal-resume.js";

const VALID_SEED_STATUS = new Set(["completed", "skipped"]);
const VALID_PR_STATES = new Set(["done", "no_changes"]);

function sanitizePrEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!VALID_PR_STATES.has(raw.state)) return null;
  const out = {
    state: raw.state,
    url: typeof raw.url === "string" && raw.url.length <= 512 ? raw.url : null,
  };
  for (const field of ["outcome", "branch", "base", "sha"]) {
    if (typeof raw[field] === "string" && raw[field].length <= 256) out[field] = raw[field];
  }
  return out;
}

export function sanitizeSeed(rawSeed, targetSteps) {
  if (!rawSeed || typeof rawSeed !== "object" || Array.isArray(rawSeed)) return null;
  const byId = targetSteps instanceof Map ? targetSteps : new Map((targetSteps ?? []).map((s) => [s.id, s]));
  const rawSteps = rawSeed.steps;
  if (!rawSteps || typeof rawSteps !== "object" || Array.isArray(rawSteps)) return null;
  const steps = {};
  for (const [id, status] of Object.entries(rawSteps)) {
    if (!byId.has(id) || !VALID_SEED_STATUS.has(status)) return null;
    steps[id] = status;
  }
  // Ensure topological closure: every dependency of a seeded step must also be seeded.
  for (const id of Object.keys(steps)) {
    const def = byId.get(id);
    for (const dep of def.dependsOn ?? []) {
      if (!(dep in steps)) return null;
    }
  }
  const conditions = {};
  if (rawSeed.conditions && typeof rawSeed.conditions === "object" && !Array.isArray(rawSeed.conditions)) {
    for (const [id, value] of Object.entries(rawSeed.conditions)) {
      if (id in steps && byId.get(id).type === "condition" && typeof value === "boolean") {
        conditions[id] = value;
      }
    }
  }
  // Completed condition steps must carry their boolean outcome so downstream branching stays intact.
  for (const [id, status] of Object.entries(steps)) {
    if (status === "completed" && byId.get(id).type === "condition" && typeof conditions[id] !== "boolean") {
      return null;
    }
  }
  const files = {};
  if (rawSeed.files && typeof rawSeed.files === "object" && !Array.isArray(rawSeed.files)) {
    for (const [id, value] of Object.entries(rawSeed.files)) {
      if (id in steps && byId.get(id).type === "artifact" && typeof value === "string" && value.length <= 256) {
        files[id] = value;
      }
    }
  }
  const pr = {};
  if (rawSeed.pr && typeof rawSeed.pr === "object" && !Array.isArray(rawSeed.pr)) {
    for (const [id, value] of Object.entries(rawSeed.pr)) {
      if (id in steps && byId.get(id).type === "pull_request") {
        const clean = sanitizePrEntry(value);
        if (clean) pr[id] = clean;
      }
    }
  }
  const reworks = {};
  if (rawSeed.reworks && typeof rawSeed.reworks === "object" && !Array.isArray(rawSeed.reworks)) {
    for (const [id, value] of Object.entries(rawSeed.reworks)) {
      if (id in steps && byId.get(id).type === "approval" && Number.isSafeInteger(value) && value >= 0 && value <= 10) {
        reworks[id] = value;
      }
    }
  }
  return { steps, conditions, files, pr, reworks };
}

export function buildResumePlan({ sourceDefinition, targetDefinition, sourceState = null, fromStepId = null }) {
  const targetSteps = targetDefinition?.steps ?? [];
  const order = topologicalOrder(targetSteps);
  if (!order) throw new DefinitionError(422, "Некорректный граф шагов целевой версии");

  const sourceById = new Map((sourceDefinition?.steps ?? []).map((s) => [s.id, s]));
  const targetById = new Map(targetSteps.map((s) => [s.id, s]));

  if (fromStepId !== null && fromStepId !== undefined) {
    if (typeof fromStepId !== "string" || !targetById.has(fromStepId)) {
      throw new DefinitionError(400, "Указанный шаг не найден в выбранной версии");
    }
  }

  const srcStepMap = sourceState?.steps && typeof sourceState.steps === "object" ? sourceState.steps : {};
  const srcConds = sourceState?.conditions && typeof sourceState.conditions === "object" ? sourceState.conditions : {};
  const reusableSet = new Set();

  for (const id of order) {
    const tStep = targetById.get(id);
    const sStep = sourceById.get(id);
    if (!sStep || sStep.type !== tStep.type) continue;
    const status = srcStepMap[id];
    if (!VALID_SEED_STATUS.has(status)) continue;
    if (tStep.type === "condition" && status === "completed" && typeof srcConds[id] !== "boolean") continue;
    const deps = Array.isArray(tStep.dependsOn) ? tStep.dependsOn : [];
    if (!deps.every((dep) => reusableSet.has(dep))) continue;
    reusableSet.add(id);
  }

  const reusableSteps = order.filter((id) => reusableSet.has(id));
  const defaultFromStepId = order.find((id) => !reusableSet.has(id)) ?? order[order.length - 1];
  const effectiveFromStepId = fromStepId ?? defaultFromStepId;

  const { reusedSteps, rerunSteps } = previewResumeSelection({
    steps: targetSteps,
    reusableSteps,
    fromStepId: effectiveFromStepId,
  });

  const rawSeed = {
    steps: Object.fromEntries(reusedSteps.map((id) => [id, srcStepMap[id]])),
    conditions: sourceState?.conditions ?? {},
    files: sourceState?.files ?? {},
    pr: sourceState?.pr ?? {},
    reworks: sourceState?.reworks ?? {},
  };
  const seed = sanitizeSeed(rawSeed, targetById);
  if (!seed) throw new DefinitionError(422, "Не удалось построить корректный снимок переносимых шагов");

  return {
    fromStepId: effectiveFromStepId,
    defaultFromStepId,
    reusableSteps,
    reusedSteps,
    rerunSteps,
    seed,
  };
}
