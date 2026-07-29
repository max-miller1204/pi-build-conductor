import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	type StepDefinition,
	validateWorkflowPlan,
	type WorkflowPlan,
} from "../src/domain/steps.js";
import { WorkflowEngine } from "../src/engine/engine.js";
import { StepExecutor } from "../src/engine/executor.js";
import {
	type StepHandler,
	type StepHandlerContext,
	StepHandlerRegistry,
	type StepOutcome,
} from "../src/engine/handlers.js";
import { GitStepIntegrator } from "../src/engine/integration.js";
import { InMemoryWorkflowStateStore } from "../src/engine/state-store.js";
import {
	createWorkflowRunState,
	type WorkflowRunState,
} from "../src/engine/workflow-state.js";
import {
	defaultWorkspaceProviders,
	type WorkspaceRequirement,
} from "../src/engine/workspaces.js";
import { GitCli } from "../src/git/git.js";
import { GitWorktreeManager } from "../src/git/worktrees.js";
import { defaultCapabilityProfiles } from "../src/security/capabilities.js";

const execute = promisify(execFile);
const directories: string[] = [];

interface Harness {
	parent: string;
	repositoryRoot: string;
	worktreeRoot: string;
}

async function createRepository(): Promise<Harness> {
	const parent = await mkdtemp(join(tmpdir(), "pi-orchestrator-engine-"));
	directories.push(parent);
	const repositoryRoot = join(parent, "repository");
	await execute("git", ["init", "-b", "main", repositoryRoot]);
	await execute("git", ["config", "user.name", "Test"], {
		cwd: repositoryRoot,
	});
	await execute("git", ["config", "user.email", "test@example.com"], {
		cwd: repositoryRoot,
	});
	await mkdir(join(repositoryRoot, "src"), { recursive: true });
	await writeFile(join(repositoryRoot, "src", "index.ts"), "export {};\n");
	await execute("git", ["add", "."], { cwd: repositoryRoot });
	await execute("git", ["commit", "-m", "Initial"], { cwd: repositoryRoot });
	return { parent, repositoryRoot, worktreeRoot: join(parent, "worktrees") };
}

function investigation(
	id: string,
	dependencies: string[] = [],
): Record<string, unknown> {
	return {
		kind: "investigation",
		id,
		title: id,
		description: `Investigate ${id}`,
		dependencies,
		questions: [`What does ${id} need?`],
	};
}

function change(
	id: string,
	dependencies: string[],
	allowedPaths: string[],
): Record<string, unknown> {
	return {
		kind: "change",
		id,
		title: id,
		description: `Implement ${id}`,
		dependencies,
		acceptanceCriteria: [`${id} exists`],
		allowedPaths,
		validationCommands: [{ command: process.execPath, args: ["-e", ""] }],
	};
}

function command(id: string, dependencies: string[]): Record<string, unknown> {
	return {
		kind: "command",
		id,
		title: id,
		description: `Run ${id}`,
		dependencies,
		command: { command: process.execPath, args: ["-e", "process.exit(0)"] },
	};
}

function approval(id: string, dependencies: string[]): Record<string, unknown> {
	return {
		kind: "approval",
		id,
		title: id,
		description: `Approve ${id}`,
		dependencies,
		prompt: `Approve ${id}?`,
	};
}

function planOf(steps: Record<string, unknown>[]): WorkflowPlan {
	return validateWorkflowPlan({
		version: 4,
		title: "Deliver the widget",
		steps,
		finalValidationCommands: [{ command: process.execPath, args: ["-e", ""] }],
	});
}

class RecordingHandler implements StepHandler {
	readonly observed: {
		stepId: string;
		requirement: WorkspaceRequirement;
		path: string;
		baseCommit: string;
		capabilities: string[];
		snapshotCommit: string;
	}[] = [];

	constructor(
		readonly kind: StepDefinition["kind"],
		private readonly body: (
			context: StepHandlerContext,
		) => Promise<StepOutcome>,
	) {}

	async execute(context: StepHandlerContext): Promise<StepOutcome> {
		this.observed.push({
			stepId: context.step.id,
			requirement: context.workspace.requirement,
			path: context.workspace.path,
			baseCommit: context.workspace.baseCommit,
			capabilities: [...context.capabilityProfile.capabilities],
			snapshotCommit: context.execution.repositorySnapshot.commit,
		});
		return this.body(context);
	}
}

/** Fails loudly instead of hanging when steps never overlap. */
class ConcurrencyBarrier {
	private readonly waiting: (() => void)[] = [];

	constructor(
		private readonly size: number,
		private readonly timeoutMs = 2_000,
	) {}

	async arrive(): Promise<void> {
		if (this.waiting.length + 1 >= this.size) {
			for (const release of this.waiting.splice(0)) {
				release();
			}
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error("steps did not run concurrently"));
			}, this.timeoutMs);
			this.waiting.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}

async function writeAndCommit(
	context: StepHandlerContext,
	relativePath: string,
): Promise<string> {
	const target = join(context.workspace.path, relativePath);
	await mkdir(join(target, ".."), { recursive: true });
	await writeFile(target, `export const id = "${context.step.id}";\n`);
	const git = new GitCli();
	return git.commitAll(
		context.workspace.path,
		`step(${context.step.id}): ${context.step.title}`,
	);
}

interface EngineHarness {
	engine: WorkflowEngine;
	store: InMemoryWorkflowStateStore;
	initial: WorkflowRunState;
	repositoryRoot: string;
	worktreeRoot: string;
}

async function createEngine(
	plan: WorkflowPlan,
	handlers: StepHandler[],
	options: { maxConcurrentWorkers?: number } = {},
): Promise<EngineHarness> {
	const { repositoryRoot, worktreeRoot } = await createRepository();
	const git = new GitCli();
	const worktrees = new GitWorktreeManager(git, worktreeRoot);
	const repository = await git.inspect(repositoryRoot);
	const runId = "run-engine-1";
	const integrationBranch = await worktrees.prepareIntegrationBranch(
		repository,
		runId,
	);
	const initial = createWorkflowRunState({
		id: runId,
		plan,
		repositoryRoot,
		baseBranch: repository.currentBranch,
		baseCommit: repository.head,
		integrationBranch,
		integrationHead: repository.head,
		capabilityProfiles: defaultCapabilityProfiles(),
		maxConcurrentWorkers: options.maxConcurrentWorkers ?? 2,
		createdAt: "2026-07-29T00:00:00.000Z",
	});
	const store = new InMemoryWorkflowStateStore(initial);
	const engine = new WorkflowEngine({
		store,
		repository,
		executor: new StepExecutor({
			workspaces: defaultWorkspaceProviders(worktrees),
			handlers: new StepHandlerRegistry(handlers),
		}),
		integrator: new GitStepIntegrator(git),
	});
	return { engine, store, initial, repositoryRoot, worktreeRoot };
}

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("workflow engine", () => {
	it("executes a mixed workflow against real Git worktrees", async () => {
		const barrier = new ConcurrencyBarrier(2);
		const investigations = new RecordingHandler("investigation", async () => ({
			status: "succeeded",
			summary: "surveyed",
		}));
		const changes = new RecordingHandler("change", async (context) => {
			await barrier.arrive();
			const commit = await writeAndCommit(
				context,
				join("src", context.step.id, "index.ts"),
			);
			return { status: "succeeded", commit };
		});
		const commands = new RecordingHandler("command", async (context) => {
			const step = context.step;
			if (step.kind !== "command") {
				throw new Error("wrong kind");
			}
			await execute(step.command.command, step.command.args, {
				cwd: context.workspace.path,
			});
			return { status: "succeeded" };
		});
		const approvals = new RecordingHandler("approval", async () => ({
			status: "succeeded",
			summary: "approved",
		}));
		const plan = planOf([
			investigation("survey"),
			change("api", ["survey"], ["src/api/"]),
			change("ui", ["survey"], ["src/ui/"]),
			command("audit", ["api", "ui"]),
			approval("ship", ["audit"]),
		]);
		const harness = await createEngine(plan, [
			investigations,
			changes,
			commands,
			approvals,
		]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		expect(
			Object.fromEntries(
				Object.entries(finished.steps).map(([id, step]) => [id, step.state]),
			),
		).toEqual({
			survey: "succeeded",
			api: "succeeded",
			ui: "succeeded",
			audit: "succeeded",
			ship: "succeeded",
		});

		// Every mutating step contributed exactly one integrated commit, in
		// topological order, and later steps started from the advanced head.
		expect(finished.steps.api?.integratedCommit).toBeDefined();
		expect(finished.steps.ui?.integratedCommit).toBeDefined();
		expect(finished.integrationHead).toBe(finished.steps.ui?.integratedCommit);
		const history = await execute(
			"git",
			["log", "--format=%s", finished.integrationBranch],
			{ cwd: harness.repositoryRoot },
		);
		expect(history.stdout.trim().split("\n")).toEqual([
			"step(ui): ui",
			"step(api): api",
			"Initial",
		]);

		// Workspaces follow the frozen capability profile of each step kind.
		expect(investigations.observed[0]).toMatchObject({
			requirement: "read-only",
			capabilities: ["read-repository"],
		});
		expect(changes.observed.map((entry) => entry.requirement)).toEqual([
			"mutable",
			"mutable",
		]);
		expect(commands.observed[0]?.requirement).toBe("read-only");
		expect(approvals.observed[0]).toMatchObject({
			requirement: "none",
			path: "",
			capabilities: [],
		});

		// Dependent steps see the advanced integration head as their snapshot.
		expect(commands.observed[0]?.snapshotCommit).toBe(
			finished.steps.ui?.integratedCommit,
		);

		// The user worktree never changed.
		const status = await execute("git", ["status", "--porcelain"], {
			cwd: harness.repositoryRoot,
		});
		expect(status.stdout).toBe("");
		const branch = await execute("git", ["branch", "--show-current"], {
			cwd: harness.repositoryRoot,
		});
		expect(branch.stdout.trim()).toBe("main");
		await expect(
			stat(join(harness.repositoryRoot, "src", "api", "index.ts")),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("never runs steps whose path locks overlap at the same time", async () => {
		let active = 0;
		let maximumActive = 0;
		const changes = new RecordingHandler("change", async (context) => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await new Promise((resolve) => setTimeout(resolve, 25));
			const commit = await writeAndCommit(
				context,
				join("src", context.step.id, "index.ts"),
			);
			active -= 1;
			return { status: "succeeded", commit };
		});
		const plan = planOf([
			change("wide", [], ["src/"]),
			change("narrow", [], ["src/narrow/"]),
		]);
		const harness = await createEngine(plan, [changes]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		expect(maximumActive).toBe(1);
	});

	it("blocks dependents and fails the run when a step fails", async () => {
		const changes = new RecordingHandler("change", async (context) =>
			context.step.id === "api"
				? { status: "failed", error: "compilation failed" }
				: {
						status: "succeeded",
						commit: await writeAndCommit(
							context,
							join("src", context.step.id, "index.ts"),
						),
					},
		);
		const plan = planOf([
			change("api", [], ["src/api/"]),
			change("ui", ["api"], ["src/ui/"]),
		]);
		const harness = await createEngine(plan, [changes]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.api?.state).toBe("failed");
		expect(finished.steps.api?.error).toBe("compilation failed");
		expect(finished.steps.ui?.state).toBe("blocked");
		expect(changes.observed.map((entry) => entry.stepId)).toEqual(["api"]);
	});

	it("fails closed when no handler is registered for a step kind", async () => {
		const plan = planOf([investigation("survey")]);
		const harness = await createEngine(plan, []);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.survey?.state).toBe("failed");
		expect(finished.steps.survey?.error).toContain("investigation");
	});

	it("stops a step that exceeds its declared timeout", async () => {
		const handler = new RecordingHandler("investigation", async (context) => {
			await new Promise((resolve) => {
				const timer = setTimeout(resolve, 5_000);
				context.signal.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
			});
			return { status: "succeeded" };
		});
		const plan = planOf([{ ...investigation("survey"), timeoutMs: 30 }]);
		const harness = await createEngine(plan, [handler]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.survey?.state).toBe("failed");
		expect(finished.steps.survey?.error).toContain("timed out");
		const attempt = finished.attempts.at(-1);
		expect(attempt?.state).toBe("failed");
		expect(attempt?.finishedAt).toBeDefined();
	});

	it("cancels running steps when the caller aborts the run", async () => {
		const controller = new AbortController();
		const handler = new RecordingHandler("investigation", async (context) => {
			controller.abort(new Error("user cancelled"));
			await new Promise<void>((resolve) => {
				if (context.signal.aborted) {
					resolve();
					return;
				}
				context.signal.addEventListener("abort", () => {
					resolve();
				});
			});
			return { status: "cancelled", error: "cancelled" };
		});
		const plan = planOf([investigation("survey"), investigation("next")]);
		const harness = await createEngine(plan, [handler], {
			maxConcurrentWorkers: 1,
		});

		const finished = await harness.engine.run(harness.initial.id, {
			signal: controller.signal,
		});

		expect(finished.state).toBe("cancelled");
		expect(finished.steps.survey?.state).toBe("cancelled");
		expect(handler.observed).toHaveLength(1);
	});
});
