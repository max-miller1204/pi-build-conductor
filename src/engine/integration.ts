import type { GitClient } from "../git/git.js";
import type { WorkflowStepAttempt } from "./workflow-state.js";

export interface StepIntegrationRequest {
	repositoryRoot: string;
	integrationBranch: string;
	/** The integration head the engine believes the branch still points at. */
	expectedHead: string;
	stepId: string;
	attempt: WorkflowStepAttempt;
	commit: string;
}

/**
 * Moves one step's committed work onto the run's integration branch. Steps are
 * integrated one at a time in plan order, so the branch history stays a
 * reviewable linear record of the workflow.
 */
export interface StepIntegrator {
	integrate(request: StepIntegrationRequest): Promise<string>;
}

export class GitStepIntegrator implements StepIntegrator {
	constructor(
		private readonly git: Pick<
			GitClient,
			"verifyTaskCommit" | "integrateCommit"
		>,
	) {}

	async integrate(request: StepIntegrationRequest): Promise<string> {
		const branch = request.attempt.branch;
		if (!branch) {
			throw new Error(
				`Step ${request.stepId} produced a commit without a workspace branch`,
			);
		}
		await this.git.verifyTaskCommit(
			request.repositoryRoot,
			branch,
			request.commit,
			request.attempt.baseCommit,
		);
		return this.git.integrateCommit(
			request.repositoryRoot,
			request.integrationBranch,
			request.expectedHead,
			request.commit,
		);
	}
}
