import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { IntegratedCommitEvidence } from "../src/domain/types.js";
import { GitCli } from "../src/git/git.js";

const execute = promisify(execFile);
const directories: string[] = [];

async function createRepository() {
	const parent = await mkdtemp(join(tmpdir(), "pi-git-history-"));
	directories.push(parent);
	const repositoryRoot = join(parent, "repository");
	await execute("git", ["init", "-b", "main", repositoryRoot]);
	await execute("git", ["config", "user.name", "Test"], {
		cwd: repositoryRoot,
	});
	await execute("git", ["config", "user.email", "test@example.com"], {
		cwd: repositoryRoot,
	});
	await writeFile(join(repositoryRoot, "README.md"), "base\n");
	await execute("git", ["add", "README.md"], { cwd: repositoryRoot });
	await execute("git", ["commit", "-m", "Initial"], { cwd: repositoryRoot });
	const baseCommit = (
		await execute("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
	).stdout.trim();
	return { repositoryRoot, baseCommit };
}

async function commitTree(
	repositoryRoot: string,
	parent: string,
	subject: string,
	extraParent?: string,
): Promise<string> {
	const tree = (
		await execute("git", ["rev-parse", `${parent}^{tree}`], {
			cwd: repositoryRoot,
		})
	).stdout.trim();
	const args = ["commit-tree", tree, "-p", parent];
	if (extraParent) {
		args.push("-p", extraParent);
	}
	args.push("-m", subject);
	return (await execute("git", args, { cwd: repositoryRoot })).stdout.trim();
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("GitCli.verifyMergeReadyHistory", () => {
	it("returns deterministic evidence for the exact linear integration chain", async () => {
		const { repositoryRoot, baseCommit } = await createRepository();
		const first = await commitTree(repositoryRoot, baseCommit, "Task: first");
		const second = await commitTree(repositoryRoot, first, "Repair: review");
		const branch = "conductor/run-1/integration";
		await execute("git", ["update-ref", `refs/heads/${branch}`, second], {
			cwd: repositoryRoot,
		});
		const commits: IntegratedCommitEvidence[] = [
			{
				kind: "task",
				id: "first",
				sourceCommit: first,
				integratedCommit: first,
			},
			{
				kind: "repair",
				id: "repair-1",
				sourceCommit: second,
				integratedCommit: second,
			},
		];

		const evidence = await new GitCli().verifyMergeReadyHistory({
			repositoryRoot,
			integrationBranch: branch,
			integrationHead: second,
			baseBranch: "main",
			baseCommit,
			commits,
			verifiedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(evidence.commits).toEqual([
			{ hash: first, parent: baseCommit, subject: "Task: first" },
			{ hash: second, parent: first, subject: "Repair: review" },
		]);
		expect(evidence.userWorktreeClean).toBe(true);
		expect(evidence.userHead).toBe(baseCommit);
	});

	it("rejects missing, extra, or reordered persisted commits", async () => {
		const { repositoryRoot, baseCommit } = await createRepository();
		const first = await commitTree(repositoryRoot, baseCommit, "First");
		const extra = await commitTree(repositoryRoot, first, "Unexpected");
		const branch = "conductor/run-2/integration";
		await execute("git", ["update-ref", `refs/heads/${branch}`, extra], {
			cwd: repositoryRoot,
		});

		await expect(
			new GitCli().verifyMergeReadyHistory({
				repositoryRoot,
				integrationBranch: branch,
				integrationHead: extra,
				baseBranch: "main",
				baseCommit,
				commits: [
					{
						kind: "task",
						id: "only",
						sourceCommit: "source",
						integratedCommit: first,
					},
				],
				verifiedAt: "2026-01-01T00:00:00.000Z",
			}),
		).rejects.toThrow(/does not match persisted commit order/);
	});

	it("rejects a source commit whose patch does not match its integrated commit", async () => {
		const { repositoryRoot, baseCommit } = await createRepository();
		await execute("git", ["checkout", "-b", "source"], {
			cwd: repositoryRoot,
		});
		await writeFile(join(repositoryRoot, "feature.txt"), "feature\n");
		await execute("git", ["add", "feature.txt"], { cwd: repositoryRoot });
		await execute("git", ["commit", "-m", "Source feature"], {
			cwd: repositoryRoot,
		});
		const source = (
			await execute("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
		).stdout.trim();
		await execute("git", ["checkout", "main"], { cwd: repositoryRoot });
		await execute("git", ["checkout", "-b", "integration-work"], {
			cwd: repositoryRoot,
		});
		await execute("git", ["cherry-pick", source], { cwd: repositoryRoot });
		const integrated = (
			await execute("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
		).stdout.trim();
		const branch = "conductor/run-patch/integration";
		await execute("git", ["update-ref", `refs/heads/${branch}`, integrated], {
			cwd: repositoryRoot,
		});
		await execute("git", ["checkout", "main"], { cwd: repositoryRoot });
		await execute("git", ["checkout", "-b", "wrong-source"], {
			cwd: repositoryRoot,
		});
		await writeFile(join(repositoryRoot, "other.txt"), "other\n");
		await execute("git", ["add", "other.txt"], { cwd: repositoryRoot });
		await execute("git", ["commit", "-m", "Wrong source"], {
			cwd: repositoryRoot,
		});
		const wrongSource = (
			await execute("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
		).stdout.trim();
		await execute("git", ["checkout", "main"], { cwd: repositoryRoot });

		const git = new GitCli();
		await expect(
			git.verifyMergeReadyHistory({
				repositoryRoot,
				integrationBranch: branch,
				integrationHead: integrated,
				baseBranch: "main",
				baseCommit,
				commits: [
					{
						kind: "task",
						id: "feature",
						sourceCommit: wrongSource,
						integratedCommit: integrated,
					},
				],
				verifiedAt: "2026-01-01T00:00:00.000Z",
			}),
		).rejects.toThrow(/does not exactly match source commit/);
		await expect(
			git.verifyMergeReadyHistory({
				repositoryRoot,
				integrationBranch: branch,
				integrationHead: integrated,
				baseBranch: "main",
				baseCommit,
				commits: [
					{
						kind: "task",
						id: "feature",
						sourceCommit: source,
						integratedCommit: integrated,
					},
				],
				verifiedAt: "2026-01-01T00:00:00.000Z",
			}),
		).resolves.toMatchObject({ integrationHead: integrated });
	});

	it("rejects merge commits in the integration range", async () => {
		const { repositoryRoot, baseCommit } = await createRepository();
		const left = await commitTree(repositoryRoot, baseCommit, "Left");
		const right = await commitTree(repositoryRoot, baseCommit, "Right");
		const merge = await commitTree(repositoryRoot, left, "Merge", right);
		const branch = "conductor/run-3/integration";
		await execute("git", ["update-ref", `refs/heads/${branch}`, merge], {
			cwd: repositoryRoot,
		});

		await expect(
			new GitCli().verifyMergeReadyHistory({
				repositoryRoot,
				integrationBranch: branch,
				integrationHead: merge,
				baseBranch: "main",
				baseCommit,
				commits: [
					{
						kind: "task",
						id: "left",
						sourceCommit: "source-1",
						integratedCommit: left,
					},
					{
						kind: "task",
						id: "merge",
						sourceCommit: "source-2",
						integratedCommit: merge,
					},
				],
				verifiedAt: "2026-01-01T00:00:00.000Z",
			}),
		).rejects.toThrow(/not single-parent/);
	});
});
