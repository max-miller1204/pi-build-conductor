import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BuildConductorDependencies,
	BuildConductor as ProductionBuildConductor,
} from "../src/conductor.js";
import { approveRun } from "../src/domain/run.js";
import type { GitClient, RepositoryInfo } from "../src/git/git.js";
import type {
	PrepareTaskWorktreeInput,
	WorktreeManager,
} from "../src/git/worktrees.js";
import { RunStore } from "../src/storage/run-store.js";
import type {
	SpawnWorkerRequest,
	WorkerBackend,
	WorkerExecution,
	WorkerExecutionOptions,
	WorkerExecutionResult,
	WorkerInstance,
} from "../src/workers/backend.js";
import { createFakeFinalizationDependencies } from "./helpers/finalization.js";
import { reviewResult } from "./helpers/review.js";

const directories: string[] = [];

class BuildConductor extends ProductionBuildConductor {
	constructor(
		dependencies: Omit<
			BuildConductorDependencies,
			"git" | "validator" | "finalValidator"
		>,
	) {
		super({ ...dependencies, ...createFakeFinalizationDependencies() });
	}
}

class FakeWorkers implements WorkerBackend {
	readonly calls: Array<{ operation: string; value?: unknown }> = [];
	readonly worker: WorkerInstance = {
		id: "worker-1",
		status: "online",
		cwd: "/worktree",
	};

	constructor(private readonly result?: WorkerExecutionResult) {}

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		this.calls.push({ operation: "spawn", value: request });
		return { ...this.worker, cwd: request.cwd };
	}

	async list(): Promise<WorkerInstance[]> {
		return [this.worker];
	}

	async status(): Promise<WorkerInstance> {
		return this.worker;
	}

	async sendPrompt(workerId: string, prompt: string): Promise<void> {
		this.calls.push({ operation: "prompt", value: { workerId, prompt } });
	}

	startPrompt(
		workerId: string,
		prompt: string,
		options: WorkerExecutionOptions = {},
	): Promise<WorkerExecution> {
		this.calls.push({ operation: "prompt", value: { workerId, prompt } });
		const review = reviewResult(prompt);
		if (review) {
			return Promise.resolve({ completion: Promise.resolve(review) });
		}
		if (this.result) {
			return Promise.resolve({ completion: Promise.resolve(this.result) });
		}
		const completion = new Promise<WorkerExecutionResult>((resolve) => {
			options.signal?.addEventListener(
				"abort",
				() => {
					const reason = options.signal?.reason;
					resolve({
						status: "aborted",
						error: reason instanceof Error ? reason.message : "aborted",
					});
				},
				{ once: true },
			);
		});
		return Promise.resolve({ completion });
	}

	async stop(workerId: string): Promise<void> {
		this.calls.push({ operation: "stop", value: workerId });
	}
}

class SlowStartWorkers extends FakeWorkers {
	override startPrompt(
		workerId: string,
		prompt: string,
		options: WorkerExecutionOptions = {},
	): Promise<WorkerExecution> {
		this.calls.push({ operation: "prompt", value: { workerId, prompt } });
		return new Promise<WorkerExecution>((_resolve, reject) => {
			options.signal?.addEventListener(
				"abort",
				() =>
					reject(
						options.signal?.reason instanceof Error
							? options.signal.reason
							: new Error("aborted"),
					),
				{ once: true },
			);
		});
	}
}

class FakeWorktrees implements WorktreeManager {
	integrationBranch?: string;
	allocationInput?: PrepareTaskWorktreeInput;

	async prepareIntegrationBranch(
		_repository: RepositoryInfo,
		runId: string,
	): Promise<string> {
		this.integrationBranch = `conductor/${runId}/integration`;
		return this.integrationBranch;
	}

	async prepareTaskWorktree(input: PrepareTaskWorktreeInput) {
		this.allocationInput = input;
		return {
			branch: `conductor/${input.runId}/task/${input.taskId}/attempt-${input.attemptNumber}`,
			path: "/worktree",
		};
	}

	finalValidationWorktreePath(runId: string, attemptNumber: number): string {
		return `/final/${runId}/${attemptNumber}`;
	}

	async prepareFinalValidationWorktree(
		_repository: RepositoryInfo,
		runId: string,
		attemptNumber: number,
	): Promise<string> {
		return this.finalValidationWorktreePath(runId, attemptNumber);
	}

	async removeTaskWorktree(): Promise<void> {}
}

class FailOnceWorktrees extends FakeWorktrees {
	removeCalls = 0;

	override async removeTaskWorktree(): Promise<void> {
		this.removeCalls += 1;
		if (this.removeCalls === 1) {
			throw new Error("cleanup failed");
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

const repository: RepositoryInfo = {
	root: "/repo",
	commonDirectory: "/repo/.git",
	currentBranch: "main",
	head: "abc123",
	isClean: true,
};

function createSingleTaskRun(conductor: BuildConductor) {
	return conductor.createRun({
		repository,
		handoffPath: "/repo/handoff.md",
		handoffText: "Implement the feature",
		plan: {
			version: 3,
			finalValidationCommands: [
				{ command: process.execPath, args: ["-e", ""] },
			],
			title: "Feature",
			tasks: [
				{
					id: "implementation",
					title: "Implementation",
					description: "Implement it",
					dependencies: [],
					acceptanceCriteria: ["Tests pass"],
					allowedPaths: ["src/implementation/"],
					validationCommands: [{ command: "npm", args: ["test"] }],
				},
			],
		},
	});
}

describe("BuildConductor vertical slice", () => {
	it("persists worker completion and cleans up the process", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-lifecycle-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new FakeWorkers({ status: "succeeded" });
		const conductor = new BuildConductor({
			store,
			workers,
			worktrees: new FakeWorktrees(),
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const repository: RepositoryInfo = {
			root: "/repo",
			commonDirectory: "/repo/.git",
			currentBranch: "main",
			head: "abc123",
			isClean: true,
		};
		const run = await conductor.createRun({
			repository,
			handoffPath: "/repo/handoff.md",
			handoffText: "Implement the feature",
			plan: {
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
				title: "Feature",
				tasks: [
					{
						id: "implementation",
						title: "Implementation",
						description: "Implement it",
						dependencies: [],
						acceptanceCriteria: ["Tests pass"],
						allowedPaths: ["src/implementation/"],
						validationCommands: [{ command: "npm", args: ["test"] }],
					},
				],
			},
		});

		const result = await conductor.approveAndLaunch(run, repository);
		await (result as typeof result & { completion: Promise<unknown> })
			.completion;

		const completed = await store.load(run.id);
		expect(completed.attempts[0]?.state).toBe("succeeded");
		expect(completed.tasks.implementation?.state).toBe("succeeded");
		expect(workers.calls).toContainEqual({
			operation: "stop",
			value: "worker-1",
		});
	});

	it("reconciles a task integration ref advanced before state persistence", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-integration-recovery-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const finalization = createFakeFinalizationDependencies();
		const integratedCommit = "integrated-source-commit";
		const verifyIntegratedCommit = vi.fn(async () => {});
		const git = {
			...finalization.git,
			async branchExists() {
				return true;
			},
			async branchHead(_repositoryRoot: string, branch: string) {
				return branch.endsWith("/integration")
					? integratedCommit
					: "source-commit";
			},
			verifyIntegratedCommit,
		};
		const conductor = new ProductionBuildConductor({
			store,
			workers: new FakeWorkers(),
			worktrees: new FakeWorktrees(),
			...finalization,
			git,
			now: () => "2026-01-01T01:00:00.000Z",
		});
		const run = await createSingleTaskRun(conductor);
		const approved = approveRun(run, "2026-01-01T00:01:00.000Z");
		const implementation = approved.tasks.implementation;
		if (!implementation) {
			throw new Error("Missing implementation task");
		}
		await store.save({
			...approved,
			tasks: {
				implementation: {
					...implementation,
					state: "succeeded",
					attemptIds: ["implementation-1"],
				},
			},
			attempts: [
				{
					id: "implementation-1",
					taskId: "implementation",
					number: 1,
					state: "succeeded",
					branch: "conductor/run/task/implementation/attempt-1",
					worktreePath: "/worktree",
					baseCommit: approved.baseCommit,
					startedAt: approved.updatedAt,
					finishedAt: approved.updatedAt,
					commit: "source-commit",
					evidence: {
						startedAt: approved.updatedAt,
						finishedAt: approved.updatedAt,
						passed: true,
						changedFiles: [],
						diffHash: "diff",
						checks: [],
					},
				},
			],
		});

		const recovered = await conductor.recoverRun(run.id);

		expect(recovered.state).toBe("integrating");
		expect(recovered.integrationHead).toBe(integratedCommit);
		expect(recovered.tasks.implementation?.integratedCommit).toBe(
			integratedCommit,
		);
		expect(verifyIntegratedCommit).toHaveBeenCalledWith(
			approved.repositoryRoot,
			integratedCommit,
			approved.baseCommit,
			"source-commit",
		);
	});

	it("reuses persisted passing final-validation evidence after restart", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-final-recovery-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const worktrees = new FakeWorktrees();
		const conductor = new BuildConductor({
			store,
			workers: new FakeWorkers({ status: "succeeded" }),
			worktrees,
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const run = await createSingleTaskRun(conductor);
		const launch = await conductor.approveAndLaunch(run, repository);
		const completed = await launch.completion;
		const completedAttempt = completed.finalValidationAttempts.at(-1);
		if (!completedAttempt?.evidence) {
			throw new Error("Missing completed final-validation evidence");
		}
		const { mergeReadyEvidence: _mergeReadyEvidence, ...withoutEvidence } =
			completed;
		await store.save({
			...withoutEvidence,
			state: "reviewed",
			finalValidationAttempts: completed.finalValidationAttempts.map(
				(attempt) =>
					attempt.id === completedAttempt.id
						? {
								...attempt,
								state: "interrupted" as const,
								error: "Conductor restarted after validation",
							}
						: attempt,
			),
		});
		const interrupted = await store.load(run.id);
		const dependencies = createFakeFinalizationDependencies();
		const validate = vi.spyOn(dependencies.finalValidator, "validate");
		const recovering = new ProductionBuildConductor({
			store,
			workers: new FakeWorkers(),
			worktrees,
			...dependencies,
			now: () => "2026-01-01T01:00:00.000Z",
		});

		const resumed = await recovering.resumeAndLaunch(interrupted, repository);
		const recovered = await resumed.completion;

		expect(recovered.state).toBe("completed");
		expect(recovered.finalValidationAttempts).toHaveLength(
			completed.finalValidationAttempts.length,
		);
		expect(validate).not.toHaveBeenCalled();
	});

	it("retains a committed attempt when cleanup fails and recovers it without recommitting", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-cleanup-recovery-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new FakeWorkers({ status: "succeeded" });
		const worktrees = new FailOnceWorktrees();
		const conductor = new BuildConductor({ store, workers, worktrees });
		const run = await createSingleTaskRun(conductor);

		const launch = await conductor.approveAndLaunch(run, repository);
		const failed = await launch.completion;
		expect(failed.state).toBe("failed");
		expect(failed.attempts[0]).toMatchObject({
			state: "validating",
			commit: expect.any(String),
			error: "cleanup failed",
		});

		const recovered = await conductor.recoverRun(run.id);
		expect(recovered.state).toBe("integrating");
		expect(recovered.attempts[0]).toMatchObject({
			state: "succeeded",
			commit: failed.attempts[0]?.commit,
		});
		expect(worktrees.removeCalls).toBe(2);
	});

	it("records worker failures and cleans up the process", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-failure-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new FakeWorkers({
			status: "failed",
			error: "model request failed",
		});
		const conductor = new BuildConductor({
			store,
			workers,
			worktrees: new FakeWorktrees(),
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const run = await createSingleTaskRun(conductor);

		const result = await conductor.approveAndLaunch(run, repository);
		const failed = await result.completion;

		expect(failed.state).toBe("failed");
		expect(failed.tasks.implementation?.state).toBe("failed");
		expect(failed.attempts[0]).toMatchObject({
			state: "failed",
			error: "model request failed",
		});
		expect(workers.calls.at(-1)).toEqual({
			operation: "stop",
			value: "worker-1",
		});
	});

	it("times out a worker and cleans up the process", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-timeout-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new FakeWorkers();
		const conductor = new BuildConductor({
			store,
			workers,
			worktrees: new FakeWorktrees(),
			workerTimeoutMs: 5,
		});
		const run = await createSingleTaskRun(conductor);

		const result = await conductor.approveAndLaunch(run, repository);
		const timedOut = await result.completion;

		expect(timedOut.state).toBe("failed");
		expect(timedOut.attempts[0]?.error).toBe(
			"Worker execution timed out after 5ms",
		);
		expect(workers.calls.filter((call) => call.operation === "stop")).toEqual([
			{ operation: "stop", value: "worker-1" },
		]);
	});

	it("detects terminal worker status when no terminal event arrives", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-status-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new FakeWorkers();
		const conductor = new BuildConductor({
			store,
			workers,
			worktrees: new FakeWorktrees(),
			workerPollIntervalMs: 5,
		});
		const run = await createSingleTaskRun(conductor);
		const result = await conductor.approveAndLaunch(run, repository);
		workers.worker.status = "error";

		const failed = await result.completion;

		expect(failed.state).toBe("failed");
		expect(failed.attempts[0]?.error).toBe(
			"Worker worker-1 entered error status before Pi settled",
		);
		expect(workers.calls.filter((call) => call.operation === "stop")).toEqual([
			{ operation: "stop", value: "worker-1" },
		]);
	});

	it("cancels an active worker and cleans up the process once", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-cancel-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new FakeWorkers();
		const conductor = new BuildConductor({
			store,
			workers,
			worktrees: new FakeWorktrees(),
		});
		const run = await createSingleTaskRun(conductor);
		const result = await conductor.approveAndLaunch(run, repository);

		const cancelled = await conductor.cancelRun(result.run);
		const monitored = await result.completion;

		expect(cancelled.state).toBe("cancelled");
		expect(monitored.state).toBe("cancelled");
		expect(monitored.tasks.implementation?.state).toBe("cancelled");
		expect(monitored.attempts[0]).toMatchObject({
			state: "cancelled",
			error: "Run cancelled",
		});
		expect(workers.calls.filter((call) => call.operation === "stop")).toEqual([
			{ operation: "stop", value: "worker-1" },
		]);
	});

	it("serializes cancellation after a commit that has already started", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-commit-cancel-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new FakeWorkers({ status: "succeeded" });
		const finalization = createFakeFinalizationDependencies();
		let releaseCommit = () => {};
		let markCommitStarted = () => {};
		const commitGate = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		const commitStarted = new Promise<void>((resolve) => {
			markCommitStarted = resolve;
		});
		const git = {
			...finalization.git,
			async commitTaskWork(): Promise<string> {
				markCommitStarted();
				await commitGate;
				return "commit-1";
			},
		} as GitClient;
		const worktrees = new FakeWorktrees();
		const dependencies = {
			store,
			workers,
			worktrees,
			git,
			validator: finalization.validator,
			finalValidator: finalization.finalValidator,
		};
		const conductor = new ProductionBuildConductor(dependencies);
		const cancellingConductor = new ProductionBuildConductor(dependencies);
		const run = await createSingleTaskRun(conductor);
		const launch = await conductor.approveAndLaunch(run, repository);
		await commitStarted;

		const cancellation = cancellingConductor.cancelRun(launch.run);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect((await store.load(run.id)).state).toBe("running");
		releaseCommit();

		const [cancelled, completed] = await Promise.all([
			cancellation,
			launch.completion,
		]);
		expect(cancelled.state).toBe("cancelled");
		expect(completed.state).toBe("cancelled");
		expect(cancelled.attempts[0]).toMatchObject({
			state: "succeeded",
			commit: "commit-1",
		});
		expect(cancelled.tasks.implementation?.integratedCommit).toBeUndefined();
	});

	it("cancels final validation from a separately constructed conductor", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-final-cancel-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new FakeWorkers({ status: "succeeded" });
		const finalization = createFakeFinalizationDependencies();
		let markValidationStarted = () => {};
		const validationStarted = new Promise<void>((resolve) => {
			markValidationStarted = resolve;
		});
		let aborted = false;
		const finalValidator = {
			validate(input: { signal?: AbortSignal }) {
				markValidationStarted();
				return new Promise<never>((_resolve, reject) => {
					input.signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(new Error("Final validation aborted"));
						},
						{ once: true },
					);
				});
			},
		};
		const dependencies = {
			store,
			workers,
			worktrees: new FakeWorktrees(),
			git: finalization.git,
			validator: finalization.validator,
			finalValidator,
			verifyReviewWorktree: finalization.verifyReviewWorktree,
		};
		const conductor = new ProductionBuildConductor(dependencies);
		const cancellingConductor = new ProductionBuildConductor(dependencies);
		const run = await createSingleTaskRun(conductor);
		const launch = await conductor.approveAndLaunch(run, repository);
		await Promise.race([
			validationStarted,
			launch.completion.then((result) => {
				throw new Error(
					`Run ended before final validation: ${result.state}; ${result.finalValidationAttempts.at(-1)?.error ?? result.reviewRounds.at(-1)?.error ?? result.reviewAttempts.find((attempt) => attempt.error)?.error ?? result.repairAttempts.find((attempt) => attempt.error)?.error ?? result.attempts.find((attempt) => attempt.error)?.error ?? "no lifecycle error"}`,
				);
			}),
		]);

		const cancelled = await cancellingConductor.cancelRun(launch.run);
		const completed = await launch.completion;

		expect(aborted).toBe(true);
		expect(cancelled.state).toBe("cancelled");
		expect(completed.state).toBe("cancelled");
		expect(completed.mergeReadyEvidence).toBeUndefined();
	});

	it("re-verifies Git evidence before reporting a completed run on resume", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-completed-resume-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const finalization = createFakeFinalizationDependencies();
		const dependencies = {
			store,
			workers: new FakeWorkers({ status: "succeeded" }),
			worktrees: new FakeWorktrees(),
			git: finalization.git,
			validator: finalization.validator,
			finalValidator: finalization.finalValidator,
			verifyReviewWorktree: finalization.verifyReviewWorktree,
		};
		const conductor = new ProductionBuildConductor(dependencies);
		const run = await createSingleTaskRun(conductor);
		const launch = await conductor.approveAndLaunch(run, repository);
		const completed = await launch.completion;
		if (completed.state !== "completed") {
			throw new Error(
				completed.finalValidationAttempts.at(-1)?.error ??
					completed.reviewRounds.at(-1)?.error ??
					completed.reviewAttempts.find((attempt) => attempt.error)?.error ??
					completed.attempts.find((attempt) => attempt.error)?.error ??
					`Run ended in ${completed.state}`,
			);
		}
		const movedGit = {
			...finalization.git,
			async verifyMergeReadyHistory(): Promise<never> {
				throw new Error("Integration branch moved");
			},
		} as GitClient;
		const recovering = new ProductionBuildConductor({
			...dependencies,
			git: movedGit,
		});

		await expect(recovering.recoverRun(run.id)).rejects.toThrow(
			/Integration branch moved/,
		);
	});

	it("preserves cancellation while a prompt is starting", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-start-cancel-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new SlowStartWorkers();
		const conductor = new BuildConductor({
			store,
			workers,
			worktrees: new FakeWorktrees(),
		});
		const run = await createSingleTaskRun(conductor);

		const launch = conductor.approveAndLaunch(run, repository);
		await vi.waitFor(() => {
			expect(workers.calls.some((call) => call.operation === "prompt")).toBe(
				true,
			);
		});
		const cancelled = await conductor.cancelRun(run);

		await expect(launch).rejects.toThrow("Run cancelled");
		expect(cancelled.state).toBe("cancelled");
		expect((await store.load(run.id)).state).toBe("cancelled");
		expect(workers.calls.filter((call) => call.operation === "stop")).toEqual([
			{ operation: "stop", value: "worker-1" },
		]);
	});

	it("fills the configured worker pool from independent ready tasks", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-concurrency-"),
		);
		directories.push(directory);
		const workers = new FakeWorkers();
		const conductor = new BuildConductor({
			store: new RunStore(directory),
			workers,
			worktrees: new FakeWorktrees(),
		});
		const run = await conductor.createRun({
			repository,
			handoffPath: "/repo/handoff.md",
			handoffText: "Implement independent tasks",
			plan: {
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
				title: "Concurrent work",
				tasks: [
					{
						id: "first",
						title: "First",
						description: "Implement first",
						dependencies: [],
						acceptanceCriteria: ["First works"],
						allowedPaths: ["src/first/"],
						validationCommands: [{ command: "npm", args: ["test"] }],
					},
					{
						id: "second",
						title: "Second",
						description: "Implement second",
						dependencies: [],
						acceptanceCriteria: ["Second works"],
						allowedPaths: ["src/second/"],
						validationCommands: [{ command: "npm", args: ["test"] }],
					},
					{
						id: "third",
						title: "Third",
						description: "Implement third",
						dependencies: [],
						acceptanceCriteria: ["Third works"],
						allowedPaths: ["src/third/"],
						validationCommands: [{ command: "npm", args: ["test"] }],
					},
				],
			},
			maxConcurrentWorkers: 2,
		});

		const result = await conductor.approveAndLaunch(run, repository);

		expect(
			workers.calls.filter((call) => call.operation === "spawn"),
		).toHaveLength(2);
		expect(result.launches.map((launch) => launch.task.id)).toEqual([
			"first",
			"second",
		]);
		await conductor.cancelRun(result.run);
		await result.completion;
	});

	it("rejects stale plan approval before Git or worker side effects", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-stale-approval-"),
		);
		directories.push(directory);
		const workers = new FakeWorkers();
		const worktrees = new FakeWorktrees();
		const conductor = new BuildConductor({
			store: new RunStore(directory),
			workers,
			worktrees,
		});
		const original = await createSingleTaskRun(conductor);
		await conductor.revisePlan(
			original.id,
			{ ...original.plan, title: "Revised" },
			3,
			original.planRevision,
		);

		await expect(
			conductor.approveAndLaunch(original, repository),
		).rejects.toThrow(/Stale plan revision/);
		expect(worktrees.integrationBranch).toBeUndefined();
		expect(workers.calls).toEqual([]);
	});

	it("recovers an awaiting-approval run without Git or worker side effects", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-preapproval-recovery-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new FakeWorkers();
		const list = vi.spyOn(workers, "list");
		const worktrees = new FakeWorktrees();
		const conductor = new BuildConductor({ store, workers, worktrees });
		const run = await createSingleTaskRun(conductor);

		const recovered = await conductor.recoverRun(run.id);

		expect(recovered).toEqual(run);
		expect(list).not.toHaveBeenCalled();
		expect(worktrees.integrationBranch).toBeUndefined();
	});

	it("rejects persisted execution state without approval before recovery side effects", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-unapproved-recovery-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new FakeWorkers();
		const list = vi.spyOn(workers, "list");
		const worktrees = new FakeWorktrees();
		const conductor = new BuildConductor({ store, workers, worktrees });
		const run = await createSingleTaskRun(conductor);
		await writeFile(
			join(directory, `${run.id}.json`),
			`${JSON.stringify({ ...run, state: "running" }, null, 2)}\n`,
			"utf8",
		);

		await expect(conductor.recoverRun(run.id)).rejects.toThrow(
			/Failed to load run/,
		);
		expect(list).not.toHaveBeenCalled();
		expect(worktrees.integrationBranch).toBeUndefined();
	});

	it("launches one worker with the selected model", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-service-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new FakeWorkers();
		const worktrees = new FakeWorktrees();
		const conductor = new BuildConductor({
			store,
			workers,
			worktrees,
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const repository: RepositoryInfo = {
			root: "/repo",
			commonDirectory: "/repo/.git",
			currentBranch: "main",
			head: "abc123",
			isClean: true,
		};
		const run = await conductor.createRun({
			repository,
			handoffPath: "/repo/handoff.md",
			handoffText: "Implement the feature",
			plan: {
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
				title: "Feature",
				tasks: [
					{
						id: "implementation",
						title: "Implementation",
						description: "Implement it",
						dependencies: [],
						acceptanceCriteria: ["Tests pass"],
						allowedPaths: ["src/implementation/"],
						validationCommands: [{ command: "npm", args: ["test"] }],
					},
				],
			},
		});

		const result = await conductor.approveAndLaunch(run, repository, {
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});

		const launch = result.launches[0];
		expect(result.run.state).toBe("running");
		expect(result.run.tasks.implementation?.state).toBe("running");
		expect(launch?.attempt).toMatchObject({
			state: "running",
			workerId: "worker-1",
			worktreePath: "/worktree",
		});
		expect(worktrees.allocationInput?.startPoint).toBe(repository.head);
		expect(workers.calls[0]).toEqual({
			operation: "spawn",
			value: {
				cwd: "/worktree",
				label: `pi-build-conductor:${run.id}:${launch?.attempt.id}:implementation`,
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			},
		});
		expect(workers.calls[1]).toMatchObject({ operation: "prompt" });
		expect(await store.load(run.id)).toEqual(result.run);
		await conductor.cancelRun(result.run);
		await result.completion;
	});
});
