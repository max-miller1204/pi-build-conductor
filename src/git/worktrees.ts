import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import * as nodePath from "node:path";
import type { OrchestrationRun } from "../domain/types.js";
import {
	type GitClient,
	integrationScratchDirectoryPrefix,
	type RepositoryInfo,
} from "./git.js";

const { basename, dirname, isAbsolute, join, relative, resolve } = nodePath;

export interface WorktreeAllocation {
	branch: string;
	path: string;
}

export function isPathInside(
	root: string,
	target: string,
	pathApi: Pick<
		typeof nodePath,
		"isAbsolute" | "relative" | "resolve"
	> = nodePath,
): boolean {
	const pathFromRoot = pathApi.relative(
		pathApi.resolve(root),
		pathApi.resolve(target),
	);
	return (
		pathFromRoot.length > 0 &&
		!/^\.\.(?:[\\/]|$)/.test(pathFromRoot) &&
		!pathApi.isAbsolute(pathFromRoot)
	);
}

async function canonicalizeExistingPrefix(path: string): Promise<string> {
	let current = resolve(path);
	const trailing: string[] = [];
	for (;;) {
		try {
			const canonical = await realpath(current);
			return trailing.length === 0 ? canonical : join(canonical, ...trailing);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
			const parent = dirname(current);
			if (parent === current) {
				return current;
			}
			trailing.unshift(basename(current));
			current = parent;
		}
	}
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
	reconcileRunResources?(
		run: OrchestrationRun,
	): Promise<ResourceReconciliationReport>;
	pruneRunResources?(
		run: OrchestrationRun,
	): Promise<ResourceReconciliationReport>;
}

export class GitWorktreeManager implements WorktreeManager {
	private canonicalRoot?: Promise<string>;

	constructor(
		private readonly git: GitClient,
		private readonly worktreeRoot: string,
		private readonly legacyWorktreeRoot?: string,
	) {}

	private canonicalWorktreeRoot(): Promise<string> {
		this.canonicalRoot ??= canonicalizeExistingPrefix(this.worktreeRoot);
		return this.canonicalRoot;
	}

	// New worktrees are always created below worktreeRoot; the legacy root only
	// keeps recovery and cleanup working for runs started before the storage
	// migration, because moving an existing Git worktree would break its
	// metadata back-pointers.
	private async canonicalRunRoots(runId: string): Promise<string[]> {
		const roots = [await this.canonicalPath(join(this.worktreeRoot, runId))];
		if (this.legacyWorktreeRoot) {
			roots.push(
				await canonicalizeExistingPrefix(join(this.legacyWorktreeRoot, runId)),
			);
		}
		return roots;
	}

	private async canonicalPath(path: string): Promise<string> {
		const target = resolve(path);
		const fromRoot = relative(resolve(this.worktreeRoot), target);
		if (fromRoot.length === 0) {
			return this.canonicalWorktreeRoot();
		}
		if (!/^\.\.(?:[\\/]|$)/.test(fromRoot) && !isAbsolute(fromRoot)) {
			return join(await this.canonicalWorktreeRoot(), fromRoot);
		}
		return canonicalizeExistingPrefix(target);
	}

	async prepareIntegrationBranch(
		repository: RepositoryInfo,
		runId: string,
	): Promise<string> {
		const freshRepository = await this.git.inspect(repository.root);
		if (!freshRepository.isClean) {
			throw new Error(
				"The current worktree must be clean before starting a orchestration run",
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
				const canonicalPath = await this.canonicalPath(path);
				const [repository, worktree] = await Promise.all([
					this.git.inspect(input.repository.root),
					this.git.inspect(path),
				]);
				if (
					worktree.root !== canonicalPath ||
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
		const roots = [
			resolve(this.worktreeRoot),
			...(this.legacyWorktreeRoot ? [resolve(this.legacyWorktreeRoot)] : []),
		];
		const target = resolve(path);
		if (!roots.some((root) => isPathInside(root, target))) {
			throw new Error(
				`Refusing to remove worktree outside orchestrator root: ${path}`,
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
		const canonicalTarget = await this.canonicalPath(target);
		const [repository, worktree] = await Promise.all([
			this.git.inspect(repositoryRoot),
			this.git.inspect(target),
		]);
		if (
			worktree.root !== canonicalTarget ||
			worktree.commonDirectory !== repository.commonDirectory ||
			worktree.root === repository.root
		) {
			throw new Error(`Refusing to remove an unexpected worktree: ${path}`);
		}
		await this.git.removeWorktree(repository.root, canonicalTarget);
	}

	async pruneRunResources(
		run: OrchestrationRun,
	): Promise<ResourceReconciliationReport> {
		if (!["completed", "failed", "cancelled"].includes(run.state)) {
			throw new Error(`Cannot prune resources for non-terminal run ${run.id}`);
		}
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

		const orphanReport = await this.reconcileRunResources(run);
		const runRoots = await this.canonicalRunRoots(run.id);
		const prefix = `conductor/${run.id}/`;
		const expectedWorktreeHeads = new Map<string, string>();
		const deletableBranchHeads = new Map<string, string>();
		for (const attempt of run.attempts) {
			expectedWorktreeHeads.set(
				await this.canonicalPath(attempt.worktreePath),
				attempt.commit ?? attempt.baseCommit,
			);
			if (!attempt.commit) {
				deletableBranchHeads.set(attempt.branch, attempt.baseCommit);
			}
		}
		for (const attempt of run.reviewAttempts) {
			expectedWorktreeHeads.set(
				await this.canonicalPath(attempt.worktreePath),
				attempt.baseCommit,
			);
			deletableBranchHeads.set(attempt.branch, attempt.baseCommit);
		}
		for (const attempt of run.repairAttempts) {
			expectedWorktreeHeads.set(
				await this.canonicalPath(attempt.worktreePath),
				attempt.commit ?? attempt.baseCommit,
			);
			if (!attempt.commit) {
				deletableBranchHeads.set(attempt.branch, attempt.baseCommit);
			}
		}
		for (const attempt of run.finalValidationAttempts) {
			expectedWorktreeHeads.set(
				await this.canonicalPath(attempt.worktreePath),
				attempt.integrationCommit,
			);
		}

		const removedWorktrees: string[] = [];
		const retainedDirtyWorktrees: string[] = [];
		const retainedUnexpectedWorktrees: string[] = [];
		for (const worktree of await this.git.listWorktrees(run.repositoryRoot)) {
			const target = resolve(worktree.path);
			if (!runRoots.some((root) => isPathInside(root, target))) {
				continue;
			}
			const expectedHead = expectedWorktreeHeads.get(target);
			if (!expectedHead) {
				continue;
			}
			const status = await this.git.status(target);
			if (status.length > 0) {
				retainedDirtyWorktrees.push(target);
				continue;
			}
			if (worktree.head !== expectedHead) {
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

		const remainingWorktrees = await this.git.listWorktrees(run.repositoryRoot);
		const checkedOutBranches = new Set(
			remainingWorktrees.flatMap((worktree) =>
				worktree.branch ? [worktree.branch] : [],
			),
		);
		const removedBranches: string[] = [];
		const retainedUnexpectedBranches: string[] = [];
		for (const branch of await this.git.listBranches(
			run.repositoryRoot,
			prefix,
		)) {
			if (
				branch.name === run.integrationBranch ||
				checkedOutBranches.has(branch.name)
			) {
				continue;
			}
			const expectedHead = deletableBranchHeads.get(branch.name);
			if (!expectedHead) {
				continue;
			}
			if (branch.head !== expectedHead) {
				retainedUnexpectedBranches.push(branch.name);
				continue;
			}
			try {
				await this.git.deleteBranch(
					run.repositoryRoot,
					branch.name,
					expectedHead,
				);
				removedBranches.push(branch.name);
			} catch {
				retainedUnexpectedBranches.push(branch.name);
			}
		}
		const allRemovedWorktrees = new Set([
			...orphanReport.removedWorktrees,
			...removedWorktrees,
		]);
		const allRemovedBranches = new Set([
			...orphanReport.removedBranches,
			...removedBranches,
		]);
		return {
			removedWorktrees: [...allRemovedWorktrees],
			removedBranches: [...allRemovedBranches],
			retainedDirtyWorktrees: [
				...new Set([
					...orphanReport.retainedDirtyWorktrees,
					...retainedDirtyWorktrees,
				]),
			].filter((path) => !allRemovedWorktrees.has(path)),
			retainedUnexpectedWorktrees: [
				...new Set([
					...orphanReport.retainedUnexpectedWorktrees,
					...retainedUnexpectedWorktrees,
				]),
			].filter((path) => !allRemovedWorktrees.has(path)),
			retainedUnexpectedBranches: [
				...new Set([
					...orphanReport.retainedUnexpectedBranches,
					...retainedUnexpectedBranches,
				]),
			].filter((branch) => !allRemovedBranches.has(branch)),
		};
	}

	async reconcileRunResources(
		run: OrchestrationRun,
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
		const runRoots = await this.canonicalRunRoots(run.id);
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
				retainedPaths.add(await this.canonicalPath(attempt.worktreePath));
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
				retainedPaths.add(await this.canonicalPath(attempt.worktreePath));
			}
		}
		for (const attempt of run.finalValidationAttempts) {
			if (attempt.state === "running" || attempt.state === "failed") {
				retainedPaths.add(await this.canonicalPath(attempt.worktreePath));
			}
		}

		const removedWorktrees: string[] = [];
		const retainedDirtyWorktrees: string[] = [];
		const retainedUnexpectedWorktrees: string[] = [];
		const retainedUnexpectedBranches: string[] = [];
		const scratchPrefix = integrationScratchDirectoryPrefix(
			run.repositoryRoot,
			run.integrationBranch,
		);
		const integrationScratchPrefix = join(
			await this.canonicalPath(dirname(scratchPrefix)),
			basename(scratchPrefix),
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
			const runRoot = runRoots.find((root) => isPathInside(root, target));
			if (!runRoot || retainedPaths.has(target)) {
				continue;
			}
			const fromRunRoot = nodePath.relative(runRoot, target);
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
