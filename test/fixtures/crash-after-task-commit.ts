import { writeFile } from "node:fs/promises";
import type { OrchestrationRun } from "../../src/domain/types.js";
import { GitCli, type TaskWorktreeSnapshot } from "../../src/git/git.js";
import { GitWorktreeManager } from "../../src/git/worktrees.js";
import { Orchestrator } from "../../src/orchestrator.js";
import { RunStore } from "../../src/storage/run-store.js";
import {
	type FinalValidationInput,
	LocalFinalValidator,
} from "../../src/validation/final-validator.js";
import { LocalTaskValidator } from "../../src/validation/task-validator.js";
import type {
	SpawnWorkerRequest,
	WorkerBackend,
	WorkerExecution,
	WorkerExecutionOptions,
	WorkerInstance,
} from "../../src/workers/backend.js";
import { reviewResult } from "../helpers/review.js";

const [repositoryRoot, runDirectory, worktreeRoot, crashBoundary] =
	process.argv.slice(2);
if (
	!repositoryRoot ||
	!runDirectory ||
	!worktreeRoot ||
	!(
		[
			"task-commit",
			"integration",
			"final-validation",
			"review-persistence",
			"repair-integration",
		] as const
	).includes(
		crashBoundary as
			| "task-commit"
			| "integration"
			| "final-validation"
			| "review-persistence"
			| "repair-integration",
	)
) {
	throw new Error(
		"Expected repository root, run directory, worktree root, and crash boundary arguments",
	);
}

class CrashAtStateBoundaryGit extends GitCli {
	private integrationCount = 0;

	override async commitTaskWork(
		worktreePath: string,
		expectedSnapshot: TaskWorktreeSnapshot,
		message: string,
	): Promise<string> {
		const commit = await super.commitTaskWork(
			worktreePath,
			expectedSnapshot,
			message,
		);
		if (crashBoundary === "task-commit") {
			process.exit(86);
		}
		return commit;
	}

	override async integrateCommit(
		repositoryRoot: string,
		branch: string,
		expectedHead: string,
		commit: string,
	): Promise<string> {
		const integratedCommit = await super.integrateCommit(
			repositoryRoot,
			branch,
			expectedHead,
			commit,
		);
		this.integrationCount += 1;
		if (crashBoundary === "integration") {
			process.exit(87);
		}
		if (crashBoundary === "repair-integration" && this.integrationCount === 2) {
			process.exit(90);
		}
		return integratedCommit;
	}
}

class WritingWorker implements WorkerBackend {
	private readonly workers = new Map<string, WorkerInstance>();
	private nextWorker = 1;

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		const worker: WorkerInstance = {
			id: `crashing-worker-${this.nextWorker++}`,
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
		const review = reviewResult(prompt);
		if (review) {
			if (
				crashBoundary === "repair-integration" &&
				prompt.includes("independent correctness reviewer")
			) {
				const baseCommit = prompt.match(
					/Review the complete integrated result at commit ([^,]+),/,
				)?.[1];
				if (!baseCommit) {
					throw new Error("Repair review prompt has no base commit");
				}
				return {
					completion: Promise.resolve({
						status: "succeeded",
						output: `BEGIN_PI_BUILD_REVIEW_REPORT\n${JSON.stringify({
							version: 1,
							category: "correctness",
							baseCommit,
							summary: "Repair is required",
							findings: [
								{
									severity: "high",
									confidence: "high",
									title: "Update the fixture",
									description: "The fixture requires a repair pass.",
									paths: ["result.txt"],
									recommendation: "Update result.txt.",
								},
							],
						})}\nEND_PI_BUILD_REVIEW_REPORT`,
					}),
				};
			}
			return { completion: Promise.resolve(review) };
		}
		const worker = await this.status(workerId);
		await writeFile(
			`${worker.cwd}/result.txt`,
			prompt.startsWith("You are the repair worker")
				? "repaired before crash\n"
				: "committed before crash\n",
			"utf8",
		);
		return { completion: Promise.resolve({ status: "succeeded" }) };
	}

	async stop(workerId: string): Promise<void> {
		const worker = await this.status(workerId);
		worker.status = "stopped";
	}
}

class CrashAfterReviewPersistenceStore extends RunStore {
	override async transaction(
		runId: string,
		mutate: (
			current: OrchestrationRun,
		) => OrchestrationRun | Promise<OrchestrationRun>,
	): Promise<OrchestrationRun> {
		const run = await super.transaction(runId, mutate);
		if (
			crashBoundary === "review-persistence" &&
			run.reviewAttempts.some((attempt) => attempt.state === "succeeded")
		) {
			process.exit(89);
		}
		return run;
	}
}

class CrashAfterFinalValidation extends LocalFinalValidator {
	override async validate(input: FinalValidationInput) {
		const evidence = await super.validate(input);
		if (crashBoundary === "final-validation") {
			process.exit(88);
		}
		return evidence;
	}
}

const git = new CrashAtStateBoundaryGit();
const repository = await git.inspect(repositoryRoot);
const orchestrator = new Orchestrator({
	store: new CrashAfterReviewPersistenceStore(runDirectory),
	git,
	worktrees: new GitWorktreeManager(git, worktreeRoot),
	workers: new WritingWorker(),
	validator: new LocalTaskValidator(git),
	finalValidator: new CrashAfterFinalValidation(git),
});
const run = await orchestrator.createRun({
	repository,
	requestPath: `${repositoryRoot}/request.md`,
	requestText: "Create the crash recovery fixture.",
	plan: {
		version: 3,
		title: "Crash after task commit",
		finalValidationCommands: [{ command: process.execPath, args: ["-e", ""] }],
		tasks: [
			{
				id: "implementation",
				title: "Implementation",
				description: "Write the exact recovery fixture.",
				dependencies: [],
				acceptanceCriteria: ["result.txt contains the expected text"],
				allowedPaths: ["result.txt"],
				validationCommands: [
					{
						command: process.execPath,
						args: ["-e", "require('node:fs').accessSync('result.txt')"],
					},
				],
			},
		],
	},
});
const launch = await orchestrator.approveAndLaunch(run, repository);
await launch.completion;
throw new Error(
	`Orchestrator completed instead of crashing at ${crashBoundary}`,
);
