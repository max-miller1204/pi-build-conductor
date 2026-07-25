import { describe, expect, it } from "vitest";
import { createOrchestrationRun } from "../src/domain/run.js";
import type {
	OrchestrationRun,
	TaskPlan,
	ValidationCheckEvidence,
} from "../src/domain/types.js";
import {
	latestFollowableWorkerAttempt,
	latestWorkerAttempt,
	renderAttemptDetails,
	renderRunList,
	renderRunOverview,
	renderTaskDetails,
	resolveRunAttempt,
	reviewStateSummary,
	taskStateSummary,
} from "../src/inspection/run-presentation.js";

const plan: TaskPlan = {
	version: 3,
	title: "Inspection build",
	tasks: [
		{
			id: "core",
			title: "Implement core",
			description: "Implement the core\nwithout terminal surprises.",
			dependencies: [],
			acceptanceCriteria: ["Core works", "Errors are reported"],
			allowedPaths: ["src/core.ts"],
			validationCommands: [{ command: "npm", args: ["test", "--", "core"] }],
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

function required<T>(value: T | undefined, name: string): T {
	if (value === undefined) {
		throw new Error(`Missing test fixture: ${name}`);
	}
	return value;
}

function checkEvidence(): ValidationCheckEvidence {
	return {
		command: "npm",
		args: ["test", "--", "core suite"],
		startedAt: "2026-01-01T00:05:00.000Z",
		finishedAt: "2026-01-01T00:06:00.000Z",
		exitCode: 1,
		stdoutTail: `${"old-output".repeat(300)}\nrecent stdout\u001b[31m red`,
		stderrTail: "failure\u0007details",
		passed: false,
	};
}

function populatedRun(): OrchestrationRun {
	const created = createOrchestrationRun({
		id: "run-inspect",
		repositoryRoot: "/repo",
		baseBranch: "main",
		baseCommit: "base-commit",
		integrationBranch: "conductor/run-inspect/integration",
		request: { sourcePath: "/repo/request.md", text: "Build it" },
		plan,
		maxConcurrentWorkers: 3,
		now: "2026-01-01T00:00:00.000Z",
	});
	const evidence = {
		startedAt: "2026-01-01T00:05:00.000Z",
		finishedAt: "2026-01-01T00:06:00.000Z",
		passed: false,
		changedFiles: [{ path: "src/core.ts", status: "M" }],
		diffHash: "diff-hash",
		checks: [checkEvidence()],
	};
	return {
		...created,
		state: "repairing",
		revision: 12,
		updatedAt: "2026-01-01T00:40:00.000Z",
		approvedAt: "2026-01-01T00:01:00.000Z",
		approvedPlanRevision: 1,
		tasks: {
			core: {
				...required(created.tasks.core, "core task"),
				state: "failed",
				attemptIds: ["task-a"],
				integrationError: "conflict\u001b[2J retained",
			},
			ui: {
				...required(created.tasks.ui, "ui task"),
				state: "blocked",
				attemptIds: [],
			},
		},
		attempts: [
			{
				id: "task-a",
				taskId: "core",
				number: 1,
				state: "failed",
				branch: "conductor/run-inspect/task/core/1",
				worktreePath: "/worktrees/core",
				baseCommit: "base-commit",
				workerId: "worker-task",
				startedAt: "2026-01-01T00:02:00.000Z",
				finishedAt: "2026-01-01T00:07:00.000Z",
				error: "Tests failed\u001b[31m",
				commit: "task-commit",
				evidence,
			},
		],
		reviewRounds: [
			{
				number: 1,
				state: "repairing",
				baseCommit: "task-integrated",
				attemptIds: ["review-a"],
				startedAt: "2026-01-01T00:10:00.000Z",
				repairAttemptId: "repair-a",
			},
		],
		reviewAttempts: [
			{
				id: "review-a",
				round: 1,
				category: "correctness",
				number: 1,
				state: "succeeded",
				branch: "conductor/run-inspect/review/correctness/1",
				worktreePath: "/worktrees/review",
				baseCommit: "task-integrated",
				workerId: "worker-review",
				startedAt: "2026-01-01T00:10:00.000Z",
				finishedAt: "2026-01-01T00:15:00.000Z",
				summary: "Found one issue\u001b[2J",
				findings: [
					{
						id: "finding-1",
						category: "correctness",
						severity: "high",
						confidence: "high",
						title: "Incorrect result",
						description: "The result is incorrect",
						paths: ["src/core.ts"],
						recommendation: "Fix it",
						status: "repair_required",
						repairAttemptId: "repair-a",
					},
				],
			},
		],
		repairAttempts: [
			{
				id: "repair-a",
				round: 1,
				number: 1,
				state: "running",
				findingIds: ["finding-1"],
				branch: "conductor/run-inspect/repair/1/1",
				worktreePath: "/worktrees/repair",
				baseCommit: "task-integrated",
				workerId: "worker-repair",
				startedAt: "2026-01-01T00:20:00.000Z",
			},
		],
		blockedWorkers: [
			{
				attemptKind: "repair",
				attemptId: "repair-a",
				workerId: "worker-repair",
				blockedAt: "2026-01-01T00:25:00.000Z",
				requestId: "request-a",
				method: "input",
				timeoutAt: "2026-01-01T00:26:00.000Z",
			},
		],
		finalValidationAttempts: [
			{
				id: "final-a",
				number: 1,
				state: "failed",
				integrationCommit: "final-head",
				worktreePath: "/worktrees/final",
				startedAt: "2026-01-01T00:30:00.000Z",
				finishedAt: "2026-01-01T00:35:00.000Z",
				error: "Final validation failed",
				evidence: {
					startedAt: "2026-01-01T00:30:00.000Z",
					finishedAt: "2026-01-01T00:35:00.000Z",
					passed: false,
					checks: [checkEvidence()],
				},
			},
		],
	};
}

describe("run inspection presentation", () => {
	it("summarizes task and review state", () => {
		const run = populatedRun();
		expect(taskStateSummary(run)).toBe("1 blocked, 1 failed");
		expect(reviewStateSummary(run)).toBe(
			"Review round 1: 1/5 reports received, 1 repair-required, 0 unresolved, 0 deferred",
		);
	});

	it("sorts run list rows by updated time without changing the input", () => {
		const older = populatedRun();
		const newer = {
			...populatedRun(),
			id: "newer",
			updatedAt: "2026-02-01T00:00:00.000Z",
		};
		const runs = [older, newer];
		const lines = renderRunList(runs);
		expect(lines.findIndex((line) => line.includes("newer"))).toBeLessThan(
			lines.findIndex((line) => line.includes("run-inspect")),
		);
		expect(runs.map((run) => run.id)).toEqual(["run-inspect", "newer"]);
		expect(lines.at(-1)).toBe("Next: /orchestrate-show <run-id>");
	});

	it("renders run refs, timestamps, task progress, and next action", () => {
		const output = renderRunOverview(populatedRun()).join("\n");
		expect(output).toContain("Base: main @ base-commit");
		expect(output).toContain(
			"Integration: conductor/run-inspect/integration @ base-commit",
		);
		expect(output).toContain("Created: 2026-01-01T00:00:00.000Z");
		expect(output).toContain("core [failed]");
		expect(output).toContain("Blocked workers: 1");
		expect(output).toContain("repair-a / worker-repair waiting on input");
		expect(output).toContain("Next: /orchestrate-follow run-inspect repair-a");
		expect(output).not.toContain("\u001b");
	});

	it("renders the full task authority and retry recommendation", () => {
		const output = renderTaskDetails(populatedRun(), "core").join("\n");
		expect(output).toContain("Description: Implement the core without");
		expect(output).toContain("Allowed paths: src/core.ts");
		expect(output).toContain("- npm test -- core");
		expect(output).toContain("worker worker-task");
		expect(output).toContain("Next: /orchestrate-retry run-inspect core");
		expect(() => renderTaskDetails(populatedRun(), "unknown")).toThrow(
			"Unknown task ID: unknown",
		);
	});

	it("resolves every attempt kind and rejects unknown or ambiguous IDs", () => {
		const run = populatedRun();
		expect(resolveRunAttempt(run, "task-a").kind).toBe("task");
		expect(resolveRunAttempt(run, "review-a").kind).toBe("review");
		expect(resolveRunAttempt(run, "repair-a").kind).toBe("repair");
		expect(resolveRunAttempt(run, "final-a").kind).toBe("final-validation");
		expect(() => resolveRunAttempt(run, "unknown")).toThrow(
			"Unknown attempt ID: unknown",
		);
		const ambiguous: OrchestrationRun = {
			...run,
			reviewAttempts: [
				{
					...required(run.reviewAttempts[0], "review attempt"),
					id: "task-a",
				},
			],
		};
		expect(() => resolveRunAttempt(ambiguous, "task-a")).toThrow(
			"Ambiguous attempt ID task-a: found task, review",
		);
	});

	it.each([
		["task-a", "Task: core - Implement core", "Diff hash: diff-hash"],
		["review-a", "Review: round 1, category correctness", "finding-1"],
		["repair-a", "Repair: round 1, findings finding-1", "worker-repair"],
		["final-a", "Integration commit: final-head", "Final validation failed"],
	])(
		"renders %s attempt details",
		(attemptId: string, detail: string, evidence: string) => {
			const output = renderAttemptDetails(populatedRun(), attemptId).join("\n");
			expect(output).toContain(detail);
			expect(output).toContain(evidence);
			expect(output).toContain("Next:");
			if (attemptId === "repair-a") {
				expect(output).toContain("Worker prompts: 1 pending");
				expect(output).toContain("waiting on input");
			}
		},
	);

	it("bounds output tails and removes terminal control characters", () => {
		const lines = renderAttemptDetails(populatedRun(), "task-a");
		const output = lines.join("\n");
		expect(output).toContain("stdout tail (truncated)");
		expect(output).toContain("recent stdout [31m red");
		expect(output).toContain("failure details");
		expect(output).not.toContain("\u001b");
		expect(output).not.toContain("\u0007");
		expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(
			520,
		);
	});

	it("selects the latest worker and latest active followable worker", () => {
		const run = populatedRun();
		expect(latestWorkerAttempt(run)?.attempt.id).toBe("repair-a");
		expect(latestFollowableWorkerAttempt(run)?.attempt.id).toBe("repair-a");
		const stopped = {
			...run,
			repairAttempts: [
				{
					...required(run.repairAttempts[0], "repair attempt"),
					state: "succeeded" as const,
				},
			],
		};
		expect(latestFollowableWorkerAttempt(stopped)).toBeUndefined();
	});
});
