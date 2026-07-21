import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { BuildRun } from "../domain/types.js";
import {
	type GitClient,
	integrationScratchDirectoryPrefix,
	type RepositoryInfo,
} from "./git.js";

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

export interface ResourceReconciliationReport {
	removedWorktrees: string[];
	removedBranches: string[];
	retainedDirtyWorktrees: string[];
	retainedUnexpectedWorktrees: string[];
	retainedUnexpectedBranches: string[];
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
	reconcileRunResources?(run: BuildRun): Promise<ResourceReconciliationReport>;
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
			const head = await this.git.branchHead(repository.root, branch);
			if (head !== repository.head) {
				throw new Error(
					`Integration branch ${branch} is at ${head}, expected ${repository.head}`,
				);
			}
			return branch;
		}
		await this.git.createBranch(repository.root, branch, repository.head);
		return branch;
	}

	async prepareTaskWorktree(
		input: PrepareTaskWorktreeInput,
	): Promise<WorktreeAllocation> {
		const branch = `conductor/${input.runId}/task/${input.taskId}/attempt-${input.attemptNumber}`;
		const path = join(
			this.worktreeRoot,
			input.runId,
			input.taskId,
			`attempt-${input.attemptNumber}`,
		);
		const expectedHead = this.git.resolveCommit
			? await this.git.resolveCommit(input.repository.root, input.startPoint)
			: input.startPoint;
		if (await this.git.branchExists(input.repository.root, branch)) {
			const branchHead = await this.git.branchHead(
				input.repository.root,
				branch,
			);
			if (branchHead !== expectedHead) {
				throw new Error(
					`Task branch ${branch} is at ${branchHead}, expected ${expectedHead}`,
				);
			}
			try {
				await lstat(path);
				const [repository, worktree] = await Promise.all([
					this.git.inspect(input.repository.root),
					this.git.inspect(path),
				]);
				if (
					worktree.root !== resolve(path) ||
					worktree.commonDirectory !== repository.commonDirectory ||
					worktree.currentBranch !== branch ||
					worktree.head !== expectedHead ||
					!worktree.isClean
				) {
					throw new Error(`Existing task worktree does not match ${branch}`);
				}
				return { branch, path };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					throw error;
				}
			}
			await mkdir(dirname(path), { recursive: true });
			await this.git.addWorktree(
				input.repository.root,
				path,
				branch,
				expectedHead,
				false,
			);
			return { branch, path };
		}
		try {
			await lstat(path);
			throw new Error(
				`Task worktree path already exists without its branch: ${path}`,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
		await mkdir(dirname(path), { recursive: true });
		await this.git.addWorktree(
			input.repository.root,
			path,
			branch,
			expectedHead,
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
		try {
			await lstat(path);
			await this.git.verifyDetachedWorktree(path, commit);
			return path;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
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

	async reconcileRunResources(
		run: BuildRun,
	): Promise<ResourceReconciliationReport> {
		if (
			!this.git.listWorktrees ||
			!this.git.listBranches ||
			!this.git.deleteBranch
		) {
			return {
				removedWorktrees: [],
				removedBranches: [],
				retainedDirtyWorktrees: [],
				retainedUnexpectedWorktrees: [],
				retainedUnexpectedBranches: [],
			};
		}
		const runRoot = resolve(this.worktreeRoot, run.id);
		const prefix = `conductor/${run.id}/`;
		const retainedPaths = new Set<string>();
		const protectedBranches = new Set<string>([run.integrationBranch]);
		const safeStartPoints = new Set<string>([
			run.baseCommit,
			run.integrationHead,
			...run.reviewRounds.map((round) => round.baseCommit),
		]);
		for (const attempt of run.attempts) {
			protectedBranches.add(attempt.branch);
			safeStartPoints.add(attempt.baseCommit);
			if (
				["prepared", "launched", "running", "validating", "failed"].includes(
					attempt.state,
				)
			) {
				retainedPaths.add(resolve(attempt.worktreePath));
			}
		}
		for (const attempt of [...run.reviewAttempts, ...run.repairAttempts]) {
			protectedBranches.add(attempt.branch);
			safeStartPoints.add(attempt.baseCommit);
			if (
				["prepared", "launched", "running", "validating", "failed"].includes(
					attempt.state,
				)
			) {
				retainedPaths.add(resolve(attempt.worktreePath));
			}
		}
		for (const attempt of run.finalValidationAttempts) {
			if (attempt.state === "running" || attempt.state === "failed") {
				retainedPaths.add(resolve(attempt.worktreePath));
			}
		}

		const removedWorktrees: string[] = [];
		const retainedDirtyWorktrees: string[] = [];
		const retainedUnexpectedWorktrees: string[] = [];
		const retainedUnexpectedBranches: string[] = [];
		const integrationScratchPrefix = integrationScratchDirectoryPrefix(
			run.repositoryRoot,
			run.integrationBranch,
		);
		let worktrees = await this.git.listWorktrees(run.repositoryRoot);
		for (const worktree of worktrees) {
			const target = resolve(worktree.path);
			const temporaryRoot = dirname(target);
			if (
				target === join(temporaryRoot, "worktree") &&
				temporaryRoot.startsWith(integrationScratchPrefix)
			) {
				await this.git.removeWorktree(run.repositoryRoot, target);
				await rm(temporaryRoot, { recursive: true, force: true });
				removedWorktrees.push(target);
				continue;
			}
			const fromRunRoot = relative(runRoot, target);
			if (
				fromRunRoot === "" ||
				fromRunRoot === ".." ||
				fromRunRoot.startsWith(
					`..${process.platform === "win32" ? "\\" : "/"}`,
				) ||
				isAbsolute(fromRunRoot) ||
				retainedPaths.has(target)
			) {
				continue;
			}
			const relativeParts = fromRunRoot.split(/[\\/]/);
			const isDetachedFinalValidation =
				worktree.branch === undefined &&
				relativeParts.length === 2 &&
				relativeParts[0] === "final-validation" &&
				/^attempt-[1-9][0-9]*$/.test(relativeParts[1] ?? "");
			const isOwnedBranch = worktree.branch?.startsWith(prefix) === true;
			if (!isOwnedBranch && !isDetachedFinalValidation) {
				continue;
			}
			if (worktree.prunable) {
				continue;
			}
			const status = await this.git.status(target);
			if (status.length > 0) {
				retainedDirtyWorktrees.push(target);
				continue;
			}
			if (!safeStartPoints.has(worktree.head)) {
				retainedUnexpectedWorktrees.push(target);
				continue;
			}
			try {
				await this.git.removeWorktree(run.repositoryRoot, target, false);
				removedWorktrees.push(target);
			} catch {
				retainedUnexpectedWorktrees.push(target);
			}
		}
		await this.git.pruneWorktrees?.(run.repositoryRoot);
		worktrees = await this.git.listWorktrees(run.repositoryRoot);
		const checkedOutBranches = new Set(
			worktrees.flatMap((worktree) =>
				worktree.branch ? [worktree.branch] : [],
			),
		);
		const removedBranches: string[] = [];
		for (const branch of await this.git.listBranches(
			run.repositoryRoot,
			prefix,
		)) {
			if (
				branch.name === run.integrationBranch ||
				protectedBranches.has(branch.name) ||
				checkedOutBranches.has(branch.name)
			) {
				continue;
			}
			if (!safeStartPoints.has(branch.head)) {
				retainedUnexpectedBranches.push(branch.name);
				continue;
			}
			try {
				await this.git.deleteBranch(
					run.repositoryRoot,
					branch.name,
					branch.head,
				);
				removedBranches.push(branch.name);
			} catch {
				retainedUnexpectedBranches.push(branch.name);
			}
		}
		return {
			removedWorktrees,
			removedBranches,
			retainedDirtyWorktrees,
			retainedUnexpectedWorktrees,
			retainedUnexpectedBranches,
		};
	}
}
