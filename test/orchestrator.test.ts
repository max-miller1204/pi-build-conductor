import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveRun } from "../src/domain/run.js";
import type {
	BlockedWorkerPolicy,
	WorkerLaunchPolicy,
	WorkerUiRequest,
	WorkerUiResponse,
} from "../src/domain/types.js";
import type { GitClient, RepositoryInfo } from "../src/git/git.js";
import type {
	PrepareTaskWorktreeInput,
	WorktreeManager,
} from "../src/git/worktrees.js";
import {
	type OrchestratorDependencies,
	Orchestrator as ProductionOrchestrator,
} from "../src/orchestrator.js";
import { blockedWorkerResponse } from "../src/security/policy.js";
import { AttemptLogStore } from "../src/storage/attempt-log-store.js";
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
import { waitForOrchestration } from "./helpers/wait.js";

const directories: string[] = [];

class Orchestrator extends ProductionOrchestrator {
	constructor(
		dependencies: Omit<
			OrchestratorDependencies,
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

class UnsupportedPolicyWorkers extends FakeWorkers {
	async preflightPolicy(policy: WorkerLaunchPolicy): Promise<void> {
		this.calls.push({ operation: "preflight", value: policy });
		throw new Error("worker launch policy v1 is unsupported");
	}
}

class UiPromptWorkers extends FakeWorkers {
	readonly responses: WorkerUiResponse[] = [];
	readonly request: WorkerUiRequest = {
		id: "ui-request-1",
		method: "confirm",
		title: "Allow privileged action?",
		message: "The worker requested permission",
	};

	constructor(private readonly holdResponse = false) {
		super();
	}

	override startPrompt(
		workerId: string,
		prompt: string,
		options: WorkerExecutionOptions = {},
	): Promise<WorkerExecution> {
		const review = reviewResult(prompt);
		if (review) {
			return Promise.resolve({ completion: Promise.resolve(review) });
		}
		this.calls.push({ operation: "prompt", value: { workerId, prompt } });
		let settled = false;
		const completion = new Promise<WorkerExecutionResult>((resolve) => {
			const settle = (result: WorkerExecutionResult) => {
				if (settled) {
					return;
				}
				settled = true;
				resolve(result);
			};
			options.onEvent?.({
				type: "ui_blocked",
				requestId: this.request.id,
				method: this.request.method,
			});
			const handling = options.onUiRequest?.(this.request, async (response) => {
				if (this.holdResponse) {
					await new Promise<void>((_resolve, reject) => {
						options.signal?.addEventListener(
							"abort",
							() => reject(new Error("response stream aborted")),
							{ once: true },
						);
					});
				}
				this.responses.push(response);
				options.onEvent?.({
					type: "ui_resolved",
					requestId: this.request.id,
					method: this.request.method,
					outcome: response.kind === "confirmation" ? "declined" : "cancelled",
				});
			});
			void Promise.resolve(handling).then(
				() => settle({ status: "succeeded" }),
				(error: unknown) =>
					settle({
						status: options.signal?.aborted ? "aborted" : "failed",
						error: error instanceof Error ? error.message : String(error),
					}),
			);
			options.signal?.addEventListener(
				"abort",
				() => {
					options.onEvent?.({
						type: "ui_resolved",
						requestId: this.request.id,
						method: this.request.method,
						outcome: "execution_aborted",
					});
					const reason = options.signal?.reason;
					settle({
						status: "aborted",
						error: reason instanceof Error ? reason.message : "aborted",
					});
				},
				{ once: true },
			);
		});
		return Promise.resolve({ completion });
	}
}

class ConcurrentUiPromptWorkers extends FakeWorkers {
	readonly responses: Array<{ requestId: string; response: WorkerUiResponse }> =
		[];
	private releaseSecond: (() => void) | undefined;

	hasPendingSecondResponse(): boolean {
		return this.releaseSecond !== undefined;
	}

	releaseSecondResponse(): void {
		this.releaseSecond?.();
	}

	override startPrompt(
		workerId: string,
		prompt: string,
		options: WorkerExecutionOptions = {},
	): Promise<WorkerExecution> {
		const review = reviewResult(prompt);
		if (review) {
			return Promise.resolve({ completion: Promise.resolve(review) });
		}
		this.calls.push({ operation: "prompt", value: { workerId, prompt } });
		const requests: WorkerUiRequest[] = [
			{
				id: "ui-request-first",
				method: "confirm",
				title: "First",
				message: "First request",
			},
			{
				id: "ui-request-second",
				method: "input",
				title: "Second",
			},
		];
		const handling = requests.map((request) => {
			options.onEvent?.({
				type: "ui_blocked",
				requestId: request.id,
				method: request.method,
			});
			return options.onUiRequest?.(request, async (response) => {
				if (request.id === "ui-request-second") {
					await new Promise<void>((resolve) => {
						this.releaseSecond = resolve;
					});
				}
				this.responses.push({ requestId: request.id, response });
				options.onEvent?.({
					type: "ui_resolved",
					requestId: request.id,
					method: request.method,
					outcome: response.kind === "confirmation" ? "declined" : "cancelled",
				});
			});
		});
		return Promise.resolve({
			completion: Promise.all(handling).then(
				(): WorkerExecutionResult => ({ status: "succeeded" }),
			),
		});
	}
}

class ProgressWorkers extends FakeWorkers {
	override startPrompt(
		workerId: string,
		prompt: string,
		options: WorkerExecutionOptions = {},
	): Promise<WorkerExecution> {
		options.onEvent?.({ type: "agent_started" });
		options.onEvent?.({ type: "text_delta", text: "working on it" });
		return super.startPrompt(workerId, prompt, options);
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

class RejectingStartWorkers extends FakeWorkers {
	override startPrompt(
		workerId: string,
		prompt: string,
	): Promise<WorkerExecution> {
		this.calls.push({ operation: "prompt", value: { workerId, prompt } });
		return Promise.reject(new Error("server stream failed to start"));
	}
}

class FakeWorktrees implements WorktreeManager {
	integrationBranch?: string;
	allocationInput?: PrepareTaskWorktreeInput;
	prunedRunId?: string;

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

	async prepareReadOnlyWorktree(): Promise<string> {
		throw new Error("read-only worktrees are unused in orchestrator tests");
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

	async pruneRunResources(
		run: import("../src/domain/types.js").OrchestrationRun,
	) {
		this.prunedRunId = run.id;
		return {
			removedWorktrees: ["/worktree"],
			removedBranches: [],
			retainedDirtyWorktrees: [],
			retainedUnexpectedWorktrees: [],
			retainedUnexpectedBranches: [],
		};
	}
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

function createSingleTaskRun(orchestrator: Orchestrator) {
	return orchestrator.createRun({
		repository,
		requestPath: "/repo/request.md",
		requestText: "Implement the feature",
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

describe("Orchestrator vertical slice", () => {
	it("persists worker completion and cleans up the process", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-lifecycle-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new FakeWorkers({ status: "succeeded" });
		const orchestrator = new Orchestrator({
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
		const run = await orchestrator.createRun({
			repository,
			requestPath: "/repo/request.md",
			requestText: "Implement the feature",
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

		const result = await orchestrator.approveAndLaunch(run, repository);
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
		const orchestrator = new ProductionOrchestrator({
			store,
			workers: new FakeWorkers(),
			worktrees: new FakeWorktrees(),
			...finalization,
			git,
			now: () => "2026-01-01T01:00:00.000Z",
		});
		const run = await createSingleTaskRun(orchestrator);
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

		const recovered = await orchestrator.recoverRun(run.id);

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
		const orchestrator = new Orchestrator({
			store,
			workers: new FakeWorkers({ status: "succeeded" }),
			worktrees,
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const run = await createSingleTaskRun(orchestrator);
		const launch = await orchestrator.approveAndLaunch(run, repository);
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
								error: "Orchestrator restarted after validation",
							}
						: attempt,
			),
		});
		const interrupted = await store.load(run.id);
		const dependencies = createFakeFinalizationDependencies();
		const validate = vi.spyOn(dependencies.finalValidator, "validate");
		const recovering = new ProductionOrchestrator({
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
		const orchestrator = new Orchestrator({ store, workers, worktrees });
		const run = await createSingleTaskRun(orchestrator);

		const launch = await orchestrator.approveAndLaunch(run, repository);
		const failed = await launch.completion;
		expect(failed.state).toBe("failed");
		expect(failed.attempts[0]).toMatchObject({
			state: "validating",
			commit: expect.any(String),
			error: "cleanup failed",
		});

		const recovered = await orchestrator.recoverRun(run.id);
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
		const orchestrator = new Orchestrator({
			store,
			workers,
			worktrees: new FakeWorktrees(),
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const run = await createSingleTaskRun(orchestrator);

		const result = await orchestrator.approveAndLaunch(run, repository);
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

	it("persists a launch failure when the server stream cannot start", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-stream-start-failure-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new RejectingStartWorkers();
		const orchestrator = new Orchestrator({
			store,
			workers,
			worktrees: new FakeWorktrees(),
		});
		const run = await createSingleTaskRun(orchestrator);

		const launch = await orchestrator.approveAndLaunch(run, repository);
		const failed = await launch.completion;

		expect(launch.launches).toEqual([]);
		expect(failed.state).toBe("failed");
		expect(failed.tasks.implementation?.state).toBe("failed");
		expect(failed.attempts[0]).toMatchObject({
			state: "failed",
			error: "server stream failed to start",
		});
		expect(workers.calls.filter((call) => call.operation === "stop")).toEqual([
			{ operation: "stop", value: "worker-1" },
		]);
	});

	it.each([
		["decline", { kind: "confirmation", confirmed: false }],
		["cancel", { kind: "cancelled" }],
	] as const)(
		"persists and journals a blocked prompt with the %s policy",
		async (policy, expectedResponse) => {
			const directory = await mkdtemp(
				join(tmpdir(), `pi-build-conductor-ui-${policy}-`),
			);
			directories.push(directory);
			const store = new RunStore(directory);
			const logs = new AttemptLogStore(join(directory, "output"));
			const workers = new UiPromptWorkers();
			const orchestrator = new Orchestrator({
				store,
				workers,
				worktrees: new FakeWorktrees(),
				attemptLogs: logs,
				blockedWorkerPolicy: policy as BlockedWorkerPolicy,
			});
			const run = await createSingleTaskRun(orchestrator);
			const snapshots: import("../src/domain/types.js").OrchestrationRun[] = [];

			const result = await orchestrator.approveAndLaunch(
				run,
				repository,
				undefined,
				{
					onRunUpdated: (updated) => snapshots.push(structuredClone(updated)),
				},
			);
			const completed = await result.completion;
			const attemptId = result.launches[0]?.attempt.id;
			if (!attemptId) {
				throw new Error("Missing launched attempt");
			}
			await logs.flush(run.id, attemptId);
			const entries = await logs.readTail(run.id, attemptId);

			expect(workers.responses[0]).toEqual(expectedResponse);
			expect(
				snapshots.some(
					(snapshot) =>
						snapshot.blockedWorkers[0]?.requestId === "ui-request-1",
				),
			).toBe(true);
			expect(completed.blockedWorkers).toEqual([]);
			expect(JSON.stringify(snapshots)).not.toContain(
				"Allow privileged action?",
			);
			expect(JSON.stringify(entries)).not.toContain(
				"The worker requested permission",
			);
			expect(entries).toContainEqual(
				expect.objectContaining({
					kind: "progress",
					event: expect.objectContaining({
						type: "ui_decision",
						policy,
					}),
				}),
			);
		},
	);

	it("uses the persisted UI policy after orchestrator configuration changes", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-persisted-ui-policy-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const creator = new Orchestrator({
			store,
			workers: new FakeWorkers(),
			worktrees: new FakeWorktrees(),
			blockedWorkerPolicy: "decline",
		});
		const run = await createSingleTaskRun(creator);
		const workers = new UiPromptWorkers();
		const resumedConfiguration = new Orchestrator({
			store,
			workers,
			worktrees: new FakeWorktrees(),
			blockedWorkerPolicy: "cancel",
		});

		const result = await resumedConfiguration.approveAndLaunch(run, repository);
		await result.completion;

		expect(run.securityPolicy.workers.uiPolicy).toBe("decline");
		expect(workers.responses[0]).toEqual({
			kind: "confirmation",
			confirmed: false,
		});
	});

	it("keeps concurrent dialogs blocked until each request resolves", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-concurrent-ui-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new ConcurrentUiPromptWorkers();
		const orchestrator = new Orchestrator({
			store,
			workers,
			worktrees: new FakeWorktrees(),
		});
		const run = await createSingleTaskRun(orchestrator);
		const result = await orchestrator.approveAndLaunch(run, repository);

		await waitForOrchestration(async () => {
			expect(
				(await store.load(run.id)).blockedWorkers.map(
					(blocked) => blocked.requestId,
				),
			).toEqual(["ui-request-second"]);
			expect(workers.hasPendingSecondResponse()).toBe(true);
		});
		workers.releaseSecondResponse();
		const completed = await result.completion;

		expect(completed.blockedWorkers).toEqual([]);
		expect(workers.responses).toHaveLength(2);
		expect(workers.responses).toEqual(
			expect.arrayContaining([
				{
					requestId: "ui-request-first",
					response: { kind: "confirmation", confirmed: false },
				},
				{
					requestId: "ui-request-second",
					response: { kind: "cancelled" },
				},
			]),
		);
	});

	it("times out and recovers scheduling after a worker stays blocked", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-ui-timeout-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const logs = new AttemptLogStore(join(directory, "output"));
		const workers = new UiPromptWorkers(true);
		const orchestrator = new Orchestrator({
			store,
			workers,
			worktrees: new FakeWorktrees(),
			attemptLogs: logs,
			workerTimeoutMs: 250,
		});
		const run = await createSingleTaskRun(orchestrator);
		const result = await orchestrator.approveAndLaunch(run, repository);
		await waitForOrchestration(async () =>
			expect((await store.load(run.id)).blockedWorkers).toHaveLength(1),
		);

		const timedOut = await result.completion;

		expect(timedOut.state).toBe("failed");
		expect(timedOut.blockedWorkers).toEqual([]);
		expect(timedOut.attempts[0]?.error).toBe(
			"Worker execution timed out after 250ms",
		);
		expect(workers.responses).toEqual([]);
	});

	it("clears a blocked prompt when the run is cancelled", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-ui-cancel-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new UiPromptWorkers(true);
		const orchestrator = new Orchestrator({
			store,
			workers,
			worktrees: new FakeWorktrees(),
		});
		const run = await createSingleTaskRun(orchestrator);
		const result = await orchestrator.approveAndLaunch(run, repository);
		await waitForOrchestration(async () =>
			expect((await store.load(run.id)).blockedWorkers).toHaveLength(1),
		);

		const cancelled = await orchestrator.cancelRun(await store.load(run.id));
		const completed = await result.completion;

		expect(cancelled.blockedWorkers).toEqual([]);
		expect(completed.state).toBe("cancelled");
		expect(completed.blockedWorkers).toEqual([]);
		expect(workers.responses).toEqual([]);
	});

	it("maps only conservative blocked-worker responses", () => {
		const request: WorkerUiRequest = {
			id: "request",
			method: "select",
			title: "Choose",
			options: ["unsafe"],
		};
		expect(blockedWorkerResponse("decline", request)).toEqual({
			kind: "cancelled",
		});
		expect(blockedWorkerResponse("cancel", request)).toEqual({
			kind: "cancelled",
		});
	});

	it("times out a worker and cleans up the process", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-timeout-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new FakeWorkers();
		const orchestrator = new Orchestrator({
			store,
			workers,
			worktrees: new FakeWorktrees(),
			workerTimeoutMs: 5,
		});
		const run = await createSingleTaskRun(orchestrator);

		const result = await orchestrator.approveAndLaunch(run, repository);
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
		const orchestrator = new Orchestrator({
			store,
			workers,
			worktrees: new FakeWorktrees(),
			workerPollIntervalMs: 5,
		});
		const run = await createSingleTaskRun(orchestrator);
		const result = await orchestrator.approveAndLaunch(run, repository);
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
		const orchestrator = new Orchestrator({
			store,
			workers,
			worktrees: new FakeWorktrees(),
		});
		const run = await createSingleTaskRun(orchestrator);
		const result = await orchestrator.approveAndLaunch(run, repository);

		const cancelled = await orchestrator.cancelRun(result.run);
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

	it("retries a failed task with a new immutable attempt", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-retry-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const worktrees = new FakeWorktrees();
		const failing = new Orchestrator({
			store,
			workers: new FakeWorkers({ status: "failed", error: "worker failed" }),
			worktrees,
		});
		const run = await createSingleTaskRun(failing);
		const firstLaunch = await failing.approveAndLaunch(run, repository);
		const failed = await firstLaunch.completion;
		expect(failed.state).toBe("failed");
		expect(failed.attempts).toHaveLength(1);

		const retrying = new Orchestrator({
			store,
			workers: new FakeWorkers(),
			worktrees,
		});
		const retry = await retrying.retryAndLaunch(run.id, repository);

		expect(retry.run.attempts).toHaveLength(2);
		expect(retry.run.attempts[0]).toEqual(failed.attempts[0]);
		expect(retry.run.attempts[1]).toMatchObject({
			number: 2,
			state: "running",
		});
		await retrying.cancelRun(retry.run);
		await retry.completion;
	});

	it("persists worker output before the attempt becomes terminal", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-output-"),
		);
		directories.push(directory);
		const store = new RunStore(join(directory, "runs"));
		const attemptLogs = new AttemptLogStore(join(directory, "output"));
		const workers = new ProgressWorkers({
			status: "failed",
			error: "worker failed",
		});
		const orchestrator = new Orchestrator({
			store,
			workers,
			worktrees: new FakeWorktrees(),
			attemptLogs,
		});
		const run = await createSingleTaskRun(orchestrator);

		const launch = await orchestrator.approveAndLaunch(run, repository);
		const failed = await launch.completion;
		const attempt = failed.attempts[0];
		if (!attempt) {
			throw new Error("Missing failed attempt");
		}
		const entries = await attemptLogs.readTail(run.id, attempt.id);

		expect(entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "progress",
					event: { type: "text_delta", text: "working on it" },
				}),
				expect.objectContaining({ kind: "terminal", status: "failed" }),
			]),
		);
	});

	it("prunes terminal run resources through the lifecycle lease", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-prune-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const worktrees = new FakeWorktrees();
		const workers = new FakeWorkers();
		const orchestrator = new Orchestrator({ store, workers, worktrees });
		const run = await createSingleTaskRun(orchestrator);
		await store.transaction(run.id, (current) => ({
			...current,
			state: "cancelled",
			updatedAt: "2026-01-01T00:01:00.000Z",
		}));

		const report = await orchestrator.pruneRunResources(run.id);

		expect(report.removedWorktrees).toEqual(["/worktree"]);
		expect(worktrees.prunedRunId).toBe(run.id);
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
		const orchestrator = new ProductionOrchestrator(dependencies);
		const cancellingOrchestrator = new ProductionOrchestrator(dependencies);
		const run = await createSingleTaskRun(orchestrator);
		const launch = await orchestrator.approveAndLaunch(run, repository);
		await commitStarted;

		const cancellation = cancellingOrchestrator.cancelRun(launch.run);
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

	it("cancels final validation from a separately constructed orchestrator", async () => {
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
		const orchestrator = new ProductionOrchestrator(dependencies);
		const cancellingOrchestrator = new ProductionOrchestrator(dependencies);
		const run = await createSingleTaskRun(orchestrator);
		const launch = await orchestrator.approveAndLaunch(run, repository);
		await Promise.race([
			validationStarted,
			launch.completion.then((result) => {
				throw new Error(
					`Run ended before final validation: ${result.state}; ${result.finalValidationAttempts.at(-1)?.error ?? result.reviewRounds.at(-1)?.error ?? result.reviewAttempts.find((attempt) => attempt.error)?.error ?? result.repairAttempts.find((attempt) => attempt.error)?.error ?? result.attempts.find((attempt) => attempt.error)?.error ?? "no lifecycle error"}`,
				);
			}),
		]);

		const cancelled = await cancellingOrchestrator.cancelRun(launch.run);
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
		const orchestrator = new ProductionOrchestrator(dependencies);
		const run = await createSingleTaskRun(orchestrator);
		const launch = await orchestrator.approveAndLaunch(run, repository);
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
		const recovering = new ProductionOrchestrator({
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
		const orchestrator = new Orchestrator({
			store,
			workers,
			worktrees: new FakeWorktrees(),
		});
		const run = await createSingleTaskRun(orchestrator);

		const launch = orchestrator.approveAndLaunch(run, repository);
		await waitForOrchestration(() => {
			expect(workers.calls.some((call) => call.operation === "prompt")).toBe(
				true,
			);
		});
		const cancelled = await orchestrator.cancelRun(run);

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
		const orchestrator = new Orchestrator({
			store: new RunStore(directory),
			workers,
			worktrees: new FakeWorktrees(),
		});
		const run = await orchestrator.createRun({
			repository,
			requestPath: "/repo/request.md",
			requestText: "Implement independent tasks",
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

		const result = await orchestrator.approveAndLaunch(run, repository);

		expect(
			workers.calls.filter((call) => call.operation === "spawn"),
		).toHaveLength(2);
		expect(result.launches.map((launch) => launch.task.id)).toEqual([
			"first",
			"second",
		]);
		await orchestrator.cancelRun(result.run);
		await result.completion;
	});

	it("rejects an incompatible server before approval or Git side effects", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-policy-preflight-"),
		);
		directories.push(directory);
		const store = new RunStore(directory);
		const workers = new UnsupportedPolicyWorkers();
		const worktrees = new FakeWorktrees();
		const orchestrator = new Orchestrator({ store, workers, worktrees });
		const run = await createSingleTaskRun(orchestrator);

		await expect(
			orchestrator.approveAndLaunch(run, repository),
		).rejects.toThrow(/worker launch policy v1 is unsupported/);

		expect((await store.load(run.id)).state).toBe("awaiting_approval");
		expect(worktrees.integrationBranch).toBeUndefined();
		expect(workers.calls.filter((call) => call.operation === "spawn")).toEqual(
			[],
		);
	});

	it("rejects stale plan approval before Git or worker side effects", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-stale-approval-"),
		);
		directories.push(directory);
		const workers = new FakeWorkers();
		const worktrees = new FakeWorktrees();
		const orchestrator = new Orchestrator({
			store: new RunStore(directory),
			workers,
			worktrees,
		});
		const original = await createSingleTaskRun(orchestrator);
		await orchestrator.revisePlan(
			original.id,
			{ ...original.plan, title: "Revised" },
			3,
			original.planRevision,
		);

		await expect(
			orchestrator.approveAndLaunch(original, repository),
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
		const orchestrator = new Orchestrator({ store, workers, worktrees });
		const run = await createSingleTaskRun(orchestrator);

		const recovered = await orchestrator.recoverRun(run.id);

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
		const orchestrator = new Orchestrator({ store, workers, worktrees });
		const run = await createSingleTaskRun(orchestrator);
		await writeFile(
			join(directory, `${run.id}.json`),
			`${JSON.stringify({ ...run, state: "running" }, null, 2)}\n`,
			"utf8",
		);

		await expect(orchestrator.recoverRun(run.id)).rejects.toThrow(
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
		const orchestrator = new Orchestrator({
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
		const run = await orchestrator.createRun({
			repository,
			requestPath: "/repo/request.md",
			requestText: "Implement the feature",
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

		const result = await orchestrator.approveAndLaunch(run, repository, {
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
				launchPolicy: {
					version: 1,
					role: "implementation",
					tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
					resourceDiscovery: "disabled",
				},
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			},
		});
		expect(workers.calls[1]).toMatchObject({ operation: "prompt" });
		const prompt = (workers.calls[1]?.value as { prompt?: string })?.prompt;
		expect(prompt).toContain("ENFORCED AUTHORITY");
		expect(prompt).toContain("REPOSITORY SNAPSHOT");
		expect(prompt).toContain(
			`isolated snapshot of commit ${launch?.attempt.baseCommit}`,
		);
		expect(prompt).toContain(result.run.integrationBranch);
		expect(prompt).toContain("<untrusted_task_json>");
		expect(prompt).toContain(
			"Host filesystem, network, and credentials may be reachable",
		);
		expect(prompt).toContain("Do not push, publish, deploy");
		expect(await store.load(run.id)).toEqual(result.run);
		await orchestrator.cancelRun(result.run);
		await result.completion;
	});
});
