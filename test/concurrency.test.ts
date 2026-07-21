import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BuildConductorDependencies,
	BuildConductor as ProductionBuildConductor,
} from "../src/conductor.js";
import { approveRun } from "../src/domain/run.js";
import type { BuildRun, TaskDefinition } from "../src/domain/types.js";
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
import { createFakeFinalizationDependencies } from "./helpers/finalization.js";
import { reviewResult } from "./helpers/review.js";

const directories: string[] = [];

class BuildConductor extends ProductionBuildConductor {
	constructor(
		dependencies: Omit<BuildConductorDependencies, "git" | "validator">,
	) {
		super({ ...dependencies, ...createFakeFinalizationDependencies() });
	}
}

class ControlledWorkers implements WorkerBackend {
	readonly instances = new Map<string, WorkerInstance>();
	readonly taskByWorker = new Map<string, string>();
	readonly pending = new Map<string, (result: WorkerExecutionResult) => void>();
	readonly startOrder: string[] = [];
	readonly stopOrder: string[] = [];
	maxInFlight = 0;
	private nextWorker = 1;

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		const id = `worker-${this.nextWorker++}`;
		const worker: WorkerInstance = {
			id,
			status: "online",
			cwd: request.cwd,
			...(request.label === undefined ? {} : { label: request.label }),
		};
		this.instances.set(id, worker);
		const taskId = request.label?.split(":").at(-1);
		if (!taskId) {
			throw new Error("missing task label");
		}
		this.taskByWorker.set(id, taskId);
		return worker;
	}

	async list(): Promise<WorkerInstance[]> {
		return [...this.instances.values()];
	}

	async status(workerId: string): Promise<WorkerInstance> {
		const worker = this.instances.get(workerId);
		if (!worker) {
			throw new Error(`unknown worker ${workerId}`);
		}
		return worker;
	}

	async sendPrompt(): Promise<void> {}

	async startPrompt(
		workerId: string,
		prompt: string,
		options: WorkerExecutionOptions = {},
	): Promise<WorkerExecution> {
		const review = reviewResult(prompt);
		if (review) {
			return { completion: Promise.resolve(review) };
		}
		const taskId = this.taskByWorker.get(workerId);
		if (!taskId) {
			throw new Error(`unknown worker ${workerId}`);
		}
		this.startOrder.push(taskId);
		const completion = new Promise<WorkerExecutionResult>((resolve) => {
			let settled = false;
			const settle = (result: WorkerExecutionResult) => {
				if (settled) {
					return;
				}
				settled = true;
				this.pending.delete(taskId);
				resolve(result);
			};
			this.pending.set(taskId, settle);
			options.signal?.addEventListener(
				"abort",
				() => {
					const reason = options.signal?.reason;
					settle({
						status: "aborted",
						error: reason instanceof Error ? reason.message : "aborted",
					});
				},
				{ once: true },
			);
		});
		this.maxInFlight = Math.max(this.maxInFlight, this.pending.size);
		return { completion };
	}

	async stop(workerId: string): Promise<void> {
		this.stopOrder.push(workerId);
		const worker = this.instances.get(workerId);
		if (worker) {
			worker.status = "stopped";
		}
	}

	settle(taskId: string, result: WorkerExecutionResult): void {
		const resolve = this.pending.get(taskId);
		if (!resolve) {
			throw new Error(`task ${taskId} is not running`);
		}
		resolve(result);
	}
}

class IsolatedWorktrees implements WorktreeManager {
	readonly allocations: PrepareTaskWorktreeInput[] = [];
	readonly removed: string[] = [];

	async prepareIntegrationBranch(
		_repository: RepositoryInfo,
		runId: string,
	): Promise<string> {
		return `conductor/${runId}/integration`;
	}

	async prepareTaskWorktree(input: PrepareTaskWorktreeInput) {
		this.allocations.push(input);
		return {
			branch: `conductor/${input.runId}/task/${input.taskId}/attempt-${input.attemptNumber}`,
			path: `/worktrees/${input.taskId}/attempt-${input.attemptNumber}`,
		};
	}

	async removeTaskWorktree(
		_repositoryRoot: string,
		path: string,
	): Promise<void> {
		this.removed.push(path);
	}
}

const repository: RepositoryInfo = {
	root: "/repo",
	commonDirectory: "/repo/.git",
	currentBranch: "main",
	head: "abc123",
	isClean: true,
};

function task(id: string, dependencies: string[] = []): TaskDefinition {
	return {
		id,
		title: id,
		description: `Implement ${id}`,
		dependencies,
		acceptanceCriteria: [`${id} works`],
		allowedPaths: [`src/${id}/`],
		validationCommands: [{ command: "npm", args: ["test"] }],
	};
}

async function setup(tasks: TaskDefinition[], maxConcurrentWorkers = 2) {
	const directory = await mkdtemp(join(tmpdir(), "pi-build-concurrency-"));
	directories.push(directory);
	const store = new RunStore(directory);
	const workers = new ControlledWorkers();
	const worktrees = new IsolatedWorktrees();
	const conductor = new BuildConductor({ store, workers, worktrees });
	const run = await conductor.createRun({
		repository,
		handoffPath: "/repo/handoff.md",
		handoffText: "Build concurrently",
		plan: { version: 2, title: "Concurrent build", tasks },
		maxConcurrentWorkers,
	});
	return { conductor, run, store, workers, worktrees };
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("bounded dependency-aware concurrency", () => {
	it("fills two slots, refills one slot, and never dispatches a task twice", async () => {
		const { conductor, run, workers, worktrees } = await setup([
			task("first"),
			task("second"),
			task("third"),
		]);

		const result = await conductor.approveAndLaunch(run, repository);
		expect(result.launches.map((launch) => launch.task.id)).toEqual([
			"first",
			"second",
		]);
		expect(workers.startOrder).toEqual(["first", "second"]);
		await expect(
			conductor.resumeAndLaunch(result.run, repository),
		).rejects.toThrow(/active lifecycle work/);
		expect(workers.startOrder).toEqual(["first", "second"]);

		workers.settle("first", { status: "succeeded" });
		await vi.waitFor(() =>
			expect(workers.startOrder).toEqual(["first", "second", "third"]),
		);
		expect(workers.maxInFlight).toBe(2);
		expect(new Set(workers.startOrder).size).toBe(3);
		expect(
			worktrees.allocations.map((allocation) => allocation.taskId),
		).toEqual(["first", "second", "third"]);

		workers.settle("second", { status: "succeeded" });
		workers.settle("third", { status: "succeeded" });
		const completed = await result.completion;
		expect(completed.state).toBe("reviewed");
	});

	it("launches newly unblocked DAG layers in deterministic plan order", async () => {
		const { conductor, run, workers } = await setup([
			task("foundation"),
			task("api", ["foundation"]),
			task("ui", ["foundation"]),
			task("release", ["api", "ui"]),
		]);
		const result = await conductor.approveAndLaunch(run, repository);
		expect(workers.startOrder).toEqual(["foundation"]);

		workers.settle("foundation", { status: "succeeded" });
		await vi.waitFor(() =>
			expect(workers.startOrder).toEqual(["foundation", "api", "ui"]),
		);
		workers.settle("ui", { status: "succeeded" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(workers.startOrder).not.toContain("release");
		workers.settle("api", { status: "succeeded" });
		await vi.waitFor(() => expect(workers.startOrder.at(-1)).toBe("release"));
		workers.settle("release", { status: "succeeded" });

		expect((await result.completion).state).toBe("reviewed");
	});

	it("refills a slot with a dependent while an unrelated worker is still running", async () => {
		const { conductor, run, workers } = await setup([
			task("foundation"),
			task("dependent", ["foundation"]),
			task("unrelated"),
		]);
		const result = await conductor.approveAndLaunch(run, repository);
		expect(workers.startOrder).toEqual(["foundation", "unrelated"]);

		workers.settle("foundation", { status: "succeeded" });
		await vi.waitFor(() =>
			expect(workers.startOrder).toEqual([
				"foundation",
				"unrelated",
				"dependent",
			]),
		);
		workers.settle("dependent", { status: "succeeded" });
		workers.settle("unrelated", { status: "succeeded" });

		expect((await result.completion).state).toBe("reviewed");
	});

	it("supports a four-worker bound with isolated workers and worktrees", async () => {
		const { conductor, run, workers, worktrees } = await setup(
			[task("one"), task("two"), task("three"), task("four"), task("five")],
			4,
		);
		const result = await conductor.approveAndLaunch(run, repository);
		expect(result.launches).toHaveLength(4);
		expect(
			new Set(result.launches.map((launch) => launch.attempt.workerId)).size,
		).toBe(4);
		expect(
			new Set(result.launches.map((launch) => launch.attempt.worktreePath))
				.size,
		).toBe(4);
		expect(worktrees.allocations).toHaveLength(4);

		workers.settle("one", { status: "succeeded" });
		await vi.waitFor(() => expect(workers.startOrder.at(-1)).toBe("five"));
		for (const taskId of ["two", "three", "four", "five"]) {
			workers.settle(taskId, { status: "succeeded" });
		}
		expect((await result.completion).state).toBe("reviewed");
		expect(workers.maxInFlight).toBe(4);
	});

	it("stops dispatch after failure while allowing active siblings to settle", async () => {
		const { conductor, run, store, workers } = await setup([
			task("foundation"),
			task("independent"),
			task("dependent", ["foundation"]),
		]);
		const result = await conductor.approveAndLaunch(run, repository);
		expect(workers.startOrder).toEqual(["foundation", "independent"]);

		workers.settle("foundation", { status: "failed", error: "failed" });
		await vi.waitFor(async () =>
			expect((await store.load(run.id)).state).toBe("failed"),
		);
		expect(workers.startOrder).not.toContain("dependent");
		workers.settle("independent", { status: "succeeded" });
		const failed = await result.completion;
		expect(failed.state).toBe("failed");
		expect(failed.tasks.dependent?.state).toBe("blocked");
	});

	it("recovers every active worker and makes interrupted tasks retryable", async () => {
		const { conductor, run, store, workers } = await setup([
			task("first"),
			task("second"),
		]);
		await workers.spawn({ cwd: "/worktrees/first", label: `${run.id}:first` });
		await workers.spawn({
			cwd: "/worktrees/second",
			label: `${run.id}:second`,
		});
		const approved = approveRun(run, "2026-01-01T00:00:00.000Z");
		const first = approved.tasks.first;
		const second = approved.tasks.second;
		if (!first || !second) {
			throw new Error("missing recovery tasks");
		}
		const active: BuildRun = {
			...approved,
			tasks: {
				first: {
					...first,
					state: "running",
					attemptIds: ["first-1"],
				},
				second: {
					...second,
					state: "running",
					attemptIds: ["second-1"],
				},
			},
			attempts: [
				{
					id: "first-1",
					taskId: "first",
					number: 1,
					state: "running",
					branch: "first",
					worktreePath: "/worktrees/first",
					baseCommit: approved.baseCommit,
					workerId: "worker-1",
					startedAt: approved.updatedAt,
				},
				{
					id: "second-1",
					taskId: "second",
					number: 1,
					state: "launched",
					branch: "second",
					worktreePath: "/worktrees/second",
					baseCommit: approved.baseCommit,
					workerId: "worker-2",
					startedAt: approved.updatedAt,
				},
			],
		};
		await store.save(active);

		const recovered = await conductor.recoverRun(run.id);

		expect(workers.stopOrder).toEqual(["worker-1", "worker-2"]);
		expect(recovered.attempts.map((attempt) => attempt.state)).toEqual([
			"interrupted",
			"interrupted",
		]);
		expect(Object.values(recovered.tasks).map((item) => item.state)).toEqual([
			"ready",
			"ready",
		]);
	});

	it("recovers a recorded commit by retrying cleanup without recommitting", async () => {
		const { conductor, run, store, worktrees } = await setup([
			task("committed"),
		]);
		const approved = approveRun(run, "2026-01-01T00:00:00.000Z");
		const committedTask = approved.tasks.committed;
		if (!committedTask) {
			throw new Error("missing committed task");
		}
		await store.save({
			...approved,
			tasks: {
				committed: {
					...committedTask,
					state: "validating",
					attemptIds: ["committed-1"],
				},
			},
			attempts: [
				{
					id: "committed-1",
					taskId: "committed",
					number: 1,
					state: "validating",
					branch: "committed",
					worktreePath: "/worktrees/committed",
					baseCommit: approved.baseCommit,
					startedAt: approved.updatedAt,
					commit: "commit-1",
					evidence: {
						startedAt: approved.updatedAt,
						finishedAt: approved.updatedAt,
						passed: true,
						changedFiles: [{ path: "src/committed/result.txt", status: "??" }],
						diffHash: "diff-1",
						checks: [],
					},
				},
			],
		});

		const recovered = await conductor.recoverRun(run.id);

		expect(recovered.state).toBe("integrating");
		expect(recovered.tasks.committed?.state).toBe("succeeded");
		expect(recovered.attempts[0]).toMatchObject({
			state: "succeeded",
			commit: "commit-1",
		});
		expect(worktrees.removed).toEqual(["/worktrees/committed"]);
	});

	it("recovers a commit created just before state persistence", async () => {
		const { conductor, run, store, worktrees } = await setup([task("crashed")]);
		const approved = approveRun(run, "2026-01-01T00:00:00.000Z");
		const crashedTask = approved.tasks.crashed;
		if (!crashedTask) {
			throw new Error("missing crashed task");
		}
		await store.save({
			...approved,
			tasks: {
				crashed: {
					...crashedTask,
					state: "validating",
					attemptIds: ["crashed-1"],
				},
			},
			attempts: [
				{
					id: "crashed-1",
					taskId: "crashed",
					number: 1,
					state: "validating",
					branch: "crashed",
					worktreePath: "/worktrees/crashed",
					baseCommit: approved.baseCommit,
					startedAt: approved.updatedAt,
					evidence: {
						startedAt: approved.updatedAt,
						finishedAt: approved.updatedAt,
						passed: true,
						changedFiles: [{ path: "src/crashed/result.txt", status: "??" }],
						diffHash: "diff-crashed",
						checks: [],
					},
				},
			],
		});

		const recovered = await conductor.recoverRun(run.id);

		expect(recovered.state).toBe("integrating");
		expect(recovered.attempts[0]).toMatchObject({
			state: "succeeded",
			commit: "recovered-commit",
		});
		expect(worktrees.removed).toEqual(["/worktrees/crashed"]);
	});

	it("retries cleanup for a live worker referenced by a terminal attempt", async () => {
		const { conductor, run, store, workers } = await setup([task("failed")]);
		await workers.spawn({
			cwd: "/worktrees/failed",
			label: `${run.id}:failed`,
		});
		const failedTask = run.tasks.failed;
		if (!failedTask) {
			throw new Error("missing failed task");
		}
		await store.save({
			...run,
			state: "failed",
			tasks: {
				failed: {
					...failedTask,
					state: "failed",
					attemptIds: ["failed-1"],
				},
			},
			attempts: [
				{
					id: "failed-1",
					taskId: "failed",
					number: 1,
					state: "failed",
					branch: "failed",
					worktreePath: "/worktrees/failed",
					baseCommit: run.baseCommit,
					workerId: "worker-1",
					startedAt: run.updatedAt,
					finishedAt: run.updatedAt,
					error: "cleanup failed",
				},
			],
		});

		await conductor.recoverRun(run.id);

		expect(workers.stopOrder).toEqual(["worker-1"]);
	});

	it("cancels every active worker once without refilling the pool", async () => {
		const { conductor, run, workers } = await setup([
			task("first"),
			task("second"),
			task("third"),
		]);
		const result = await conductor.approveAndLaunch(run, repository);
		await conductor.cancelRun(result.run);
		const cancelled = await result.completion;

		expect(cancelled.state).toBe("cancelled");
		expect(workers.startOrder).toEqual(["first", "second"]);
		expect(workers.stopOrder.sort()).toEqual(["worker-1", "worker-2"]);
	});
});
