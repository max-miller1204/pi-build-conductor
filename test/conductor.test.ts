import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

	async stop(workerId: string): Promise<void> {
		this.calls.push({ operation: "stop", value: workerId });
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

describe("BuildConductor vertical slice", () => {
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
