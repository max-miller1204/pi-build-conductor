import type { StepArtifactReader } from "../domain/step-context.js";
import { stepProfileName } from "../domain/steps.js";
import {
	type FinalReviewSummary,
	type FinalValidationEvidence,
	type IntegratedCommitEvidence,
	MERGE_READY_EVIDENCE_VERSION,
	type MergeReadyEvidence,
	type ReviewFinding,
	type RunSecurityPolicy,
} from "../domain/types.js";
import type { GitClient, RepositoryInfo } from "../git/git.js";
import type { WorktreeManager } from "../git/worktrees.js";
import {
	FinalValidationError,
	type FinalValidator,
} from "../validation/final-validator.js";
import type { ReviewFindingsPayload } from "./steps/review.js";
import type { WorkflowRunState } from "./workflow-state.js";

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
	evidence: FinalValidationEvidence;
	/** Present only when final validation passed. */
	mergeReady?: MergeReadyEvidence;
}

/** Every commit the workflow contributed, in integration order. */
export function integratedCommitEvidence(
	state: WorkflowRunState,
): IntegratedCommitEvidence[] {
	const evidence: IntegratedCommitEvidence[] = [];
	for (const attempt of state.attempts) {
		const record = state.steps[attempt.stepId];
		if (
			attempt.state !== "succeeded" ||
			!attempt.commit ||
			!record?.integratedCommit
		) {
			continue;
		}
		evidence.push({
			kind: stepProfileName(record.definition) === "repair" ? "repair" : "task",
			id: attempt.stepId,
			sourceCommit: attempt.commit,
			integratedCommit: record.integratedCommit,
		});
	}
	return evidence;
}

async function reviewOutcomes(
	state: WorkflowRunState,
	artifacts: StepArtifactReader | undefined,
): Promise<{ summaries: FinalReviewSummary[]; risks: ReviewFinding[] }> {
	const summaries: FinalReviewSummary[] = [];
	const risks: ReviewFinding[] = [];
	if (!artifacts) {
		return { summaries, risks };
	}
	for (const [stepId, record] of Object.entries(state.steps)) {
		if (stepProfileName(record.definition) !== "review") {
			continue;
		}
		for (const output of record.definition.outputs ?? []) {
			const artifact = await artifacts.latest(state.id, stepId, output);
			if (!artifact) {
				continue;
			}
			const payload = JSON.parse(artifact.payload) as ReviewFindingsPayload;
			summaries.push({ category: payload.category, summary: payload.summary });
			for (const finding of payload.findings ?? []) {
				if (finding.status !== "repaired") {
					risks.push(finding);
				}
			}
		}
	}
	return { summaries, risks };
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
		return { evidence };
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
	const { summaries, risks } = await reviewOutcomes(
		state,
		dependencies.artifacts,
	);
	return {
		evidence,
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
