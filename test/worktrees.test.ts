import { execFile } from "node:child_process";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildRun } from "../src/domain/run.js";
import type { TaskPlan } from "../src/domain/types.js";
import { GitCli, integrationScratchDirectoryPrefix } from "../src/git/git.js";
import { GitWorktreeManager, isPathInside } from "../src/git/worktrees.js";

const execute = promisify(execFile);
const directories: string[] = [];

async function createRepository(): Promise<string> {
	const parent = await mkdtemp(join(tmpdir(), "pi-build-conductor-git-"));
	directories.push(parent);
	const repository = join(parent, "repository");
	await execute("git", ["init", "-b", "main", repository]);
	await execute("git", ["config", "user.name", "Test"], { cwd: repository });
	await execute("git", ["config", "user.email", "test@example.com"], {
		cwd: repository,
	});
	await writeFile(join(repository, "README.md"), "# Fixture\n", "utf8");
	await execute("git", ["add", "README.md"], { cwd: repository });
	await execute("git", ["commit", "-m", "Initial"], { cwd: repository });
	return repository;
}

function createRun(repositoryRoot: string, baseCommit: string) {
	const plan: TaskPlan = {
		version: 3,
		title: "Fixture",
		finalValidationCommands: [{ command: process.execPath, args: ["-e", ""] }],
		tasks: [
			{
				id: "implementation",
				title: "Implementation",
				description: "Implement it",
				dependencies: [],
				acceptanceCriteria: ["Done"],
				allowedPaths: ["src/"],
				validationCommands: [{ command: process.execPath, args: ["-e", ""] }],
			},
		],
	};
	return createBuildRun({
		id: "run-1",
		repositoryRoot,
		baseBranch: "main",
		baseCommit,
		integrationBranch: "conductor/run-1/integration",
		handoff: { sourcePath: "handoff.md", text: "Build it" },
		plan,
		maxConcurrentWorkers: 2,
		now: "2026-01-01T00:00:00.000Z",
	});
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("GitWorktreeManager", () => {
	it("creates isolated branches without checking out the integration branch", async () => {
		const repositoryRoot = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const manager = new GitWorktreeManager(
			git,
			join(repositoryRoot, "..", "worktrees"),
		);

		const integrationBranch = await manager.prepareIntegrationBranch(
			repository,
			"run-1",
		);
		const allocation = await manager.prepareTaskWorktree({
			repository,
			runId: "run-1",
			taskId: "implementation",
			attemptNumber: 1,
			startPoint: integrationBranch,
		});

		const [originalWorktree, taskWorktree] = await Promise.all([
			git.inspect(repositoryRoot),
			git.inspect(allocation.path),
		]);
		expect(integrationBranch).toBe("conductor/run-1/integration");
		expect(allocation.branch).toBe(
			"conductor/run-1/task/implementation/attempt-1",
		);
		expect(originalWorktree.currentBranch).toBe("main");
		expect(taskWorktree.currentBranch).toBe(allocation.branch);
	});

	it("supports worktree roots containing spaces and Unicode", async () => {
		const repositoryRoot = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const worktreeRoot = join(repositoryRoot, "..", "conductor worktrees Ω");
		const manager = new GitWorktreeManager(git, worktreeRoot);
		await manager.prepareIntegrationBranch(repository, "run-1");

		const taskWorktree = await manager.prepareTaskWorktree({
			repository,
			runId: "run-1",
			taskId: "implementation",
			attemptNumber: 1,
			startPoint: repository.head,
		});
		const finalWorktree = await manager.prepareFinalValidationWorktree(
			repository,
			"run-1",
			1,
			repository.head,
		);

		expect(taskWorktree.path).toContain("conductor worktrees Ω");
		expect(finalWorktree).toContain("conductor worktrees Ω");
		expect((await git.inspect(taskWorktree.path)).isClean).toBe(true);
		await manager.removeTaskWorktree(repositoryRoot, taskWorktree.path);
		await manager.removeTaskWorktree(repositoryRoot, finalWorktree);
		expect(await git.listWorktrees(repositoryRoot)).toHaveLength(1);
	});

	it("applies Windows path containment without prefix confusion", () => {
		const root = "C:\\conductor\\worktrees\\run-1";

		expect(isPathInside(root, `${root}\\task\\attempt-1`, win32)).toBe(true);
		expect(isPathInside(root, root, win32)).toBe(false);
		expect(
			isPathInside(root, "C:\\conductor\\worktrees\\run-10\\task", win32),
		).toBe(false);
		expect(isPathInside(root, "C:\\conductor\\worktrees\\outside", win32)).toBe(
			false,
		);
		expect(isPathInside(root, "D:\\run-1\\task", win32)).toBe(false);
	});

	it("rejects removal at or outside the conductor worktree root", async () => {
		const repositoryRoot = await createRepository();
		const git = new GitCli();
		const worktreeRoot = join(repositoryRoot, "..", "worktrees");
		const manager = new GitWorktreeManager(git, worktreeRoot);

		await expect(
			manager.removeTaskWorktree(repositoryRoot, worktreeRoot),
		).rejects.toThrow(/outside conductor root/);
		await expect(
			manager.removeTaskWorktree(
				repositoryRoot,
				join(worktreeRoot, "..", "worktrees-other", "run-1"),
			),
		).rejects.toThrow(/outside conductor root/);
		await expect(
			manager.removeTaskWorktree(repositoryRoot, repositoryRoot),
		).rejects.toThrow(/outside conductor root/);
	});

	it("adopts an exact existing allocation after an interrupted create", async () => {
		const repositoryRoot = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const manager = new GitWorktreeManager(
			git,
			join(repositoryRoot, "..", "worktrees"),
		);
		await manager.prepareIntegrationBranch(repository, "run-1");
		const input = {
			repository,
			runId: "run-1",
			taskId: "implementation",
			attemptNumber: 1,
			startPoint: repository.head,
		};

		const first = await manager.prepareTaskWorktree(input);
		const second = await manager.prepareTaskWorktree(input);

		expect(second).toEqual(first);
		expect(await git.listWorktrees(repositoryRoot)).toHaveLength(2);
	});

	it("removes clean orphan worktrees and branches in the run namespace", async () => {
		const repositoryRoot = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const manager = new GitWorktreeManager(
			git,
			join(repositoryRoot, "..", "worktrees"),
		);
		await manager.prepareIntegrationBranch(repository, "run-1");
		const orphan = await manager.prepareTaskWorktree({
			repository,
			runId: "run-1",
			taskId: "orphan",
			attemptNumber: 1,
			startPoint: repository.head,
		});

		const report = await manager.reconcileRunResources(
			createRun(repositoryRoot, repository.head),
		);

		expect(report.removedWorktrees).toEqual([orphan.path]);
		expect(report.removedBranches).toEqual([orphan.branch]);
		await expect(lstat(orphan.path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await git.branchExists(repositoryRoot, orphan.branch)).toBe(false);
	});

	it("removes integration scratch worktrees left by a crash", async () => {
		const repositoryRoot = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const manager = new GitWorktreeManager(
			git,
			join(repositoryRoot, "..", "worktrees"),
		);
		const integrationBranch = await manager.prepareIntegrationBranch(
			repository,
			"run-1",
		);
		const temporaryRoot = await mkdtemp(
			integrationScratchDirectoryPrefix(repositoryRoot, integrationBranch),
		);
		const scratchWorktree = join(temporaryRoot, "worktree");
		await git.addDetachedWorktree(
			repositoryRoot,
			scratchWorktree,
			repository.head,
		);

		const report = await manager.reconcileRunResources(
			createRun(repositoryRoot, repository.head),
		);

		expect(report.removedWorktrees).toContain(scratchWorktree);
		await expect(lstat(temporaryRoot)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("retains dirty orphan worktrees for manual inspection", async () => {
		const repositoryRoot = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const manager = new GitWorktreeManager(
			git,
			join(repositoryRoot, "..", "worktrees"),
		);
		await manager.prepareIntegrationBranch(repository, "run-1");
		const orphan = await manager.prepareTaskWorktree({
			repository,
			runId: "run-1",
			taskId: "orphan",
			attemptNumber: 1,
			startPoint: repository.head,
		});
		await writeFile(join(orphan.path, "untracked.txt"), "retain", "utf8");

		const report = await manager.reconcileRunResources(
			createRun(repositoryRoot, repository.head),
		);

		expect(report.retainedDirtyWorktrees).toEqual([orphan.path]);
		expect(report.removedWorktrees).toEqual([]);
		expect(await git.branchExists(repositoryRoot, orphan.branch)).toBe(true);
	});

	it("retains clean orphan worktrees whose branch contains unique commits", async () => {
		const repositoryRoot = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const manager = new GitWorktreeManager(
			git,
			join(repositoryRoot, "..", "worktrees"),
		);
		await manager.prepareIntegrationBranch(repository, "run-1");
		const orphan = await manager.prepareTaskWorktree({
			repository,
			runId: "run-1",
			taskId: "orphan",
			attemptNumber: 1,
			startPoint: repository.head,
		});
		await writeFile(join(orphan.path, "committed.txt"), "retain", "utf8");
		await execute("git", ["add", "committed.txt"], { cwd: orphan.path });
		await execute("git", ["commit", "-m", "Unique orphan work"], {
			cwd: orphan.path,
		});

		const report = await manager.reconcileRunResources(
			createRun(repositoryRoot, repository.head),
		);

		expect(report.retainedUnexpectedWorktrees).toEqual([orphan.path]);
		expect(report.removedWorktrees).toEqual([]);
		expect(await git.branchExists(repositoryRoot, orphan.branch)).toBe(true);
		expect((await git.inspect(orphan.path)).isClean).toBe(true);
	});

	it("retains detached final-validation worktrees with unexpected commits", async () => {
		const repositoryRoot = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const manager = new GitWorktreeManager(
			git,
			join(repositoryRoot, "..", "worktrees"),
		);
		await manager.prepareIntegrationBranch(repository, "run-1");
		const path = await manager.prepareFinalValidationWorktree(
			repository,
			"run-1",
			1,
			repository.head,
		);
		await writeFile(join(path, "committed.txt"), "retain", "utf8");
		await execute("git", ["add", "committed.txt"], { cwd: path });
		await execute("git", ["commit", "-m", "Unexpected validation commit"], {
			cwd: path,
		});

		const report = await manager.reconcileRunResources(
			createRun(repositoryRoot, repository.head),
		);

		expect(report.retainedUnexpectedWorktrees).toEqual([path]);
		expect((await git.inspect(path)).isClean).toBe(true);
	});

	it("explicitly prunes clean terminal attempt resources", async () => {
		const repositoryRoot = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const manager = new GitWorktreeManager(
			git,
			join(repositoryRoot, "..", "worktrees"),
		);
		await manager.prepareIntegrationBranch(repository, "run-1");
		const allocation = await manager.prepareTaskWorktree({
			repository,
			runId: "run-1",
			taskId: "implementation",
			attemptNumber: 1,
			startPoint: repository.head,
		});
		const run = createRun(repositoryRoot, repository.head);
		const task = run.tasks.implementation;
		if (!task) {
			throw new Error("Missing task fixture");
		}
		run.state = "failed";
		run.tasks.implementation = {
			...task,
			state: "failed",
			attemptIds: ["implementation-1"],
		};
		run.attempts = [
			{
				id: "implementation-1",
				taskId: "implementation",
				number: 1,
				state: "failed",
				branch: allocation.branch,
				worktreePath: allocation.path,
				baseCommit: repository.head,
				startedAt: run.createdAt,
				finishedAt: run.updatedAt,
				error: "worker failed",
			},
		];

		const report = await manager.pruneRunResources(run);

		expect(report.removedWorktrees).toEqual([allocation.path]);
		expect(report.removedBranches).toEqual([allocation.branch]);
		expect(await git.branchExists(repositoryRoot, run.integrationBranch)).toBe(
			true,
		);
		expect(await git.branchExists(repositoryRoot, allocation.branch)).toBe(
			false,
		);
		await expect(lstat(allocation.path)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(await manager.pruneRunResources(run)).toMatchObject({
			removedWorktrees: [],
			removedBranches: [],
		});
	});

	it("retains dirty terminal attempt resources during explicit pruning", async () => {
		const repositoryRoot = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const manager = new GitWorktreeManager(
			git,
			join(repositoryRoot, "..", "worktrees"),
		);
		await manager.prepareIntegrationBranch(repository, "run-1");
		const allocation = await manager.prepareTaskWorktree({
			repository,
			runId: "run-1",
			taskId: "implementation",
			attemptNumber: 1,
			startPoint: repository.head,
		});
		await writeFile(
			join(allocation.path, "worker-output.txt"),
			"retain",
			"utf8",
		);
		const run = createRun(repositoryRoot, repository.head);
		run.state = "cancelled";
		run.attempts = [
			{
				id: "implementation-1",
				taskId: "implementation",
				number: 1,
				state: "cancelled",
				branch: allocation.branch,
				worktreePath: allocation.path,
				baseCommit: repository.head,
				startedAt: run.createdAt,
				finishedAt: run.updatedAt,
			},
		];

		const report = await manager.pruneRunResources(run);

		expect(report.retainedDirtyWorktrees).toEqual([allocation.path]);
		expect(report.removedWorktrees).toEqual([]);
		expect(await git.branchExists(repositoryRoot, allocation.branch)).toBe(
			true,
		);
	});

	it("creates and safely removes a detached final validation worktree", async () => {
		const repositoryRoot = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const manager = new GitWorktreeManager(
			git,
			join(repositoryRoot, "..", "worktrees"),
		);
		const path = await manager.prepareFinalValidationWorktree(
			repository,
			"run-1",
			1,
			repository.head,
		);

		await git.verifyDetachedWorktree(path, repository.head);
		expect((await git.inspect(path)).currentBranch).toBe("HEAD");
		await manager.removeTaskWorktree(repositoryRoot, path);
		await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await git.inspect(repositoryRoot)).currentBranch).toBe("main");
	});

	it("refuses to start from a dirty worktree", async () => {
		const repositoryRoot = await createRepository();
		await writeFile(join(repositoryRoot, "untracked.txt"), "dirty", "utf8");
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const manager = new GitWorktreeManager(
			git,
			join(repositoryRoot, "..", "worktrees"),
		);

		await expect(
			manager.prepareIntegrationBranch(repository, "run-1"),
		).rejects.toThrow(/must be clean/);
	});

	it("refuses stale repository metadata before creating a branch", async () => {
		const repositoryRoot = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		await writeFile(join(repositoryRoot, "change.txt"), "new commit", "utf8");
		await execute("git", ["add", "change.txt"], { cwd: repositoryRoot });
		await execute("git", ["commit", "-m", "Change"], { cwd: repositoryRoot });
		const manager = new GitWorktreeManager(
			git,
			join(repositoryRoot, "..", "worktrees"),
		);

		await expect(
			manager.prepareIntegrationBranch(repository, "run-1"),
		).rejects.toThrow(/repository changed/);
	});
});
