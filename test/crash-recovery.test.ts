import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { BuildConductor } from "../src/conductor.js";
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

const execute = promisify(execFile);
const directories: string[] = [];

class RecoveryWorkers implements WorkerBackend {
	async spawn(): Promise<never> {
		throw new Error("Recovery must not spawn a worker");
	}

	async list() {
		return [];
	}

	async status(): Promise<never> {
		throw new Error("Recovery has no live workers");
	}

	async sendPrompt(): Promise<never> {
		throw new Error("Recovery must not send a prompt");
	}

	async startPrompt(): Promise<never> {
		throw new Error("Recovery must not start a prompt");
	}

	async stop(): Promise<never> {
		throw new Error("Recovery has no live workers to stop");
	}
}

class ReviewRecoveryWorkers implements WorkerBackend {
	private readonly workers = new Map<string, WorkerInstance>();
	private nextWorker = 1;

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		const worker: WorkerInstance = {
			id: `review-recovery-${this.nextWorker++}`,
			status: "online",
			cwd: request.cwd,
			...(request.label ? { label: request.label } : {}),
		};
		this.workers.set(worker.id, worker);
		return worker;
	}

	async list(): Promise<WorkerInstance[]> {
		return [...this.workers.values()];
	}

	async status(workerId: string): Promise<WorkerInstance> {
		const worker = this.workers.get(workerId);
		if (!worker) {
			throw new Error(`Unknown worker ${workerId}`);
		}
		return worker;
	}

	async sendPrompt(): Promise<void> {}

	async startPrompt(
		workerId: string,
		prompt: string,
		_options: WorkerExecutionOptions = {},
	): Promise<WorkerExecution> {
		await this.status(workerId);
		const category = prompt.match(
			/independent (correctness|security|maintainability|tests|documentation) reviewer/,
		)?.[1];
		const baseCommit = prompt.match(
			/Review the complete integrated result at commit ([^,]+),/,
		)?.[1];
		if (!category || !baseCommit) {
			throw new Error("Review recovery worker received a non-review prompt");
		}
		return {
			completion: Promise.resolve({
				status: "succeeded",
				output: `BEGIN_PI_BUILD_REVIEW_REPORT\n${JSON.stringify({
					version: 1,
					category,
					baseCommit,
					summary: "Recovered review completed",
					findings: [],
				})}\nEND_PI_BUILD_REVIEW_REPORT`,
			}),
		};
	}

	async stop(workerId: string): Promise<void> {
		const worker = await this.status(workerId);
		worker.status = "stopped";
	}
}

async function createRepository(): Promise<{
	parent: string;
	repositoryRoot: string;
}> {
	const parent = await mkdtemp(join(tmpdir(), "pi-build-crash-recovery-"));
	directories.push(parent);
	const repositoryRoot = join(parent, "repository");
	await execute("git", ["init", "-b", "main", repositoryRoot]);
	await execute("git", ["config", "user.name", "Test"], {
		cwd: repositoryRoot,
	});
	await execute("git", ["config", "user.email", "test@example.com"], {
		cwd: repositoryRoot,
	});
	await writeFile(join(repositoryRoot, "base.txt"), "base\n", "utf8");
	await execute("git", ["add", "base.txt"], { cwd: repositoryRoot });
	await execute("git", ["commit", "-m", "Initial"], { cwd: repositoryRoot });
	return { parent, repositoryRoot };
}

async function runCrashFixture(
	boundary:
		| "task-commit"
		| "integration"
		| "final-validation"
		| "review-persistence"
		| "repair-integration",
	exitCode: number,
) {
	const { parent, repositoryRoot } = await createRepository();
	const runDirectory = join(parent, "runs");
	const worktreeRoot = join(parent, "worktrees");
	await expect(
		execute(
			"npm",
			[
				"run",
				"test:crash-fixture",
				"--",
				repositoryRoot,
				runDirectory,
				worktreeRoot,
				boundary,
			],
			{ cwd: process.cwd() },
		),
	).rejects.toMatchObject({ code: exitCode });

	const store = new RunStore(runDirectory);
	const [crashed] = await store.list();
	if (!crashed) {
		throw new Error("Crash fixture did not persist a run");
	}
	return {
		crashed,
		git: new GitCli(),
		repositoryRoot,
		store,
		worktreeRoot,
	};
}

function recoveryConductor(
	store: RunStore,
	git: GitCli,
	worktreeRoot: string,
	workers: WorkerBackend = new RecoveryWorkers(),
): BuildConductor {
	return new BuildConductor({
		store,
		git,
		worktrees: new GitWorktreeManager(git, worktreeRoot),
		workers,
		validator: new LocalTaskValidator(git),
		finalValidator: new LocalFinalValidator(git),
	});
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("process crash recovery", () => {
	it("recovers a real Git commit created just before state persistence", async () => {
		const { crashed, git, repositoryRoot, store, worktreeRoot } =
			await runCrashFixture("task-commit", 86);
		expect(crashed).toMatchObject({
			state: "running",
			tasks: { implementation: { state: "validating" } },
			attempts: [{ state: "validating", evidence: { passed: true } }],
		});

		const crashedAttempt = crashed.attempts[0];
		if (!crashedAttempt) {
			throw new Error("Crash fixture did not persist its task attempt");
		}
		expect(crashedAttempt.commit).toBeUndefined();
		const committedHead = await git.branchHead(
			repositoryRoot,
			crashedAttempt.branch,
		);
		expect(committedHead).not.toBe(crashedAttempt.baseCommit);

		const recovered = await recoveryConductor(
			store,
			git,
			worktreeRoot,
		).recoverRun(crashed.id);

		expect(recovered.state).toBe("integrating");
		expect(recovered.attempts[0]).toMatchObject({
			state: "succeeded",
			commit: committedHead,
		});
		expect(recovered.tasks.implementation).toMatchObject({
			state: "succeeded",
			integratedCommit: expect.any(String),
		});
		const result = await execute(
			"git",
			["show", `${recovered.integrationBranch}:result.txt`],
			{ cwd: repositoryRoot },
		);
		expect(result.stdout).toBe("committed before crash\n");
		expect(await git.listWorktrees(repositoryRoot)).toHaveLength(1);
		expect(await git.inspect(repositoryRoot)).toMatchObject({
			currentBranch: "main",
			head: crashed.baseCommit,
			isClean: true,
		});
	}, 20_000);

	it("preserves a persisted reviewer and resumes only missing categories", async () => {
		const { crashed, git, repositoryRoot, store, worktreeRoot } =
			await runCrashFixture("review-persistence", 89);
		const persistedReviews = crashed.reviewAttempts.filter(
			(attempt) => attempt.state === "succeeded",
		);
		expect(crashed.state).toBe("reviewing");
		expect(persistedReviews).toHaveLength(1);
		const persistedReview = persistedReviews[0];
		if (!persistedReview) {
			throw new Error("Crash fixture did not persist a reviewer");
		}

		const conductor = recoveryConductor(
			store,
			git,
			worktreeRoot,
			new ReviewRecoveryWorkers(),
		);
		const recovered = await conductor.recoverRun(crashed.id);
		expect(recovered.state).toBe("reviewing");
		expect(
			recovered.reviewAttempts.find(
				(attempt) => attempt.id === persistedReview.id,
			),
		).toMatchObject({ state: "succeeded", category: persistedReview.category });
		expect(
			recovered.reviewAttempts
				.filter((attempt) => attempt.id !== persistedReview.id)
				.every((attempt) => attempt.state === "interrupted"),
		).toBe(true);

		const repository = await git.inspect(repositoryRoot);
		const completed = await (
			await conductor.resumeAndLaunch(recovered, repository)
		).completion;
		const succeededReviews = completed.reviewAttempts.filter(
			(attempt) => attempt.state === "succeeded",
		);

		expect(completed.state).toBe("completed");
		expect(succeededReviews).toHaveLength(5);
		expect(
			new Set(succeededReviews.map((attempt) => attempt.category)).size,
		).toBe(5);
		expect(
			succeededReviews.some((attempt) => attempt.id === persistedReview.id),
		).toBe(true);
		expect(completed.mergeReadyEvidence).toBeDefined();
		expect(await git.listWorktrees(repositoryRoot)).toHaveLength(1);
		expect(await git.inspect(repositoryRoot)).toMatchObject({
			currentBranch: "main",
			head: crashed.baseCommit,
			isClean: true,
		});
	}, 20_000);

	it("reconciles a repair integration created just before persistence", async () => {
		const { crashed, git, repositoryRoot, store, worktreeRoot } =
			await runCrashFixture("repair-integration", 90);
		const repair = crashed.repairAttempts[0];
		if (!repair?.commit) {
			throw new Error("Crash fixture did not persist its repair commit");
		}
		expect(crashed).toMatchObject({
			state: "repairing",
			repairAttempts: [
				{
					state: "validating",
					commit: repair.commit,
					evidence: { passed: true },
				},
			],
		});
		expect(repair.integratedCommit).toBeUndefined();
		const advancedHead = await git.branchHead(
			repositoryRoot,
			crashed.integrationBranch,
		);
		expect(advancedHead).not.toBe(repair.baseCommit);

		const conductor = recoveryConductor(
			store,
			git,
			worktreeRoot,
			new ReviewRecoveryWorkers(),
		);
		const recovered = await conductor.recoverRun(crashed.id);
		const recoveredAgain = await conductor.recoverRun(crashed.id);
		const recoveredRepair = recovered.repairAttempts[0];

		expect(recovered).toMatchObject({
			state: "reviewing",
			integrationHead: advancedHead,
			repairAttempts: [
				{
					state: "succeeded",
					commit: repair.commit,
					integratedCommit: advancedHead,
				},
			],
			reviewRounds: [
				{ number: 1, state: "succeeded" },
				{ number: 2, state: "running", baseCommit: advancedHead },
			],
		});
		if (!recoveredRepair) {
			throw new Error("Recovered run lost its repair attempt");
		}
		expect(
			recovered.reviewAttempts
				.flatMap((attempt) => attempt.findings ?? [])
				.find((finding) => recoveredRepair.findingIds.includes(finding.id)),
		).toMatchObject({
			status: "repaired",
			repairAttemptId: recoveredRepair.id,
		});
		expect(recoveredAgain.integrationHead).toBe(advancedHead);

		const repository = await git.inspect(repositoryRoot);
		const completed = await (
			await conductor.resumeAndLaunch(recoveredAgain, repository)
		).completion;
		expect(completed.state).toBe("completed");
		expect(completed.repairAttempts).toHaveLength(1);
		expect(
			await git.branchHead(repositoryRoot, completed.integrationBranch),
		).toBe(advancedHead);
		const history = await execute(
			"git",
			["rev-list", "--count", `${crashed.baseCommit}..${advancedHead}`],
			{ cwd: repositoryRoot },
		);
		expect(history.stdout.trim()).toBe("2");
		expect(await git.listWorktrees(repositoryRoot)).toHaveLength(1);
	}, 20_000);

	it("resumes final validation after a process crash before evidence persistence", async () => {
		const { crashed, git, repositoryRoot, store, worktreeRoot } =
			await runCrashFixture("final-validation", 88);
		expect(crashed).toMatchObject({
			state: "validating",
			tasks: {
				implementation: {
					state: "succeeded",
					integratedCommit: expect.any(String),
				},
			},
			finalValidationAttempts: [
				{
					state: "running",
				},
			],
		});
		expect(crashed.finalValidationAttempts[0]?.evidence).toBeUndefined();
		expect(crashed.reviewAttempts).toHaveLength(5);
		const conductor = recoveryConductor(store, git, worktreeRoot);

		const recovered = await conductor.recoverRun(crashed.id);
		expect(recovered).toMatchObject({
			state: "reviewed",
			finalValidationAttempts: [
				{
					state: "interrupted",
					error: "Conductor restarted",
				},
			],
		});
		const repository = await git.inspect(repositoryRoot);
		const completed = await (
			await conductor.resumeAndLaunch(recovered, repository)
		).completion;

		expect(completed.state).toBe("completed");
		expect(completed.reviewAttempts).toHaveLength(5);
		expect(completed.finalValidationAttempts).toMatchObject([
			{ state: "interrupted", error: "Conductor restarted" },
			{ state: "succeeded", evidence: { passed: true } },
		]);
		expect(completed.mergeReadyEvidence).toBeDefined();
		expect(await git.listWorktrees(repositoryRoot)).toHaveLength(1);
		expect(await git.inspect(repositoryRoot)).toMatchObject({
			currentBranch: "main",
			head: crashed.baseCommit,
			isClean: true,
		});
	}, 20_000);

	it("reconciles an integration ref advanced just before state persistence", async () => {
		const { crashed, git, repositoryRoot, store, worktreeRoot } =
			await runCrashFixture("integration", 87);
		expect(crashed).toMatchObject({
			state: "running",
			tasks: {
				implementation: {
					state: "succeeded",
				},
			},
			attempts: [
				{
					state: "succeeded",
					commit: expect.any(String),
					evidence: { passed: true },
				},
			],
		});
		expect(crashed.tasks.implementation?.integratedCommit).toBeUndefined();
		const advancedHead = await git.branchHead(
			repositoryRoot,
			crashed.integrationBranch,
		);
		expect(advancedHead).not.toBe(crashed.baseCommit);

		const conductor = recoveryConductor(store, git, worktreeRoot);
		const recovered = await conductor.recoverRun(crashed.id);
		const recoveredAgain = await conductor.recoverRun(crashed.id);

		expect(recovered).toMatchObject({
			state: "integrating",
			integrationHead: advancedHead,
			tasks: {
				implementation: {
					state: "succeeded",
					integratedCommit: advancedHead,
				},
			},
		});
		expect(recoveredAgain.integrationHead).toBe(advancedHead);
		expect(
			await git.branchHead(repositoryRoot, recovered.integrationBranch),
		).toBe(advancedHead);
		const history = await execute(
			"git",
			["rev-list", "--count", `${crashed.baseCommit}..${advancedHead}`],
			{ cwd: repositoryRoot },
		);
		expect(history.stdout.trim()).toBe("1");
		expect(await git.listWorktrees(repositoryRoot)).toHaveLength(1);
		expect(await git.inspect(repositoryRoot)).toMatchObject({
			currentBranch: "main",
			head: crashed.baseCommit,
			isClean: true,
		});
	}, 20_000);
});
