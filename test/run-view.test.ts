import { describe, expect, it } from "vitest";
import { approveRun, createOrchestrationRun } from "../src/domain/run.js";
import type { OrchestrationRun, TaskPlan } from "../src/domain/types.js";
import {
	createWorkflowRunState,
	type StepRunState,
	type WorkflowRunState,
} from "../src/engine/workflow-state.js";
import {
	renderRunOverview,
	reviewStateSummary,
} from "../src/inspection/run-presentation.js";
import {
	engineRunView,
	type ReviewFindingsByStep,
	reviewRoundViews,
} from "../src/inspection/run-view.js";
import { defaultCapabilityProfiles } from "../src/security/capabilities.js";
import { buildChangeWorkflowPlan } from "../src/workflows/change.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

const plan: TaskPlan = {
	version: 3,
	title: "Engine view",
	tasks: [
		{
			id: "implementation",
			title: "Implement",
			description: "Implement it",
			dependencies: [],
			acceptanceCriteria: ["Done"],
			allowedPaths: ["src/"],
			validationCommands: [{ command: "npm", args: ["test"] }],
		},
	],
	finalValidationCommands: [{ command: "npm", args: ["run", "check"] }],
};

function storedRun(): OrchestrationRun {
	return approveRun(
		createOrchestrationRun({
			id: "engine-run",
			repositoryRoot: "/repo",
			baseBranch: "main",
			baseCommit: "base",
			integrationBranch: "conductor/engine-run/integration",
			request: { sourcePath: "/repo/request.md", text: "Build it" },
			plan,
			maxConcurrentWorkers: 2,
			now: CREATED_AT,
		}),
		CREATED_AT,
	);
}

function workflowState(): WorkflowRunState {
	return createWorkflowRunState({
		id: "engine-run",
		plan: buildChangeWorkflowPlan(plan),
		repositoryRoot: "/repo",
		baseBranch: "main",
		baseCommit: "base",
		integrationBranch: "conductor/engine-run/integration",
		integrationHead: "base",
		capabilityProfiles: defaultCapabilityProfiles(),
		maxConcurrentWorkers: 2,
		createdAt: CREATED_AT,
	});
}

/** Puts the named steps into one state, leaving the rest untouched. */
function withStepStates(
	state: WorkflowRunState,
	states: Record<string, StepRunState>,
): WorkflowRunState {
	const steps = { ...state.steps };
	for (const [stepId, stepState] of Object.entries(states)) {
		const record = steps[stepId];
		if (!record) {
			throw new Error(`Missing test fixture step: ${stepId}`);
		}
		steps[stepId] = { ...record, state: stepState };
	}
	return { ...state, steps };
}

function reviewRound(
	state: WorkflowRunState,
	round: number,
	stepState: StepRunState,
): WorkflowRunState {
	return withStepStates(
		state,
		Object.fromEntries(
			Object.keys(state.steps)
				.filter((stepId) => stepId.startsWith(`review-${round}-`))
				.map((stepId) => [stepId, stepState]),
		),
	);
}

function reviewAttempts(
	state: WorkflowRunState,
	round: number,
): WorkflowRunState {
	return {
		...state,
		attempts: [
			...state.attempts,
			...Object.keys(state.steps)
				.filter((stepId) => stepId.startsWith(`review-${round}-`))
				.map((stepId, index) => ({
					id: `${stepId}-1`,
					stepId,
					number: 1,
					state: "succeeded" as const,
					workspaceRequirement: "read-only" as const,
					workspacePath: `/worktrees/${stepId}`,
					baseCommit: "integrated",
					startedAt: `2026-01-01T00:1${index}:00.000Z`,
					finishedAt: `2026-01-01T00:2${index}:00.000Z`,
					workerId: `worker-${stepId}`,
				})),
		],
	};
}

function findings(
	round: number,
	severity: "high" | "low",
): ReviewFindingsByStep {
	return new Map([
		[
			`review-${round}-security`,
			{
				category: "security" as const,
				baseCommit: "integrated",
				summary: "One issue",
				findings: [
					{
						id: `review-${round}-security-001`,
						category: "security" as const,
						severity,
						confidence: "high" as const,
						title: "Missing check",
						description: "The check is missing",
						paths: ["src/core.ts"],
						recommendation: "Add it",
						status: "unresolved" as const,
					},
				],
			},
		],
	]);
}

describe("reading an engine run", () => {
	it("presents every workflow step as a unit in dependency order", () => {
		const view = engineRunView(storedRun(), workflowState());

		expect(view.source).toBe("engine");
		expect(view.units[0]?.id).toBe("implementation");
		expect(view.units[0]?.role).toBe("change");
		expect(view.units.filter((unit) => unit.role === "review")).toHaveLength(
			15,
		);
		expect(view.units.filter((unit) => unit.role === "repair")).toHaveLength(2);
		expect(
			view.units.find((unit) => unit.id === "review-2-tests")?.review,
		).toEqual({ round: 2, category: "tests" });
		expect(view.units.find((unit) => unit.id === "repair-1")?.repairRound).toBe(
			1,
		);
	});

	it("derives the run phase the engine is in rather than storing it", () => {
		const running = workflowState();
		expect(engineRunView(storedRun(), running).state).toBe("running");

		const integrated = withStepStates(running, {
			implementation: "succeeded",
		});
		expect(engineRunView(storedRun(), integrated).state).toBe("integrating");

		const reviewing = withStepStates(integrated, {
			"review-1-security": "running",
		});
		expect(engineRunView(storedRun(), reviewing).state).toBe("reviewing");

		const repairing = withStepStates(reviewRound(integrated, 1, "succeeded"), {
			"repair-1": "running",
		});
		expect(engineRunView(storedRun(), repairing).state).toBe("repairing");

		expect(
			engineRunView(storedRun(), { ...integrated, state: "completed" }).state,
		).toBe("reviewed");
		expect(
			engineRunView(storedRun(), { ...integrated, state: "failed" }).state,
		).toBe("failed");
	});

	it("lets the stored run own the phases the engine knows nothing about", () => {
		const state = { ...workflowState(), state: "completed" as const };
		for (const stored of ["validating", "completed", "failed"] as const) {
			expect(
				engineRunView({ ...storedRun(), state: stored }, state).state,
			).toBe(stored);
		}
		// A cancelled engine run stays cancelled whatever the stored run says.
		expect(
			engineRunView(
				{ ...storedRun(), state: "failed" },
				{
					...state,
					state: "cancelled",
				},
			).state,
		).toBe("cancelled");
	});

	it("applies the repair policy to the findings a review published", () => {
		const state = reviewAttempts(
			reviewRound(withStepStates(workflowState(), {}), 1, "succeeded"),
			1,
		);
		const required = engineRunView(storedRun(), state, findings(1, "high"));
		expect(
			required.attempts.flatMap((attempt) => attempt.findings ?? []),
		).toEqual([expect.objectContaining({ status: "repair_required" })]);

		const repaired = engineRunView(
			{
				...storedRun(),
			},
			withStepStates(
				{
					...state,
					steps: {
						...state.steps,
						...(state.steps["repair-1"]
							? {
									"repair-1": {
										...state.steps["repair-1"],
										integratedCommit: "repair-commit",
									},
								}
							: {}),
					},
					attempts: [
						...state.attempts,
						{
							id: "repair-1-1",
							stepId: "repair-1",
							number: 1,
							state: "succeeded",
							workspaceRequirement: "mutable",
							workspacePath: "/worktrees/repair-1",
							branch: "conductor/engine-run/task/repair-1/attempt-1",
							baseCommit: "integrated",
							startedAt: "2026-01-01T00:30:00.000Z",
							finishedAt: "2026-01-01T00:31:00.000Z",
							commit: "repair-commit",
						},
					],
				},
				{ "repair-1": "succeeded" },
			),
			findings(1, "high"),
		);
		expect(
			repaired.attempts.flatMap((attempt) => attempt.findings ?? []),
		).toEqual([
			expect.objectContaining({
				status: "repaired",
				repairAttemptId: "repair-1-1",
			}),
		]);

		// A finding the policy does not require repaired is deferred, never
		// reported as work a repair failed to do.
		const deferred = engineRunView(storedRun(), state, findings(1, "low"));
		expect(
			deferred.attempts.flatMap((attempt) => attempt.findings ?? []),
		).toEqual([expect.objectContaining({ status: "deferred" })]);
	});

	it("derives review rounds from the review and repair steps", () => {
		const state = reviewAttempts(
			reviewRound(workflowState(), 1, "succeeded"),
			1,
		);

		const [first, ...rest] = reviewRoundViews(
			engineRunView(storedRun(), state, findings(1, "low")),
		);
		expect(first).toMatchObject({
			number: 1,
			state: "succeeded",
			reported: 5,
			categories: 5,
			baseCommit: "integrated",
		});
		expect(first?.findings).toEqual({
			repair_required: 0,
			deferred: 1,
			repaired: 0,
			unresolved: 0,
		});
		// Later rounds exist as steps but have not reported anything yet.
		expect(rest.map((round) => [round.number, round.state])).toEqual([
			[2, "running"],
			[3, "running"],
		]);

		// A round whose findings still require repair, with no repair step left
		// to run them, is the reason a run cannot merge.
		const unrepaired = reviewRoundViews(
			engineRunView(
				storedRun(),
				reviewAttempts(reviewRound(workflowState(), 3, "succeeded"), 3),
				findings(3, "high"),
			),
		).at(-1);
		expect(unrepaired).toMatchObject({
			number: 3,
			state: "failed",
			error: expect.stringContaining("Important findings remain"),
		});
	});

	it("does not present planned review rounds as started", () => {
		const view = engineRunView(storedRun(), workflowState());

		expect(reviewRoundViews(view)).toHaveLength(3);
		expect(reviewStateSummary(view)).toBe("Reviews: not started");
		expect(renderRunOverview(view).join("\n")).not.toContain(
			"Latest review round:",
		);
	});

	it("presents round one while later review rounds are still planned", () => {
		const state = workflowState();
		const stepId = "review-1-security";
		const record = state.steps[stepId];
		if (!record) {
			throw new Error(`Missing test fixture step: ${stepId}`);
		}
		const started = {
			...state,
			steps: {
				...state.steps,
				[stepId]: { ...record, state: "running" as const },
			},
			attempts: [
				...state.attempts,
				{
					id: `${stepId}-1`,
					stepId,
					number: 1,
					state: "running" as const,
					workspaceRequirement: "read-only" as const,
					workspacePath: `/worktrees/${stepId}`,
					baseCommit: "integrated",
					startedAt: "2026-01-01T00:10:00.000Z",
					workerId: `worker-${stepId}`,
				},
			],
		};
		const view = engineRunView(storedRun(), started);
		const overview = renderRunOverview(view).join("\n");

		expect(reviewRoundViews(view)).toHaveLength(3);
		expect(reviewStateSummary(view)).toContain("Review round 1:");
		expect(overview).toContain("Latest review round: running");
		expect(overview).not.toContain("Review round 3:");
	});

	it("reports a failed review round with the step failure behind it", () => {
		const state = withStepStates(workflowState(), {
			"review-1-security": "failed",
		});
		const failed = { ...state };
		const record = failed.steps["review-1-security"];
		if (record) {
			failed.steps = {
				...failed.steps,
				"review-1-security": { ...record, error: "The reviewer crashed" },
			};
		}

		expect(
			reviewRoundViews(engineRunView(storedRun(), failed))[0],
		).toMatchObject({ state: "failed", error: "The reviewer crashed" });
	});
});
