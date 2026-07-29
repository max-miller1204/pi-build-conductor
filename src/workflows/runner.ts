import { randomUUID } from "node:crypto";
import {
	type StepDefinition,
	stepCapabilities,
	type WorkflowPlan,
} from "../domain/steps.js";
import { WorkflowEngine } from "../engine/engine.js";
import type { WorkflowEvent } from "../engine/events.js";
import { StepExecutor } from "../engine/executor.js";
import type { StepHandler } from "../engine/handlers.js";
import { StepHandlerRegistry } from "../engine/handlers.js";
import { GitStepIntegrator } from "../engine/integration.js";
import { InMemoryWorkflowStateStore } from "../engine/state-store.js";
import {
	createWorkflowRunState,
	type WorkflowRunState,
} from "../engine/workflow-state.js";
import { defaultWorkspaceProviders } from "../engine/workspaces.js";
import type { GitClient, RepositoryInfo } from "../git/git.js";
import type { WorktreeManager } from "../git/worktrees.js";
import { defaultCapabilityProfiles } from "../security/capabilities.js";
import type { ArtifactStore } from "../storage/artifact-store.js";

export function newWorkflowRunId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function mutatingSteps(plan: WorkflowPlan): StepDefinition[] {
	return plan.steps.filter((step) =>
		stepCapabilities(step).includes("mutate-repository"),
	);
}

export interface ReadOnlyWorkflowDependencies {
	git: GitClient;
	worktrees: WorktreeManager;
	artifacts: ArtifactStore;
	onEvent?: (event: WorkflowEvent) => void;
}

export interface ReadOnlyWorkflowRequest {
	runId: string;
	repository: RepositoryInfo;
	plan: WorkflowPlan;
	handlers: StepHandler[];
	maxConcurrentWorkers?: number;
	signal?: AbortSignal;
}

/**
 * Runs a read-only workflow plan on the engine against the repository's
 * current head. No integration branch is created because nothing may
 * integrate: a plan containing any step with mutate-repository authority is
 * rejected before anything runs. Artifacts persist through the given store;
 * the run state itself is ephemeral because a failed read-only run is simply
 * run again.
 */
export async function runReadOnlyWorkflow(
	dependencies: ReadOnlyWorkflowDependencies,
	request: ReadOnlyWorkflowRequest,
): Promise<WorkflowRunState> {
	const mutating = mutatingSteps(request.plan);
	if (mutating.length > 0) {
		throw new Error(
			`Read-only workflow execution rejected mutating steps: ${mutating
				.map((step) => step.id)
				.join(", ")}`,
		);
	}
	if (!request.repository.isClean) {
		throw new Error(
			"Commit or stash all changes before running a read-only workflow",
		);
	}
	const initial = createWorkflowRunState({
		id: request.runId,
		plan: request.plan,
		repositoryRoot: request.repository.root,
		baseBranch: request.repository.currentBranch,
		baseCommit: request.repository.head,
		// Nothing integrates in a read-only run, so the current branch head is
		// the exact snapshot every step executes against.
		integrationBranch: request.repository.currentBranch,
		integrationHead: request.repository.head,
		capabilityProfiles: defaultCapabilityProfiles(),
		maxConcurrentWorkers: request.maxConcurrentWorkers ?? 2,
	});
	const engine = new WorkflowEngine({
		store: new InMemoryWorkflowStateStore(initial),
		repository: request.repository,
		artifacts: dependencies.artifacts,
		executor: new StepExecutor({
			workspaces: defaultWorkspaceProviders(dependencies.worktrees),
			handlers: new StepHandlerRegistry(request.handlers),
		}),
		integrator: new GitStepIntegrator(dependencies.git),
		...(dependencies.onEvent ? { onEvent: dependencies.onEvent } : {}),
	});
	return engine.run(request.runId, {
		...(request.signal ? { signal: request.signal } : {}),
	});
}

/** One bounded line per failed step, for surfacing run failures. */
export function describeFailedSteps(state: WorkflowRunState): string[] {
	const lines: string[] = [];
	for (const [stepId, record] of Object.entries(state.steps)) {
		if (record.state !== "failed" && record.state !== "blocked") {
			continue;
		}
		const attemptId = record.attemptIds[record.attemptIds.length - 1];
		const attempt = state.attempts.find((entry) => entry.id === attemptId);
		const error = record.error ?? attempt?.error ?? "no recorded error";
		lines.push(`- ${stepId} (${record.state}): ${error.slice(0, 300)}`);
	}
	return lines;
}
