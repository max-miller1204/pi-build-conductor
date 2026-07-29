import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StepDefinition } from "../src/domain/steps.js";
import type { WorkflowEvent } from "../src/engine/events.js";
import type {
	StepHandler,
	StepHandlerContext,
	StepOutcome,
} from "../src/engine/handlers.js";
import type { WorkspaceRequirement } from "../src/engine/workspaces.js";
import { GitCli } from "../src/git/git.js";
import {
	approvalStep,
	changeStep,
	commandStep,
	createWorkflowHarness,
	execute,
	investigationStep,
	removeWorkflowHarnessDirectories,
	workflowPlanOf,
} from "./helpers/workflow.js";

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

function eventKinds(events: WorkflowEvent[]): string[] {
	return events.map((event) => event.kind);
}

afterEach(removeWorkflowHarnessDirectories);

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
		const plan = workflowPlanOf([
			investigationStep("survey"),
			changeStep("api", ["survey"], ["src/api/"]),
			changeStep("ui", ["survey"], ["src/ui/"]),
			commandStep("audit", ["api", "ui"]),
			approvalStep("ship", ["audit"]),
		]);
		const harness = await createWorkflowHarness(plan, [
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

	it("records one ordered timeline of everything the run did", async () => {
		const handlers = [
			new RecordingHandler("investigation", async () => ({
				status: "succeeded",
				summary: "surveyed",
			})),
			new RecordingHandler("change", async (context) => ({
				status: "succeeded",
				commit: await writeAndCommit(
					context,
					join("src", context.step.id, "index.ts"),
				),
			})),
		];
		const plan = workflowPlanOf([
			investigationStep("survey"),
			changeStep("api", ["survey"], ["src/api/"]),
		]);
		const harness = await createWorkflowHarness(plan, handlers);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		expect(eventKinds(harness.events)).toEqual([
			"step_launched",
			"step_succeeded",
			"step_launched",
			"step_succeeded",
			"step_integrated",
			"run_settled",
		]);
		expect(harness.events.map((event) => event.sequence)).toEqual([
			1, 2, 3, 4, 5, 6,
		]);
		expect(finished.events).toEqual(harness.events);
		expect(finished.droppedEvents).toBe(0);
		expect(harness.events.at(-2)).toMatchObject({
			kind: "step_integrated",
			stepId: "api",
			integrationHead: finished.integrationHead,
		});
		expect(harness.events.at(-1)).toMatchObject({
			kind: "run_settled",
			state: "completed",
		});
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
		const plan = workflowPlanOf([
			changeStep("wide", [], ["src/"]),
			changeStep("narrow", [], ["src/narrow/"]),
		]);
		const harness = await createWorkflowHarness(plan, [changes]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		expect(maximumActive).toBe(1);
	});

	it("serializes steps that hold the same named resource lock", async () => {
		// The barrier proves the unlocked step really did run alongside a locked
		// one, so the counter below is measuring exclusion and not idleness.
		const barrier = new ConcurrencyBarrier(2);
		let holdingDatabase = 0;
		let maximumHoldingDatabase = 0;
		const commands = new RecordingHandler("command", async (context) => {
			if (context.step.id !== "seed") {
				await barrier.arrive();
			}
			if (context.step.id === "lint") {
				return { status: "succeeded" };
			}
			holdingDatabase += 1;
			maximumHoldingDatabase = Math.max(
				maximumHoldingDatabase,
				holdingDatabase,
			);
			await new Promise((resolve) => setTimeout(resolve, 25));
			holdingDatabase -= 1;
			return { status: "succeeded" };
		});
		const plan = workflowPlanOf([
			commandStep("migrate", [], { resourceLocks: ["database"] }),
			commandStep("seed", [], { resourceLocks: ["database"] }),
			commandStep("lint", []),
		]);
		const harness = await createWorkflowHarness(plan, [commands], {
			maxConcurrentWorkers: 3,
		});

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		expect(maximumHoldingDatabase).toBe(1);
		expect(commands.observed).toHaveLength(3);
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
		const plan = workflowPlanOf([
			changeStep("api", [], ["src/api/"]),
			changeStep("ui", ["api"], ["src/ui/"]),
		]);
		const harness = await createWorkflowHarness(plan, [changes]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.api?.state).toBe("failed");
		expect(finished.steps.api?.error).toBe("compilation failed");
		expect(finished.steps.ui?.state).toBe("blocked");
		expect(changes.observed.map((entry) => entry.stepId)).toEqual(["api"]);
		expect(harness.events).toContainEqual(
			expect.objectContaining({
				kind: "step_failed",
				stepId: "api",
				failureClass: "terminal",
			}),
		);
		expect(harness.events).toContainEqual(
			expect.objectContaining({
				kind: "step_blocked",
				stepId: "ui",
				blockedBy: ["api"],
			}),
		);
	});

	it("retries a failed step within its declared budget", async () => {
		let attempts = 0;
		const changes = new RecordingHandler("change", async (context) => {
			attempts += 1;
			if (attempts === 1) {
				return { status: "failed", error: "flaky worker" };
			}
			return {
				status: "succeeded",
				commit: await writeAndCommit(
					context,
					join("src", context.step.id, "index.ts"),
				),
			};
		});
		const plan = workflowPlanOf([
			changeStep("api", [], ["src/api/"], { retry: { maxAttempts: 2 } }),
		]);
		const harness = await createWorkflowHarness(plan, [changes]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		expect(finished.steps.api?.state).toBe("succeeded");
		expect(finished.steps.api?.error).toBeUndefined();
		expect(finished.attempts.map((attempt) => attempt.state)).toEqual([
			"failed",
			"succeeded",
		]);
		expect(harness.events).toContainEqual(
			expect.objectContaining({
				kind: "step_failed",
				stepId: "api",
				failureClass: "retryable",
			}),
		);
		expect(harness.events).toContainEqual(
			expect.objectContaining({
				kind: "step_retry_scheduled",
				stepId: "api",
				nextAttemptNumber: 2,
			}),
		);
	});

	it("stops retrying a failure the handler reports as permanent", async () => {
		let attempts = 0;
		const changes = new RecordingHandler("change", async () => {
			attempts += 1;
			return {
				status: "failed",
				error: "the diff left the approved paths",
				retryable: false,
			};
		});
		const plan = workflowPlanOf([
			changeStep("api", [], ["src/api/"], { retry: { maxAttempts: 3 } }),
		]);
		const harness = await createWorkflowHarness(plan, [changes]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(attempts).toBe(1);
		expect(finished.steps.api?.error).toBe("the diff left the approved paths");
	});

	it("exhausts the retry budget before failing the run", async () => {
		let attempts = 0;
		const changes = new RecordingHandler("change", async () => {
			attempts += 1;
			return { status: "failed", error: "still broken" };
		});
		const plan = workflowPlanOf([
			changeStep("api", [], ["src/api/"], { retry: { maxAttempts: 3 } }),
		]);
		const harness = await createWorkflowHarness(plan, [changes]);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(attempts).toBe(3);
		expect(finished.attempts).toHaveLength(3);
		expect(
			harness.events.filter((event) => event.kind === "step_retry_scheduled"),
		).toHaveLength(2);
	});

	it("fails closed when no handler is registered for a step kind", async () => {
		const plan = workflowPlanOf([investigationStep("survey")]);
		const harness = await createWorkflowHarness(plan, []);

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
		const plan = workflowPlanOf([
			investigationStep("survey", [], { timeoutMs: 30 }),
		]);
		const harness = await createWorkflowHarness(plan, [handler]);

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
		const plan = workflowPlanOf([
			investigationStep("survey"),
			investigationStep("next"),
		]);
		const harness = await createWorkflowHarness(plan, [handler], {
			maxConcurrentWorkers: 1,
		});

		const finished = await harness.engine.run(harness.initial.id, {
			signal: controller.signal,
		});

		expect(finished.state).toBe("cancelled");
		expect(finished.steps.survey?.state).toBe("cancelled");
		expect(finished.steps.next?.state).toBe("cancelled");
		expect(handler.observed).toHaveLength(1);
	});

	it("cancels an executing run through the engine", async () => {
		let started: (() => void) | undefined;
		const startedOnce = new Promise<void>((resolve) => {
			started = resolve;
		});
		const handler = new RecordingHandler("investigation", async (context) => {
			started?.();
			await new Promise<void>((resolve) => {
				if (context.signal.aborted) {
					resolve();
					return;
				}
				context.signal.addEventListener("abort", () => {
					resolve();
				});
			});
			return { status: "cancelled", error: "stopped by the user" };
		});
		const plan = workflowPlanOf([
			investigationStep("survey"),
			investigationStep("later", ["survey"]),
		]);
		const harness = await createWorkflowHarness(plan, [handler], {
			maxConcurrentWorkers: 1,
		});

		const running = harness.engine.run(harness.initial.id);
		await startedOnce;
		await harness.engine.cancel(harness.initial.id, "stopped by the user");
		const finished = await running;

		expect(finished.state).toBe("cancelled");
		expect(finished.steps.survey?.state).toBe("cancelled");
		expect(finished.steps.later?.state).toBe("cancelled");
		expect(harness.events).toContainEqual(
			expect.objectContaining({
				kind: "run_cancellation_requested",
				reason: "stopped by the user",
			}),
		);
		expect(harness.events.at(-1)).toMatchObject({
			kind: "run_settled",
			state: "cancelled",
		});
	});

	it("cancels a run that nobody is executing", async () => {
		const plan = workflowPlanOf([investigationStep("survey")]);
		const harness = await createWorkflowHarness(plan, []);

		const cancelled = await harness.engine.cancel(harness.initial.id);

		expect(cancelled.state).toBe("cancelled");
		expect(cancelled.steps.survey?.state).toBe("cancelled");
	});

	it("refuses to execute one run twice at the same time", async () => {
		const handler = new RecordingHandler("investigation", async () => {
			await new Promise((resolve) => setTimeout(resolve, 40));
			return { status: "succeeded" };
		});
		const plan = workflowPlanOf([investigationStep("survey")]);
		const harness = await createWorkflowHarness(plan, [handler]);

		const running = harness.engine.run(harness.initial.id);

		await expect(harness.engine.run(harness.initial.id)).rejects.toThrow(
			/already executing/,
		);
		expect((await running).state).toBe("completed");
	});
});
