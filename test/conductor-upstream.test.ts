import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
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
	WorkerInstance,
} from "../src/workers/backend.js";
import { OfficialOrchestratorBackend } from "../src/workers/orchestrator-backend.js";
import { reviewResult } from "./helpers/review.js";

const execute = promisify(execFile);
const socketPath = process.env.PI_ORCHESTRATOR_SMOKE_SOCKET;
const directories: string[] = [];
const backends: HybridOrchestratorWorkers[] = [];

class HybridOrchestratorWorkers implements WorkerBackend {
	readonly realPromptEvents: string[] = [];
	private readonly synthetic = new Map<string, WorkerInstance>();
	private readonly realWorkerIds = new Set<string>();
	private nextSyntheticWorker = 1;

	constructor(private readonly official: OfficialOrchestratorBackend) {}

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		if (request.label?.includes(":review-")) {
			const worker: WorkerInstance = {
				id: `synthetic-review-${this.nextSyntheticWorker++}`,
				status: "online",
				cwd: request.cwd,
				label: request.label,
			};
			this.synthetic.set(worker.id, worker);
			return worker;
		}
		const worker = await this.official.spawn(request);
		this.realWorkerIds.add(worker.id);
		return worker;
	}

	async list(): Promise<WorkerInstance[]> {
		return [...(await this.official.list()), ...this.synthetic.values()];
	}

	async status(workerId: string): Promise<WorkerInstance> {
		const synthetic = this.synthetic.get(workerId);
		return synthetic ?? this.official.status(workerId);
	}

	async sendPrompt(workerId: string, prompt: string): Promise<void> {
		if (!this.synthetic.has(workerId)) {
			await this.official.sendPrompt(workerId, prompt);
		}
	}

	async startPrompt(
		workerId: string,
		prompt: string,
		options: WorkerExecutionOptions = {},
	): Promise<WorkerExecution> {
		if (this.synthetic.has(workerId)) {
			const result = reviewResult(prompt);
			if (!result) {
				throw new Error(
					`Synthetic worker ${workerId} received a non-review prompt`,
				);
			}
			return { completion: Promise.resolve(result) };
		}
		return this.official.startPrompt(workerId, prompt, {
			...options,
			onEvent: (event) => {
				this.realPromptEvents.push(event.type);
				options.onEvent?.(event);
			},
		});
	}

	async stop(workerId: string): Promise<void> {
		const synthetic = this.synthetic.get(workerId);
		if (synthetic) {
			synthetic.status = "stopped";
			return;
		}
		try {
			await this.official.stop(workerId);
		} finally {
			this.realWorkerIds.delete(workerId);
		}
	}

	async cleanup(): Promise<void> {
		await Promise.allSettled(
			[...this.realWorkerIds].map((workerId) => this.stop(workerId)),
		);
	}
}

async function createRepository(): Promise<{
	parent: string;
	repositoryRoot: string;
}> {
	const parent = await mkdtemp(join(tmpdir(), "pi-build-upstream-e2e-"));
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

function implementationTask(): TaskDefinition {
	return {
		id: "implementation",
		title: "Create the upstream result",
		description:
			"Create result.txt containing exactly upstream conductor succeeded followed by a newline. Do not modify any other file.",
		dependencies: [],
		acceptanceCriteria: ["result.txt contains the exact requested text"],
		allowedPaths: ["result.txt"],
		validationCommands: [
			{
				command: process.execPath,
				args: [
					"-e",
					"const fs=require('node:fs'); if(fs.readFileSync('result.txt','utf8')!=='upstream conductor succeeded\\n') process.exit(1)",
				],
			},
		],
	};
}

afterEach(async () => {
	await Promise.all(backends.splice(0).map((backend) => backend.cleanup()));
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe.runIf(Boolean(socketPath))("real orchestrator conductor flow", () => {
	it("takes one real Pi worker from task prompt to merge-ready evidence", async () => {
		if (!socketPath) {
			throw new Error("PI_ORCHESTRATOR_SMOKE_SOCKET is required");
		}
		const { parent, repositoryRoot } = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const workers = new HybridOrchestratorWorkers(
			new OfficialOrchestratorBackend({
				socketPath,
				requestTimeoutMs: 60_000,
			}),
		);
		backends.push(workers);
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
			handoffText: "Exercise the complete conductor lifecycle with real Pi.",
			plan: {
				version: 3,
				title: "Real upstream conductor flow",
				tasks: [implementationTask()],
				finalValidationCommands: [
					{
						command: process.execPath,
						args: [
							"-e",
							"const fs=require('node:fs'); if(fs.readFileSync('result.txt','utf8')!=='upstream conductor succeeded\\n') process.exit(1)",
						],
					},
				],
			},
		});

		const completed = await (await conductor.approveAndLaunch(run, repository))
			.completion;

		expect(
			completed.state,
			completed.attempts.find((attempt) => attempt.error)?.error ??
				completed.reviewAttempts.find((attempt) => attempt.error)?.error ??
				completed.finalValidationAttempts.find((attempt) => attempt.error)
					?.error,
		).toBe("completed");
		expect(completed.attempts).toHaveLength(1);
		expect(completed.attempts[0]?.state).toBe("succeeded");
		expect(completed.reviewAttempts).toHaveLength(5);
		expect(
			completed.reviewAttempts.every(
				(attempt) => attempt.state === "succeeded",
			),
		).toBe(true);
		expect(completed.mergeReadyEvidence).toBeDefined();
		expect(workers.realPromptEvents).toContain("agent_started");
		const integrated = await execute(
			"git",
			["show", `${completed.integrationBranch}:result.txt`],
			{ cwd: repositoryRoot },
		);
		expect(integrated.stdout).toBe("upstream conductor succeeded\n");
		expect(await git.inspect(repositoryRoot)).toMatchObject({
			currentBranch: "main",
			head: repository.head,
			isClean: true,
		});
	}, 240_000);

	it("persists a timeout from a real Pi worker and stops it", async () => {
		if (!socketPath) {
			throw new Error("PI_ORCHESTRATOR_SMOKE_SOCKET is required");
		}
		const { parent, repositoryRoot } = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const workers = new HybridOrchestratorWorkers(
			new OfficialOrchestratorBackend({
				socketPath,
				requestTimeoutMs: 60_000,
			}),
		);
		backends.push(workers);
		const store = new RunStore(join(parent, "runs"));
		const conductor = new BuildConductor({
			store,
			git,
			worktrees: new GitWorktreeManager(git, join(parent, "worktrees")),
			workers,
			validator: new LocalTaskValidator(git),
			finalValidator: new LocalFinalValidator(git),
			workerTimeoutMs: 1,
		});
		const run = await conductor.createRun({
			repository,
			handoffPath: join(repositoryRoot, "handoff.md"),
			handoffText: "Exercise a real Pi worker timeout.",
			plan: {
				version: 3,
				title: "Real upstream worker timeout",
				tasks: [implementationTask()],
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
			},
		});

		const launch = await conductor.approveAndLaunch(run, repository);
		const failed = await launch.completion;

		expect(failed.state).toBe("failed");
		expect(failed.tasks.implementation?.state).toBe("failed");
		expect(failed.attempts[0]).toMatchObject({
			state: "failed",
			error: "Worker execution timed out after 1ms",
		});
		expect(failed.reviewAttempts).toHaveLength(0);
		expect(failed.mergeReadyEvidence).toBeUndefined();
		expect((await store.load(run.id)).state).toBe("failed");
		expect(await git.inspect(repositoryRoot)).toMatchObject({
			currentBranch: "main",
			head: repository.head,
			isClean: true,
		});
	}, 240_000);
});
