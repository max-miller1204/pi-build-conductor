import { execFile } from "node:child_process";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildConductor } from "../src/conductor.js";
import type { TaskAttempt, TaskDefinition } from "../src/domain/types.js";
import { GitCli } from "../src/git/git.js";
import { GitWorktreeManager } from "../src/git/worktrees.js";
import { RunStore } from "../src/storage/run-store.js";
import { LocalFinalValidator } from "../src/validation/final-validator.js";
import { LocalTaskValidator } from "../src/validation/task-validator.js";
import type {
	SpawnWorkerRequest,
	WorkerBackend,
	WorkerExecution,
	WorkerExecutionOptions,
	WorkerInstance,
} from "../src/workers/backend.js";
import { reviewResult } from "./helpers/review.js";

const execute = promisify(execFile);
const directories: string[] = [];

async function createRepository(): Promise<{
	parent: string;
	repositoryRoot: string;
}> {
	const parent = await mkdtemp(join(tmpdir(), "pi-build-finalization-"));
	directories.push(parent);
	const repositoryRoot = join(parent, "repository");
	await execute("git", ["init", "-b", "main", repositoryRoot]);
	await execute("git", ["config", "user.name", "Test"], {
		cwd: repositoryRoot,
	});
	await execute("git", ["config", "user.email", "test@example.com"], {
		cwd: repositoryRoot,
	});
	await writeFile(join(repositoryRoot, "README.md"), "# Fixture\n", "utf8");
	await execute("git", ["add", "README.md"], { cwd: repositoryRoot });
	await execute("git", ["commit", "-m", "Initial"], { cwd: repositoryRoot });
	return { parent, repositoryRoot };
}

function task(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
	return {
		id: "implementation",
		title: "Implementation",
		description: "Implement the feature",
		dependencies: [],
		acceptanceCriteria: ["Focused checks pass"],
		allowedPaths: ["src/result.txt"],
		validationCommands: [
			{
				command: process.execPath,
				args: ["-e", "require('node:fs').accessSync('src/result.txt')"],
			},
		],
		...overrides,
	};
}

async function allocateTaskWorktree() {
	const { parent, repositoryRoot } = await createRepository();
	const git = new GitCli();
	const repository = await git.inspect(repositoryRoot);
	const worktrees = new GitWorktreeManager(git, join(parent, "worktrees"));
	const integrationBranch = await worktrees.prepareIntegrationBranch(
		repository,
		"run-1",
	);
	const allocation = await worktrees.prepareTaskWorktree({
		repository,
		runId: "run-1",
		taskId: "implementation",
		attemptNumber: 1,
		startPoint: integrationBranch,
	});
	const attempt: TaskAttempt = {
		id: "implementation-1",
		taskId: "implementation",
		number: 1,
		state: "validating",
		branch: allocation.branch,
		worktreePath: allocation.path,
		baseCommit: repository.head,
		startedAt: "2026-01-01T00:00:00.000Z",
	};
	return { allocation, attempt, git, repository, repositoryRoot, worktrees };
}

class WritingWorkers implements WorkerBackend {
	private worker?: WorkerInstance;

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		this.worker = { id: "worker-1", status: "online", cwd: request.cwd };
		return this.worker;
	}

	async list(): Promise<WorkerInstance[]> {
		return this.worker ? [this.worker] : [];
	}

	async status(): Promise<WorkerInstance> {
		if (!this.worker) {
			throw new Error("worker not started");
		}
		return this.worker;
	}

	async sendPrompt(): Promise<void> {}

	async startPrompt(
		_workerId: string,
		prompt: string,
		_options: WorkerExecutionOptions = {},
	): Promise<WorkerExecution> {
		const review = reviewResult(prompt);
		if (review) {
			return { completion: Promise.resolve(review) };
		}
		if (!this.worker) {
			throw new Error("worker not started");
		}
		await mkdir(join(this.worker.cwd, "src"), { recursive: true });
		await writeFile(
			join(this.worker.cwd, "src", "result.txt"),
			"done\n",
			"utf8",
		);
		return { completion: Promise.resolve({ status: "succeeded" }) };
	}

	async stop(): Promise<void> {
		if (this.worker) {
			this.worker.status = "stopped";
		}
	}
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("task validation and conductor-owned commits", () => {
	it("validates an approved diff, creates one commit, and safely removes its worktree", async () => {
		const fixture = await allocateTaskWorktree();
		await mkdir(join(fixture.allocation.path, "src"), { recursive: true });
		await writeFile(
			join(fixture.allocation.path, "src", "result.txt"),
			"done\n",
			"utf8",
		);
		const hookPath = join(
			fixture.repositoryRoot,
			".git",
			"hooks",
			"pre-commit",
		);
		await writeFile(
			hookPath,
			"#!/bin/sh\nprintf 'hook changed\\n' > src/result.txt\nexit 1\n",
			"utf8",
		);
		await chmod(hookPath, 0o755);
		const validator = new LocalTaskValidator(fixture.git);

		const validation = await validator.validate({
			task: task(),
			attempt: fixture.attempt,
		});
		const commit = await fixture.git.commitTaskWork(
			fixture.allocation.path,
			validation.snapshot,
			"build(implementation): Implementation",
		);

		expect(validation.evidence).toMatchObject({
			passed: true,
			changedFiles: [{ path: "src/result.txt", status: "??" }],
		});
		expect(
			(
				await execute("git", ["show", `${commit}:src/result.txt`], {
					cwd: fixture.repositoryRoot,
				})
			).stdout,
		).toBe("done\n");
		await expect(
			fixture.git.verifyTaskCommit(
				fixture.repositoryRoot,
				fixture.allocation.branch,
				commit,
				fixture.repository.head,
			),
		).resolves.toBeUndefined();
		expect(
			await readFile(
				join(fixture.allocation.path, "src", "result.txt"),
				"utf8",
			),
		).toBe("done\n");
		await fixture.worktrees.removeTaskWorktree(
			fixture.repositoryRoot,
			fixture.allocation.path,
		);
		await expect(access(fixture.allocation.path)).rejects.toThrow();
		expect(
			await fixture.git.branchExists(
				fixture.repositoryRoot,
				fixture.allocation.branch,
			),
		).toBe(true);
	});

	it("rejects clean filters that would alter validated bytes", async () => {
		const fixture = await allocateTaskWorktree();
		await mkdir(join(fixture.allocation.path, "src"), { recursive: true });
		await writeFile(
			join(fixture.allocation.path, "src", "result.txt"),
			"done\n",
			"utf8",
		);
		await execute(
			"git",
			["config", "filter.rewrite.clean", "sed 's/done/filtered/'"],
			{ cwd: fixture.repositoryRoot },
		);
		await writeFile(
			join(fixture.repositoryRoot, ".git", "info", "attributes"),
			"src/result.txt filter=rewrite\n",
			"utf8",
		);
		const validation = await new LocalTaskValidator(fixture.git).validate({
			task: task(),
			attempt: fixture.attempt,
		});

		await expect(
			fixture.git.commitTaskWork(
				fixture.allocation.path,
				validation.snapshot,
				"build(implementation): filtered content",
			),
		).rejects.toThrow(/clean filter would alter validated bytes/);
		expect((await fixture.git.inspect(fixture.repositoryRoot)).head).toBe(
			fixture.repository.head,
		);
	});

	it("treats Git pathspec-looking filenames as literal approved paths", async () => {
		const fixture = await allocateTaskWorktree();
		const magicPath = ":(exclude)outside.txt";
		await writeFile(
			join(fixture.allocation.path, magicPath),
			"literal\n",
			"utf8",
		);
		const magicTask = task({
			allowedPaths: [magicPath],
			validationCommands: [
				{
					command: process.execPath,
					args: [
						"-e",
						`require('node:fs').accessSync(${JSON.stringify(magicPath)})`,
					],
				},
			],
		});
		const validation = await new LocalTaskValidator(fixture.git).validate({
			task: magicTask,
			attempt: fixture.attempt,
		});

		await expect(
			fixture.git.commitTaskWork(
				fixture.allocation.path,
				validation.snapshot,
				"build(implementation): literal pathspec",
			),
		).resolves.toEqual(expect.any(String));
		expect(await fixture.git.status(fixture.allocation.path)).toBe("");
	});

	it("rejects out-of-scope changes before running approved commands", async () => {
		const fixture = await allocateTaskWorktree();
		await writeFile(
			join(fixture.allocation.path, "outside.txt"),
			"unsafe\n",
			"utf8",
		);
		const validator = new LocalTaskValidator(fixture.git);

		await expect(
			validator.validate({ task: task(), attempt: fixture.attempt }),
		).rejects.toThrow(/outside its approved scope.*outside\.txt/);
		expect(await fixture.git.inspect(fixture.allocation.path)).toMatchObject({
			head: fixture.repository.head,
			isClean: false,
		});
	});

	it("rejects worker-created commits and validation commands that mutate files", async () => {
		const committed = await allocateTaskWorktree();
		await mkdir(join(committed.allocation.path, "src"), { recursive: true });
		await writeFile(
			join(committed.allocation.path, "src", "result.txt"),
			"done\n",
			"utf8",
		);
		await execute("git", ["add", "--all"], { cwd: committed.allocation.path });
		await execute("git", ["commit", "-m", "Worker commit"], {
			cwd: committed.allocation.path,
		});
		await expect(
			new LocalTaskValidator(committed.git).validate({
				task: task(),
				attempt: committed.attempt,
			}),
		).rejects.toThrow(/HEAD changed/);

		const mutated = await allocateTaskWorktree();
		await mkdir(join(mutated.allocation.path, "src"), { recursive: true });
		await writeFile(
			join(mutated.allocation.path, "src", "result.txt"),
			"before\n",
			"utf8",
		);
		const mutatingTask = task({
			validationCommands: [
				{
					command: process.execPath,
					args: [
						"-e",
						"require('node:fs').appendFileSync('src/result.txt', 'after\\n')",
					],
				},
			],
		});
		await expect(
			new LocalTaskValidator(mutated.git).validate({
				task: mutatingTask,
				attempt: mutated.attempt,
			}),
		).rejects.toMatchObject({
			message: "Validation commands modified the task worktree",
		});
	});

	it("force-kills validation commands that ignore graceful termination", async () => {
		const fixture = await allocateTaskWorktree();
		await mkdir(join(fixture.allocation.path, "src"), { recursive: true });
		await writeFile(
			join(fixture.allocation.path, "src", "result.txt"),
			"done\n",
			"utf8",
		);
		const stubbornTask = task({
			validationCommands: [
				{
					command: process.execPath,
					args: [
						"-e",
						"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
					],
				},
			],
		});
		const started = Date.now();

		await expect(
			new LocalTaskValidator(fixture.git, { commandTimeoutMs: 50 }).validate({
				task: stubbornTask,
				attempt: fixture.attempt,
			}),
		).rejects.toThrow(/timed out/);
		expect(Date.now() - started).toBeLessThan(2_500);
	});

	it("runs the real finalization pipeline without changing the user branch", async () => {
		const { parent, repositoryRoot } = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const store = new RunStore(join(parent, "runs"));
		const worktrees = new GitWorktreeManager(git, join(parent, "worktrees"));
		const conductor = new BuildConductor({
			store,
			git,
			worktrees,
			workers: new WritingWorkers(),
			validator: new LocalTaskValidator(git),
			finalValidator: new LocalFinalValidator(git),
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const run = await conductor.createRun({
			repository,
			handoffPath: join(repositoryRoot, "handoff.md"),
			handoffText: "Implement the feature",
			plan: {
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
				title: "Feature",
				tasks: [task()],
			},
		});

		const launch = await conductor.approveAndLaunch(run, repository);
		const completed = await launch.completion;
		const attempt = completed.attempts[0];
		if (!attempt?.commit) {
			throw new Error("missing finalized attempt commit");
		}

		expect(completed.state).toBe("completed");
		expect(attempt).toMatchObject({
			state: "succeeded",
			baseCommit: repository.head,
			evidence: { passed: true },
		});
		expect(await git.inspect(repositoryRoot)).toMatchObject({
			currentBranch: "main",
			head: repository.head,
			isClean: true,
		});
		await expect(
			git.verifyTaskCommit(
				repositoryRoot,
				attempt.branch,
				attempt.commit,
				attempt.baseCommit,
			),
		).resolves.toBeUndefined();
		await expect(access(attempt.worktreePath)).rejects.toThrow();
		expect((await store.load(run.id)).attempts[0]?.commit).toBe(attempt.commit);
	});

	it("aborts focused validation on cancellation and does not create a commit", async () => {
		const { parent, repositoryRoot } = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const store = new RunStore(join(parent, "runs"));
		const worktrees = new GitWorktreeManager(git, join(parent, "worktrees"));
		const conductor = new BuildConductor({
			store,
			git,
			worktrees,
			workers: new WritingWorkers(),
			validator: new LocalTaskValidator(git),
			finalValidator: new LocalFinalValidator(git),
		});
		const slowTask = task({
			validationCommands: [
				{
					command: process.execPath,
					args: ["-e", "setTimeout(() => {}, 10_000)"],
				},
			],
		});
		const run = await conductor.createRun({
			repository,
			handoffPath: join(repositoryRoot, "handoff.md"),
			handoffText: "Implement the feature",
			plan: {
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
				title: "Feature",
				tasks: [slowTask],
			},
		});
		const launch = await conductor.approveAndLaunch(run, repository);
		await vi.waitFor(async () => {
			expect((await store.load(run.id)).attempts[0]?.state).toBe("validating");
		});

		const cancelled = await conductor.cancelRun(launch.run);
		const completed = await launch.completion;
		const attempt = completed.attempts[0];

		expect(cancelled.state).toBe("cancelled");
		expect(completed.state).toBe("cancelled");
		expect(attempt?.state).toBe("cancelled");
		expect(attempt?.commit).toBeUndefined();
		await expect(access(attempt?.worktreePath ?? "")).resolves.toBeUndefined();
		expect(await git.inspect(attempt?.worktreePath ?? "")).toMatchObject({
			head: repository.head,
			isClean: false,
		});
	});
});
