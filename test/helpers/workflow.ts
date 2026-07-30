import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	validateWorkflowPlan,
	type WorkflowPlan,
} from "../../src/domain/steps.js";
import {
	WorkflowEngine,
	type WorkflowEngineDependencies,
} from "../../src/engine/engine.js";
import type { WorkflowEvent } from "../../src/engine/events.js";
import { StepExecutor } from "../../src/engine/executor.js";
import {
	type StepHandler,
	StepHandlerRegistry,
} from "../../src/engine/handlers.js";
import { GitStepIntegrator } from "../../src/engine/integration.js";
import { InMemoryWorkflowStateStore } from "../../src/engine/state-store.js";
import {
	createWorkflowRunState,
	type WorkflowRunState,
} from "../../src/engine/workflow-state.js";
import { defaultWorkspaceProviders } from "../../src/engine/workspaces.js";
import { GitCli } from "../../src/git/git.js";
import { GitWorktreeManager } from "../../src/git/worktrees.js";
import { defaultCapabilityProfiles } from "../../src/security/capabilities.js";
import { ArtifactStore } from "../../src/storage/artifact-store.js";

export const execute = promisify(execFile);

const directories: string[] = [];

export async function removeWorkflowHarnessDirectories(): Promise<void> {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
}

export interface WorkflowRepository {
	parent: string;
	repositoryRoot: string;
	worktreeRoot: string;
	artifactRoot: string;
}

export async function createWorkflowRepository(): Promise<WorkflowRepository> {
	const parent = await mkdtemp(join(tmpdir(), "pi-orchestrator-engine-"));
	directories.push(parent);
	const repositoryRoot = join(parent, "repository");
	await execute("git", ["init", "-b", "main", repositoryRoot]);
	await execute("git", ["config", "user.name", "Test"], {
		cwd: repositoryRoot,
	});
	await execute("git", ["config", "user.email", "test@example.com"], {
		cwd: repositoryRoot,
	});
	await mkdir(join(repositoryRoot, "src"), { recursive: true });
	await writeFile(join(repositoryRoot, "src", "index.ts"), "export {};\n");
	await execute("git", ["add", "."], { cwd: repositoryRoot });
	await execute("git", ["commit", "-m", "Initial"], { cwd: repositoryRoot });
	return {
		parent,
		repositoryRoot,
		worktreeRoot: join(parent, "worktrees"),
		artifactRoot: join(parent, "artifacts"),
	};
}

export function investigationStep(
	id: string,
	dependencies: string[] = [],
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		kind: "investigation",
		id,
		title: id,
		description: `Investigate ${id}`,
		dependencies,
		questions: [`What does ${id} need?`],
		...extra,
	};
}

export function changeStep(
	id: string,
	dependencies: string[],
	allowedPaths: string[],
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		kind: "change",
		id,
		title: id,
		description: `Implement ${id}`,
		dependencies,
		acceptanceCriteria: [`${id} exists`],
		allowedPaths,
		validationCommands: [{ command: process.execPath, args: ["-e", ""] }],
		...extra,
	};
}

export function commandStep(
	id: string,
	dependencies: string[],
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		kind: "command",
		id,
		title: id,
		description: `Run ${id}`,
		dependencies,
		command: { command: process.execPath, args: ["-e", "process.exit(0)"] },
		...extra,
	};
}

export function approvalStep(
	id: string,
	dependencies: string[],
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		kind: "approval",
		id,
		title: id,
		description: `Approve ${id}`,
		dependencies,
		prompt: `Approve ${id}?`,
		...extra,
	};
}

export function workflowPlanOf(steps: Record<string, unknown>[]): WorkflowPlan {
	return validateWorkflowPlan({
		version: 4,
		title: "Deliver the widget",
		steps,
		finalValidationCommands: [{ command: process.execPath, args: ["-e", ""] }],
	});
}

export interface WorkflowHarness extends WorkflowRepository {
	engine: WorkflowEngine;
	store: InMemoryWorkflowStateStore;
	artifacts: ArtifactStore;
	initial: WorkflowRunState;
	events: WorkflowEvent[];
}

export interface CreateWorkflowHarnessOptions {
	maxConcurrentWorkers?: number;
	runId?: string;
	engine?: Partial<WorkflowEngineDependencies>;
}

export async function createWorkflowHarness(
	plan: WorkflowPlan,
	handlers: StepHandler[],
	options: CreateWorkflowHarnessOptions = {},
): Promise<WorkflowHarness> {
	const repositoryPaths = await createWorkflowRepository();
	const git = new GitCli();
	const worktrees = new GitWorktreeManager(git, repositoryPaths.worktreeRoot);
	const repository = await git.inspect(repositoryPaths.repositoryRoot);
	const runId = options.runId ?? "run-engine-1";
	const integrationBranch = await worktrees.prepareIntegrationBranch(
		repository,
		runId,
	);
	const initial = createWorkflowRunState({
		id: runId,
		plan,
		repositoryRoot: repositoryPaths.repositoryRoot,
		baseBranch: repository.currentBranch,
		baseCommit: repository.head,
		integrationBranch,
		integrationHead: repository.head,
		capabilityProfiles: defaultCapabilityProfiles(),
		maxConcurrentWorkers: options.maxConcurrentWorkers ?? 2,
		createdAt: "2026-07-29T00:00:00.000Z",
	});
	const store = new InMemoryWorkflowStateStore(initial);
	const artifacts = new ArtifactStore(repositoryPaths.artifactRoot);
	const events: WorkflowEvent[] = [];
	const engine = new WorkflowEngine({
		store,
		repository,
		artifacts,
		executor: new StepExecutor({
			workspaces: defaultWorkspaceProviders(worktrees),
			handlers: new StepHandlerRegistry(handlers),
		}),
		integrator: new GitStepIntegrator(git),
		onEvent: (event) => {
			events.push(event);
		},
		...options.engine,
	});
	return {
		...repositoryPaths,
		engine,
		store,
		artifacts,
		initial,
		events,
	};
}
