import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { StepWorkerRunner } from "../src/engine/steps/worker-runner.js";
import { GitCli } from "../src/git/git.js";
import { GitWorktreeManager } from "../src/git/worktrees.js";
import { readSecurityPolicy } from "../src/security/policy.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import type {
	WorkerBackend,
	WorkerExecution,
	WorkerInstance,
} from "../src/workers/backend.js";
import { buildChangeWorkflowPlan } from "../src/workflows/change.js";
import {
	buildInvestigateWorkflowPlan,
	INVESTIGATE_REPORT_OUTPUT,
	investigateStepHandlers,
	SYNTHESIS_STEP_ID,
} from "../src/workflows/investigate.js";
import {
	describeFailedSteps,
	newWorkflowRunId,
	runReadOnlyWorkflow,
} from "../src/workflows/runner.js";

const execute = promisify(execFile);
const directories: string[] = [];
const securityPolicy = readSecurityPolicy({});

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createFixture() {
	const parent = await mkdtemp(join(tmpdir(), "pi-workflow-runner-"));
	directories.push(parent);
	const repositoryRoot = join(parent, "repository");
	await execute("git", ["init", "-b", "main", repositoryRoot]);
	await execute("git", ["config", "user.name", "Test"], {
		cwd: repositoryRoot,
	});
	await execute("git", ["config", "user.email", "test@example.com"], {
		cwd: repositoryRoot,
	});
	await mkdir(join(repositoryRoot, "src"));
	await writeFile(join(repositoryRoot, "src", "index.ts"), "export {};\n");
	await execute("git", ["add", "."], { cwd: repositoryRoot });
	await execute("git", ["commit", "-m", "Initial"], { cwd: repositoryRoot });
	const git = new GitCli();
	const repository = await git.inspect(repositoryRoot);
	return {
		git,
		repository,
		worktrees: new GitWorktreeManager(git, join(parent, "worktrees")),
		artifacts: new ArtifactStore(join(parent, "artifacts")),
	};
}

class AnsweringWorkers implements WorkerBackend {
	private next = 1;

	constructor(private readonly answer: string) {}

	async spawn(request: { cwd: string }): Promise<WorkerInstance> {
		return { id: `worker-${this.next++}`, status: "online", cwd: request.cwd };
	}

	async list(): Promise<WorkerInstance[]> {
		return [];
	}

	async status(workerId: string): Promise<WorkerInstance> {
		return { id: workerId, status: "online", cwd: "/" };
	}

	async startPrompt(): Promise<WorkerExecution> {
		return {
			completion: Promise.resolve({
				status: "succeeded" as const,
				output: this.answer,
			}),
		};
	}

	async stop(): Promise<void> {}
}

describe("runReadOnlyWorkflow", () => {
	it("runs a read-only workflow without creating branches and persists artifacts", async () => {
		const fixture = await createFixture();
		const runId = newWorkflowRunId("investigate");
		const requestText = "Where is the entry point?";
		const state = await runReadOnlyWorkflow(fixture, {
			runId,
			repository: fixture.repository,
			plan: buildInvestigateWorkflowPlan({
				requestText,
				questions: [requestText],
			}),
			handlers: investigateStepHandlers({
				worker: new StepWorkerRunner({
					workers: new AnsweringWorkers("src/index.ts is the entry point."),
					securityPolicy,
				}),
				git: fixture.git,
				securityPolicy,
				requestText,
			}),
		});

		expect(state.state).toBe("completed");

		// The synthesis report is persisted on disk for later inspection.
		const report = await fixture.artifacts.latest(
			runId,
			SYNTHESIS_STEP_ID,
			INVESTIGATE_REPORT_OUTPUT,
		);
		expect(report?.payload).toBe("src/index.ts is the entry point.");

		// No branch was created and the repository is untouched.
		const branches = await execute("git", ["branch", "--list"], {
			cwd: fixture.repository.root,
		});
		expect(branches.stdout.trim()).toBe("* main");
		const status = await execute("git", ["status", "--porcelain"], {
			cwd: fixture.repository.root,
		});
		expect(status.stdout.trim()).toBe("");
	});

	it("rejects plans containing mutating steps", async () => {
		const fixture = await createFixture();
		const plan = buildChangeWorkflowPlan({
			version: 3,
			title: "Mutating plan",
			tasks: [
				{
					id: "edit-src",
					title: "Edit src",
					description: "Edit src/index.ts.",
					dependencies: [],
					acceptanceCriteria: ["edited"],
					allowedPaths: ["src/"],
					validationCommands: [{ command: process.execPath, args: ["-e", ""] }],
				},
			],
			finalValidationCommands: [
				{ command: process.execPath, args: ["-e", ""] },
			],
		});
		await expect(
			runReadOnlyWorkflow(fixture, {
				runId: newWorkflowRunId("plan"),
				repository: fixture.repository,
				plan,
				handlers: [],
			}),
		).rejects.toThrow(/mutating steps/);
	});

	it("rejects a dirty repository", async () => {
		const fixture = await createFixture();
		await writeFile(
			join(fixture.repository.root, "src", "dirty.ts"),
			"export {};\n",
		);
		const repository = await fixture.git.inspect(fixture.repository.root);
		await expect(
			runReadOnlyWorkflow(fixture, {
				runId: newWorkflowRunId("investigate"),
				repository,
				plan: buildInvestigateWorkflowPlan({
					requestText: "q?",
					questions: ["q?"],
				}),
				handlers: [],
			}),
		).rejects.toThrow(/Commit or stash/);
	});

	it("describes failed steps for surfacing", async () => {
		const fixture = await createFixture();
		const requestText = "Where is the entry point?";
		const workers: WorkerBackend = {
			spawn: async (request) => ({
				id: "worker-1",
				status: "online",
				cwd: request.cwd,
			}),
			list: async () => [],
			status: async () => ({ id: "worker-1", status: "online", cwd: "/" }),
			startPrompt: async () => ({
				completion: Promise.resolve({
					status: "failed" as const,
					error: "worker exploded",
				}),
			}),
			stop: async () => {},
		};
		const state = await runReadOnlyWorkflow(fixture, {
			runId: newWorkflowRunId("investigate"),
			repository: fixture.repository,
			plan: buildInvestigateWorkflowPlan({
				requestText,
				questions: [requestText],
			}),
			handlers: investigateStepHandlers({
				worker: new StepWorkerRunner({ workers, securityPolicy }),
				git: fixture.git,
				securityPolicy,
				requestText,
			}),
		});
		expect(state.state).toBe("failed");
		const lines = describeFailedSteps(state);
		expect(lines.some((line) => line.includes("worker exploded"))).toBe(true);
		expect(lines.some((line) => line.includes("blocked"))).toBe(true);
	});
});
