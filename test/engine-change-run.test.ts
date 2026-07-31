import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { retryableRunWork } from "../src/domain/run-control.js";
import {
	type OrchestrationRun,
	REVIEW_CATEGORIES,
	type ReviewSeverity,
	type TaskPlan,
} from "../src/domain/types.js";
import { GitCli } from "../src/git/git.js";
import { GitWorktreeManager } from "../src/git/worktrees.js";
import { Orchestrator } from "../src/orchestrator.js";
import { readSecurityPolicy } from "../src/security/policy.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { RunStore } from "../src/storage/run-store.js";
import { FileWorkflowStateStore } from "../src/storage/workflow-state-store.js";
import {
	FinalValidationError,
	type FinalValidator,
	LocalFinalValidator,
} from "../src/validation/final-validator.js";
import { LocalTaskValidator } from "../src/validation/task-validator.js";
import {
	EngineChangeRunner,
	hasLegacyExecutionState,
} from "../src/workflows/change-run.js";
import {
	CHANGE_RUN_CRASH_EXIT_CODE,
	CHANGE_RUN_CRASH_RUN_ID,
	ChangeRunWorkers,
} from "./helpers/change-run-workers.js";

const execute = promisify(execFile);
const directories: string[] = [];

class TestArtifactStore extends ArtifactStore {
	missingStepId?: string;

	override latest(runId: string, stepId: string, output: string) {
		return stepId === this.missingStepId
			? Promise.resolve(undefined)
			: super.latest(runId, stepId, output);
	}
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createRepository() {
	const parent = await mkdtemp(join(tmpdir(), "pi-orchestrator-change-run-"));
	directories.push(parent);
	const repositoryRoot = join(parent, "repository");
	await execute("git", ["init", "-b", "main", repositoryRoot]);
	await execute("git", ["config", "user.name", "Test"], {
		cwd: repositoryRoot,
	});
	await execute("git", ["config", "user.email", "test@example.com"], {
		cwd: repositoryRoot,
	});
	await writeFile(join(repositoryRoot, "README.md"), "base\n");
	await execute("git", ["add", "README.md"], { cwd: repositoryRoot });
	await execute("git", ["commit", "-m", "Initial"], { cwd: repositoryRoot });
	return { parent, repositoryRoot };
}

function taskPlan(): TaskPlan {
	return {
		version: 3,
		title: "Reviewed feature",
		tasks: [
			{
				id: "implementation",
				title: "Implementation",
				description: "Implement the feature",
				dependencies: [],
				acceptanceCriteria: ["Implementation exists"],
				allowedPaths: ["src/"],
				validationCommands: [
					{
						command: process.execPath,
						args: ["-e", "require('node:fs').accessSync('src/result.txt')"],
					},
				],
			},
		],
		finalValidationCommands: [{ command: process.execPath, args: ["-e", ""] }],
	};
}

async function createHarness(
	findingPath?: string,
	findingSeverity: ReviewSeverity = "high",
	failFinalValidationOnce = false,
) {
	const { parent, repositoryRoot } = await createRepository();
	const git = new GitCli();
	const repository = await git.inspect(repositoryRoot);
	const workers = new ChangeRunWorkers({
		path: findingPath ?? "src/review-fix.txt",
		severity: findingSeverity,
	});
	const store = new RunStore(join(parent, "runs"));
	const worktrees = new GitWorktreeManager(git, join(parent, "worktrees"));
	const securityPolicy = readSecurityPolicy({});
	const localFinalValidator = new LocalFinalValidator(git);
	let finalValidationCalls = 0;
	const finalValidator: FinalValidator = failFinalValidationOnce
		? {
				validate(input) {
					finalValidationCalls += 1;
					return localFinalValidator.validate(
						finalValidationCalls === 1
							? {
									...input,
									commands: [
										{
											command: process.execPath,
											args: ["-e", "process.exit(1)"],
										},
									],
								}
							: input,
					);
				},
			}
		: localFinalValidator;
	const dependencies = {
		store,
		workflowStates: new FileWorkflowStateStore(join(parent, "workflow-runs")),
		artifacts: new TestArtifactStore(join(parent, "artifacts")),
		workers,
		git,
		worktrees,
		validator: new LocalTaskValidator(git),
		finalValidator,
		securityPolicy,
	};
	const created = await new Orchestrator({
		store,
		git,
		worktrees,
		workers,
		validator: dependencies.validator,
		finalValidator: dependencies.finalValidator,
	}).createRun({
		repository,
		requestPath: join(repositoryRoot, "request.md"),
		requestText: "Implement and independently review the feature",
		plan: taskPlan(),
	});
	return {
		parent,
		repositoryRoot,
		git,
		repository,
		store,
		workers,
		dependencies,
		run: created,
		runner: new EngineChangeRunner(dependencies),
	};
}

function findingsOf(run: OrchestrationRun) {
	return run.reviewAttempts.flatMap((attempt) => attempt.findings ?? []);
}

describe("live /orchestrate change runs on the engine", () => {
	it("implements, reviews, repairs, verifies, and records merge-ready evidence", async () => {
		const harness = await createHarness();
		const updates: OrchestrationRun[] = [];

		const launch = await harness.runner.approveAndLaunch(
			harness.run,
			harness.repository,
			undefined,
			{ onRunUpdated: (run) => updates.push(run) },
		);
		const completed = await launch.completion;

		expect(completed.state).toBe("completed");
		expect(completed.approvedPlanRevision).toBe(1);
		expect(completed.tasks.implementation?.state).toBe("succeeded");
		expect(completed.tasks.implementation?.integratedCommit).toEqual(
			expect.any(String),
		);
		expect(completed.attempts).toEqual([
			expect.objectContaining({
				taskId: "implementation",
				state: "succeeded",
				commit: expect.any(String),
				evidence: expect.objectContaining({ passed: true }),
			}),
		]);

		// The finding the first round raised was repaired, and the round after
		// the repair reviewed the repaired head with fresh reviewers.
		expect(completed.repairAttempts).toEqual([
			expect.objectContaining({
				round: 1,
				state: "succeeded",
				commit: expect.any(String),
				integratedCommit: expect.any(String),
			}),
		]);
		expect(
			findingsOf(completed).find(
				(finding) => finding.title === "Missing review fix",
			),
		).toMatchObject({
			status: "repaired",
			repairAttemptId: completed.repairAttempts[0]?.id,
		});
		expect(completed.reviewRounds.map((round) => round.state)).toEqual([
			"succeeded",
			"succeeded",
			"succeeded",
		]);
		expect(completed.reviewAttempts).toHaveLength(REVIEW_CATEGORIES.length * 3);
		// Round 3 reviewed a head nothing changed, so it cost no workers.
		expect(
			harness.workers.prompts.filter((prompt) =>
				prompt.includes("reviewer for orchestration run"),
			),
		).toHaveLength(REVIEW_CATEGORIES.length * 2);

		expect(completed.finalValidationAttempts).toEqual([
			expect.objectContaining({
				number: 1,
				state: "succeeded",
				integrationCommit: completed.integrationHead,
			}),
		]);
		expect(completed.mergeReadyEvidence?.integrationHead).toBe(
			completed.integrationHead,
		);
		expect(
			completed.mergeReadyEvidence?.commits.map((entry) => entry.kind),
		).toEqual(["task", "repair"]);
		expect(completed.mergeReadyEvidence?.finalReviews).toHaveLength(
			REVIEW_CATEGORIES.length,
		);

		// The user's branch and worktree were never touched.
		const repository = await harness.git.inspect(harness.repositoryRoot);
		expect(repository.isClean).toBe(true);
		expect(repository.head).toBe(harness.repository.head);
		expect(completed.integrationHead).not.toBe(harness.repository.head);

		// The stored run stayed inspectable throughout, not only at the end.
		expect(updates.length).toBeGreaterThan(0);
		expect(await harness.store.load(harness.run.id)).toEqual(completed);
	});

	it("resumes an interrupted run from durable state alone", async () => {
		const parent = await mkdtemp(join(tmpdir(), "pi-orchestrator-resume-"));
		directories.push(parent);
		const repositoryRoot = join(parent, "repository");
		await execute("git", ["init", "-b", "main", repositoryRoot]);
		await execute("git", ["config", "user.name", "Test"], {
			cwd: repositoryRoot,
		});
		await execute("git", ["config", "user.email", "test@example.com"], {
			cwd: repositoryRoot,
		});
		await writeFile(join(repositoryRoot, "README.md"), "base\n");
		await execute("git", ["add", "README.md"], { cwd: repositoryRoot });
		await execute("git", ["commit", "-m", "Initial"], { cwd: repositoryRoot });

		const runDirectory = join(parent, "runs");
		const stateDirectory = join(parent, "workflow-runs");
		const artifactDirectory = join(parent, "artifacts");
		const worktreeRoot = join(parent, "worktrees");
		// A real process dies once the implementation commit and its evidence are
		// durable but before the engine could record either.
		await expect(
			execute(
				"npm",
				[
					"run",
					"test:change-run-crash-fixture",
					"--",
					repositoryRoot,
					runDirectory,
					stateDirectory,
					artifactDirectory,
					worktreeRoot,
				],
				{ cwd: process.cwd() },
			),
		).rejects.toMatchObject({ code: CHANGE_RUN_CRASH_EXIT_CODE });

		const git = new GitCli();
		const store = new RunStore(runDirectory);
		const interrupted = await store.load(CHANGE_RUN_CRASH_RUN_ID);
		expect(interrupted.state).toBe("running");
		expect(interrupted.mergeReadyEvidence).toBeUndefined();

		const runner = new EngineChangeRunner({
			store,
			workflowStates: new FileWorkflowStateStore(stateDirectory),
			artifacts: new ArtifactStore(artifactDirectory),
			workers: new ChangeRunWorkers(),
			git,
			worktrees: new GitWorktreeManager(git, worktreeRoot),
			validator: new LocalTaskValidator(git),
			finalValidator: new LocalFinalValidator(git),
			securityPolicy: readSecurityPolicy({}),
		});
		const resumed = await runner.resume(
			interrupted,
			await git.inspect(repositoryRoot),
		);
		const completed = await resumed.completion;

		expect(completed.state).toBe("completed");
		// The interrupted attempt was adopted with the checks that justified it,
		// rather than repeating work that was already durable.
		expect(completed.attempts).toEqual([
			expect.objectContaining({
				taskId: "implementation",
				number: 1,
				state: "succeeded",
				evidence: expect.objectContaining({ passed: true }),
			}),
		]);
		expect(completed.mergeReadyEvidence?.integrationHead).toBe(
			completed.integrationHead,
		);
	}, 120_000);

	it("cancels a running run and stops its workers", async () => {
		const harness = await createHarness();
		let workerStarted = () => {};
		const started = new Promise<void>((resolve) => {
			workerStarted = resolve;
		});
		let releaseWorker = () => {};
		const held = new Promise<void>((resolve) => {
			releaseWorker = resolve;
		});
		harness.workers.onChangeWorker = async () => {
			workerStarted();
			await held;
		};

		const launch = await harness.runner.approveAndLaunch(
			harness.run,
			harness.repository,
		);
		await started;
		const cancelled = await harness.runner.cancel(
			await harness.store.load(harness.run.id),
			harness.repository,
		);
		expect(cancelled.state).toBe("cancelled");

		releaseWorker();
		const settled = await launch.completion;

		expect(settled.state).toBe("cancelled");
		expect(settled.mergeReadyEvidence).toBeUndefined();
		// Nothing was reviewed, and every worker this run started was stopped.
		expect(settled.reviewAttempts).toEqual([]);
		expect(
			[...harness.workers.workers.values()].every(
				(worker) => worker.status === "stopped",
			),
		).toBe(true);
	}, 120_000);

	it("refuses to recover a run that is still executing in this process", async () => {
		const harness = await createHarness();
		let workerStarted = () => {};
		const started = new Promise<void>((resolve) => {
			workerStarted = resolve;
		});
		let releaseWorker = () => {};
		const held = new Promise<void>((resolve) => {
			releaseWorker = resolve;
		});
		harness.workers.onChangeWorker = async () => {
			workerStarted();
			await held;
		};

		const launch = await harness.runner.approveAndLaunch(
			harness.run,
			harness.repository,
		);
		await started;
		await expect(
			harness.runner.resume(
				await harness.store.load(harness.run.id),
				harness.repository,
			),
		).rejects.toThrow(/active lifecycle work/);

		releaseWorker();
		expect((await launch.completion).state).toBe("completed");
	}, 120_000);

	it("allows only one concurrent resume to own the run lifecycle", async () => {
		const harness = await createHarness(undefined, "high", true);
		const failed = await (
			await harness.runner.approveAndLaunch(harness.run, harness.repository)
		).completion;
		let enteredHas = () => {};
		const hasStarted = new Promise<void>((resolve) => {
			enteredHas = resolve;
		});
		let releaseHas = () => {};
		const heldHas = new Promise<void>((resolve) => {
			releaseHas = resolve;
		});
		const originalHas = harness.dependencies.workflowStates.has.bind(
			harness.dependencies.workflowStates,
		);
		let hasCalls = 0;
		harness.dependencies.workflowStates.has = async (runId) => {
			hasCalls += 1;
			if (hasCalls === 1) {
				enteredHas();
				await heldHas;
			}
			return originalHas(runId);
		};

		const first = harness.runner.resume(failed, harness.repository);
		await hasStarted;
		await expect(
			harness.runner.resume(failed, harness.repository),
		).rejects.toThrow(/active lifecycle work/);
		releaseHas();

		const resumed = await first;
		expect((await resumed.completion).state).toBe("completed");
	}, 120_000);

	it("keeps a run cancelled when final validation is aborted", async () => {
		const harness = await createHarness();
		let validationStarted = () => {};
		const started = new Promise<void>((resolve) => {
			validationStarted = resolve;
		});
		harness.dependencies.finalValidator = {
			validate(input) {
				validationStarted();
				return new Promise<never>((_resolve, reject) => {
					const abort = () => {
						const now = new Date().toISOString();
						reject(
							new FinalValidationError("Final validation aborted", {
								startedAt: now,
								finishedAt: now,
								passed: false,
								checks: [],
							}),
						);
					};
					if (input.signal?.aborted) {
						abort();
					} else {
						input.signal?.addEventListener("abort", abort, { once: true });
					}
				});
			},
		};

		const launch = await harness.runner.approveAndLaunch(
			harness.run,
			harness.repository,
		);
		await started;
		const validating = await harness.store.load(harness.run.id);
		expect(validating.state).toBe("validating");
		expect(validating.finalValidationAttempts.at(-1)?.state).toBe("running");

		const cancelled = await harness.runner.cancel(
			validating,
			harness.repository,
		);
		expect(cancelled.state).toBe("cancelled");
		expect(cancelled.finalValidationAttempts.at(-1)?.state).toBe("cancelled");

		const settled = await launch.completion;
		expect(settled.state).toBe("cancelled");
		expect(settled.mergeReadyEvidence).toBeUndefined();
		expect((await harness.store.load(harness.run.id)).state).toBe("cancelled");
	}, 120_000);

	it("records a review evidence gap without a validation attempt", async () => {
		const harness = await createHarness();
		harness.dependencies.artifacts.missingStepId = "review-3-security";

		const failed = await (
			await harness.runner.approveAndLaunch(harness.run, harness.repository)
		).completion;

		expect(failed.state).toBe("failed");
		expect(failed.finalValidationAttempts).toEqual([]);
		expect(failed.reviewRounds.at(-1)).toMatchObject({
			state: "failed",
			error: expect.stringContaining("Review evidence is unavailable"),
		});
		expect(retryableRunWork(failed)).toMatchObject({
			retryable: false,
			reasonCode: "review-phase-unsupported",
		});
	}, 120_000);

	it("settles an unexpected finalization exception", async () => {
		const harness = await createHarness();
		harness.dependencies.finalValidator = {
			async validate() {
				throw new Error("Final validator crashed");
			},
		};

		const failed = await (
			await harness.runner.approveAndLaunch(harness.run, harness.repository)
		).completion;

		expect(failed.state).toBe("failed");
		expect(failed.finalValidationAttempts.at(-1)).toMatchObject({
			state: "failed",
			error: "Final validator crashed",
		});
		expect(await harness.store.load(harness.run.id)).toEqual(failed);
	}, 120_000);

	it("interrupts stale final validation before resuming", async () => {
		const harness = await createHarness(undefined, "high", true);
		const failed = await (
			await harness.runner.approveAndLaunch(harness.run, harness.repository)
		).completion;
		const stale = await harness.store.transaction(failed.id, (stored) => ({
			...stored,
			state: "validating",
			finalValidationAttempts: stored.finalValidationAttempts.map((attempt) => {
				const {
					error: _error,
					evidence: _evidence,
					finishedAt: _finishedAt,
					...retained
				} = attempt;
				return { ...retained, state: "running" as const };
			}),
		}));

		const resumed = await harness.runner.resume(stale, harness.repository);
		const completed = await resumed.completion;

		expect(completed.state).toBe("completed");
		expect(
			completed.finalValidationAttempts.map((attempt) => attempt.state),
		).toEqual(["interrupted", "succeeded"]);
	}, 120_000);

	it("retries the failed work of a settled run without losing its history", async () => {
		const harness = await createHarness();
		harness.workers.failNextChange = true;

		const failed = await (
			await harness.runner.approveAndLaunch(harness.run, harness.repository)
		).completion;
		expect(failed.state).toBe("failed");
		expect(failed.tasks.implementation?.state).toBe("failed");
		expect(failed.mergeReadyEvidence).toBeUndefined();

		const completed = await (
			await harness.runner.retry(failed, harness.repository)
		).completion;

		expect(completed.state).toBe("completed");
		// The first attempt is still on the record; the retry is the next one.
		expect(
			completed.attempts.map((attempt) => [attempt.number, attempt.state]),
		).toEqual([
			[1, "failed"],
			[2, "succeeded"],
		]);
		expect(completed.mergeReadyEvidence?.integrationHead).toBe(
			completed.integrationHead,
		);
	}, 120_000);

	it("retries final validation after the workflow itself completed", async () => {
		const harness = await createHarness(undefined, "high", true);

		const failed = await (
			await harness.runner.approveAndLaunch(harness.run, harness.repository)
		).completion;
		expect(failed.state).toBe("failed");
		expect(failed.finalValidationAttempts).toEqual([
			expect.objectContaining({ number: 1, state: "failed" }),
		]);

		const completed = await (
			await harness.runner.retry(failed, harness.repository)
		).completion;

		expect(completed.state).toBe("completed");
		expect(
			completed.finalValidationAttempts.map((attempt) => [
				attempt.number,
				attempt.state,
			]),
		).toEqual([
			[1, "failed"],
			[2, "succeeded"],
		]);
		expect(completed.attempts).toHaveLength(1);
		expect(
			harness.workers.prompts.filter((prompt) => prompt.includes("reviewer")),
		).toHaveLength(REVIEW_CATEGORIES.length * 2);
	}, 120_000);

	it("re-keys deferred findings adopted by later review rounds", async () => {
		const harness = await createHarness("src/follow-up.txt", "low");

		const completed = await (
			await harness.runner.approveAndLaunch(harness.run, harness.repository)
		).completion;
		const deferred = findingsOf(completed).filter(
			(finding) => finding.title === "Missing review fix",
		);

		expect(completed.state).toBe("completed");
		expect(deferred.map((finding) => finding.id)).toEqual([
			"review-1-security-001",
			"review-2-security-001",
			"review-3-security-001",
		]);
		expect(deferred.every((finding) => finding.status === "deferred")).toBe(
			true,
		);
		expect(completed.repairAttempts).toEqual([]);
	}, 120_000);

	it("leaves a run that executed under the legacy orchestrator alone", async () => {
		const harness = await createHarness();
		const legacy = await new Orchestrator({
			store: harness.store,
			git: harness.git,
			worktrees: harness.dependencies.worktrees,
			workers: harness.workers,
			validator: harness.dependencies.validator,
			finalValidator: harness.dependencies.finalValidator,
		}).approveAndLaunch(harness.run, harness.repository);
		const executed = await legacy.completion;

		// The legacy lifecycle owns this run: it has no engine snapshot, and its
		// attempts, worktrees, and review rounds were created by that lifecycle.
		expect(hasLegacyExecutionState(executed)).toBe(true);
		expect(await harness.runner.hasWorkflowState(executed.id)).toBe(false);
		await expect(
			harness.runner.resume(executed, harness.repository),
		).rejects.toThrow(/legacy orchestrator/);
		// It also stays fully inspectable through the same stored run surface.
		expect(await harness.store.load(executed.id)).toEqual(executed);
	}, 120_000);

	it("fails the run when a finding needs changes outside the approved paths", async () => {
		const harness = await createHarness("README.md");

		const launch = await harness.runner.approveAndLaunch(
			harness.run,
			harness.repository,
		);
		const settled = await launch.completion;

		expect(settled.state).toBe("failed");
		expect(settled.mergeReadyEvidence).toBeUndefined();
		// The repair refused the work rather than giving a worker authority it
		// could not legally use, and the run records why.
		expect(settled.repairAttempts).toEqual([
			expect.objectContaining({
				round: 1,
				state: "failed",
				error: expect.stringContaining("outside approved paths"),
			}),
		]);
		expect(settled.repairAttempts[0]?.commit).toBeUndefined();
		expect(
			harness.workers.prompts.some((prompt) =>
				prompt.includes("You are the repair worker"),
			),
		).toBe(false);
		expect(
			findingsOf(settled).find(
				(finding) => finding.title === "Missing review fix",
			),
		).toMatchObject({ status: "repair_required", paths: ["README.md"] });
	});
});
