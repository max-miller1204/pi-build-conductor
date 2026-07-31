import { type ArtifactRecord, artifactIdFor } from "../domain/artifacts.js";
import { type StepDefinition, stepRetryPolicy } from "../domain/steps.js";
import {
	isActiveAttemptState,
	type TaskValidationEvidence,
} from "../domain/types.js";
import type { GitClient } from "../git/git.js";
import type { StoredArtifactEntry } from "../storage/artifact-store.js";
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

/** The output every step that commits publishes its focused checks under. */
const EVIDENCE_OUTPUT = "evidence";

/** The read surface recovery needs to prove an artifact really is durable. */
export interface RecoveryArtifactReader {
	scan(runId: string): Promise<StoredArtifactEntry[]>;
	/** Used to recover the checks behind an adopted commit, when available. */
	read?(runId: string, artifactId: string): Promise<ArtifactRecord>;
}

export interface WorkflowRecoveryDependencies {
	store: WorkflowStateStore;
	git: Pick<GitClient, "branchHead" | "verifyTaskCommit">;
	/** Used to verify declared outputs before adopting an interrupted attempt. */
	artifacts?: RecoveryArtifactReader;
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

/** Why one interrupted attempt may or may not be adopted as it stands. */
interface InterruptedAttemptDecision {
	/** The commit the attempt durably produced before the interruption. */
	commit?: string;
	/** The declared artifacts that attempt durably published. */
	artifactIds?: string[];
	/** The focused checks recovered for an adopted commit. */
	evidence?: TaskValidationEvidence;
	/** Why the attempt cannot be adopted, though it may still run again. */
	retryReason?: string;
	/** Why the attempt's step branch could not be safely reconciled. */
	blockedReason?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The artifacts of one run that are durable right now. An unreadable file is
 * deliberately absent: an artifact the engine cannot read back is not evidence
 * that a step produced it.
 */
async function durableArtifactIds(
	artifacts: RecoveryArtifactReader,
	runId: string,
): Promise<Set<string>> {
	const entries = await artifacts.scan(runId);
	return new Set(
		entries.flatMap((entry) =>
			entry.kind === "artifact" ? [entry.artifact.id] : [],
		),
	);
}

function declaredArtifactIds(
	step: StepDefinition,
	attempt: WorkflowStepAttempt,
): { output: string; artifactId?: string }[] {
	return (step.outputs ?? []).map((output) => {
		try {
			return {
				output,
				artifactId: artifactIdFor({
					stepId: step.id,
					output,
					attempt: attempt.number,
				}),
			};
		} catch {
			// An identity this run could never have written is simply not durable.
			return { output };
		}
	});
}

/** Finds the commit an interrupted attempt left behind on its step branch. */
async function interruptedAttemptCommit(
	dependencies: WorkflowRecoveryDependencies,
	state: WorkflowRunState,
	attempt: WorkflowStepAttempt,
): Promise<InterruptedAttemptDecision> {
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
		return {
			blockedReason: `could not reconcile step branch: ${errorMessage(error)}`,
		};
	}
}

/**
 * Decides an interrupted attempt from durable evidence rather than from the
 * process that vanished.
 *
 * Work a worker really committed is adopted only when the artifacts that
 * attempt declared are durable too. Adoption is final, and dependent steps
 * resolve their inputs from stored artifacts, so adopting a producer whose
 * outputs never reached storage would strand every dependent on a step the run
 * reports as succeeded. Everything else runs again or fails by retry budget.
 */
async function inspectInterruptedAttempt(
	dependencies: WorkflowRecoveryDependencies,
	state: WorkflowRunState,
	attempt: WorkflowStepAttempt,
	durable: Set<string>,
): Promise<InterruptedAttemptDecision> {
	const decision = await interruptedAttemptCommit(dependencies, state, attempt);
	if (decision.commit === undefined) {
		return decision;
	}
	const step = requireStep(state, attempt.stepId).definition;
	const declared = declaredArtifactIds(step, attempt);
	if (declared.length > 0 && !dependencies.artifacts) {
		return {
			retryReason: `no artifact store is configured to verify the declared output${
				declared.length === 1 ? "" : "s"
			} of ${step.id}`,
		};
	}
	const missing = declared.filter(
		(entry) => entry.artifactId === undefined || !durable.has(entry.artifactId),
	);
	if (missing.length > 0) {
		return {
			retryReason: `did not durably store the declared output${
				missing.length === 1 ? "" : "s"
			} of ${step.id}: ${missing.map((entry) => entry.output).join(", ")}`,
		};
	}
	return {
		commit: decision.commit,
		artifactIds: declared.flatMap((entry) =>
			entry.artifactId ? [entry.artifactId] : [],
		),
		...(attempt.evidence
			? { evidence: attempt.evidence }
			: await adoptedEvidence(dependencies, state.id, step, attempt)),
	};
}

/**
 * Recovers the focused checks that justified an adopted commit. The evidence
 * a step published is durable, but the attempt record that would have carried
 * it was lost with the interrupted process, and a commit whose justification
 * is unknown should not be reported as validated work.
 */
async function adoptedEvidence(
	dependencies: WorkflowRecoveryDependencies,
	runId: string,
	step: StepDefinition,
	attempt: WorkflowStepAttempt,
): Promise<{ evidence?: TaskValidationEvidence }> {
	const artifacts = dependencies.artifacts;
	if (!artifacts?.read || !(step.outputs ?? []).includes(EVIDENCE_OUTPUT)) {
		return {};
	}
	try {
		const record = await artifacts.read(
			runId,
			artifactIdFor({
				stepId: step.id,
				output: EVIDENCE_OUTPUT,
				attempt: attempt.number,
			}),
		);
		const evidence = JSON.parse(record.payload) as TaskValidationEvidence;
		return evidence.passed === true ? { evidence } : {};
	} catch {
		// The commit still stands on its own durable Git evidence; only the
		// recorded checks are missing.
		return {};
	}
}

/**
 * Reconciles a run whose executing process disappeared. Every attempt still
 * marked active is settled from durable evidence. Recovery adopts only commits
 * with every declared artifact and retries unverified work only when safe and
 * budgeted.
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
	const durable = dependencies.artifacts
		? await durableArtifactIds(dependencies.artifacts, runId)
		: new Set<string>();
	const decisions = new Map<string, InterruptedAttemptDecision>();
	for (const attempt of interrupted) {
		decisions.set(
			attempt.id,
			await inspectInterruptedAttempt(dependencies, loaded, attempt, durable),
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
				const artifactIds = decision.artifactIds ?? [];
				next = updateStepAttempt(next, attempt.id, {
					state: "succeeded",
					finishedAt,
					commit: decision.commit,
					...(decision.evidence ? { evidence: decision.evidence } : {}),
					...(artifactIds.length > 0 ? { artifactIds } : {}),
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
					reason:
						artifactIds.length > 0
							? "the worker's commit and every declared artifact already existed"
							: "the worker's commit already existed on the step branch",
				});
				continue;
			}
			const obstacle = decision.blockedReason ?? decision.retryReason;
			const reason = obstacle
				? `The run was interrupted and ${obstacle}`
				: "The run was interrupted before this attempt settled";
			next = updateStepAttempt(next, attempt.id, {
				state: "interrupted",
				finishedAt,
				error: reason,
			});
			const budget = stepRetryPolicy(record.definition).maxAttempts;
			const retry = !decision.blockedReason && attempt.number < budget;
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
