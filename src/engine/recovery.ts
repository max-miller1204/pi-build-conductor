import { stepRetryPolicy } from "../domain/steps.js";
import { isActiveAttemptState } from "../domain/types.js";
import type { GitClient } from "../git/git.js";
import {
	appendWorkflowEvents,
	blockedStepEvents,
	type WorkflowEventBody,
} from "./events.js";
import { reconcileWorkflowSteps } from "./scheduler.js";
import type { WorkflowStateStore } from "./state-store.js";
import {
	requireStep,
	updateStep,
	updateStepAttempt,
	type WorkflowRunState,
	type WorkflowStepAttempt,
} from "./workflow-state.js";

export interface WorkflowRecoveryDependencies {
	store: WorkflowStateStore;
	git: Pick<GitClient, "branchHead" | "verifyTaskCommit">;
	now?: () => string;
	onStateChanged?: (state: WorkflowRunState) => void;
}

/** What recovery decided about one interrupted attempt. */
export interface RecoveredAttempt {
	attemptId: string;
	stepId: string;
	outcome: "adopted_commit" | "retry_scheduled" | "failed";
	commit?: string;
	reason: string;
}

export interface WorkflowRecoveryResult {
	state: WorkflowRunState;
	recovered: RecoveredAttempt[];
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Decides an interrupted attempt from durable Git state rather than from the
 * process that vanished: work a worker really committed is adopted, and
 * everything else is retried or failed according to the step's retry budget.
 */
async function inspectInterruptedAttempt(
	dependencies: WorkflowRecoveryDependencies,
	state: WorkflowRunState,
	attempt: WorkflowStepAttempt,
): Promise<{ commit?: string; error?: string }> {
	if (!attempt.branch) {
		return {};
	}
	if (attempt.commit) {
		return { commit: attempt.commit };
	}
	try {
		const head = await dependencies.git.branchHead(
			state.repositoryRoot,
			attempt.branch,
		);
		if (head === attempt.baseCommit) {
			return {};
		}
		await dependencies.git.verifyTaskCommit(
			state.repositoryRoot,
			attempt.branch,
			head,
			attempt.baseCommit,
		);
		return { commit: head };
	} catch (error) {
		return { error: `could not reconcile step branch: ${errorMessage(error)}` };
	}
}

/**
 * Reconciles a run whose executing process disappeared. Every attempt still
 * marked active is settled from durable evidence, so a resumed run never
 * double-runs a step and never loses a commit that already exists.
 */
export async function recoverWorkflowRun(
	dependencies: WorkflowRecoveryDependencies,
	runId: string,
): Promise<WorkflowRecoveryResult> {
	const now = dependencies.now ?? (() => new Date().toISOString());
	const loaded = await dependencies.store.load(runId);
	const interrupted = loaded.attempts.filter((attempt) =>
		isActiveAttemptState(attempt.state),
	);
	const decisions = new Map<string, { commit?: string; error?: string }>();
	for (const attempt of interrupted) {
		decisions.set(
			attempt.id,
			await inspectInterruptedAttempt(dependencies, loaded, attempt),
		);
	}
	const recovered: RecoveredAttempt[] = [];
	const state = await dependencies.store.transaction(runId, (current) => {
		let next = current;
		const events: WorkflowEventBody[] = [];
		for (const attempt of current.attempts) {
			if (!isActiveAttemptState(attempt.state)) {
				continue;
			}
			const decision = decisions.get(attempt.id) ?? {};
			const record = requireStep(next, attempt.stepId);
			const finishedAt = now();
			if (decision.commit) {
				next = updateStepAttempt(next, attempt.id, {
					state: "succeeded",
					finishedAt,
					commit: decision.commit,
				});
				next = updateStep(next, attempt.stepId, { state: "succeeded" });
				events.push({
					kind: "step_succeeded",
					stepId: attempt.stepId,
					attemptId: attempt.id,
					summary: `Adopted commit ${decision.commit} created before the interruption`,
				});
				recovered.push({
					attemptId: attempt.id,
					stepId: attempt.stepId,
					outcome: "adopted_commit",
					commit: decision.commit,
					reason: "the worker's commit already existed on the step branch",
				});
				continue;
			}
			const reason = decision.error
				? `The run was interrupted and ${decision.error}`
				: "The run was interrupted before this attempt settled";
			next = updateStepAttempt(next, attempt.id, {
				state: "interrupted",
				finishedAt,
				error: reason,
			});
			const budget = stepRetryPolicy(record.definition).maxAttempts;
			const retry = !decision.error && attempt.number < budget;
			next = updateStep(next, attempt.stepId, {
				state: retry ? "ready" : "failed",
				...(retry ? {} : { error: reason }),
			});
			events.push({
				kind: "step_failed",
				stepId: attempt.stepId,
				attemptId: attempt.id,
				error: reason,
				failureClass: retry ? "retryable" : "terminal",
				reason: retry
					? `the interrupted attempt may run again within its budget of ${budget}`
					: "the interrupted attempt cannot safely run again",
			});
			if (retry) {
				events.push({
					kind: "step_retry_scheduled",
					stepId: attempt.stepId,
					attemptId: attempt.id,
					nextAttemptNumber: attempt.number + 1,
					reason,
				});
			}
			recovered.push({
				attemptId: attempt.id,
				stepId: attempt.stepId,
				outcome: retry ? "retry_scheduled" : "failed",
				reason,
			});
		}
		if (events.length === 0) {
			return current;
		}
		// A step blocked by an attempt that recovered is no longer blocked;
		// reconciliation re-blocks whatever is still genuinely unreachable.
		for (const [stepId, record] of Object.entries(next.steps)) {
			if (record.state === "blocked") {
				next = updateStep(next, stepId, { state: "planned" });
			}
		}
		const reconciled = reconcileWorkflowSteps(next);
		const failed = Object.values(reconciled.steps).some(
			(record) => record.state === "failed",
		);
		return appendWorkflowEvents(
			{
				...reconciled,
				state: current.state === "running" && failed ? "failed" : current.state,
				updatedAt: now(),
			},
			[...events, ...blockedStepEvents(next, reconciled)],
			now(),
		);
	});
	try {
		dependencies.onStateChanged?.(state);
	} catch {
		// Observers must never affect persisted lifecycle state.
	}
	return { state, recovered };
}
