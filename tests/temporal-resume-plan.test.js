// FEAT-19.32: unit tests for shared/temporal-resume.js and lib/temporal/resume-plan.js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildResumePlan, sanitizeSeed } from "../lib/temporal/resume-plan.js";
import { previewResumeSelection } from "../shared/temporal-resume.js";

const linearDef = {
  steps: [
    { id: "s1", type: "model", dependsOn: [] },
    { id: "s2", type: "model", dependsOn: ["s1"] },
    { id: "s3", type: "approval", dependsOn: ["s2"] },
    { id: "s4", type: "artifact", dependsOn: ["s3"] },
  ],
};

describe("buildResumePlan (FEAT-19.32)", () => {
  it("resumes from first failed/uncompleted step by default", () => {
    const plan = buildResumePlan({
      sourceDefinition: linearDef,
      targetDefinition: linearDef,
      sourceState: { steps: { s1: "completed", s2: "running", s3: "waiting", s4: "waiting" } },
    });
    assert.equal(plan.defaultFromStepId, "s2");
    assert.equal(plan.fromStepId, "s2");
    assert.deepEqual(plan.reusedSteps, ["s1"]);
    assert.deepEqual(plan.rerunSteps, ["s2", "s3", "s4"]);
    assert.deepEqual(plan.seed.steps, { s1: "completed" });
  });

  it("allows picking an earlier step and excludes it plus transitive dependents", () => {
    const plan = buildResumePlan({
      sourceDefinition: linearDef,
      targetDefinition: linearDef,
      sourceState: { steps: { s1: "completed", s2: "completed", s3: "rejected", s4: "waiting" } },
      fromStepId: "s2",
    });
    assert.equal(plan.defaultFromStepId, "s3");
    assert.equal(plan.fromStepId, "s2");
    assert.deepEqual(plan.reusedSteps, ["s1"]);
    assert.deepEqual(plan.rerunSteps, ["s2", "s3", "s4"]);
  });

  it("supports picking step 1 for full restart with empty reusedSteps", () => {
    const plan = buildResumePlan({
      sourceDefinition: linearDef,
      targetDefinition: linearDef,
      sourceState: { steps: { s1: "completed", s2: "completed", s3: "completed", s4: "completed" } },
      fromStepId: "s1",
    });
    assert.equal(plan.defaultFromStepId, "s4");
    assert.deepEqual(plan.reusedSteps, []);
    assert.deepEqual(plan.rerunSteps, ["s1", "s2", "s3", "s4"]);
    assert.deepEqual(plan.seed.steps, {});
  });

  it("defaults to last step when all steps completed in source run", () => {
    const plan = buildResumePlan({
      sourceDefinition: linearDef,
      targetDefinition: linearDef,
      sourceState: { steps: { s1: "completed", s2: "completed", s3: "completed", s4: "completed" }, files: { s4: "out.md" } },
    });
    assert.equal(plan.fromStepId, "s4");
    assert.deepEqual(plan.reusedSteps, ["s1", "s2", "s3"]);
    assert.deepEqual(plan.rerunSteps, ["s4"]);
    assert.deepEqual(plan.seed.files, {});
  });

  it("handles parallel branches: keeps completed sibling branch when one branch fails", () => {
    const diamond = {
      steps: [
        { id: "init", type: "timer", dependsOn: [] },
        { id: "b1", type: "model", dependsOn: ["init"] },
        { id: "b2", type: "model", dependsOn: ["init"] },
        { id: "join", type: "parallel", dependsOn: ["b1", "b2"] },
      ],
    };
    const plan = buildResumePlan({
      sourceDefinition: diamond,
      targetDefinition: diamond,
      sourceState: { steps: { init: "completed", b1: "completed", b2: "running", join: "waiting" } },
    });
    assert.equal(plan.fromStepId, "b2");
    assert.deepEqual(plan.reusedSteps, ["init", "b1"]);
    assert.deepEqual(plan.rerunSteps, ["b2", "join"]);
  });

  it("upgrades to newer version: stops reusing at step with changed type or new dependency", () => {
    const v2 = {
      steps: [
        { id: "s1", type: "model", dependsOn: [] },
        { id: "s2", type: "timer", dependsOn: ["s1"] }, // type changed!
        { id: "s3", type: "approval", dependsOn: ["s2"] },
      ],
    };
    const plan = buildResumePlan({
      sourceDefinition: linearDef,
      targetDefinition: v2,
      sourceState: { steps: { s1: "completed", s2: "completed", s3: "completed" } },
    });
    assert.equal(plan.fromStepId, "s2");
    assert.deepEqual(plan.reusableSteps, ["s1"]);
    assert.deepEqual(plan.reusedSteps, ["s1"]);
    assert.deepEqual(plan.rerunSteps, ["s2", "s3"]);
  });

  it("carries condition booleans, artifact files, pr metadata, and approval reworks safely", () => {
    const rich = {
      steps: [
        { id: "c1", type: "condition", dependsOn: [] },
        { id: "a1", type: "artifact", dependsOn: ["c1"] },
        { id: "ap1", type: "approval", dependsOn: ["a1"] },
        { id: "pr1", type: "pull_request", dependsOn: ["ap1"] },
        { id: "last", type: "timer", dependsOn: ["pr1"] },
      ],
    };
    const plan = buildResumePlan({
      sourceDefinition: rich,
      targetDefinition: rich,
      sourceState: {
        steps: { c1: "completed", a1: "completed", ap1: "completed", pr1: "completed", last: "waiting" },
        conditions: { c1: true, extra: "drop" },
        files: { a1: "runs/r1/report.md", last: "drop.md" },
        reworks: { ap1: 2, fake: 99 },
        pr: { pr1: { state: "done", url: "https://github.com/o/r/pull/1", outcome: "created", secret: "nope" } },
      },
    });
    assert.deepEqual(plan.reusedSteps, ["c1", "a1", "ap1", "pr1"]);
    assert.deepEqual(plan.seed, {
      steps: { c1: "completed", a1: "completed", ap1: "completed", pr1: "completed" },
      conditions: { c1: true },
      files: { a1: "runs/r1/report.md" },
      pr: { pr1: { state: "done", url: "https://github.com/o/r/pull/1", outcome: "created" } },
      reworks: { ap1: 2 },
    });
  });

  it("refuses to reuse completed condition step if boolean outcome is missing", () => {
    const condDef = {
      steps: [
        { id: "c1", type: "condition", dependsOn: [] },
        { id: "s2", type: "timer", dependsOn: ["c1"] },
      ],
    };
    const plan = buildResumePlan({
      sourceDefinition: condDef,
      targetDefinition: condDef,
      sourceState: { steps: { c1: "completed", s2: "waiting" }, conditions: {} },
    });
    assert.equal(plan.fromStepId, "c1");
    assert.deepEqual(plan.reusedSteps, []);
  });

  it("rejects unknown fromStepId with 400", () => {
    assert.throws(
      () => buildResumePlan({ sourceDefinition: linearDef, targetDefinition: linearDef, sourceState: null, fromStepId: "nope" }),
      (e) => e.status === 400
    );
  });

  it("sanitizeSeed rejects non-closed seed where dependency is missing", () => {
    const bad = sanitizeSeed({ steps: { s2: "completed" } }, linearDef.steps);
    assert.equal(bad, null);
  });

  it("previewResumeSelection matches server selection", () => {
    const res = previewResumeSelection({
      steps: linearDef.steps,
      reusableSteps: ["s1", "s2"],
      fromStepId: "s2",
    });
    assert.deepEqual(res.reusedSteps, ["s1"]);
    assert.deepEqual(res.rerunSteps, ["s2", "s3", "s4"]);
  });
});
