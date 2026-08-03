import { describe, expect, it } from "vitest";
import {
	validateWorkflowPlan,
	type WorkflowPlan,
} from "../src/domain/steps.js";
import {
	launchableStepIds,
	nextIntegrableStepId,
	pathLocksConflict,
	reconcileWorkflowSteps,
} from "../src/engine/scheduler.js";
import {
	createWorkflowRunState,
	type StepRunState,
	type WorkflowRunState,
	type WorkflowStepAttempt,
} from "../src/engine/workflow-state.js";
import { defaultCapabilityProfiles } from "../src/security/capabilities.js";

function investigation(
	id: string,
	dependencies: string[] = [],
): Record<string, unknown> {
	return {
		kind: "investigation",
		id,
		title: id,
		description: `Investigate ${id}`,
		dependencies,
		questions: [`What does ${id} need?`],
	};
}

function change(
	id: string,
	dependencies: string[],
	allowedPaths: string[],
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		kind: "change",
		id,
		title: id,
		description: `Implement ${id}`,
		dependencies,
		acceptanceCriteria: [`${id} exists`],
		allowedPaths,
		validationCommands: [{ command: "node", args: ["-e", ""] }],
		...extra,
	};
}

function approval(id: string, dependencies: string[]): Record<string, unknown> {
	return {
		kind: "approval",
		id,
		title: id,
		description: `Approve ${id}`,
		dependencies,
		prompt: `Approve ${id}?`,
	};
}

function planOf(steps: Record<string, unknown>[]): WorkflowPlan {
	return validateWorkflowPlan({
		version: 4,
		title: "Deliver the widget",
		steps,
		finalValidationCommands: [{ command: "node", args: ["-e", ""] }],
	});
}

function runWith(
	plan: WorkflowPlan,
	maxConcurrentWorkers = 2,
): WorkflowRunState {
	return createWorkflowRunState({
		id: "run-1",
		plan,
		repositoryRoot: "/repo",
		baseBranch: "main",
		baseCommit: "base",
		integrationBranch: "conductor/run-1/integration",
		integrationHead: "base",
		capabilityProfiles: defaultCapabilityProfiles(),
		maxConcurrentWorkers,
		createdAt: "2026-07-29T00:00:00.000Z",
	});
}

function withStep(
	state: WorkflowRunState,
	stepId: string,
	update: { state?: StepRunState; integratedCommit?: string },
): WorkflowRunState {
	const record = state.steps[stepId];
	if (!record) {
		throw new Error(`unknown step ${stepId}`);
	}
	return {
		...state,
		steps: { ...state.steps, [stepId]: { ...record, ...update } },
	};
}

function activeAttempt(stepId: string): WorkflowStepAttempt {
	return {
		id: `${stepId}-1`,
		stepId,
		number: 1,
		state: "running",
		workspaceRequirement: "mutable",
		workspacePath: `/worktrees/${stepId}`,
		branch: `conductor/run-1/task/${stepId}/attempt-1`,
		baseCommit: "base",
		startedAt: "2026-07-29T00:00:00.000Z",
	};
}

describe("workflow scheduler", () => {
	it("launches only dependency-free steps in deterministic plan order", () => {
		const state = runWith(
			planOf([
				change("ui", [], ["src/ui/"]),
				change("api", [], ["src/api/"]),
				change("release", ["api", "ui"], ["release/"]),
			]),
			4,
		);

		expect(launchableStepIds(state)).toEqual(["ui", "api"]);
	});

	it("skips a missing stored step record without disturbing later readiness", () => {
		const state = runWith(
			planOf([
				change("missing", [], ["src/missing/"]),
				change("ready", [], ["src/ready/"]),
			]),
			2,
		);
		const { missing: _missing, ...remainingSteps } = state.steps;

		expect(launchableStepIds({ ...state, steps: remainingSteps })).toEqual([
			"ready",
		]);
	});

	it("keeps dependents waiting until a mutating dependency is integrated", () => {
		const plan = planOf([
			change("api", [], ["src/api/"]),
			change("ui", ["api"], ["src/ui/"]),
		]);
		const succeeded = withStep(runWith(plan), "api", { state: "succeeded" });

		expect(reconcileWorkflowSteps(succeeded).steps.ui?.state).toBe("planned");
		expect(launchableStepIds(succeeded)).toEqual([]);

		const integrated = withStep(succeeded, "api", {
			integratedCommit: "commit-api",
		});

		expect(launchableStepIds(integrated)).toEqual(["ui"]);
	});

	it("unblocks dependents of a step that cannot change the repository", () => {
		const plan = planOf([
			investigation("survey"),
			change("api", ["survey"], ["src/api/"]),
		]);
		const state = withStep(runWith(plan), "survey", { state: "succeeded" });

		expect(launchableStepIds(state)).toEqual(["api"]);
	});

	it("bounds worker slots without ever holding back a decision gate", () => {
		const plan = planOf([
			change("api", [], ["src/api/"]),
			change("ui", [], ["src/ui/"]),
			change("docs", [], ["docs/"]),
			approval("ship", []),
		]);
		const state = runWith(plan, 2);

		expect(launchableStepIds(state)).toEqual(["api", "ui", "ship"]);

		const busy: WorkflowRunState = {
			...withStep(withStep(state, "api", { state: "running" }), "ui", {
				state: "running",
			}),
			attempts: [activeAttempt("api"), activeAttempt("ui")],
		};

		expect(launchableStepIds(busy)).toEqual(["ship"]);
	});

	it("counts steps left running without an attempt against the slot budget", () => {
		const plan = planOf([
			change("api", [], ["src/api/"]),
			change("ui", [], ["src/ui/"]),
			change("docs", [], ["docs/"]),
		]);
		const interrupted = withStep(
			withStep(runWith(plan, 2), "api", {
				state: "running",
			}),
			"ui",
			{ state: "running" },
		);

		expect(launchableStepIds(interrupted)).toEqual([]);
	});

	it("never launches steps whose path locks overlap", () => {
		const plan = planOf([
			change("wide", [], ["src/"]),
			change("narrow", [], ["src/narrow/"]),
			change("other", [], ["docs/"]),
		]);

		expect(launchableStepIds(runWith(plan, 4))).toEqual(["wide", "other"]);

		const running: WorkflowRunState = {
			...withStep(runWith(plan, 4), "narrow", { state: "running" }),
			attempts: [activeAttempt("narrow")],
		};

		expect(launchableStepIds(running)).toEqual(["other"]);
	});

	it("honours explicit path locks over the default change-step locks", () => {
		const plan = planOf([
			change("api", [], ["src/api/"], { pathLocks: ["generated/"] }),
			change("ui", [], ["src/ui/"], { pathLocks: ["generated/"] }),
		]);

		expect(launchableStepIds(runWith(plan, 4))).toEqual(["api"]);
	});

	it("never launches steps that hold the same named resource lock", () => {
		const plan = planOf([
			change("migrate", [], ["db/migrations/"], {
				resourceLocks: ["database"],
			}),
			change("seed", [], ["db/seeds/"], { resourceLocks: ["database"] }),
			change("docs", [], ["docs/"], { resourceLocks: ["site"] }),
		]);

		expect(launchableStepIds(runWith(plan, 4))).toEqual(["migrate", "docs"]);

		const running: WorkflowRunState = {
			...withStep(runWith(plan, 4), "seed", { state: "running" }),
			attempts: [activeAttempt("seed")],
		};

		expect(launchableStepIds(running)).toEqual(["docs"]);
	});

	it("blocks every dependent of a failed step transitively", () => {
		const plan = planOf([
			change("api", [], ["src/api/"]),
			change("ui", ["api"], ["src/ui/"]),
			approval("ship", ["ui"]),
		]);
		const failed = withStep(runWith(plan), "api", { state: "failed" });
		const reconciled = reconcileWorkflowSteps(failed);

		expect(reconciled.steps.ui?.state).toBe("blocked");
		expect(reconciled.steps.ship?.state).toBe("blocked");
		expect(launchableStepIds(failed)).toEqual([]);
	});

	it("stops scheduling once the run is no longer running", () => {
		const state = runWith(planOf([change("api", [], ["src/api/"])]));

		expect(launchableStepIds({ ...state, state: "cancelled" })).toEqual([]);
	});

	it("integrates mutating steps in plan order and waits for the first gap", () => {
		const plan = planOf([
			investigation("survey"),
			change("api", ["survey"], ["src/api/"]),
			change("ui", ["survey"], ["src/ui/"]),
		]);
		const state = withStep(runWith(plan), "survey", { state: "succeeded" });

		expect(nextIntegrableStepId(state)).toBeUndefined();

		const uiFirst = withStep(state, "ui", { state: "succeeded" });

		expect(nextIntegrableStepId(uiFirst)).toBeUndefined();

		const apiDone = withStep(uiFirst, "api", { state: "succeeded" });

		expect(nextIntegrableStepId(apiDone)).toBe("api");
		expect(
			nextIntegrableStepId(
				withStep(apiDone, "api", { integratedCommit: "commit-api" }),
			),
		).toBe("ui");
	});

	it("treats containment as a path-lock conflict in both directions", () => {
		expect(pathLocksConflict("src/", "src/api/index.ts")).toBe(true);
		expect(pathLocksConflict("src/api/index.ts", "src/")).toBe(true);
		expect(pathLocksConflict("src/api/", "src/ui/")).toBe(false);
		expect(pathLocksConflict("src/api.ts", "src/api.ts")).toBe(true);
		expect(pathLocksConflict("src/api.ts", "src/api.tsx")).toBe(false);
	});
});
