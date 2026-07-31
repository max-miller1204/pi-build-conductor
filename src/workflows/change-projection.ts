import { topologicalTaskIds } from "../domain/dag.js";
import { stepProfileName } from "../domain/steps.js";
import {
	type MergeReadyEvidence,
	type OrchestrationRun,
	REVIEW_CATEGORIES,
	type RepairAttempt,
	type ReviewAttempt,
	type ReviewFinding,
	type ReviewRound,
	type ReviewRoundState,
	type RunState,
	type RunTask,
	type TaskAttempt,
	type TaskState,
} from "../domain/types.js";
import {
	parseReviewStepId,
	type ReviewFindingsPayload,
} from "../engine/steps/review.js";
import type {
	WorkflowRunState,
	WorkflowStepAttempt,
	WorkflowStepRecord,
} from "../engine/workflow-state.js";
import { requiresAutomaticRepair } from "../review/review-policy.js";
import { repairStepId } from "./change.js";

/** The review findings each review step published, by step id. */
export type ReviewFindingsByStep = ReadonlyMap<string, ReviewFindingsPayload>;

export interface ChangeRunProjectionInput {
	state: WorkflowRunState;
	findings: ReviewFindingsByStep;
}

/** One review round of the change workflow, assembled from its steps. */
interface RoundProjection {
	number: number;
	attempts: ReviewAttempt[];
	repair?: RepairAttempt;
	baseCommit: string;
	failed: boolean;
	cancelled: boolean;
}

function stepsWithProfile(
	state: WorkflowRunState,
	profile: string,
): [string, WorkflowStepRecord][] {
	return Object.entries(state.steps).filter(
		([, record]) => stepProfileName(record.definition) === profile,
	);
}

function attemptsOf(
	state: WorkflowRunState,
	stepId: string,
): WorkflowStepAttempt[] {
	return state.attempts.filter((attempt) => attempt.stepId === stepId);
}

/**
 * The stored run distinguishes work that finished from work that finished and
 * was integrated, so an attempt that produced a commit nothing has integrated
 * yet is still settling rather than succeeded.
 */
function integratedAttemptState(
	attempt: WorkflowStepAttempt,
	record: WorkflowStepRecord,
): TaskAttempt["state"] {
	if (attempt.state !== "succeeded") {
		return attempt.state;
	}
	return record.integratedCommit || !attempt.commit
		? "succeeded"
		: "validating";
}

function projectTaskAttempt(
	attempt: WorkflowStepAttempt,
): TaskAttempt | undefined {
	// A committed attempt is only representable with the checks that justified
	// the commit; the durable engine state stays the record of the rest.
	if (attempt.commit && !attempt.evidence?.passed) {
		return undefined;
	}
	return {
		id: attempt.id,
		taskId: attempt.stepId,
		number: attempt.number,
		state: attempt.state,
		branch: attempt.branch ?? "",
		worktreePath: attempt.workspacePath,
		baseCommit: attempt.baseCommit,
		startedAt: attempt.startedAt,
		...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
		...(attempt.error ? { error: attempt.error } : {}),
		...(attempt.commit ? { commit: attempt.commit } : {}),
		...(attempt.evidence ? { evidence: attempt.evidence } : {}),
	};
}

function projectTasks(
	run: OrchestrationRun,
	state: WorkflowRunState,
	attempts: TaskAttempt[],
): Record<string, RunTask> {
	const attemptIdsByTask = new Map<string, string[]>();
	for (const attempt of attempts) {
		attemptIdsByTask.set(attempt.taskId, [
			...(attemptIdsByTask.get(attempt.taskId) ?? []),
			attempt.id,
		]);
	}
	const tasks: Record<string, RunTask> = {};
	for (const [taskId, task] of Object.entries(run.tasks)) {
		const record = state.steps[taskId];
		if (!record) {
			tasks[taskId] = task;
			continue;
		}
		tasks[taskId] = {
			definition: task.definition,
			state: record.state as TaskState,
			attemptIds: attemptIdsByTask.get(taskId) ?? [],
			...(record.integratedCommit
				? { integratedCommit: record.integratedCommit }
				: {}),
			...(record.integrationError && !record.integratedCommit
				? { integrationError: record.integrationError }
				: {}),
		};
	}
	return tasks;
}

/**
 * Applies the same repair policy the repair step applies, so the stored run
 * shows exactly the findings that were required to be repaired, which of them
 * a repair addressed, and which remain open.
 */
function projectFindings(
	payload: ReviewFindingsPayload | undefined,
	repair: RepairAttempt | undefined,
): ReviewFinding[] {
	const repaired =
		repair?.state === "succeeded" && repair.integratedCommit
			? repair.id
			: undefined;
	return (payload?.findings ?? []).map((finding) => {
		if (!requiresAutomaticRepair(finding)) {
			return { ...finding, status: "deferred" as const };
		}
		return repaired
			? { ...finding, status: "repaired" as const, repairAttemptId: repaired }
			: { ...finding, status: "repair_required" as const };
	});
}

function projectReviewAttempts(
	state: WorkflowRunState,
	findings: ReviewFindingsByStep,
	round: number,
): {
	attempts: ReviewAttempt[];
	baseCommit?: string;
	failed: boolean;
	cancelled: boolean;
} {
	const attempts: ReviewAttempt[] = [];
	let baseCommit: string | undefined;
	let failed = false;
	let cancelled = false;
	for (const [stepId, record] of stepsWithProfile(state, "review")) {
		const identity = parseReviewStepId(stepId);
		if (identity.round !== round) {
			continue;
		}
		if (record.state === "failed" || record.state === "blocked") {
			failed = true;
		}
		if (record.state === "cancelled") {
			cancelled = true;
		}
		const payload = findings.get(stepId);
		for (const attempt of attemptsOf(state, stepId)) {
			baseCommit ??= attempt.baseCommit;
			const succeeded = attempt.state === "succeeded";
			attempts.push({
				id: attempt.id,
				round,
				category: identity.category,
				number: attempt.number,
				state: attempt.state,
				worktreePath: attempt.workspacePath,
				baseCommit: attempt.baseCommit,
				startedAt: attempt.startedAt,
				...(attempt.branch ? { branch: attempt.branch } : {}),
				...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
				...(attempt.error ? { error: attempt.error } : {}),
				// The review's own conclusion is the summary a reader wants, not
				// the step note an adopted round records instead.
				...(succeeded
					? { summary: payload?.summary ?? attempt.summary ?? "" }
					: attempt.summary
						? { summary: attempt.summary }
						: {}),
				...(succeeded ? { findings: [] } : {}),
			});
		}
	}
	return {
		attempts,
		...(baseCommit === undefined ? {} : { baseCommit }),
		failed,
		cancelled,
	};
}

function projectRepairAttempt(
	state: WorkflowRunState,
	round: number,
	requiredFindingIds: string[],
): RepairAttempt | undefined {
	const stepId = repairStepId(round);
	const record = state.steps[stepId];
	if (!record || requiredFindingIds.length === 0) {
		return undefined;
	}
	const attempt = attemptsOf(state, stepId).at(-1);
	if (!attempt || (attempt.commit && !attempt.evidence?.passed)) {
		return undefined;
	}
	return {
		id: attempt.id,
		round,
		number: attempt.number,
		state: integratedAttemptState(attempt, record),
		findingIds: requiredFindingIds,
		branch: attempt.branch ?? "",
		worktreePath: attempt.workspacePath,
		baseCommit: attempt.baseCommit,
		startedAt: attempt.startedAt,
		...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
		...(attempt.error ? { error: attempt.error } : {}),
		...(attempt.commit ? { commit: attempt.commit } : {}),
		...(attempt.evidence ? { evidence: attempt.evidence } : {}),
		...(record.integratedCommit && attempt.commit
			? { integratedCommit: record.integratedCommit }
			: {}),
	};
}

/** Why a round could not succeed, for the run record a user reads. */
function roundError(
	state: ReviewRoundState,
	round: RoundProjection,
	unrepaired: ReviewFinding[],
): string | undefined {
	if (state !== "failed") {
		return undefined;
	}
	if (unrepaired.length > 0 && !round.repair) {
		return `Important findings remain after the approved repair rounds: ${unrepaired
			.map((finding) => finding.id)
			.join(", ")}`;
	}
	return (
		round.repair?.error ??
		round.attempts.find((attempt) => attempt.error)?.error ??
		"The review round did not complete"
	);
}

function roundState(
	round: RoundProjection,
	hasRepairStep: boolean,
	unrepaired: number,
): ReviewRoundState {
	if (round.cancelled) {
		return "cancelled";
	}
	if (round.failed) {
		return "failed";
	}
	const succeeded = new Set(
		round.attempts
			.filter((attempt) => attempt.state === "succeeded")
			.map((attempt) => attempt.category),
	);
	if (succeeded.size !== REVIEW_CATEGORIES.length) {
		return "running";
	}
	if (unrepaired === 0) {
		return "succeeded";
	}
	if (!hasRepairStep) {
		// The last round is the evidence that stands, so findings it still
		// requires repaired are the reason this run cannot merge.
		return "failed";
	}
	if (round.repair?.state === "succeeded") {
		return "succeeded";
	}
	return round.repair?.state === "failed" ||
		round.repair?.state === "cancelled" ||
		round.repair?.state === "interrupted"
		? "failed"
		: "repairing";
}

function projectRounds(
	state: WorkflowRunState,
	findings: ReviewFindingsByStep,
): {
	rounds: ReviewRound[];
	attempts: ReviewAttempt[];
	repairs: RepairAttempt[];
} {
	const numbers = [
		...new Set(
			stepsWithProfile(state, "review").map(
				([stepId]) => parseReviewStepId(stepId).round,
			),
		),
	].sort((left, right) => left - right);
	const rounds: ReviewRound[] = [];
	const allAttempts: ReviewAttempt[] = [];
	const repairs: RepairAttempt[] = [];
	for (const number of numbers) {
		const projected = projectReviewAttempts(state, findings, number);
		if (projected.attempts.length === 0 || projected.baseCommit === undefined) {
			break;
		}
		// The findings a repair had to address are the ones the review policy
		// required, which is exactly what the repair step itself consumed.
		const required = projected.attempts.flatMap((attempt) => {
			const payload = findings.get(`review-${number}-${attempt.category}`);
			return attempt.state === "succeeded"
				? (payload?.findings ?? []).filter((finding) =>
						requiresAutomaticRepair(finding),
					)
				: [];
		});
		const repair = projectRepairAttempt(
			state,
			number,
			required.map((finding) => finding.id),
		);
		const attempts = projected.attempts.map((attempt) =>
			attempt.state === "succeeded"
				? {
						...attempt,
						findings: projectFindings(
							findings.get(`review-${number}-${attempt.category}`),
							repair,
						),
					}
				: attempt,
		);
		const round: RoundProjection = {
			number,
			attempts,
			baseCommit: projected.baseCommit,
			failed: projected.failed,
			cancelled: projected.cancelled,
			...(repair ? { repair } : {}),
		};
		const unrepaired = attempts
			.flatMap((attempt) => attempt.findings ?? [])
			.filter((finding) => finding.status === "repair_required");
		const settled = roundState(
			round,
			state.steps[repairStepId(number)] !== undefined,
			unrepaired.length,
		);
		const error = roundError(settled, round, unrepaired);
		rounds.push({
			number,
			state: settled,
			baseCommit: projected.baseCommit,
			attemptIds: attempts.map((attempt) => attempt.id),
			startedAt: attempts[0]?.startedAt ?? "",
			...(repair ? { repairAttemptId: repair.id } : {}),
			...(error ? { error } : {}),
		});
		allAttempts.push(...attempts);
		if (repair) {
			repairs.push(repair);
		}
	}
	return { rounds, attempts: allAttempts, repairs };
}

function projectRunState(
	state: WorkflowRunState,
	rounds: ReviewRound[],
	taskIds: string[],
): RunState {
	if (state.state === "cancelled") {
		return "cancelled";
	}
	if (state.state === "failed") {
		return "failed";
	}
	if (state.state === "completed") {
		return rounds.at(-1)?.state === "succeeded" ? "reviewed" : "failed";
	}
	const active = (profile: string) =>
		stepsWithProfile(state, profile).some(([, record]) =>
			["ready", "running"].includes(record.state),
		);
	if (active("repair")) {
		return "repairing";
	}
	if (active("review")) {
		return "reviewing";
	}
	const changesDone = taskIds.every(
		(taskId) => state.steps[taskId]?.state === "succeeded",
	);
	return changesDone ? "integrating" : "running";
}

/**
 * Restates merge-ready evidence in the stored run's own identities.
 *
 * The engine names a repair commit by its step; the stored run names it by the
 * repair attempt that produced it. Only the naming differs, so the commits are
 * matched on the source commit itself rather than trusted to line up.
 */
export function alignMergeReadyEvidence(
	evidence: MergeReadyEvidence,
	run: OrchestrationRun,
): MergeReadyEvidence {
	return {
		...evidence,
		commits: evidence.commits.map((commit) => {
			if (commit.kind !== "repair") {
				return commit;
			}
			const repair = run.repairAttempts.find(
				(attempt) => attempt.commit === commit.sourceCommit,
			);
			return repair ? { ...commit, id: repair.id } : commit;
		}),
	};
}

/**
 * Projects an engine workflow run onto the stored orchestration run it
 * executes.
 *
 * The engine snapshot is the execution record; this projection is what makes
 * that record inspectable and controllable through the run surface every
 * command already speaks. It never invents state: anything it cannot represent
 * faithfully is left out, and the engine snapshot remains authoritative.
 */
export function projectChangeRun(
	run: OrchestrationRun,
	input: ChangeRunProjectionInput,
	now: string,
): OrchestrationRun {
	const { state } = input;
	const taskIds = topologicalTaskIds(run.plan);
	const taskAttempts = state.attempts
		.filter((attempt) => taskIds.includes(attempt.stepId))
		.flatMap((attempt) => {
			const projected = projectTaskAttempt(attempt);
			return projected ? [projected] : [];
		});
	const { rounds, attempts, repairs } = projectRounds(state, input.findings);
	const projected: OrchestrationRun = {
		...run,
		state: projectRunState(state, rounds, taskIds),
		tasks: projectTasks(run, state, taskAttempts),
		attempts: taskAttempts,
		integrationHead: state.integrationHead,
		reviewRounds: rounds,
		reviewAttempts: attempts,
		repairAttempts: repairs,
		blockedWorkers: [],
		updatedAt: now,
	};
	return JSON.stringify({ ...projected, updatedAt: run.updatedAt }) ===
		JSON.stringify(run)
		? run
		: projected;
}
