import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { BuildConductor } from "../src/conductor.js";
import { GitCli } from "../src/git/git.js";
import { GitWorktreeManager } from "../src/git/worktrees.js";
import {
	REVIEW_REPORT_END,
	REVIEW_REPORT_START,
} from "../src/review/review-report.js";
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

class ReviewFlowWorkers implements WorkerBackend {
	readonly workers = new Map<string, WorkerInstance>();
	readonly labels: string[] = [];
	private nextWorker = 1;
	private emittedFinding = false;

	constructor(private readonly findingPath = "src/review-fix.txt") {}

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		const worker: WorkerInstance = {
			id: `worker-${this.nextWorker++}`,
			status: "online",
			cwd: request.cwd,
			...(request.label ? { label: request.label } : {}),
		};
		this.workers.set(worker.id, worker);
		this.labels.push(request.label ?? "");
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

	async startPrompt(
		workerId: string,
		prompt: string,
		_options: WorkerExecutionOptions = {},
	): Promise<WorkerExecution> {
		const worker = await this.status(workerId);
		if (prompt.includes("isolated implementation worker")) {
			await mkdir(join(worker.cwd, "src"), { recursive: true });
			await writeFile(join(worker.cwd, "src", "result.txt"), "implemented\n");
			return { completion: Promise.resolve({ status: "succeeded" }) };
		}
		if (prompt.includes("isolated repair worker")) {
			await mkdir(join(worker.cwd, "src"), { recursive: true });
			await writeFile(join(worker.cwd, "src", "review-fix.txt"), "repaired\n");
			return { completion: Promise.resolve({ status: "succeeded" }) };
		}
		const category = prompt.match(
			/independent (correctness|security|maintainability|tests|documentation) reviewer/,
		)?.[1];
		const baseCommit = prompt.match(
			/Review the complete integrated result at commit ([^,]+),/,
		)?.[1];
		if (!category || !baseCommit) {
			throw new Error("Unexpected worker prompt");
		}
		const findings =
			category === "correctness" && !this.emittedFinding
				? [
						{
							severity: "high",
							confidence: "high",
							title: "Missing review fix",
							description: "The implementation needs the required review fix.",
							paths: [this.findingPath],
							recommendation: "Create the review fix file.",
						},
					]
				: [];
		if (findings.length > 0) {
			this.emittedFinding = true;
		}
		return {
			completion: Promise.resolve({
				status: "succeeded",
				output: `${REVIEW_REPORT_START}\n${JSON.stringify({
					version: 1,
					category,
					baseCommit,
					summary:
						findings.length > 0 ? "One important finding" : "No findings",
					findings,
				})}\n${REVIEW_REPORT_END}`,
			}),
		};
	}

	async stop(workerId: string): Promise<void> {
		const worker = await this.status(workerId);
		worker.status = "stopped";
	}
}

async function createRepository() {
	const parent = await mkdtemp(join(tmpdir(), "pi-build-review-flow-"));
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

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("independent review and repair lifecycle", () => {
	it("repairs important findings and verifies the repaired integration head with fresh reviewers", async () => {
		const { parent, repositoryRoot } = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const workers = new ReviewFlowWorkers();
		const store = new RunStore(join(parent, "runs"));
		const conductor = new BuildConductor({
			store,
			git,
			worktrees: new GitWorktreeManager(git, join(parent, "worktrees")),
			workers,
			validator: new LocalTaskValidator(git),
			finalValidator: new LocalFinalValidator(git),
		});
		const run = await conductor.createRun({
			repository,
			handoffPath: join(repositoryRoot, "handoff.md"),
			handoffText: "Implement and independently review the feature",
			plan: {
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
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
			},
		});

		const result = await conductor.approveAndLaunch(run, repository);
		const completed = await result.completion;

		expect(completed.state).toBe("completed");
		expect(completed.reviewRounds).toHaveLength(2);
		expect(completed.reviewAttempts).toHaveLength(10);
		expect(completed.repairAttempts).toEqual([
			expect.objectContaining({
				state: "succeeded",
				commit: expect.any(String),
				integratedCommit: expect.any(String),
			}),
		]);
		expect(
			completed.reviewAttempts
				.flatMap((attempt) => attempt.findings ?? [])
				.find((finding) => finding.title === "Missing review fix"),
		).toMatchObject({
			status: "repaired",
			repairAttemptId: expect.any(String),
		});
		expect(new Set(workers.workers.keys()).size).toBe(12);
		expect(await git.branchHead(repositoryRoot, "main")).toBe(repository.head);
		expect(completed.integrationHead).not.toBe(repository.head);

		const completedRepair = completed.repairAttempts[0];
		const completedRound = completed.reviewRounds[0];
		if (!completedRepair?.integratedCommit || !completedRound) {
			throw new Error("Expected an integrated repair and first review round");
		}
		const {
			integratedCommit: recoveredIntegratedCommit,
			finishedAt: _repairFinishedAt,
			...repairBeforePersistence
		} = completedRepair;
		const { finishedAt: _roundFinishedAt, ...roundBeforePersistence } =
			completedRound;
		const {
			mergeReadyEvidence: _mergeReadyEvidence,
			...beforeFinalValidation
		} = completed;
		await store.save({
			...beforeFinalValidation,
			state: "repairing",
			integrationHead: completedRepair.baseCommit,
			finalValidationAttempts: [],
			repairAttempts: [{ ...repairBeforePersistence, state: "validating" }],
			reviewRounds: [{ ...roundBeforePersistence, state: "repairing" }],
			reviewAttempts: completed.reviewAttempts
				.filter((attempt) => attempt.round === 1)
				.map((attempt) => ({
					...attempt,
					...(attempt.findings
						? {
								findings: attempt.findings.map((finding) => {
									const { repairAttemptId: _repairAttemptId, ...unrepaired } =
										finding;
									return { ...unrepaired, status: "repair_required" as const };
								}),
							}
						: {}),
				})),
		});

		const recovered = await conductor.recoverRun(run.id);
		expect(recovered.state).toBe("reviewing");
		expect(recovered.integrationHead).toBe(recoveredIntegratedCommit);
		expect(recovered.repairAttempts[0]).toMatchObject({
			state: "succeeded",
			integratedCommit: recoveredIntegratedCommit,
		});
		expect(recovered.reviewRounds).toHaveLength(2);
	});

	it("fails important findings outside the approved repair scope", async () => {
		const { parent, repositoryRoot } = await createRepository();
		const git = new GitCli();
		const repository = await git.inspect(repositoryRoot);
		const workers = new ReviewFlowWorkers("README.md");
		const conductor = new BuildConductor({
			store: new RunStore(join(parent, "runs")),
			git,
			worktrees: new GitWorktreeManager(git, join(parent, "worktrees")),
			workers,
			validator: new LocalTaskValidator(git),
			finalValidator: new LocalFinalValidator(git),
		});
		const run = await conductor.createRun({
			repository,
			handoffPath: join(repositoryRoot, "handoff.md"),
			handoffText: "Keep repairs within approved source paths",
			plan: {
				version: 3,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", ""] },
				],
				title: "Scoped feature",
				tasks: [
					{
						id: "implementation",
						title: "Implementation",
						description: "Implement the feature",
						dependencies: [],
						acceptanceCriteria: ["Implementation exists"],
						allowedPaths: ["src/"],
						validationCommands: [
							{ command: process.execPath, args: ["-e", ""] },
						],
					},
				],
			},
		});

		const result = await conductor.approveAndLaunch(run, repository);
		const completed = await result.completion;

		expect(completed.state).toBe("failed");
		expect(completed.repairAttempts).toEqual([]);
		expect(
			completed.reviewAttempts
				.flatMap((attempt) => attempt.findings ?? [])
				.find((finding) => finding.title === "Missing review fix"),
		).toMatchObject({ status: "unresolved", paths: ["README.md"] });
		expect(workers.labels.some((label) => label.includes(":repair:"))).toBe(
			false,
		);
	});
});
