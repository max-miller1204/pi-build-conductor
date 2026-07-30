import { describe, expect, it } from "vitest";
import { PlanValidationError } from "../src/domain/dag.js";
import {
	readWorkflowPlanDocument,
	translateLegacyTaskPlan,
} from "../src/domain/plan-translation.js";
import {
	stepCapabilities,
	stepPathLocks,
	validateWorkflowPlan,
	WORKFLOW_PLAN_SCHEMA_VERSION,
} from "../src/domain/steps.js";
import type { TaskPlan } from "../src/domain/types.js";

function legacyPlan(): TaskPlan {
	return {
		version: 3,
		title: "Legacy build",
		tasks: [
			{
				id: "core",
				title: "Implement core",
				description: "Implement the core module",
				dependencies: [],
				acceptanceCriteria: ["Core works"],
				allowedPaths: ["src/core/"],
				validationCommands: [{ command: "npm", args: ["test"] }],
			},
			{
				id: "ui",
				title: "Implement UI",
				description: "Present the result",
				dependencies: ["core"],
				acceptanceCriteria: ["UI works"],
				allowedPaths: ["src/ui.ts"],
				validationCommands: [{ command: "npm", args: ["run", "typecheck"] }],
			},
		],
		finalValidationCommands: [{ command: "npm", args: ["run", "check"] }],
	};
}

describe("legacy plan translation", () => {
	it("translates every legacy task into an equivalent change step", () => {
		const legacy = legacyPlan();
		const workflow = translateLegacyTaskPlan(legacy);

		expect(workflow.version).toBe(WORKFLOW_PLAN_SCHEMA_VERSION);
		expect(workflow.title).toBe(legacy.title);
		expect(workflow.finalValidationCommands).toEqual(
			legacy.finalValidationCommands,
		);
		expect(workflow.steps.map((step) => step.kind)).toEqual([
			"change",
			"change",
		]);
		expect(workflow.steps.map((step) => step.id)).toEqual(["core", "ui"]);
		const ui = workflow.steps[1];
		if (ui?.kind !== "change") {
			throw new Error("Expected a change step");
		}
		expect(ui.dependencies).toEqual(["core"]);
		expect(ui.acceptanceCriteria).toEqual(["UI works"]);
		expect(ui.allowedPaths).toEqual(["src/ui.ts"]);
		expect(ui.validationCommands).toEqual([
			{ command: "npm", args: ["run", "typecheck"] },
		]);
		expect(validateWorkflowPlan(workflow)).toEqual(workflow);
	});

	it("preserves legacy execution authority through the step defaults", () => {
		const workflow = translateLegacyTaskPlan(legacyPlan());
		const core = workflow.steps[0];
		if (!core) {
			throw new Error("Missing translated step");
		}
		expect(stepCapabilities(core)).toEqual([
			"read-repository",
			"mutate-repository",
			"execute-commands",
		]);
		expect(stepPathLocks(core)).toEqual(["src/core/"]);
	});

	it("is deterministic", () => {
		expect(translateLegacyTaskPlan(legacyPlan())).toEqual(
			translateLegacyTaskPlan(legacyPlan()),
		);
	});

	it("reads version 3 and version 4 plan documents", () => {
		const fromLegacy = readWorkflowPlanDocument(legacyPlan());
		expect(fromLegacy).toEqual(translateLegacyTaskPlan(legacyPlan()));

		const workflow = translateLegacyTaskPlan(legacyPlan());
		expect(readWorkflowPlanDocument(workflow)).toEqual(workflow);
	});

	it("rejects unsupported plan document versions with a typed issue", () => {
		try {
			readWorkflowPlanDocument({ ...legacyPlan(), version: 2 });
			throw new Error("Expected a validation error");
		} catch (error) {
			if (!(error instanceof PlanValidationError)) {
				throw error;
			}
			expect(error.details).toContainEqual(
				expect.objectContaining({ code: "unsupported_plan_version" }),
			);
		}
	});

	it("propagates legacy validation failures", () => {
		const invalid = legacyPlan();
		invalid.tasks[0]?.dependencies.push("missing");
		expect(() => readWorkflowPlanDocument(invalid)).toThrow(
			PlanValidationError,
		);
	});
});
