import type { StepDefinition } from "../domain/steps.js";
import type {
	CapabilityProfile,
	RunCapabilityProfiles,
} from "../domain/types.js";
import type { RepositoryInfo } from "../git/git.js";
import type { WorktreeManager } from "../git/worktrees.js";
import { stepCapabilityProfile } from "../security/capabilities.js";

/**
 * How much repository access one step needs. The requirement is derived from
 * the frozen capability profile rather than from the step kind, so narrowing a
 * step's declared capabilities also narrows the workspace it receives.
 */
export type WorkspaceRequirement = "none" | "read-only" | "mutable";

export const WORKSPACE_REQUIREMENTS: readonly WorkspaceRequirement[] = [
	"none",
	"read-only",
	"mutable",
];

export function workspaceRequirementFor(
	profile: CapabilityProfile,
): WorkspaceRequirement {
	if (profile.capabilities.includes("mutate-repository")) {
		return "mutable";
	}
	return profile.capabilities.length === 0 ? "none" : "read-only";
}

export function stepWorkspaceRequirement(
	profiles: RunCapabilityProfiles,
	step: StepDefinition,
): WorkspaceRequirement {
	return workspaceRequirementFor(stepCapabilityProfile(profiles, step));
}

/**
 * Only steps that occupy a workspace occupy a worker slot; a pure decision
 * gate waits on a person, not on orchestration concurrency.
 */
export function stepConsumesWorkerSlot(
	profiles: RunCapabilityProfiles,
	step: StepDefinition,
): boolean {
	return stepWorkspaceRequirement(profiles, step) !== "none";
}

/** A step whose approved authority can change the repository must integrate. */
export function stepRequiresIntegration(
	profiles: RunCapabilityProfiles,
	step: StepDefinition,
): boolean {
	return stepWorkspaceRequirement(profiles, step) === "mutable";
}

export interface WorkspaceRequest {
	repository: RepositoryInfo;
	runId: string;
	stepId: string;
	attemptNumber: number;
	startPoint: string;
}

export interface Workspace {
	requirement: WorkspaceRequirement;
	/** Empty exactly when the requirement is `none`. */
	path: string;
	branch?: string;
	baseCommit: string;
}

export interface WorkspaceProvider {
	readonly requirement: WorkspaceRequirement;
	acquire(request: WorkspaceRequest): Promise<Workspace>;
	release(repositoryRoot: string, workspace: Workspace): Promise<void>;
}

/** Provides the empty workspace steps without repository authority receive. */
export class DetachedWorkspaceProvider implements WorkspaceProvider {
	readonly requirement = "none" as const;

	async acquire(request: WorkspaceRequest): Promise<Workspace> {
		return {
			requirement: "none",
			path: "",
			baseCommit: request.startPoint,
		};
	}

	async release(): Promise<void> {
		// A step without a workspace has nothing to release.
	}
}

/**
 * Provides an isolated Git worktree. Read-only and mutable steps use the same
 * isolation: a step is prevented from changing the repository by its tool
 * allowlist and validated boundary, never by sharing the user's worktree.
 */
export class WorktreeWorkspaceProvider implements WorkspaceProvider {
	constructor(
		private readonly worktrees: WorktreeManager,
		readonly requirement: "read-only" | "mutable",
	) {}

	async acquire(request: WorkspaceRequest): Promise<Workspace> {
		const allocation = await this.worktrees.prepareTaskWorktree({
			repository: request.repository,
			runId: request.runId,
			taskId: request.stepId,
			attemptNumber: request.attemptNumber,
			startPoint: request.startPoint,
		});
		return {
			requirement: this.requirement,
			path: allocation.path,
			branch: allocation.branch,
			baseCommit: request.startPoint,
		};
	}

	async release(repositoryRoot: string, workspace: Workspace): Promise<void> {
		await this.worktrees.removeTaskWorktree(repositoryRoot, workspace.path);
	}
}

export class WorkspaceProviderRegistry {
	private readonly providers = new Map<
		WorkspaceRequirement,
		WorkspaceProvider
	>();

	constructor(providers: readonly WorkspaceProvider[]) {
		for (const provider of providers) {
			if (this.providers.has(provider.requirement)) {
				throw new Error(
					`Duplicate workspace provider for requirement ${provider.requirement}`,
				);
			}
			this.providers.set(provider.requirement, provider);
		}
		for (const requirement of WORKSPACE_REQUIREMENTS) {
			if (!this.providers.has(requirement)) {
				throw new Error(
					`Missing workspace provider for requirement ${requirement}`,
				);
			}
		}
	}

	providerFor(requirement: WorkspaceRequirement): WorkspaceProvider {
		const provider = this.providers.get(requirement);
		if (!provider) {
			throw new Error(
				`Missing workspace provider for requirement ${requirement}`,
			);
		}
		return provider;
	}
}

export function defaultWorkspaceProviders(
	worktrees: WorktreeManager,
): WorkspaceProviderRegistry {
	return new WorkspaceProviderRegistry([
		new DetachedWorkspaceProvider(),
		new WorktreeWorkspaceProvider(worktrees, "read-only"),
		new WorktreeWorkspaceProvider(worktrees, "mutable"),
	]);
}
