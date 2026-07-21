import { lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
	finalValidationWorktreePath(runId: string, attemptNumber: number): string;
	prepareFinalValidationWorktree(
		repository: RepositoryInfo,
		runId: string,
		attemptNumber: number,
		commit: string,
	): Promise<string>;
	removeTaskWorktree(repositoryRoot: string, path: string): Promise<void>;
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
		const freshRepository = await this.git.inspect(repository.root);
		if (!freshRepository.isClean) {
			throw new Error(
				"The current worktree must be clean before starting a build run",
			);
		}
		if (
			freshRepository.root !== repository.root ||
			freshRepository.head !== repository.head ||
			freshRepository.currentBranch !== repository.currentBranch
		) {
			throw new Error(
				"The repository changed before integration branch creation",
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

	finalValidationWorktreePath(runId: string, attemptNumber: number): string {
		return join(
			this.worktreeRoot,
			runId,
			"final-validation",
			`attempt-${attemptNumber}`,
		);
	}

	async prepareFinalValidationWorktree(
		repository: RepositoryInfo,
		runId: string,
		attemptNumber: number,
		commit: string,
	): Promise<string> {
		const path = this.finalValidationWorktreePath(runId, attemptNumber);
		await mkdir(dirname(path), { recursive: true });
		await this.git.addDetachedWorktree(repository.root, path, commit);
		return path;
	}

	async removeTaskWorktree(
		repositoryRoot: string,
		path: string,
	): Promise<void> {
		const root = resolve(this.worktreeRoot);
		const target = resolve(path);
		const pathFromRoot = relative(root, target);
		if (
			pathFromRoot.length === 0 ||
			pathFromRoot === ".." ||
			pathFromRoot.startsWith(
				`..${process.platform === "win32" ? "\\" : "/"}`,
			) ||
			isAbsolute(pathFromRoot)
		) {
			throw new Error(
				`Refusing to remove worktree outside conductor root: ${path}`,
			);
		}
		try {
			await lstat(target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}
		const [repository, worktree] = await Promise.all([
			this.git.inspect(repositoryRoot),
			this.git.inspect(target),
		]);
		if (
			worktree.root !== target ||
			worktree.commonDirectory !== repository.commonDirectory ||
			worktree.root === repository.root
		) {
			throw new Error(`Refusing to remove an unexpected worktree: ${path}`);
		}
		await this.git.removeWorktree(repository.root, target);
	}
}
