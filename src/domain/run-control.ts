import { reconcileTaskStates } from "./scheduler.js";
import { type BuildRun, isActiveAttemptState, type RunTask } from "./types.js";

export type RunRetryPhase = "tasks" | "final-validation";

export type RunRetryBlockReason =
	| "run-not-failed"
	| "run-not-approved"
	| "active-attempts"
	| "interrupted-attempts"
	| "review-phase-unsupported"
	| "repair-phase-unsupported"
	| "no-retryable-failure";

export interface TaskRunRetryWork {
	retryable: true;
	phase: "tasks";
	failedTaskIds: string[];
	resetTaskIds: string[];
}

export interface FinalValidationRunRetryWork {
	retryable: true;
	phase: "final-validation";
	attemptId: string;
}

export type RetryableRunWork = TaskRunRetryWork | FinalValidationRunRetryWork;

export interface NonRetryableRunWork {
	retryable: false;
	reasonCode: RunRetryBlockReason;
	reason: string;
}

export type RunRetryAssessment = RetryableRunWork | NonRetryableRunWork;

export type RecommendedRunAction =
	| {
			action: "retry";
			reason: string;
			work: RetryableRunWork;
	  }
	| {
			action: "resume";
			reason: string;
	  }
	| {
			action: "none";
			reason: string;
	  };

export class RunRetryError extends Error {
	constructor(
		readonly runId: string,
		readonly reasonCode: RunRetryBlockReason,
		message: string,
	) {
		super(message);
		this.name = "RunRetryError";
	}
}

function blocked(
	reasonCode: RunRetryBlockReason,
	reason: string,
): NonRetryableRunWork {
	return { retryable: false, reasonCode, reason };
}

function activeAttemptIds(run: BuildRun): string[] {
	return [...run.attempts, ...run.reviewAttempts, ...run.repairAttempts]
		.filter((attempt) => isActiveAttemptState(attempt.state))
		.map((attempt) => attempt.id)
		.concat(
			run.finalValidationAttempts
				.filter((attempt) => attempt.state === "running")
				.map((attempt) => attempt.id),
		);
}

function interruptedAttemptIds(run: BuildRun): string[] {
	const latestTasks = new Map<string, (typeof run.attempts)[number]>();
	for (const attempt of run.attempts) {
		latestTasks.set(attempt.taskId, attempt);
	}
	const latestReviews = new Map<string, (typeof run.reviewAttempts)[number]>();
	for (const attempt of run.reviewAttempts) {
		latestReviews.set(`${attempt.round}:${attempt.category}`, attempt);
	}
	const latestRepairs = new Map<string, (typeof run.repairAttempts)[number]>();
	for (const attempt of run.repairAttempts) {
		latestRepairs.set(String(attempt.round), attempt);
	}
	const latestFinal = run.finalValidationAttempts.at(-1);
	return [
		...latestTasks.values(),
		...latestReviews.values(),
		...latestRepairs.values(),
		...(latestFinal ? [latestFinal] : []),
	]
		.filter((attempt) => attempt.state === "interrupted")
		.map((attempt) => attempt.id);
}

function taskRetryWork(run: BuildRun): TaskRunRetryWork | undefined {
	const failedTaskIds = run.plan.tasks.flatMap((definition) =>
		run.tasks[definition.id]?.state === "failed" ? [definition.id] : [],
	);
	if (failedTaskIds.length === 0) {
		return undefined;
	}

	const resetIds = new Set(failedTaskIds);
	let changed = true;
	while (changed) {
		changed = false;
		for (const definition of run.plan.tasks) {
			if (
				run.tasks[definition.id]?.state === "blocked" &&
				!resetIds.has(definition.id) &&
				definition.dependencies.some((dependency) => resetIds.has(dependency))
			) {
				resetIds.add(definition.id);
				changed = true;
			}
		}
	}

	return {
		retryable: true,
		phase: "tasks",
		failedTaskIds,
		resetTaskIds: run.plan.tasks.flatMap((definition) =>
			resetIds.has(definition.id) ? [definition.id] : [],
		),
	};
}

export function retryableRunWork(run: BuildRun): RunRetryAssessment {
	if (run.state !== "failed") {
		return blocked(
			"run-not-failed",
			`Run ${run.id} is ${run.state}; only failed runs can be retried`,
		);
	}
	if (run.approvedPlanRevision === undefined || run.approvedAt === undefined) {
		return blocked(
			"run-not-approved",
			`Run ${run.id} has no approved plan; approve a plan before starting work`,
		);
	}

	const activeIds = activeAttemptIds(run);
	if (activeIds.length > 0) {
		return blocked(
			"active-attempts",
			`Run ${run.id} still has active attempts (${activeIds.join(", ")}); wait for or cancel them before retrying`,
		);
	}

	const interruptedIds = interruptedAttemptIds(run);
	if (interruptedIds.length > 0) {
		return blocked(
			"interrupted-attempts",
			`Run ${run.id} has interrupted attempts (${interruptedIds.join(", ")}); resume the run instead of retrying so recovery can reconcile them`,
		);
	}

	const taskWork = taskRetryWork(run);
	if (taskWork) {
		return taskWork;
	}

	const finalAttempt = run.finalValidationAttempts.at(-1);
	if (finalAttempt?.state === "failed") {
		return {
			retryable: true,
			phase: "final-validation",
			attemptId: finalAttempt.id,
		};
	}

	const repairAttempt = run.repairAttempts.at(-1);
	if (repairAttempt?.state === "failed") {
		return blocked(
			"repair-phase-unsupported",
			`Run ${run.id} failed during repair attempt ${repairAttempt.id}; repair retries require review-round coordination and are not safe through this transition`,
		);
	}

	const reviewRound = run.reviewRounds.at(-1);
	const failedReview = run.reviewAttempts.findLast(
		(attempt) => attempt.state === "failed",
	);
	if (reviewRound?.state === "failed" || failedReview) {
		return blocked(
			"review-phase-unsupported",
			`Run ${run.id} failed during review${failedReview ? ` attempt ${failedReview.id}` : ""}; review retries require review-round coordination and are not safe through this transition`,
		);
	}

	return blocked(
		"no-retryable-failure",
		`Run ${run.id} is failed, but no failed task or latest failed final-validation attempt identifies safe retry work; inspect the run failure before retrying`,
	);
}

export function recommendedRunAction(run: BuildRun): RecommendedRunAction {
	if (!["cancelled", "completed"].includes(run.state)) {
		const activeIds = activeAttemptIds(run);
		const interruptedIds = interruptedAttemptIds(run);
		if (
			run.approvedPlanRevision !== undefined &&
			activeIds.length === 0 &&
			interruptedIds.length > 0
		) {
			return {
				action: "resume",
				reason: `Run ${run.id} has interrupted attempts (${interruptedIds.join(", ")}); resume the run instead of retrying so recovery can reconcile them`,
			};
		}
	}

	const assessment = retryableRunWork(run);
	if (assessment.retryable) {
		return {
			action: "retry",
			reason:
				assessment.phase === "tasks"
					? `Retry failed tasks: ${assessment.failedTaskIds.join(", ")}`
					: `Retry final validation after attempt ${assessment.attemptId}`,
			work: assessment,
		};
	}
	return { action: "none", reason: assessment.reason };
}

function resetFailedTask(run: BuildRun, task: RunTask): RunTask {
	const { integrationError, ...historicalTask } = task;
	if (
		integrationError &&
		task.attemptIds.some((attemptId) =>
			run.attempts.some(
				(attempt) =>
					attempt.id === attemptId &&
					attempt.state === "succeeded" &&
					attempt.commit !== undefined,
			),
		)
	) {
		return { ...historicalTask, state: "succeeded" };
	}
	return { ...historicalTask, state: "planned" };
}

export function prepareFailedRunRetry(run: BuildRun, now: string): BuildRun {
	const assessment = retryableRunWork(run);
	if (!assessment.retryable) {
		throw new RunRetryError(run.id, assessment.reasonCode, assessment.reason);
	}

	if (assessment.phase === "final-validation") {
		return {
			...run,
			state: "reviewed",
			updatedAt: now,
		};
	}

	const resetIds = new Set(assessment.resetTaskIds);
	const failedIds = new Set(assessment.failedTaskIds);
	const tasks = Object.fromEntries(
		Object.entries(run.tasks).map(([taskId, task]) => {
			if (failedIds.has(taskId)) {
				return [taskId, resetFailedTask(run, task)];
			}
			if (resetIds.has(taskId)) {
				return [taskId, { ...task, state: "planned" as const }];
			}
			return [taskId, task];
		}),
	);

	return reconcileTaskStates({
		...run,
		state: "running",
		tasks,
		updatedAt: now,
	});
}
