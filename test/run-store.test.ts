import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	approveRun,
	createOrchestrationRun,
	restoreRunPlanRevision,
	reviseRunPlan,
} from "../src/domain/run.js";
import type { OrchestrationRun, TaskPlan } from "../src/domain/types.js";
import { RunStore, validateStoredRun } from "../src/storage/run-store.js";
import { removeTemporaryDirectories } from "./helpers/cleanup.js";

const directories: string[] = [];

async function temporaryStore(): Promise<RunStore> {
	const directory = await mkdtemp(join(tmpdir(), "pi-build-conductor-"));
	directories.push(directory);
	return new RunStore(directory);
}

function createRun(): OrchestrationRun {
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
	return createOrchestrationRun({
		id: "run-1",
		repositoryRoot: "/repo",
		baseBranch: "main",
		baseCommit: "abc123",
		integrationBranch: "conductor/run-1/integration",
		request: { sourcePath: "/repo/request.md", text: "Build it" },
		plan,
		maxConcurrentWorkers: 2,
		now: "2026-01-01T00:00:00.000Z",
	});
}

afterEach(async () => {
	await removeTemporaryDirectories(directories);
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
		const {
			revision: _revision,
			planRevision: _planRevision,
			planRevisions: _planRevisions,
			approvedPlanRevision: _approvedPlanRevision,
			...current
		} = run;
		await writeFile(
			join(store.directory, `${run.id}.json`),
			`${JSON.stringify({ ...current, schemaVersion: 4 }, null, 2)}\n`,
			"utf8",
		);

		const first = await store.load(run.id);
		const second = await store.load(run.id);
		expect(first).toMatchObject({
			schemaVersion: 9,
			revision: 0,
			planRevision: 1,
			blockedWorkers: [],
		});
		expect(second).toEqual(first);
		const persisted = await readFile(
			join(store.directory, `${run.id}.json`),
			"utf8",
		);
		expect(persisted).toContain('"schemaVersion": 9');
		expect(persisted).toContain('"revision": 0');
	});

	it("migrates schema 5 plan snapshots into immutable revision history", async () => {
		const store = await temporaryStore();
		const run = approveRun(createRun(), "2026-01-01T00:01:00.000Z");
		const {
			planRevision: _planRevision,
			planRevisions: _planRevisions,
			approvedPlanRevision: _approvedPlanRevision,
			...legacy
		} = run;
		await writeFile(
			join(store.directory, `${run.id}.json`),
			`${JSON.stringify({ ...legacy, schemaVersion: 5 }, null, 2)}\n`,
			"utf8",
		);

		const migrated = await store.load(run.id);
		expect(migrated).toMatchObject({
			schemaVersion: 9,
			planRevision: 1,
			approvedPlanRevision: 1,
			planRevisions: [
				{
					number: 1,
					source: "migrated",
					maxConcurrentWorkers: 2,
				},
			],
		});
	});

	it("migrates schema 6 snapshots with an empty blocked-worker projection", async () => {
		const store = await temporaryStore();
		const { blockedWorkers: _blockedWorkers, ...run } = createRun();
		await writeFile(
			join(store.directory, `${run.id}.json`),
			`${JSON.stringify({ ...run, schemaVersion: 6 }, null, 2)}\n`,
			"utf8",
		);

		const migrated = await store.load(run.id);
		expect(migrated).toMatchObject({
			schemaVersion: 9,
			blockedWorkers: [],
		});
		expect(
			await readFile(join(store.directory, `${run.id}.json`), "utf8"),
		).toContain('"blockedWorkers": []');
	});

	it("migrates schema 8 handoff snapshots to the neutral request terminology", async () => {
		const store = await temporaryStore();
		const run = createRun();
		const { request, ...legacy } = run;
		await writeFile(
			join(store.directory, `${run.id}.json`),
			`${JSON.stringify({ ...legacy, schemaVersion: 8, handoff: request }, null, 2)}\n`,
			"utf8",
		);

		const migrated = await store.load(run.id);
		expect(migrated).toEqual(run);
		expect(migrated.schemaVersion).toBe(9);
		expect(Object.hasOwn(migrated, "handoff")).toBe(false);
		expect(await store.load(run.id)).toEqual(migrated);
	});

	it("keeps current plans, task projections, and historical revisions isolated", () => {
		const run = createRun();
		run.plan.title = "Mutated current plan";
		const implementation = run.tasks.implementation;
		if (!implementation) {
			throw new Error("Missing implementation task");
		}
		implementation.definition.title = "Mutated task projection";

		expect(run.planRevisions[0]?.plan.title).toBe("Build");
		expect(run.plan.tasks[0]?.title).toBe("Implementation");
		expect(run.planRevisions[0]?.plan.tasks[0]?.title).toBe("Implementation");
	});

	it("appends valid plan revisions, restores history, and freezes approval", () => {
		const initial = createRun();
		const revised = reviseRunPlan(initial, {
			plan: { ...initial.plan, title: "Revised build" },
			maxConcurrentWorkers: 4,
			expectedPlanRevision: 1,
			now: "2026-01-01T00:01:00.000Z",
		});
		expect(revised).toMatchObject({
			planRevision: 2,
			maxConcurrentWorkers: 4,
			plan: { title: "Revised build" },
		});
		expect(revised.planRevisions).toHaveLength(2);
		expect(
			reviseRunPlan(revised, {
				plan: revised.plan,
				maxConcurrentWorkers: 4,
				expectedPlanRevision: 2,
				now: "2026-01-01T00:02:00.000Z",
			}),
		).toBe(revised);

		const restored = restoreRunPlanRevision(
			revised,
			1,
			2,
			"2026-01-01T00:03:00.000Z",
		);
		expect(restored).toMatchObject({
			planRevision: 3,
			maxConcurrentWorkers: 2,
			plan: { title: "Build" },
			planRevisions: [{}, {}, { source: "restored", restoredFrom: 1 }],
		});
		const repeatedRestore = restoreRunPlanRevision(
			restored,
			1,
			3,
			"2026-01-01T00:04:00.000Z",
		);
		expect(repeatedRestore).toMatchObject({
			planRevision: 4,
			planRevisions: [{}, {}, {}, { source: "restored", restoredFrom: 1 }],
		});
		const approved = approveRun(repeatedRestore, "2026-01-01T00:05:00.000Z", 4);
		expect(approved.approvedPlanRevision).toBe(4);
		expect(() =>
			reviseRunPlan(approved, {
				plan: approved.plan,
				maxConcurrentWorkers: 2,
				expectedPlanRevision: 4,
				now: "2026-01-01T00:06:00.000Z",
			}),
		).toThrow(/Cannot revise plan/);
	});

	it("rejects execution-capable states without recorded approval", () => {
		const run = createRun();
		expect(() => validateStoredRun({ ...run, state: "running" })).toThrow(
			/Run state running requires plan approval/,
		);
		expect(() =>
			validateStoredRun({
				...approveRun(run, "2026-01-01T00:01:00.000Z"),
				state: "awaiting_approval",
			}),
		).toThrow(/cannot already have plan approval/);
	});

	it("rejects malformed or mismatched plan revision history", () => {
		const run = createRun();
		expect(() =>
			validateStoredRun({
				...run,
				planRevision: 2,
			}),
		).toThrow(/identify the latest plan revision/);
		expect(() =>
			validateStoredRun({
				...run,
				planRevisions: [{ ...run.planRevisions[0], maxConcurrentWorkers: 3 }],
			}),
		).toThrow(/must match the latest plan revision/);
	});

	it("prevents rewriting history and changing an approved plan through raw store transactions", async () => {
		const store = await temporaryStore();
		const initial = await store.create(createRun());
		const firstRevision = initial.planRevisions[0];
		if (!firstRevision) {
			throw new Error("Missing initial plan revision");
		}
		await expect(
			store.transaction(initial.id, (current) => ({
				...current,
				planRevisions: [{ ...firstRevision, source: "edited" as const }],
			})),
		).rejects.toThrow(/Plan revision 1 is immutable/);
		await expect(
			store.transaction(initial.id, (current) => {
				const revision = current.planRevisions[0];
				if (!revision) {
					throw new Error("Missing current revision");
				}
				revision.source = "edited";
				return { ...current };
			}),
		).rejects.toThrow(/Plan revision 1 is immutable/);
		await expect(
			store.transaction(initial.id, (current) => ({
				...current,
				securityPolicy: {
					...current.securityPolicy,
					workers: {
						...current.securityPolicy.workers,
						uiPolicy: "cancel" as const,
					},
				},
			})),
		).rejects.toThrow(/security policy is immutable/);
		await expect(
			store.transaction(initial.id, (current) => {
				current.id = "redirected-run";
				return current;
			}),
		).rejects.toThrow(/cannot change the run id/);
		const normalizedRevision = await store.transaction(
			initial.id,
			(current) => {
				current.revision = 99;
				return current;
			},
		);
		expect(normalizedRevision.revision).toBe(1);

		const approved = await store.transaction(initial.id, (current) =>
			approveRun(current, "2026-01-01T00:02:00.000Z"),
		);
		await expect(
			store.transaction(approved.id, (current) => ({
				...current,
				plan: { ...current.plan, title: "Tampered" },
				planRevisions: [
					...current.planRevisions,
					{
						number: 2,
						createdAt: current.updatedAt,
						source: "edited" as const,
						plan: { ...current.plan, title: "Tampered" },
						maxConcurrentWorkers: current.maxConcurrentWorkers,
					},
				],
				planRevision: 2,
				approvedPlanRevision: 2,
			})),
		).rejects.toThrow(/Approved plan revision is immutable/);
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
		const integratedRun: OrchestrationRun = {
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

	it("scans valid runs even when another snapshot is unreadable", async () => {
		const store = await temporaryStore();
		const run = createRun();
		await store.save(run);
		await writeFile(join(store.directory, "broken.json"), "{", "utf8");

		expect(await store.scan()).toEqual([
			{
				kind: "unreadable",
				runId: "broken",
				error: expect.stringContaining("Failed to load run broken"),
			},
			{ kind: "run", run },
		]);
		await expect(store.list()).rejects.toThrow(/Failed to list run broken/);
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

	it("rejects active task projections without an active attempt", () => {
		const run = approveRun(createRun(), "2026-01-01T00:01:00.000Z");
		const implementation = run.tasks.implementation;
		if (!implementation) {
			throw new Error("Missing implementation task");
		}

		expect(() =>
			validateStoredRun({
				...run,
				tasks: {
					implementation: { ...implementation, state: "running" },
				},
			}),
		).toThrow(/Active task implementation has no active attempt/);
	});

	it("rejects duplicate attempt numbers for one task", () => {
		const run = approveRun(createRun(), "2026-01-01T00:01:00.000Z");
		const implementation = run.tasks.implementation;
		if (!implementation) {
			throw new Error("Missing implementation task");
		}
		const firstAttempt = {
			id: "attempt-1",
			taskId: "implementation",
			number: 1,
			state: "interrupted" as const,
			branch: "conductor/run-1/task/implementation/attempt-1",
			worktreePath: "/tmp/worktree-1",
			baseCommit: run.baseCommit,
			startedAt: run.updatedAt,
			finishedAt: run.updatedAt,
			error: "Orchestrator restarted",
		};

		expect(() =>
			validateStoredRun({
				...run,
				tasks: {
					implementation: {
						...implementation,
						attemptIds: ["attempt-1", "attempt-2"],
					},
				},
				attempts: [
					firstAttempt,
					{
						...firstAttempt,
						id: "attempt-2",
						branch: "conductor/run-1/task/implementation/attempt-2",
						worktreePath: "/tmp/worktree-2",
					},
				],
			}),
		).toThrow(/Duplicate attempt number 1 for task implementation/);
	});

	it("validates blocked workers against active typed attempts", () => {
		const run = approveRun(createRun(), "2026-01-01T00:01:00.000Z");
		const implementation = run.tasks.implementation;
		if (!implementation) {
			throw new Error("Missing implementation task");
		}
		const active: OrchestrationRun = {
			...run,
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
					state: "running",
					branch: "conductor/run-1/task/implementation/attempt-1",
					worktreePath: "/tmp/worktree-1",
					baseCommit: run.baseCommit,
					workerId: "worker-1",
					startedAt: run.updatedAt,
				},
			],
			blockedWorkers: [
				{
					attemptKind: "task",
					attemptId: "attempt-1",
					workerId: "worker-1",
					blockedAt: run.updatedAt,
					requestId: "request-1",
					method: "confirm",
				},
			],
		};

		expect(validateStoredRun(active).blockedWorkers).toEqual(
			active.blockedWorkers,
		);
		expect(() =>
			validateStoredRun({
				...active,
				blockedWorkers: [
					...active.blockedWorkers,
					...(active.blockedWorkers[0]
						? [{ ...active.blockedWorkers[0] }]
						: []),
				],
			}),
		).toThrow(/Duplicate blocked worker request/);
		expect(() =>
			validateStoredRun({
				...active,
				blockedWorkers: active.blockedWorkers.map((blocked) => ({
					...blocked,
					workerId: "other-worker",
				})),
			}),
		).toThrow(/workerId does not match/);
		expect(() =>
			validateStoredRun({
				...active,
				blockedWorkers: active.blockedWorkers.map((blocked) => ({
					...blocked,
					title: "sensitive title",
				})),
			}),
		).toThrow(/title must not be persisted/);
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
			const running: OrchestrationRun = {
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
				error: "Orchestrator restarted",
			});
			expect(await store.load("run-1")).toEqual(recovered);
		},
	);
});
