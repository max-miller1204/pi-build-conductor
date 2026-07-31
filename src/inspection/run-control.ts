import { reconcileTaskStates } from "../domain/scheduler.js";
import {
	isActiveAttemptState,
	type OrchestrationRun,
} from "../domain/types.js";
import {
	legacyRunView,
	type RunAttemptView,
	type RunUnitView,
	type RunView,
	reviewRoundViews,
} from "./run-view.js";

export type RunRetryPhase = "steps" | "final-validation";

export type RunRetryBlockReason =
	| "run-not-failed"
	| "run-not-approved"
	| "active-attempts"
	| "interrupted-attempts"
	| "review-phase-unsupported"
	| "repair-phase-unsupported"
	| "no-retryable-failure";

export interface StepRunRetryWork {
	retryable: true;
	phase: "steps";
	/** The steps that failed on their own merits. */
	failedUnitIds: string[];
	/** Those steps plus everything blocked behind them. */
	resetUnitIds: string[];
}

export interface FinalValidationRunRetryWork {
	retryable: true;
	phase: "final-validation";
	attemptId: string;
}

export type RetryableRunWork = StepRunRetryWork | FinalValidationRunRetryWork;

export interface NonRetryableRunWork {
	retryable: false;
	reasonCode: RunRetryBlockReason;
	reason: string;
}

export type RunRetryAssessment = RetryableRunWork | NonRetryableRunWork;

export type RecommendedRunAction =
	| { action: "retry"; reason: string; work: RetryableRunWork }
	| { action: "resume"; reason: string }
	| { action: "none"; reason: string };

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

function activeAttemptIds(view: RunView): string[] {
	return [
		...view.attempts
			.filter((attempt) => isActiveAttemptState(attempt.state))
			.map((attempt) => attempt.id),
		...view.finalValidationAttempts
			.filter((attempt) => attempt.state === "running")
			.map((attempt) => attempt.id),
	];
}

/**
 * Only the newest attempt of each step can still be interrupted; an older one
 * was already superseded by the attempt that followed it.
 */
function interruptedAttemptIds(view: RunView): string[] {
	const latest = new Map<string, RunAttemptView>();
	for (const attempt of view.attempts) {
		latest.set(attempt.unitId, attempt);
	}
	const finalAttempt = view.finalValidationAttempts.at(-1);
	return [
		...[...latest.values()]
			.filter((attempt) => attempt.state === "interrupted")
			.map((attempt) => attempt.id),
		...(finalAttempt?.state === "interrupted" ? [finalAttempt.id] : []),
	];
}

function failedUnits(view: RunView): RunUnitView[] {
	return view.units.filter((unit) => unit.state === "failed");
}

/** The failed steps plus every step blocked only by them. */
function stepRetryWork(
	view: RunView,
	failed: readonly RunUnitView[],
): StepRunRetryWork {
	const resetIds = new Set(failed.map((unit) => unit.id));
	let changed = true;
	while (changed) {
		changed = false;
		for (const unit of view.units) {
			if (
				unit.state === "blocked" &&
				!resetIds.has(unit.id) &&
				unit.dependencies.some((dependency) => resetIds.has(dependency))
			) {
				resetIds.add(unit.id);
				changed = true;
			}
		}
	}
	return {
		retryable: true,
		phase: "steps",
		failedUnitIds: failed.map((unit) => unit.id),
		resetUnitIds: view.units.flatMap((unit) =>
			resetIds.has(unit.id) ? [unit.id] : [],
		),
	};
}

function finalValidationRetryWork(
	view: RunView,
): FinalValidationRunRetryWork | undefined {
	const attempt = view.finalValidationAttempts.at(-1);
	return attempt?.state === "failed"
		? { retryable: true, phase: "final-validation", attemptId: attempt.id }
		: undefined;
}

/**
 * Why a legacy run cannot be retried past its reviews.
 *
 * The legacy lifecycle drives review rounds itself, so restarting one needs
 * round coordination this transition never had. Engine runs have no such
 * limit: a review and a repair are ordinary steps there.
 */
function legacyReviewBlock(view: RunView): NonRetryableRunWork | undefined {
	const repair = view.attempts.findLast(
		(attempt) => attempt.role === "repair" && attempt.state === "failed",
	);
	if (repair) {
		return blocked(
			"repair-phase-unsupported",
			`Run ${view.id} failed during repair attempt ${repair.id}; repair retries require review-round coordination and are not safe through this transition`,
		);
	}
	const review = view.attempts.findLast(
		(attempt) => attempt.role === "review" && attempt.state === "failed",
	);
	if (review || reviewRoundViews(view).at(-1)?.state === "failed") {
		return blocked(
			"review-phase-unsupported",
			`Run ${view.id} failed during review${review ? ` attempt ${review.id}` : ""}; review retries require review-round coordination and are not safe through this transition`,
		);
	}
	return undefined;
}

export function retryableRunWork(view: RunView): RunRetryAssessment {
	if (view.state !== "failed") {
		return blocked(
			"run-not-failed",
			`Run ${view.id} is ${view.state}; only failed runs can be retried`,
		);
	}
	if (
		view.approvedPlanRevision === undefined ||
		view.approvedAt === undefined
	) {
		return blocked(
			"run-not-approved",
			`Run ${view.id} has no approved plan; approve a plan before starting work`,
		);
	}

	const activeIds = activeAttemptIds(view);
	if (activeIds.length > 0) {
		return blocked(
			"active-attempts",
			`Run ${view.id} still has active attempts (${activeIds.join(", ")}); wait for or cancel them before retrying`,
		);
	}

	const interruptedIds = interruptedAttemptIds(view);
	if (interruptedIds.length > 0) {
		return blocked(
			"interrupted-attempts",
			`Run ${view.id} has interrupted attempts (${interruptedIds.join(", ")}); resume the run instead of retrying so recovery can reconcile them`,
		);
	}

	const failed = failedUnits(view);
	if (view.source === "legacy") {
		const failedChanges = failed.filter((unit) => unit.role === "change");
		if (failedChanges.length > 0) {
			return stepRetryWork(view, failedChanges);
		}
		return (
			finalValidationRetryWork(view) ??
			legacyReviewBlock(view) ??
			blocked(
				"no-retryable-failure",
				`Run ${view.id} is failed, but no failed step or latest failed final-validation attempt identifies safe retry work; inspect the run failure before retrying`,
			)
		);
	}

	if (failed.length > 0) {
		return stepRetryWork(view, failed);
	}
	return (
		finalValidationRetryWork(view) ??
		blocked(
			"no-retryable-failure",
			`Run ${view.id} is failed, but no failed step or latest failed final-validation attempt identifies safe retry work; inspect the run failure before retrying`,
		)
	);
}

export function recommendedRunAction(view: RunView): RecommendedRunAction {
	if (!["cancelled", "completed"].includes(view.state)) {
		const interruptedIds = interruptedAttemptIds(view);
		if (
			view.approvedPlanRevision !== undefined &&
			activeAttemptIds(view).length === 0 &&
			interruptedIds.length > 0
		) {
			return {
				action: "resume",
				reason: `Run ${view.id} has interrupted attempts (${interruptedIds.join(", ")}); resume the run instead of retrying so recovery can reconcile them`,
			};
		}
	}

	const assessment = retryableRunWork(view);
	if (assessment.retryable) {
		return {
			action: "retry",
			reason:
				assessment.phase === "steps"
					? `Retry failed steps: ${assessment.failedUnitIds.join(", ")}`
					: `Retry final validation after attempt ${assessment.attemptId}`,
			work: assessment,
		};
	}
	return { action: "none", reason: assessment.reason };
}

function resetFailedTask(
	run: OrchestrationRun,
	task: OrchestrationRun["tasks"][string],
): OrchestrationRun["tasks"][string] {
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

/**
 * Prepares a legacy run for another pass at its failed work. Engine runs reset
 * their own failed steps inside the workflow snapshot instead.
 */
export function prepareFailedRunRetry(
	run: OrchestrationRun,
	now: string,
): OrchestrationRun {
	const assessment = retryableRunWork(legacyRunView(run));
	if (!assessment.retryable) {
		throw new RunRetryError(run.id, assessment.reasonCode, assessment.reason);
	}

	if (assessment.phase === "final-validation") {
		return { ...run, state: "reviewed", updatedAt: now };
	}

	const resetIds = new Set(assessment.resetUnitIds);
	const failedIds = new Set(assessment.failedUnitIds);
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
