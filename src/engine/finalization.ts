import type { StepArtifactReader } from "../domain/step-context.js";
import { stepProfileName, topologicalStepIds } from "../domain/steps.js";
import {
	type FinalReviewSummary,
	type FinalValidationEvidence,
	type IntegratedCommitEvidence,
	MERGE_READY_EVIDENCE_VERSION,
	type MergeReadyEvidence,
	REVIEW_CATEGORIES,
	type ReviewCategory,
	type ReviewFinding,
	type RunSecurityPolicy,
} from "../domain/types.js";
import type { GitClient, RepositoryInfo } from "../git/git.js";
import type { WorktreeManager } from "../git/worktrees.js";
import { requiresAutomaticRepair } from "../review/review-policy.js";
import {
	FinalValidationError,
	type FinalValidator,
} from "../validation/final-validator.js";
import type { ReviewFindingsPayload } from "./steps/review.js";
import type { WorkflowRunState } from "./workflow-state.js";
import { stepRequiresIntegration } from "./workspaces.js";

export interface WorkflowFinalizationDependencies {
	finalValidator: FinalValidator;
	worktrees: Pick<
		WorktreeManager,
		"prepareFinalValidationWorktree" | "removeTaskWorktree"
	>;
	git: Pick<GitClient, "verifyMergeReadyHistory">;
	securityPolicy: RunSecurityPolicy;
	/** Required to summarize review findings into merge-ready evidence. */
	artifacts?: StepArtifactReader;
	now?: () => string;
}

export interface WorkflowFinalizationInput {
	state: WorkflowRunState;
	repository: RepositoryInfo;
	attemptNumber?: number;
	signal?: AbortSignal;
}

export interface WorkflowFinalizationResult {
	/**
	 * Absent when the run's review evidence could not justify merging, because
	 * final validation is not run for a result that cannot become merge-ready.
	 */
	evidence?: FinalValidationEvidence;
	/** Present only when the reviews hold and final validation passed. */
	mergeReady?: MergeReadyEvidence;
	/** Why merge-ready evidence was withheld. */
	evidenceGap?: string;
	/** The worktree the final suite ran in, for the attempt record. */
	worktreePath?: string;
}

/** Every commit the workflow contributed, in integration order. */
export function integratedCommitEvidence(
	state: WorkflowRunState,
): IntegratedCommitEvidence[] {
	const evidence: IntegratedCommitEvidence[] = [];
	for (const stepId of topologicalStepIds(state.plan)) {
		const record = state.steps[stepId];
		if (
			!record ||
			!stepRequiresIntegration(state.capabilityProfiles, record.definition) ||
			!record.integratedCommit
		) {
			continue;
		}
		const attemptIds = new Set(record.attemptIds);
		const attempt = state.attempts.findLast(
			(candidate) =>
				attemptIds.has(candidate.id) && candidate.state === "succeeded",
		);
		if (!attempt) {
			throw new Error(`Integrated step ${stepId} has no successful attempt`);
		}
		if (!attempt.commit) {
			continue;
		}
		evidence.push({
			kind: stepProfileName(record.definition) === "repair" ? "repair" : "task",
			id: stepId,
			sourceCommit: attempt.commit,
			integratedCommit: record.integratedCommit,
		});
	}
	return evidence;
}

interface ReviewOutcomes {
	summaries: FinalReviewSummary[];
	risks: ReviewFinding[];
	/** Why these reviews cannot back merge-ready evidence. */
	gap?: string;
}

/**
 * Summarizes the reviews that describe the head this run would merge.
 *
 * A review only counts as evidence when it read the final integrated commit:
 * a review of an earlier head says nothing about what a later step changed.
 * Every category that was reviewed at all must therefore also have been
 * reviewed at the final head, and none of those final findings may still
 * require repair, or the run has not earned merge-ready evidence.
 */
async function reviewOutcomes(
	state: WorkflowRunState,
	artifacts: StepArtifactReader | undefined,
): Promise<ReviewOutcomes> {
	const staleCategories = new Set<ReviewCategory>();
	const reviewSteps = topologicalStepIds(state.plan).flatMap((stepId) => {
		const record = state.steps[stepId];
		return record && stepProfileName(record.definition) === "review"
			? [{ stepId, outputs: record.definition.outputs ?? [] }]
			: [];
	});
	// The newest review of the final head per category is that category's
	// evidence; an earlier review of the same commit adds no new information.
	const latest = new Map<ReviewCategory, ReviewFindingsPayload>();
	if (reviewSteps.length === 0) {
		return { summaries: [], risks: [] };
	}
	if (!artifacts) {
		return {
			summaries: [],
			risks: [],
			gap: `Review evidence is unavailable for ${reviewSteps
				.map(({ stepId }) => stepId)
				.join(", ")}`,
		};
	}
	const unavailable: string[] = [];
	for (const { stepId, outputs } of reviewSteps) {
		if (outputs.length === 0) {
			unavailable.push(stepId);
			continue;
		}
		for (const output of outputs) {
			const artifact = await artifacts.latest(state.id, stepId, output);
			if (!artifact) {
				unavailable.push(`${stepId}.${output}`);
				continue;
			}
			const payload = JSON.parse(artifact.payload) as ReviewFindingsPayload;
			if (payload.baseCommit === state.integrationHead) {
				latest.set(payload.category, payload);
			} else {
				staleCategories.add(payload.category);
			}
		}
	}
	if (unavailable.length > 0) {
		return {
			summaries: [],
			risks: [],
			gap: `Review evidence is unavailable for ${unavailable.join(", ")}`,
		};
	}
	const summaries: FinalReviewSummary[] = [];
	const risks: ReviewFinding[] = [];
	for (const category of REVIEW_CATEGORIES) {
		const payload = latest.get(category);
		if (!payload) {
			continue;
		}
		summaries.push({ category, summary: payload.summary });
		for (const finding of payload.findings ?? []) {
			if (finding.status !== "repaired") {
				risks.push(finding);
			}
		}
	}
	risks.sort((left, right) => left.id.localeCompare(right.id));
	const missing = [...staleCategories].filter(
		(category) => !latest.has(category),
	);
	if (missing.length > 0) {
		return {
			summaries,
			risks,
			gap: `No ${missing.join(", ")} review covers the final integrated commit ${state.integrationHead}`,
		};
	}
	const unrepaired = risks.filter((finding) =>
		requiresAutomaticRepair(finding),
	);
	if (unrepaired.length > 0) {
		return {
			summaries,
			risks,
			gap: `Important findings remain after the approved repair rounds: ${unrepaired
				.map((finding) => finding.id)
				.join(", ")}`,
		};
	}
	return { summaries, risks };
}

function assertFinalizableState(state: WorkflowRunState): void {
	if (state.state !== "completed") {
		throw new Error(
			`Cannot finalize workflow run ${state.id} in ${state.state} state; expected completed`,
		);
	}
	for (const stepId of topologicalStepIds(state.plan)) {
		const record = state.steps[stepId];
		if (!record || record.state !== "succeeded") {
			throw new Error(
				`Cannot finalize workflow run ${state.id}; step ${stepId} has not succeeded`,
			);
		}
		if (
			stepRequiresIntegration(state.capabilityProfiles, record.definition) &&
			!record.integratedCommit
		) {
			throw new Error(
				`Cannot finalize workflow run ${state.id}; mutating step ${stepId} has not been integrated`,
			);
		}
	}
}

/**
 * Runs the plan's final validation against the exact integrated result and,
 * when it passes, assembles the merge-ready evidence a reviewer needs: the
 * verified Git history, the checks that ran, and every risk left open.
 */
export async function finalizeWorkflowRun(
	dependencies: WorkflowFinalizationDependencies,
	input: WorkflowFinalizationInput,
): Promise<WorkflowFinalizationResult> {
	const now = dependencies.now ?? (() => new Date().toISOString());
	const { state } = input;
	assertFinalizableState(state);
	// Reviews are checked before the suite runs: a result the reviews cannot
	// support will not become merge-ready however green its checks are.
	const { summaries, risks, gap } = await reviewOutcomes(
		state,
		dependencies.artifacts,
	);
	if (gap) {
		return { evidenceGap: gap };
	}
	const attemptNumber = input.attemptNumber ?? 1;
	const worktreePath =
		await dependencies.worktrees.prepareFinalValidationWorktree(
			input.repository,
			state.id,
			attemptNumber,
			state.integrationHead,
		);
	let evidence: FinalValidationEvidence;
	try {
		evidence = await dependencies.finalValidator.validate({
			worktreePath,
			integrationCommit: state.integrationHead,
			commands: state.plan.finalValidationCommands,
			securityPolicy: dependencies.securityPolicy,
			...(input.signal ? { signal: input.signal } : {}),
		});
	} catch (error) {
		// A failed check is a recorded outcome, not an exception the caller has
		// to interpret; the evidence is the answer either way.
		if (!(error instanceof FinalValidationError)) {
			throw error;
		}
		evidence = error.evidence;
	} finally {
		await dependencies.worktrees.removeTaskWorktree(
			state.repositoryRoot,
			worktreePath,
		);
	}
	if (!evidence.passed) {
		return { evidence, worktreePath };
	}
	const commits = integratedCommitEvidence(state);
	const verifiedAt = now();
	const git = await dependencies.git.verifyMergeReadyHistory({
		repositoryRoot: state.repositoryRoot,
		integrationBranch: state.integrationBranch,
		integrationHead: state.integrationHead,
		baseBranch: state.baseBranch,
		baseCommit: state.baseCommit,
		commits,
		verifiedAt,
	});
	return {
		evidence,
		worktreePath,
		mergeReady: {
			version: MERGE_READY_EVIDENCE_VERSION,
			generatedAt: verifiedAt,
			securityPolicy: dependencies.securityPolicy,
			integrationBranch: state.integrationBranch,
			integrationHead: state.integrationHead,
			baseBranch: state.baseBranch,
			baseCommit: state.baseCommit,
			commits,
			finalReviews: summaries,
			remainingRisks: risks,
			finalChecks: evidence.checks,
			git,
		},
	};
}
