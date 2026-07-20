import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveRun, createBuildRun } from "../src/domain/run.js";
import type { BuildRun, TaskPlan } from "../src/domain/types.js";
import { RunStore, validateStoredRun } from "../src/storage/run-store.js";

const directories: string[] = [];

async function temporaryStore(): Promise<RunStore> {
	const directory = await mkdtemp(join(tmpdir(), "pi-build-conductor-"));
	directories.push(directory);
	return new RunStore(directory);
}

function createRun(): BuildRun {
	const plan: TaskPlan = {
		version: 2,
		title: "Build",
		tasks: [
			{
				id: "implementation",
				title: "Implementation",
				description: "Implement the feature",
				dependencies: [],
				acceptanceCriteria: ["Tests pass"],
				allowedPaths: ["src/implementation/"],
				validationCommands: [{ command: "npm", args: ["test"] }],
			},
		],
	};
	return createBuildRun({
		id: "run-1",
		repositoryRoot: "/repo",
		baseBranch: "main",
		baseCommit: "abc123",
		integrationBranch: "conductor/run-1/integration",
		handoff: { sourcePath: "/repo/handoff.md", text: "Build it" },
		plan,
		maxConcurrentWorkers: 2,
		now: "2026-01-01T00:00:00.000Z",
	});
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("RunStore", () => {
	it("round-trips durable run state", async () => {
		const store = await temporaryStore();
		const run = createRun();
		await store.save(run);

		expect(await store.load(run.id)).toEqual(run);
		expect(await store.list()).toEqual([run]);
	});

	it("ignores incomplete temporary writes during listing", async () => {
		const store = await temporaryStore();
		const run = createRun();
		await store.save(run);
		await writeFile(join(store.directory, ".run-2.partial.tmp"), "{", "utf8");

		expect(await store.list()).toEqual([run]);
	});

	it("rejects an integration branch outside the run namespace", () => {
		const run = createRun();
		expect(() =>
			validateStoredRun({ ...run, integrationBranch: run.baseBranch }),
		).toThrow(/run\.integrationBranch must be conductor\/run-1\/integration/);
	});

	it("rejects malformed attempt records", () => {
		const run = createRun();
		expect(() =>
			validateStoredRun({
				...run,
				attempts: [null],
			}),
		).toThrow(/run\.attempts\[0\] must be an object/);
	});

	it.each([1, 5, 2.5])(
		"rejects an out-of-range concurrency limit of %s",
		(maxConcurrentWorkers) => {
			const run = createRun();
			expect(() => validateStoredRun({ ...run, maxConcurrentWorkers })).toThrow(
				/must be an integer from 2 to 4/,
			);
		},
	);

	it.each(["prepared", "launched", "running"] as const)(
		"recovers %s work as retryable after restart",
		async (attemptState) => {
			const store = await temporaryStore();
			const approved = approveRun(createRun(), "2026-01-01T00:01:00.000Z");
			const implementation = approved.tasks.implementation;
			if (!implementation) {
				throw new Error("missing implementation task");
			}
			const running: BuildRun = {
				...approved,
				tasks: {
					implementation: {
						...implementation,
						state: "running",
						attemptIds: ["attempt-1"],
					},
				},
				attempts: [
					{
						id: "attempt-1",
						taskId: "implementation",
						number: 1,
						state: attemptState,
						branch: "conductor/run-1/implementation",
						worktreePath: "/tmp/worktree",
						baseCommit: approved.baseCommit,
						workerId: "worker-1",
						startedAt: "2026-01-01T00:02:00.000Z",
					},
				],
			};
			await store.save(running);

			const recovered = await store.recover(
				"run-1",
				"2026-01-01T01:00:00.000Z",
			);
			expect(recovered.tasks.implementation?.state).toBe("ready");
			expect(recovered.attempts[0]).toMatchObject({
				state: "interrupted",
				finishedAt: "2026-01-01T01:00:00.000Z",
				error: "Conductor restarted",
			});
			expect(await store.load("run-1")).toEqual(recovered);
		},
	);
});
