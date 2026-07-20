import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitCli } from "../src/git/git.js";
import { GitWorktreeManager } from "../src/git/worktrees.js";

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
