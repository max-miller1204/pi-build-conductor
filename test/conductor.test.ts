import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BuildConductor } from "../src/conductor.js";
import type { RepositoryInfo } from "../src/git/git.js";
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

const directories: string[] = [];

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
			version: 1,
			title: "Feature",
			tasks: [
				{
					id: "implementation",
					title: "Implementation",
					description: "Implement it",
					dependencies: [],
					acceptanceCriteria: ["Tests pass"],
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
				version: 1,
				title: "Feature",
				tasks: [
					{
						id: "implementation",
						title: "Implementation",
						description: "Implement it",
						dependencies: [],
						acceptanceCriteria: ["Tests pass"],
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
		expect(workers.calls.at(-1)).toEqual({
			operation: "stop",
			value: "worker-1",
		});
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

	it("launches one worker and safely recovers it for retry", async () => {
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
				version: 1,
				title: "Feature",
				tasks: [
					{
						id: "implementation",
						title: "Implementation",
						description: "Implement it",
						dependencies: [],
						acceptanceCriteria: ["Tests pass"],
					},
				],
			},
		});

		const result = await conductor.approveAndLaunch(run, repository, {
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});

		expect(result.run.state).toBe("running");
		expect(result.run.tasks.implementation?.state).toBe("running");
		expect(result.attempt).toMatchObject({
			state: "running",
			workerId: "worker-1",
			worktreePath: "/worktree",
		});
		expect(worktrees.allocationInput?.startPoint).toBe(
			result.run.integrationBranch,
		);
		expect(workers.calls[0]).toEqual({
			operation: "spawn",
			value: {
				cwd: "/worktree",
				label: `${run.id}:implementation`,
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			},
		});
		expect(workers.calls[1]).toMatchObject({ operation: "prompt" });
		expect(await store.load(run.id)).toEqual(result.run);

		const recovered = await conductor.recoverRun(run.id);
		expect(recovered.tasks.implementation?.state).toBe("ready");
		expect(recovered.attempts[0]?.state).toBe("interrupted");
		expect(workers.calls[2]).toEqual({ operation: "stop", value: "worker-1" });

		const resumed = await conductor.resumeAndLaunch(recovered, repository);
		expect(resumed.attempt.number).toBe(2);
		expect(resumed.attempt.state).toBe("running");
		expect(resumed.attempt.branch).toContain("attempt-2");
	});
});
