import { describe, expect, it } from "vitest";
import { approveRun, createOrchestrationRun } from "../src/domain/run.js";
import {
	prepareFailedRunRetry,
	RunRetryError,
	recommendedRunAction,
	retryableRunWork,
} from "../src/domain/run-control.js";
import {
	type OrchestrationRun,
	REVIEW_CATEGORIES,
	type RunTask,
	type TaskDefinition,
	type TaskPlan,
} from "../src/domain/types.js";
import { validateStoredRun } from "../src/storage/run-store.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const APPROVED_AT = "2026-01-01T00:01:00.000Z";
const RETRIED_AT = "2026-01-01T01:00:00.000Z";

function task(id: string, dependencies: string[] = []): TaskDefinition {
	return {
		id,
		title: id,
		description: `Implement ${id}`,
		dependencies,
		acceptanceCriteria: [`${id} works`],
		allowedPaths: [`src/${id}/`],
		validationCommands: [{ command: "npm", args: ["test"] }],
	};
}

function createRun(definitions: TaskDefinition[] = [task("implementation")]) {
	const plan: TaskPlan = {
		version: 3,
		title: "Retry test",
		tasks: definitions,
		finalValidationCommands: [{ command: "npm", args: ["test"] }],
	};
	return createOrchestrationRun({
		id: "retry-run",
		repositoryRoot: "/repo",
		baseBranch: "main",
		baseCommit: "base",
		integrationBranch: "conductor/retry-run/integration",
		request: { sourcePath: "/repo/request.md", text: "Implement it" },
		plan,
		maxConcurrentWorkers: 2,
		now: CREATED_AT,
	});
}

function approvedRun(definitions?: TaskDefinition[]): OrchestrationRun {
	return approveRun(createRun(definitions), APPROVED_AT);
}

function runTask(run: OrchestrationRun, taskId: string): RunTask {
	const found = run.tasks[taskId];
	if (!found) {
		throw new Error(`Missing test task ${taskId}`);
	}
	return found;
}

function failedEvidence() {
	return {
		startedAt: APPROVED_AT,
		finishedAt: APPROVED_AT,
		passed: false,
		changedFiles: [{ path: "src/failed/file.ts", status: "M" }],
		diffHash: "failed-diff",
		checks: [
			{
				command: "npm",
				args: ["test"],
				startedAt: APPROVED_AT,
				finishedAt: APPROVED_AT,
				exitCode: 1,
				stdoutTail: "failure output",
				stderrTail: "test failed",
				passed: false,
			},
		],
	};
}

function taskFailureRun(): OrchestrationRun {
	const run = approvedRun([
		task("retained"),
		task("failed"),
		task("child", ["failed"]),
		task("grandchild", ["child"]),
		task("other"),
	]);
	return {
		...run,
		state: "failed",
		integrationHead: "integrated-retained",
		tasks: {
			...run.tasks,
			retained: {
				...runTask(run, "retained"),
				state: "succeeded",
				attemptIds: ["retained-1"],
				integratedCommit: "integrated-retained",
			},
			failed: {
				...runTask(run, "failed"),
				state: "failed",
				attemptIds: ["failed-1"],
				integrationError: "cherry-pick conflicted",
			},
			child: { ...runTask(run, "child"), state: "blocked" },
			grandchild: { ...runTask(run, "grandchild"), state: "blocked" },
		},
		attempts: [
			{
				id: "retained-1",
				taskId: "retained",
				number: 1,
				state: "succeeded",
				branch: "conductor/retry-run/task/retained/attempt-1",
				worktreePath: "/worktrees/retained",
				baseCommit: "base",
				startedAt: APPROVED_AT,
				finishedAt: APPROVED_AT,
				commit: "source-retained",
				evidence: { ...failedEvidence(), passed: true, checks: [] },
			},
			{
				id: "failed-1",
				taskId: "failed",
				number: 1,
				state: "failed",
				branch: "conductor/retry-run/task/failed/attempt-1",
				worktreePath: "/worktrees/failed",
				baseCommit: "integrated-retained",
				startedAt: APPROVED_AT,
				finishedAt: APPROVED_AT,
				error: "validation failed",
				evidence: failedEvidence(),
			},
		],
	};
}

function failedFinalValidationRun(): OrchestrationRun {
	const run = approvedRun();
	const reviewAttempts = REVIEW_CATEGORIES.map((category) => ({
		id: `review-${category}`,
		round: 1,
		category,
		number: 1,
		state: "succeeded" as const,
		branch: `conductor/retry-run/review/${category}`,
		worktreePath: `/worktrees/review-${category}`,
		baseCommit: run.integrationHead,
		startedAt: APPROVED_AT,
		finishedAt: APPROVED_AT,
		summary: `${category} passed`,
		findings: [],
	}));
	return {
		...run,
		state: "failed",
		reviewRounds: [
			{
				number: 1,
				state: "succeeded",
				baseCommit: run.integrationHead,
				attemptIds: reviewAttempts.map((attempt) => attempt.id),
				startedAt: APPROVED_AT,
				finishedAt: APPROVED_AT,
			},
		],
		reviewAttempts,
		finalValidationAttempts: [
			{
				id: "retry-run-final-1",
				number: 1,
				state: "failed",
				integrationCommit: run.integrationHead,
				worktreePath: "/worktrees/final-1",
				startedAt: APPROVED_AT,
				finishedAt: APPROVED_AT,
				error: "npm test failed",
				evidence: {
					startedAt: APPROVED_AT,
					finishedAt: APPROVED_AT,
					passed: false,
					checks: failedEvidence().checks,
				},
			},
		],
	};
}

describe("failed run retry control", () => {
	it("identifies task work and every blocked descendant", () => {
		const run = taskFailureRun();

		expect(retryableRunWork(run)).toEqual({
			retryable: true,
			phase: "tasks",
			failedTaskIds: ["failed"],
			resetTaskIds: ["failed", "child", "grandchild"],
		});
		expect(recommendedRunAction(run)).toMatchObject({
			action: "retry",
			work: { phase: "tasks", failedTaskIds: ["failed"] },
		});
	});

	it("atomically replans failed task work without losing history", () => {
		const run = taskFailureRun();
		const original = structuredClone(run);
		const attempts = run.attempts;
		const retained = run.tasks.retained;

		const retried = prepareFailedRunRetry(run, RETRIED_AT);

		expect(run).toEqual(original);
		expect(retried).not.toBe(run);
		expect(retried).toMatchObject({ state: "running", updatedAt: RETRIED_AT });
		expect(retried.tasks.failed).toMatchObject({
			state: "ready",
			attemptIds: ["failed-1"],
		});
		expect(retried.tasks.failed).not.toHaveProperty("integrationError");
		expect(retried.tasks.child?.state).toBe("planned");
		expect(retried.tasks.grandchild?.state).toBe("planned");
		expect(retried.tasks.other?.state).toBe("ready");
		expect(retried.tasks.retained).toEqual(retained);
		expect(retried.tasks.retained).toMatchObject({
			state: "succeeded",
			integratedCommit: "integrated-retained",
		});
		expect(retried.attempts).toBe(attempts);
		expect(retried.attempts).toEqual(original.attempts);
		expect(retried.attempts[1]?.evidence).toEqual(failedEvidence());
		expect(validateStoredRun(retried)).toBe(retried);
	});

	it("retries integration without rerunning an already validated task", () => {
		const run = taskFailureRun();
		const attempt = run.attempts.find((item) => item.taskId === "failed");
		if (!attempt) {
			throw new Error("Missing failed task attempt");
		}
		attempt.state = "succeeded";
		attempt.commit = "source-failed";
		attempt.evidence = { ...failedEvidence(), passed: true, checks: [] };

		const retried = prepareFailedRunRetry(run, RETRIED_AT);

		expect(retried.tasks.failed).toMatchObject({
			state: "succeeded",
			attemptIds: ["failed-1"],
		});
		expect(retried.tasks.failed).not.toHaveProperty("integrationError");
		expect(validateStoredRun(retried)).toBe(retried);
	});

	it("returns reviewed for a failed final-validation attempt", () => {
		const run = failedFinalValidationRun();
		const finalAttempts = run.finalValidationAttempts;
		const reviewAttempts = run.reviewAttempts;

		expect(retryableRunWork(run)).toEqual({
			retryable: true,
			phase: "final-validation",
			attemptId: "retry-run-final-1",
		});
		const retried = prepareFailedRunRetry(run, RETRIED_AT);
		expect(retried.state).toBe("reviewed");
		expect(retried.updatedAt).toBe(RETRIED_AT);
		expect(retried.finalValidationAttempts).toBe(finalAttempts);
		expect(retried.reviewAttempts).toBe(reviewAttempts);
		expect(validateStoredRun(retried)).toBe(retried);
	});

	it("directs interrupted work to resume instead of retry", () => {
		const run = taskFailureRun();
		run.attempts.push({
			id: "other-1",
			taskId: "other",
			number: 1,
			state: "interrupted",
			branch: "conductor/retry-run/task/other/attempt-1",
			worktreePath: "/worktrees/other",
			baseCommit: run.integrationHead,
			startedAt: APPROVED_AT,
			finishedAt: APPROVED_AT,
			error: "Orchestrator restarted",
		});
		runTask(run, "other").attemptIds.push("other-1");

		expect(recommendedRunAction(run)).toMatchObject({
			action: "resume",
			reason: expect.stringContaining("resume the run instead of retrying"),
		});
		expect(() => prepareFailedRunRetry(run, RETRIED_AT)).toThrowError(
			/resume the run instead of retrying/,
		);
	});

	it("recommends resume for a recovered nonfailed run", () => {
		const run = approvedRun();
		run.attempts.push({
			id: "implementation-1",
			taskId: "implementation",
			number: 1,
			state: "interrupted",
			branch: "conductor/retry-run/task/implementation/attempt-1",
			worktreePath: "/worktrees/implementation",
			baseCommit: run.integrationHead,
			startedAt: APPROVED_AT,
			finishedAt: APPROVED_AT,
			error: "Orchestrator restarted",
		});
		runTask(run, "implementation").attemptIds.push("implementation-1");

		expect(recommendedRunAction(run)).toMatchObject({
			action: "resume",
			reason: expect.stringContaining("interrupted attempts"),
		});
	});

	it("does not let a superseded historical interruption mask a later failure", () => {
		const run = taskFailureRun();
		const failedAttempt = run.attempts.pop();
		if (!failedAttempt) {
			throw new Error("Missing failed test attempt");
		}
		run.attempts.push(
			{
				id: "failed-interrupted",
				taskId: "failed",
				number: 1,
				state: "interrupted",
				branch: "conductor/retry-run/task/failed/attempt-1",
				worktreePath: "/worktrees/failed-1",
				baseCommit: run.integrationHead,
				startedAt: APPROVED_AT,
				finishedAt: APPROVED_AT,
				error: "Orchestrator restarted",
			},
			{ ...failedAttempt, number: 2 },
		);
		runTask(run, "failed").attemptIds.unshift("failed-interrupted");

		expect(recommendedRunAction(run)).toMatchObject({
			action: "retry",
			work: { phase: "tasks" },
		});
	});

	it.each([
		{
			name: "task",
			addActive(run: OrchestrationRun) {
				run.attempts.push({
					id: "active-task",
					taskId: "other",
					number: 1,
					state: "running",
					branch: "active",
					worktreePath: "/active",
					baseCommit: run.integrationHead,
					startedAt: APPROVED_AT,
				});
			},
		},
		{
			name: "review",
			addActive(run: OrchestrationRun) {
				run.reviewAttempts.push({
					id: "active-review",
					round: 1,
					category: "correctness",
					number: 1,
					state: "prepared",
					branch: "active",
					worktreePath: "/active",
					baseCommit: run.integrationHead,
					startedAt: APPROVED_AT,
				});
			},
		},
		{
			name: "repair",
			addActive(run: OrchestrationRun) {
				run.repairAttempts.push({
					id: "active-repair",
					round: 1,
					number: 1,
					state: "validating",
					findingIds: ["finding-1"],
					branch: "active",
					worktreePath: "/active",
					baseCommit: run.integrationHead,
					startedAt: APPROVED_AT,
				});
			},
		},
		{
			name: "final validation",
			addActive(run: OrchestrationRun) {
				run.finalValidationAttempts.push({
					id: "active-final",
					number: 1,
					state: "running",
					integrationCommit: run.integrationHead,
					worktreePath: "/active",
					startedAt: APPROVED_AT,
				});
			},
		},
	])("rejects retry while a $name attempt is active", ({ addActive }) => {
		const run = taskFailureRun();
		addActive(run);
		const assessment = retryableRunWork(run);
		expect(assessment).toMatchObject({
			retryable: false,
			reasonCode: "active-attempts",
		});
		expect(() => prepareFailedRunRetry(run, RETRIED_AT)).toThrowError(
			/wait for or cancel them before retrying/,
		);
	});

	it("classifies review failure as explicitly unsupported", () => {
		const run = approvedRun();
		run.state = "failed";
		run.reviewRounds.push({
			number: 1,
			state: "failed",
			baseCommit: run.integrationHead,
			attemptIds: ["review-failed"],
			startedAt: APPROVED_AT,
			finishedAt: APPROVED_AT,
			error: "review failed",
		});
		run.reviewAttempts.push({
			id: "review-failed",
			round: 1,
			category: "security",
			number: 1,
			state: "failed",
			branch: "review",
			worktreePath: "/review",
			baseCommit: run.integrationHead,
			startedAt: APPROVED_AT,
			finishedAt: APPROVED_AT,
			error: "review failed",
		});

		expect(retryableRunWork(run)).toMatchObject({
			retryable: false,
			reasonCode: "review-phase-unsupported",
			reason: expect.stringContaining("review-round coordination"),
		});
	});

	it("classifies repair failure as explicitly unsupported", () => {
		const run = approvedRun();
		run.state = "failed";
		run.repairAttempts.push({
			id: "repair-failed",
			round: 1,
			number: 1,
			state: "failed",
			findingIds: ["finding-1"],
			branch: "repair",
			worktreePath: "/repair",
			baseCommit: run.integrationHead,
			startedAt: APPROVED_AT,
			finishedAt: APPROVED_AT,
			error: "repair failed",
		});

		expect(retryableRunWork(run)).toMatchObject({
			retryable: false,
			reasonCode: "repair-phase-unsupported",
			reason: expect.stringContaining("review-round coordination"),
		});
	});

	it("rejects an unapproved failed run with an actionable reason", () => {
		const run = { ...createRun(), state: "failed" as const };
		const assessment = retryableRunWork(run);
		expect(assessment).toMatchObject({
			retryable: false,
			reasonCode: "run-not-approved",
			reason: expect.stringContaining("approve a plan"),
		});
	});

	it.each(["running", "cancelled", "completed"] as const)(
		"rejects a %s run because it is not failed",
		(state) => {
			const run = { ...approvedRun(), state };
			expect(recommendedRunAction(run)).toMatchObject({ action: "none" });
			try {
				prepareFailedRunRetry(run, RETRIED_AT);
				expect.unreachable("Expected retry preparation to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(RunRetryError);
				expect(error).toMatchObject({ reasonCode: "run-not-failed" });
				expect((error as Error).message).toContain(`Run retry-run is ${state}`);
			}
		},
	);

	it("rejects a failed run whose failure phase cannot be identified", () => {
		const run = { ...approvedRun(), state: "failed" as const };
		expect(retryableRunWork(run)).toMatchObject({
			retryable: false,
			reasonCode: "no-retryable-failure",
			reason: expect.stringContaining("inspect the run failure"),
		});
	});
});
