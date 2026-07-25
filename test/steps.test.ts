import { describe, expect, it } from "vitest";
import {
	STEP_KINDS,
	validateWorkflowPlan,
	validateWorkflowPlanResult,
	WORKFLOW_PLAN_SCHEMA_VERSION,
	type WorkflowPlan,
} from "../src/domain/steps.js";

function workflowPlan(): WorkflowPlan {
	return {
		version: WORKFLOW_PLAN_SCHEMA_VERSION,
		title: "Ship health checks",
		steps: [
			{
				id: "survey",
				kind: "investigation",
				title: "Survey the service entry points",
				description: "Find where request handling starts",
				dependencies: [],
				questions: ["Which module owns the HTTP server lifecycle?"],
			},
			{
				id: "approve-approach",
				kind: "approval",
				title: "Approve the endpoint design",
				description: "Confirm the endpoint shape before changes",
				dependencies: ["survey"],
				prompt: "Approve adding GET /healthz returning build metadata?",
			},
			{
				id: "implement",
				kind: "change",
				title: "Implement the endpoint",
				description: "Add the endpoint and tests",
				dependencies: ["approve-approach"],
				acceptanceCriteria: ["GET /healthz returns 200"],
				allowedPaths: ["src/server/"],
				validationCommands: [{ command: "npm", args: ["test"] }],
			},
			{
				id: "verify-build",
				kind: "command",
				title: "Verify the production build",
				description: "Run the build after the change lands",
				dependencies: ["implement"],
				command: { command: "npm", args: ["run", "build"] },
			},
		],
		finalValidationCommands: [{ command: "npm", args: ["run", "check"] }],
	};
}

describe("workflow step definitions", () => {
	it("declares the four generalized step kinds", () => {
		expect(STEP_KINDS).toEqual([
			"investigation",
			"change",
			"command",
			"approval",
		]);
	});

	it("accepts a plan combining all four step kinds", () => {
		const plan = workflowPlan();
		expect(validateWorkflowPlan(plan)).toEqual(plan);
	});

	it("rejects unknown step kinds with a typed issue", () => {
		const plan = workflowPlan();
		const result = validateWorkflowPlanResult({
			...plan,
			steps: [{ ...plan.steps[0], kind: "deploy" }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues).toContainEqual(
				expect.objectContaining({ code: "step_kind", path: "steps[0].kind" }),
			);
		}
	});

	it("rejects steps missing their kind-specific fields", () => {
		const plan = workflowPlan();
		const stripped = plan.steps.map((step) => {
			const {
				questions: _questions,
				prompt: _prompt,
				command: _command,
				allowedPaths: _allowedPaths,
				...rest
			} = step as unknown as Record<string, unknown>;
			return rest;
		});
		const result = validateWorkflowPlanResult({ ...plan, steps: stripped });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const paths = result.issues.map((issue) => issue.path);
			expect(paths).toContain("steps[0].questions");
			expect(paths).toContain("steps[1].prompt");
			expect(paths).toContain("steps[2].allowedPaths");
			expect(paths).toContain("steps[3].command");
		}
	});

	it("rejects duplicate ids, unknown dependencies, and cycles", () => {
		const plan = workflowPlan();
		const duplicate = validateWorkflowPlanResult({
			...plan,
			steps: [plan.steps[0], plan.steps[0]],
		});
		expect(duplicate.ok).toBe(false);
		if (!duplicate.ok) {
			expect(duplicate.issues).toContainEqual(
				expect.objectContaining({ code: "duplicate_step_id" }),
			);
		}

		const unknown = validateWorkflowPlanResult({
			...plan,
			steps: [{ ...plan.steps[0], dependencies: ["missing"] }],
		});
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) {
			expect(unknown.issues).toContainEqual(
				expect.objectContaining({ code: "unknown_dependency" }),
			);
		}

		const first = plan.steps[0];
		const second = plan.steps[1];
		if (!first || !second) {
			throw new Error("Missing fixture steps");
		}
		const cyclic = validateWorkflowPlanResult({
			...plan,
			steps: [
				{ ...first, dependencies: [second.id] },
				{ ...second, dependencies: [first.id] },
			],
		});
		expect(cyclic.ok).toBe(false);
		if (!cyclic.ok) {
			expect(cyclic.issues).toContainEqual(
				expect.objectContaining({ code: "dependency_cycle" }),
			);
		}
	});

	it("requires final validation only when a change step exists", () => {
		const plan = workflowPlan();
		const investigation = plan.steps[0];
		if (!investigation) {
			throw new Error("Missing fixture step");
		}
		const readOnly = validateWorkflowPlanResult({
			...plan,
			steps: [investigation],
			finalValidationCommands: [],
		});
		expect(readOnly.ok).toBe(true);

		const mutating = validateWorkflowPlanResult({
			...plan,
			finalValidationCommands: [],
		});
		expect(mutating.ok).toBe(false);
		if (!mutating.ok) {
			expect(mutating.issues).toContainEqual(
				expect.objectContaining({ code: "required_final_validation" }),
			);
		}
	});

	it("rejects malformed plans and wrong schema versions", () => {
		expect(() => validateWorkflowPlan(null)).toThrow(/plan must be an object/);
		const result = validateWorkflowPlanResult({
			...workflowPlan(),
			version: 3,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues).toContainEqual(
				expect.objectContaining({ code: "schema_version" }),
			);
		}
	});
});
