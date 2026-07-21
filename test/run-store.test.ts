import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
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
		version: 3,
		finalValidationCommands: [{ command: process.execPath, args: ["-e", ""] }],
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

	it("migrates schema 4 snapshots durably and idempotently", async () => {
		const store = await temporaryStore();
		const run = createRun();
		const { revision: _revision, ...current } = run;
		await writeFile(
			join(store.directory, `${run.id}.json`),
			`${JSON.stringify({ ...current, schemaVersion: 4 }, null, 2)}\n`,
			"utf8",
		);

		const first = await store.load(run.id);
		const second = await store.load(run.id);
		expect(first).toMatchObject({ schemaVersion: 5, revision: 0 });
		expect(second).toEqual(first);
		const persisted = await readFile(
			join(store.directory, `${run.id}.json`),
			"utf8",
		);
		expect(persisted).toContain('"schemaVersion": 5');
		expect(persisted).toContain('"revision": 0');
	});

	it("serializes concurrent transactions without losing updates", async () => {
		const store = await temporaryStore();
		const otherProcessStore = new RunStore(store.directory);
		const run = await store.create(createRun());

		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				(index % 2 === 0 ? store : otherProcessStore).transaction(
					run.id,
					(current) => ({
						...current,
						updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
					}),
				),
			),
		);

		expect((await store.load(run.id)).revision).toBe(20);
	});

	it("holds an exclusive lifecycle lease across store instances", async () => {
		const store = await temporaryStore();
		const otherProcessStore = new RunStore(store.directory);
		const release = await store.acquireLifecycleLease("run-1");
		let acquired = false;
		const waiting = otherProcessStore
			.acquireLifecycleLease("run-1")
			.then((releaseWaiting) => {
				acquired = true;
				return releaseWaiting;
			});
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
		expect(acquired).toBe(false);

		await release();
		const releaseWaiting = await waiting;
		expect(acquired).toBe(true);
		await releaseWaiting();
	});

	it("reclaims a stale lifecycle lease left by a crashed process", async () => {
		const store = await temporaryStore();
		const lockPath = join(store.directory, ".run-1.lifecycle.lock");
		await mkdir(lockPath, { recursive: true });
		const staleTime = new Date(Date.now() - 60_000);
		await utimes(lockPath, staleTime, staleTime);

		const release = await store.acquireLifecycleLease("run-1");
		await release();
		await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("rejects stale snapshots and duplicate run creation", async () => {
		const store = await temporaryStore();
		const run = await store.create(createRun());
		const stale = await store.load(run.id);
		await store.transaction(run.id, (current) => ({
			...current,
			updatedAt: "2026-01-01T00:01:00.000Z",
		}));

		await expect(
			store.save({
				...stale,
				updatedAt: "2026-01-01T00:02:00.000Z",
			}),
		).rejects.toThrow(/Stale run revision/);
		await expect(store.create(run)).rejects.toThrow(/Run already exists/);
	});

	it("rejects legacy runs that lack an approved final validation suite", () => {
		const run = createRun();
		const task = run.tasks.implementation;
		if (!task) {
			throw new Error("Missing test task");
		}
		const integratedCommit = "integrated-implementation";
		const integratedRun: BuildRun = {
			...run,
			integrationHead: integratedCommit,
			tasks: {
				implementation: {
					...task,
					state: "succeeded",
					attemptIds: ["attempt-1"],
					integratedCommit,
				},
			},
			attempts: [
				{
					id: "attempt-1",
					taskId: "implementation",
					number: 1,
					state: "succeeded",
					branch: "conductor/run-1/task/implementation/attempt-1",
					worktreePath: "/worktrees/implementation",
					baseCommit: run.baseCommit,
					startedAt: run.createdAt,
					finishedAt: run.updatedAt,
					commit: "source-implementation",
					evidence: {
						startedAt: run.createdAt,
						finishedAt: run.updatedAt,
						passed: true,
						changedFiles: [],
						diffHash: "diff",
						checks: [],
					},
				},
			],
		};
		const {
			integrationHead: _integrationHead,
			reviewRounds: _reviewRounds,
			reviewAttempts: _reviewAttempts,
			repairAttempts: _repairAttempts,
			...legacy
		} = integratedRun;

		expect(() => validateStoredRun({ ...legacy, schemaVersion: 2 })).toThrow(
			/start a new approved run/,
		);
		expect(() => validateStoredRun({ ...legacy, schemaVersion: 3 })).toThrow(
			/start a new approved run/,
		);
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
