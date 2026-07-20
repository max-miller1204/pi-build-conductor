import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitClient, RepositoryInfo } from "./git.js";

export interface WorktreeAllocation {
	branch: string;
	path: string;
}

export interface PrepareTaskWorktreeInput {
	repository: RepositoryInfo;
	runId: string;
	taskId: string;
	attemptNumber: number;
	startPoint: string;
}

export interface WorktreeManager {
	prepareIntegrationBranch(
		repository: RepositoryInfo,
		runId: string,
	): Promise<string>;
	prepareTaskWorktree(
		input: PrepareTaskWorktreeInput,
	): Promise<WorktreeAllocation>;
}

export class GitWorktreeManager implements WorktreeManager {
	constructor(
		private readonly git: GitClient,
		private readonly worktreeRoot: string,
	) {}

	async prepareIntegrationBranch(
		repository: RepositoryInfo,
		runId: string,
	): Promise<string> {
		if (!repository.isClean) {
			throw new Error(
				"The current worktree must be clean before starting a build run",
			);
		}
		const branch = `conductor/${runId}/integration`;
		if (await this.git.branchExists(repository.root, branch)) {
			throw new Error(`Integration branch already exists: ${branch}`);
		}
		await this.git.createBranch(repository.root, branch, repository.head);
		return branch;
	}

	async prepareTaskWorktree(
		input: PrepareTaskWorktreeInput,
	): Promise<WorktreeAllocation> {
		const branch = `conductor/${input.runId}/task/${input.taskId}/attempt-${input.attemptNumber}`;
		if (await this.git.branchExists(input.repository.root, branch)) {
			throw new Error(`Task branch already exists: ${branch}`);
		}
		const path = join(
			this.worktreeRoot,
			input.runId,
			input.taskId,
			`attempt-${input.attemptNumber}`,
		);
		await mkdir(dirname(path), { recursive: true });
		await this.git.addWorktree(
			input.repository.root,
			path,
			branch,
			input.startPoint,
		);
		return { branch, path };
	}
}
