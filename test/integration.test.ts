import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildConductor } from "../src/conductor.js";
import type { TaskDefinition } from "../src/domain/types.js";
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
	WorkerExecutionResult,
	WorkerInstance,
} from "../src/workers/backend.js";
import { reviewResult } from "./helpers/review.js";

const execute = promisify(execFile);
const directories: string[] = [];

async function createRepository(): Promise<{
	parent: string;
	repositoryRoot: string;
}> {
	const parent = await mkdtemp(join(tmpdir(), "pi-build-integration-"));
	directories.push(parent);
	const repositoryRoot = join(parent, "repository");
	await execute("git", ["init", "-b", "main", repositoryRoot]);
	await execute("git", ["config", "user.name", "Test"], {
		cwd: repositoryRoot,
	});
	await execute("git", ["config", "user.email", "test@example.com"], {
		cwd: repositoryRoot,
	});
	await writeFile(join(repositoryRoot, "shared.txt"), "base\n", "utf8");
	await execute("git", ["add", "shared.txt"], { cwd: repositoryRoot });
	await execute("git", ["commit", "-m", "Initial"], { cwd: repositoryRoot });
	return { parent, repositoryRoot };
}

function task(
	id: string,
	dependencies: string[],
	allowedPaths: string[],
	validationScript: string,
): TaskDefinition {
	return {
		id,
		title: id,
		description: `Implement ${id}`,
		dependencies,
		acceptanceCriteria: [`${id} works`],
		allowedPaths,
		validationCommands: [
			{ command: process.execPath, args: ["-e", validationScript] },
		],
	};
}

class WritingWorkers implements WorkerBackend {
	private readonly workers = new Map<string, WorkerInstance>();
	private nextWorker = 1;

	constructor(
		private readonly writeTask: (taskId: string, cwd: string) => Promise<void>,
	) {}

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		const worker: WorkerInstance = {
			id: `worker-${this.nextWorker++}`,
			status: "online",
			cwd: request.cwd,
			...(request.label ? { label: request.label } : {}),
		};
		this.workers.set(worker.id, worker);
		return worker;
	}

	async list(): Promise<WorkerInstance[]> {
		return [...this.workers.values()];
	}

	async status(workerId: string): Promise<WorkerInstance> {
		const worker = this.workers.get(workerId);
		if (!worker) {
			throw new Error(`Unknown worker ${workerId}`);
		}
		return worker;
	}

	async sendPrompt(): Promise<void> {}

	async startPrompt(
		workerId: string,
		prompt: string,
		_options: WorkerExecutionOptions = {},
	): Promise<WorkerExecution> {
		const review = reviewResult(prompt);
		if (review) {
			return { completion: Promise.resolve(review) };
		}
		const worker = await this.status(workerId);
		const taskId = worker.label?.split(":").at(-1);
		if (!taskId) {
			throw new Error(`Worker ${workerId} has no task label`);
		}
		const completion = this.writeTask(taskId, worker.cwd).then(
			(): WorkerExecutionResult => ({ status: "succeeded" }),
			(error: unknown): WorkerExecutionResult => ({
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		return { completion };
	}

	async stop(workerId: string): Promise<void> {
		const worker = await this.status(workerId);
		worker.status = "stopped";
	}
}

async function showFile(
	repositoryRoot: string,
	branch: string,
	path: string,
): Promise<string> {
	return (
		await execute("git", ["show", `${branch}:${path}`], { cwd: repositoryRoot })
	).stdout;
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("sequential task integration", () => {
	it("lands dependency commits in order and bases dependents on the refreshed integration head", async () => {
		const { parent, repositoryRoot } = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const workers = new WritingWorkers(async (taskId, cwd) => {
			await mkdir(join(cwd, "src"), { recursive: true });
			if (taskId === "foundation") {
				await writeFile(join(cwd, "src", "foundation.txt"), "foundation\n");
				return;
			}
			const foundation = await readFile(
				join(cwd, "src", "foundation.txt"),
				"utf8",
			);
			await writeFile(
				join(cwd, "src", "dependent.txt"),
				`dependent sees ${foundation}`,
			);
		});
		const conductor = new BuildConductor({
			store: new RunStore(join(parent, "runs")),
			git,
			worktrees: new GitWorktreeManager(git, join(parent, "worktrees")),
			workers,
			validator: new LocalTaskValidator(git),
			finalValidator: new LocalFinalValidator(git),
		});
		const run = await conductor.createRun({
			repository,
			handoffPath: join(repositoryRoot, "handoff.md"),
			handoffText: "Build in dependency order",
			plan: {
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
				title: "Sequential integration",
				tasks: [
					task(
						"foundation",
						[],
						["src/foundation.txt"],
						"require('node:fs').accessSync('src/foundation.txt')",
					),
					task(
						"dependent",
						["foundation"],
						["src/dependent.txt"],
						"const fs=require('node:fs'); fs.accessSync('src/foundation.txt'); fs.accessSync('src/dependent.txt')",
					),
				],
			},
		});

		const completed = await (await conductor.approveAndLaunch(run, repository))
			.completion;
		const foundationAttempt = completed.attempts.find(
			(attempt) => attempt.taskId === "foundation",
		);
		const dependentAttempt = completed.attempts.find(
			(attempt) => attempt.taskId === "dependent",
		);

		expect(
			completed.state,
			completed.finalValidationAttempts.at(-1)?.error,
		).toBe("completed");
		expect(completed.tasks.foundation?.integratedCommit).toBeTruthy();
		expect(completed.tasks.dependent?.integratedCommit).toBeTruthy();
		expect(foundationAttempt?.baseCommit).toBe(repository.head);
		expect(dependentAttempt?.baseCommit).toBe(
			completed.tasks.foundation?.integratedCommit,
		);
		expect(
			await showFile(
				repositoryRoot,
				completed.integrationBranch,
				"src/dependent.txt",
			),
		).toBe("dependent sees foundation\n");
		expect(await git.inspect(repositoryRoot)).toMatchObject({
			currentBranch: "main",
			head: repository.head,
			isClean: true,
		});
	});

	it("integrates independent tasks in plan order after they finish in reverse order", async () => {
		const { parent, repositoryRoot } = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		let releaseFirst = () => {};
		let releaseSecond = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const workers = new WritingWorkers(async (taskId, cwd) => {
			await (taskId === "first" ? firstGate : secondGate);
			await mkdir(join(cwd, "src"), { recursive: true });
			await writeFile(join(cwd, "src", `${taskId}.txt`), `${taskId}\n`);
		});
		const store = new RunStore(join(parent, "runs"));
		const conductor = new BuildConductor({
			store,
			git,
			worktrees: new GitWorktreeManager(git, join(parent, "worktrees")),
			workers,
			validator: new LocalTaskValidator(git),
			finalValidator: new LocalFinalValidator(git),
		});
		const run = await conductor.createRun({
			repository,
			handoffPath: join(repositoryRoot, "handoff.md"),
			handoffText: "Integrate deterministically",
			plan: {
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
				title: "Deterministic integration",
				tasks: [
					task("first", [], ["src/first.txt"], ""),
					task("second", [], ["src/second.txt"], ""),
				],
			},
		});

		const launch = await conductor.approveAndLaunch(run, repository);
		releaseSecond();
		await vi.waitFor(async () => {
			expect((await store.load(run.id)).tasks.second?.state).toBe("succeeded");
		});
		expect(await git.branchHead(repositoryRoot, run.integrationBranch)).toBe(
			repository.head,
		);
		releaseFirst();
		const completed = await launch.completion;
		const subjects = (
			await execute(
				"git",
				[
					"log",
					"--reverse",
					"--format=%s",
					`${repository.head}..${completed.integrationBranch}`,
				],
				{ cwd: repositoryRoot },
			)
		).stdout
			.trim()
			.split("\n");

		expect(subjects).toEqual(["build(first): first", "build(second): second"]);
		expect(await git.inspect(repositoryRoot)).toMatchObject({
			currentBranch: "main",
			head: repository.head,
			isClean: true,
		});
	});

	it("leaves the integration branch at the last good commit when a cherry-pick conflicts", async () => {
		const { parent, repositoryRoot } = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const workers = new WritingWorkers(async (taskId, cwd) => {
			await writeFile(join(cwd, "shared.txt"), `${taskId}\n`, "utf8");
		});
		const conductor = new BuildConductor({
			store: new RunStore(join(parent, "runs")),
			git,
			worktrees: new GitWorktreeManager(git, join(parent, "worktrees")),
			workers,
			validator: new LocalTaskValidator(git),
			finalValidator: new LocalFinalValidator(git),
		});
		const run = await conductor.createRun({
			repository,
			handoffPath: join(repositoryRoot, "handoff.md"),
			handoffText: "Create conflicting independent changes",
			plan: {
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
				title: "Conflict safety",
				tasks: [
					task("first", [], ["shared.txt"], ""),
					task("second", [], ["shared.txt"], ""),
				],
			},
		});

		const completed = await (await conductor.approveAndLaunch(run, repository))
			.completion;

		expect(completed.state).toBe("failed");
		expect(completed.tasks.first?.integratedCommit).toBeTruthy();
		expect(completed.tasks.second).toMatchObject({
			state: "failed",
			integrationError: expect.stringMatching(/cherry-pick|conflict/i),
		});
		expect(completed.attempts.map((attempt) => attempt.state)).toEqual([
			"succeeded",
			"succeeded",
		]);
		expect(
			await showFile(repositoryRoot, completed.integrationBranch, "shared.txt"),
		).toBe("first\n");
		expect(await git.inspect(repositoryRoot)).toMatchObject({
			currentBranch: "main",
			head: repository.head,
			isClean: true,
		});
	});
});
