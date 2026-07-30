import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	StepHandler,
	StepHandlerContext,
	StepOutcome,
} from "../src/engine/handlers.js";
import { ChangeStepHandler } from "../src/engine/steps/change.js";
import { StepWorkerRunner } from "../src/engine/steps/worker-runner.js";
import { GitCli } from "../src/git/git.js";
import { isPathInside } from "../src/git/worktrees.js";
import { readSecurityPolicy } from "../src/security/policy.js";
import { LocalTaskValidator } from "../src/validation/task-validator.js";
import type {
	SpawnWorkerRequest,
	WorkerBackend,
	WorkerExecution,
	WorkerInstance,
} from "../src/workers/backend.js";
import {
	changeStep,
	createWorkflowHarness,
	execute,
	removeWorkflowHarnessDirectories,
	workflowPlanOf,
} from "./helpers/workflow.js";

/** A worker backend that performs a scripted edit inside its own worktree. */
class EditingWorkers implements WorkerBackend {
	readonly cwds: string[] = [];
	private readonly workers = new Map<string, WorkerInstance>();
	private next = 1;

	constructor(
		private readonly edit: (stepId: string, cwd: string) => Promise<void>,
	) {}

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		this.cwds.push(request.cwd);
		const worker: WorkerInstance = {
			id: `worker-${this.next++}`,
			status: "online",
			cwd: request.cwd,
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

	async startPrompt(
		workerId: string,
		prompt: string,
	): Promise<WorkerExecution> {
		const worker = this.workers.get(workerId);
		if (!worker) {
			throw new Error(`Unknown worker ${workerId}`);
		}
		const stepId = /step ([a-z][a-z0-9-]*)\./.exec(prompt)?.[1] ?? "";
		return {
			completion: this.edit(stepId, worker.cwd).then(() => ({
				status: "succeeded" as const,
			})),
		};
	}

	async stop(workerId: string): Promise<void> {
		this.workers.delete(workerId);
	}
}

function changeHandlerFor(workers: WorkerBackend): StepHandler {
	const git = new GitCli();
	const securityPolicy = readSecurityPolicy({});
	return new ChangeStepHandler({
		worker: new StepWorkerRunner({
			workers,
			securityPolicy,
			pollIntervalMs: 50,
		}),
		git,
		securityPolicy,
		validator: new LocalTaskValidator(git),
	});
}

function trackingHandler(
	active: { current: number; maximum: number },
	body: (context: StepHandlerContext) => Promise<StepOutcome>,
): StepHandler {
	return {
		kind: "change",
		execute: async (context) => {
			active.current += 1;
			active.maximum = Math.max(active.maximum, active.current);
			try {
				return await body(context);
			} finally {
				active.current -= 1;
			}
		},
	};
}

async function writeIn(cwd: string, path: string, body: string): Promise<void> {
	const target = join(cwd, path);
	await mkdir(join(target, ".."), { recursive: true });
	await writeFile(target, body);
}

afterEach(removeWorkflowHarnessDirectories);

describe("workflow engine parity: Git isolation", () => {
	it("keeps every worker out of the user worktree and branch", async () => {
		const workers = new EditingWorkers(async (stepId, cwd) => {
			await writeIn(cwd, join("src", stepId, "index.ts"), `export {};\n`);
		});
		const plan = workflowPlanOf([
			changeStep("api", [], ["src/api/"]),
			changeStep("ui", ["api"], ["src/ui/"]),
		]);
		const harness = await createWorkflowHarness(plan, [
			changeHandlerFor(workers),
		]);
		const userHeadBefore = await execute("git", ["rev-parse", "HEAD"], {
			cwd: harness.repositoryRoot,
		});

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		// Every worker ran in its own worktree below the orchestrator root.
		expect(workers.cwds).toHaveLength(2);
		expect(new Set(workers.cwds).size).toBe(2);
		for (const cwd of workers.cwds) {
			expect(isPathInside(harness.worktreeRoot, cwd)).toBe(true);
			expect(isPathInside(harness.repositoryRoot, cwd)).toBe(false);
		}
		// The user branch, HEAD, and worktree are exactly as they were.
		const userHeadAfter = await execute("git", ["rev-parse", "HEAD"], {
			cwd: harness.repositoryRoot,
		});
		expect(userHeadAfter.stdout).toBe(userHeadBefore.stdout);
		const branch = await execute("git", ["branch", "--show-current"], {
			cwd: harness.repositoryRoot,
		});
		expect(branch.stdout.trim()).toBe("main");
		const status = await execute("git", ["status", "--porcelain"], {
			cwd: harness.repositoryRoot,
		});
		expect(status.stdout).toBe("");
		// Only the integration branch advanced, and every step branch is
		// namespaced to this run.
		const branches = await execute("git", ["branch", "--format=%(refname)"], {
			cwd: harness.repositoryRoot,
		});
		const refs = branches.stdout.trim().split("\n");
		expect(refs).toContain(`refs/heads/${finished.integrationBranch}`);
		for (const ref of refs) {
			expect(
				ref === "refs/heads/main" ||
					ref.startsWith(`refs/heads/conductor/${finished.id}/`),
			).toBe(true);
		}
	});

	it("bases each dependent step on the refreshed integration head", async () => {
		const workers = new EditingWorkers(async (stepId, cwd) => {
			if (stepId === "ui") {
				// The dependent step must already see its dependency's committed work.
				const dependency = await readFile(
					join(cwd, "src", "api", "index.ts"),
					"utf8",
				);
				expect(dependency).toContain("api");
			}
			await writeIn(
				cwd,
				join("src", stepId, "index.ts"),
				`export {}; // ${stepId}\n`,
			);
		});
		const plan = workflowPlanOf([
			changeStep("api", [], ["src/api/"]),
			changeStep("ui", ["api"], ["src/ui/"]),
		]);
		const harness = await createWorkflowHarness(plan, [
			changeHandlerFor(workers),
		]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		expect(finished.attempts[1]?.baseCommit).toBe(
			finished.steps.api?.integratedCommit,
		);
	});
});

describe("workflow engine parity: bounded concurrency", () => {
	it("never exceeds the approved worker bound", async () => {
		const active = { current: 0, maximum: 0 };
		const plan = workflowPlanOf([
			changeStep("one", [], ["src/one/"]),
			changeStep("two", [], ["src/two/"]),
			changeStep("three", [], ["src/three/"]),
			changeStep("four", [], ["src/four/"]),
		]);
		const harness = await createWorkflowHarness(
			plan,
			[
				trackingHandler(active, async (context) => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					await writeIn(
						context.workspace.path,
						join("src", context.step.id, "index.ts"),
						"export {};\n",
					);
					return {
						status: "succeeded",
						commit: await new GitCli().commitAll(
							context.workspace.path,
							`step(${context.step.id}): ${context.step.title}`,
						),
					};
				}),
			],
			{ maxConcurrentWorkers: 2 },
		);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		expect(active.maximum).toBeLessThanOrEqual(2);
		expect(finished.attempts).toHaveLength(4);
	});

	it("integrates independent steps in plan order however they finish", async () => {
		const plan = workflowPlanOf([
			changeStep("first", [], ["src/first/"]),
			changeStep("second", [], ["src/second/"]),
		]);
		const harness = await createWorkflowHarness(plan, [
			{
				kind: "change",
				execute: async (context) => {
					// The later step finishes first.
					await new Promise((resolve) =>
						setTimeout(resolve, context.step.id === "first" ? 60 : 0),
					);
					await writeIn(
						context.workspace.path,
						join("src", context.step.id, "index.ts"),
						"export {};\n",
					);
					return {
						status: "succeeded",
						commit: await new GitCli().commitAll(
							context.workspace.path,
							`step(${context.step.id}): ${context.step.title}`,
						),
					};
				},
			},
		]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		const history = await execute(
			"git",
			["log", "--format=%s", finished.integrationBranch],
			{ cwd: harness.repositoryRoot },
		);
		expect(history.stdout.trim().split("\n")).toEqual([
			"step(second): second",
			"step(first): first",
			"Initial",
		]);
	});

	it("leaves the integration branch at the last good commit when a cherry-pick conflicts", async () => {
		const plan = workflowPlanOf([
			changeStep("first", [], ["shared.txt"], { pathLocks: ["first/"] }),
			changeStep("second", [], ["shared.txt"], { pathLocks: ["second/"] }),
		]);
		const harness = await createWorkflowHarness(plan, [
			{
				kind: "change",
				execute: async (context) => {
					await writeFile(
						join(context.workspace.path, "shared.txt"),
						`${context.step.id} content\n`,
					);
					return {
						status: "succeeded",
						commit: await new GitCli().commitAll(
							context.workspace.path,
							`step(${context.step.id}): ${context.step.title}`,
						),
					};
				},
			},
		]);
		await writeFile(join(harness.repositoryRoot, "shared.txt"), "base\n");
		await execute("git", ["add", "shared.txt"], {
			cwd: harness.repositoryRoot,
		});
		await execute("git", ["commit", "-m", "Add shared file"], {
			cwd: harness.repositoryRoot,
		});
		const head = await execute("git", ["rev-parse", "HEAD"], {
			cwd: harness.repositoryRoot,
		});
		await execute(
			"git",
			["branch", "-f", harness.initial.integrationBranch, head.stdout.trim()],
			{ cwd: harness.repositoryRoot },
		);
		harness.store.save({
			...harness.initial,
			baseCommit: head.stdout.trim(),
			integrationHead: head.stdout.trim(),
		});

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.second?.integrationError).toContain(
			"Failed to integrate step second",
		);
		// The first commit survived; the conflicting one never landed.
		expect(finished.integrationHead).toBe(
			finished.steps.first?.integratedCommit,
		);
		const branchHead = await execute(
			"git",
			["rev-parse", finished.integrationBranch],
			{ cwd: harness.repositoryRoot },
		);
		expect(branchHead.stdout.trim()).toBe(finished.integrationHead);
		const status = await execute("git", ["status", "--porcelain"], {
			cwd: harness.repositoryRoot,
		});
		expect(status.stdout).toBe("");
	});
});

describe("workflow engine parity: security boundaries", () => {
	it("rejects a worker that created its own commit", async () => {
		const workers = new EditingWorkers(async (stepId, cwd) => {
			await writeIn(cwd, join("src", stepId, "index.ts"), "export {};\n");
			await execute("git", ["add", "."], { cwd });
			await execute("git", ["commit", "-m", "worker commit"], { cwd });
		});
		const plan = workflowPlanOf([changeStep("api", [], ["src/api/"])]);
		const harness = await createWorkflowHarness(plan, [
			changeHandlerFor(workers),
		]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.api?.error).toContain("Task worktree HEAD changed");
		const history = await execute(
			"git",
			["log", "--format=%s", finished.integrationBranch],
			{ cwd: harness.repositoryRoot },
		);
		expect(history.stdout.trim()).toBe("Initial");
	});

	it("rejects a focused check that mutates the repository", async () => {
		const workers = new EditingWorkers(async (stepId, cwd) => {
			await writeIn(cwd, join("src", stepId, "index.ts"), "export {};\n");
		});
		const plan = workflowPlanOf([
			{
				...changeStep("api", [], ["src/api/"]),
				validationCommands: [
					{
						command: process.execPath,
						args: [
							"-e",
							"require('node:fs').writeFileSync('src/api/extra.ts','x')",
						],
					},
				],
			},
		]);
		const harness = await createWorkflowHarness(plan, [
			changeHandlerFor(workers),
		]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.api?.error).toContain(
			"Validation commands modified the task worktree",
		);
	});
});
