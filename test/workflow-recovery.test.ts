import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	finalizeWorkflowRun,
	integratedCommitEvidence,
} from "../src/engine/finalization.js";
import type {
	StepHandler,
	StepHandlerContext,
	StepOutcome,
} from "../src/engine/handlers.js";
import { recoverWorkflowRun } from "../src/engine/recovery.js";
import { GitCli } from "../src/git/git.js";
import { GitWorktreeManager } from "../src/git/worktrees.js";
import { readSecurityPolicy } from "../src/security/policy.js";
import { LocalFinalValidator } from "../src/validation/final-validator.js";
import {
	changeStep,
	createWorkflowHarness,
	execute,
	investigationStep,
	removeWorkflowHarnessDirectories,
	type WorkflowHarness,
	workflowPlanOf,
} from "./helpers/workflow.js";

function handlerOf(
	kind: StepHandler["kind"],
	body: (context: StepHandlerContext) => Promise<StepOutcome>,
): StepHandler {
	return { kind, execute: body };
}

/**
 * Runs the workflow until its first step commits, then rebuilds the durable
 * state a killed process leaves behind: the step branch carries the commit its
 * worker really made, while the attempt is still recorded as active because
 * nothing ever settled it. Returns that attempt's id.
 */
async function interruptAfterFirstCommit(
	harness: WorkflowHarness,
): Promise<string> {
	await harness.engine.run(harness.initial.id);
	const crashed = await harness.store.load(harness.initial.id);
	const attempt = crashed.attempts[0];
	const record = attempt ? crashed.steps[attempt.stepId] : undefined;
	if (!attempt || !record) {
		throw new Error("missing crashed attempt");
	}
	const { error: _stepError, ...stepWithoutError } = record;
	const { error: _attemptError, ...attemptWithoutError } = attempt;
	harness.store.save({
		...crashed,
		state: "running",
		steps: {
			...crashed.steps,
			[attempt.stepId]: { ...stepWithoutError, state: "running" },
		},
		attempts: [{ ...attemptWithoutError, state: "running" }],
	});
	return attempt.id;
}

async function writeAndCommit(
	context: StepHandlerContext,
	body = "export {};\n",
): Promise<string> {
	const target = join(
		context.workspace.path,
		"src",
		context.step.id,
		"index.ts",
	);
	await mkdir(join(target, ".."), { recursive: true });
	await writeFile(target, body);
	return new GitCli().commitAll(
		context.workspace.path,
		`step(${context.step.id}): ${context.step.title}`,
	);
}

afterEach(removeWorkflowHarnessDirectories);

describe("workflow finalization", () => {
	it("produces merge-ready evidence for a verified integration branch", async () => {
		const plan = workflowPlanOf([changeStep("api", [], ["src/api/"])]);
		const harness = await createWorkflowHarness(plan, [
			handlerOf("change", async (context) => ({
				status: "succeeded",
				commit: await writeAndCommit(context),
			})),
		]);
		const finished = await harness.engine.run(harness.initial.id);
		expect(finished.state).toBe("completed");
		const git = new GitCli();
		const repository = await git.inspect(harness.repositoryRoot);

		const result = await finalizeWorkflowRun(
			{
				finalValidator: new LocalFinalValidator(git),
				worktrees: new GitWorktreeManager(git, harness.worktreeRoot),
				git,
				securityPolicy: readSecurityPolicy({}),
				artifacts: harness.artifacts,
			},
			{ state: finished, repository },
		);

		expect(result.evidence.passed).toBe(true);
		expect(result.mergeReady?.commits).toEqual([
			{
				kind: "task",
				id: "api",
				sourceCommit: expect.any(String),
				integratedCommit: finished.integrationHead,
			},
		]);
		expect(result.mergeReady?.git.integrationHead).toBe(
			finished.integrationHead,
		);
		expect(result.mergeReady?.git.userWorktreeClean).toBe(true);
		expect(result.mergeReady?.finalChecks).toHaveLength(1);
	});

	it("withholds merge-ready evidence when final validation fails", async () => {
		const plan = workflowPlanOf([
			{
				...changeStep("api", [], ["src/api/"]),
				validationCommands: [{ command: process.execPath, args: ["-e", ""] }],
			},
		]);
		const harness = await createWorkflowHarness(plan, [
			handlerOf("change", async (context) => ({
				status: "succeeded",
				commit: await writeAndCommit(context),
			})),
		]);
		const finished = await harness.engine.run(harness.initial.id);
		const failing = {
			...finished,
			plan: {
				...finished.plan,
				finalValidationCommands: [
					{ command: process.execPath, args: ["-e", "process.exit(1)"] },
				],
			},
		};
		const git = new GitCli();

		const result = await finalizeWorkflowRun(
			{
				finalValidator: new LocalFinalValidator(git),
				worktrees: new GitWorktreeManager(git, harness.worktreeRoot),
				git,
				securityPolicy: readSecurityPolicy({}),
			},
			{
				state: failing,
				repository: await git.inspect(harness.repositoryRoot),
			},
		);

		expect(result.evidence.passed).toBe(false);
		expect(result.mergeReady).toBeUndefined();
	});

	it("orders commit evidence by integration order after a retry", async () => {
		const plan = workflowPlanOf([
			changeStep("api", [], ["src/api/"]),
			changeStep("ui", [], ["src/ui/"]),
		]);
		const harness = await createWorkflowHarness(plan, [
			handlerOf("change", async (context) => ({
				status: "succeeded",
				commit: await writeAndCommit(context),
			})),
		]);
		const finished = await harness.engine.run(harness.initial.id);
		const apiAttempt = finished.attempts.find(
			(attempt) => attempt.stepId === "api",
		);
		const uiAttempt = finished.attempts.find(
			(attempt) => attempt.stepId === "ui",
		);
		if (!apiAttempt || !uiAttempt) {
			throw new Error("missing workflow attempts");
		}
		const apiRecord = finished.steps.api;
		if (!apiRecord) {
			throw new Error("missing api step");
		}
		const { commit: _commit, ...failedApiAttempt } = apiAttempt;
		const retried = {
			...finished,
			steps: {
				...finished.steps,
				api: {
					...apiRecord,
					attemptIds: ["api-failed", apiAttempt.id],
				},
			},
			attempts: [
				{
					...failedApiAttempt,
					id: "api-failed",
					state: "failed" as const,
				},
				uiAttempt,
				apiAttempt,
			],
		};

		expect(integratedCommitEvidence(retried).map((entry) => entry.id)).toEqual([
			"api",
			"ui",
		]);
	});

	it("rejects finalization unless the run is completed and fully integrated", async () => {
		const plan = workflowPlanOf([changeStep("api", [], ["src/api/"])]);
		const harness = await createWorkflowHarness(plan, [
			handlerOf("change", async (context) => ({
				status: "succeeded",
				commit: await writeAndCommit(context),
			})),
		]);
		const finished = await harness.engine.run(harness.initial.id);
		const git = new GitCli();
		const dependencies = {
			finalValidator: new LocalFinalValidator(git),
			worktrees: new GitWorktreeManager(git, harness.worktreeRoot),
			git,
			securityPolicy: readSecurityPolicy({}),
		};
		const repository = await git.inspect(harness.repositoryRoot);
		const apiRecord = finished.steps.api;
		if (!apiRecord) {
			throw new Error("missing api step");
		}
		const { integratedCommit: _integratedCommit, ...unintegratedApiRecord } =
			apiRecord;

		await expect(
			finalizeWorkflowRun(dependencies, {
				state: { ...finished, state: "failed" },
				repository,
			}),
		).rejects.toThrow(/expected completed/);
		await expect(
			finalizeWorkflowRun(dependencies, {
				state: {
					...finished,
					steps: {
						...finished.steps,
						api: {
							...unintegratedApiRecord,
						},
					},
				},
				repository,
			}),
		).rejects.toThrow(/has not been integrated/);
	});
});

describe("workflow recovery", () => {
	it("adopts a commit a worker created just before the interruption", async () => {
		const plan = workflowPlanOf([
			changeStep("api", [], ["src/api/"]),
			changeStep("ui", ["api"], ["src/ui/"]),
		]);
		const harness = await createWorkflowHarness(plan, [
			handlerOf("change", async (context) => {
				const commit = await writeAndCommit(context);
				if (context.step.id === "api") {
					// The process disappears after the commit exists but before the
					// engine ever learns about it.
					return { status: "failed", error: "process crashed" };
				}
				return { status: "succeeded", commit };
			}),
		]);
		const interrupted = await interruptAfterFirstCommit(harness);
		const branch = (await harness.store.load(harness.initial.id)).attempts[0]
			?.branch;

		const recovery = await recoverWorkflowRun(
			{ store: harness.store, git: new GitCli() },
			harness.initial.id,
		);

		expect(recovery.recovered).toEqual([
			{
				attemptId: interrupted,
				stepId: "api",
				outcome: "adopted_commit",
				commit: expect.any(String),
				reason: "the worker's commit already existed on the step branch",
			},
		]);
		expect(recovery.state.steps.api?.state).toBe("succeeded");
		expect(recovery.state.attempts[0]?.state).toBe("succeeded");
		expect(recovery.state.attempts[0]?.commit).toBe(
			await execute("git", ["rev-parse", branch ?? ""], {
				cwd: harness.repositoryRoot,
			}).then((result) => result.stdout.trim()),
		);

		// The resumed run continues from the adopted commit.
		const resumed = await harness.engine.run(harness.initial.id);
		expect(resumed.state).toBe("completed");
		const history = await execute(
			"git",
			["log", "--format=%s", resumed.integrationBranch],
			{ cwd: harness.repositoryRoot },
		);
		expect(history.stdout.trim().split("\n")).toEqual([
			"step(ui): ui",
			"step(api): api",
			"Initial",
		]);
	});

	it("refuses to adopt a commit whose declared artifacts never reached storage", async () => {
		// The producer's own retry budget is exhausted, so the only fail-closed
		// answer is to fail it: adopting would complete a step whose dependents
		// can never resolve the inputs it owed them.
		const plan = workflowPlanOf([
			changeStep("api", [], ["src/api/"], { outputs: ["report"] }),
			changeStep("ui", ["api"], ["src/ui/"], {
				inputs: [{ stepId: "api", output: "report" }],
			}),
		]);
		const harness = await createWorkflowHarness(plan, [
			handlerOf("change", async (context) => {
				await writeAndCommit(context);
				return { status: "failed", error: "process crashed" };
			}),
		]);
		const interrupted = await interruptAfterFirstCommit(harness);

		const recovery = await recoverWorkflowRun(
			{ store: harness.store, git: new GitCli(), artifacts: harness.artifacts },
			harness.initial.id,
		);

		expect(recovery.recovered).toEqual([
			{
				attemptId: interrupted,
				stepId: "api",
				outcome: "failed",
				reason: expect.stringContaining(
					"did not durably store the declared output of api: report",
				),
			},
		]);
		expect(recovery.state.state).toBe("failed");
		expect(recovery.state.steps.api?.state).toBe("failed");
		expect(recovery.state.attempts[0]?.commit).toBeUndefined();
		expect(recovery.state.steps.ui?.state).toBe("blocked");
	});

	it("refuses to adopt declared outputs it has no artifact store to verify", async () => {
		const plan = workflowPlanOf([
			changeStep("api", [], ["src/api/"], {
				outputs: ["report"],
				retry: { maxAttempts: 3 },
			}),
		]);
		const harness = await createWorkflowHarness(plan, [
			handlerOf("change", async (context) => {
				await writeAndCommit(context);
				return { status: "failed", error: "process crashed" };
			}),
		]);
		const interrupted = await interruptAfterFirstCommit(harness);

		const recovery = await recoverWorkflowRun(
			{ store: harness.store, git: new GitCli() },
			harness.initial.id,
		);

		// Retry budget remains, but no retry can produce evidence a store that
		// is not configured could ever confirm.
		expect(recovery.recovered).toEqual([
			{
				attemptId: interrupted,
				stepId: "api",
				outcome: "failed",
				reason: expect.stringContaining(
					"no artifact store is configured to verify the declared output of api",
				),
			},
		]);
		expect(recovery.state.steps.api?.state).toBe("failed");
	});

	it("reschedules an interrupted attempt that produced nothing", async () => {
		const plan = workflowPlanOf([
			investigationStep("survey", [], { retry: { maxAttempts: 2 } }),
		]);
		const harness = await createWorkflowHarness(plan, [
			handlerOf("investigation", async () => ({ status: "succeeded" })),
		]);
		const survey = harness.initial.steps.survey;
		if (!survey) {
			throw new Error("missing step");
		}
		harness.store.save({
			...harness.initial,
			steps: {
				...harness.initial.steps,
				survey: { ...survey, state: "running", attemptIds: ["survey-1"] },
			},
			attempts: [
				{
					id: "survey-1",
					stepId: "survey",
					number: 1,
					state: "running",
					workspaceRequirement: "read-only",
					workspacePath: join(harness.worktreeRoot, "gone"),
					baseCommit: harness.initial.integrationHead,
					startedAt: "2026-07-29T00:00:00.000Z",
				},
			],
		});

		const recovery = await recoverWorkflowRun(
			{ store: harness.store, git: new GitCli() },
			harness.initial.id,
		);

		expect(recovery.recovered[0]?.outcome).toBe("retry_scheduled");
		expect(recovery.state.steps.survey?.state).toBe("ready");
		expect(recovery.state.attempts[0]?.state).toBe("interrupted");
		expect(recovery.state.events.map((event) => event.kind)).toEqual([
			"step_failed",
			"step_retry_scheduled",
		]);

		const resumed = await harness.engine.run(harness.initial.id);
		expect(resumed.state).toBe("completed");
		expect(resumed.attempts).toHaveLength(2);
	});

	it("fails an interrupted attempt that has no retry budget left", async () => {
		const plan = workflowPlanOf([investigationStep("survey")]);
		const harness = await createWorkflowHarness(plan, []);
		const survey = harness.initial.steps.survey;
		if (!survey) {
			throw new Error("missing step");
		}
		harness.store.save({
			...harness.initial,
			steps: {
				...harness.initial.steps,
				survey: { ...survey, state: "running", attemptIds: ["survey-1"] },
			},
			attempts: [
				{
					id: "survey-1",
					stepId: "survey",
					number: 1,
					state: "running",
					workspaceRequirement: "read-only",
					workspacePath: join(harness.worktreeRoot, "gone"),
					baseCommit: harness.initial.integrationHead,
					startedAt: "2026-07-29T00:00:00.000Z",
				},
			],
		});

		const recovery = await recoverWorkflowRun(
			{ store: harness.store, git: new GitCli() },
			harness.initial.id,
		);

		expect(recovery.recovered[0]?.outcome).toBe("failed");
		expect(recovery.state.state).toBe("failed");
		expect(recovery.state.steps.survey?.state).toBe("failed");
	});

	it("leaves a settled run untouched", async () => {
		const plan = workflowPlanOf([investigationStep("survey")]);
		const harness = await createWorkflowHarness(plan, [
			handlerOf("investigation", async () => ({ status: "succeeded" })),
		]);
		const finished = await harness.engine.run(harness.initial.id);

		const recovery = await recoverWorkflowRun(
			{ store: harness.store, git: new GitCli() },
			harness.initial.id,
		);

		expect(recovery.recovered).toEqual([]);
		expect(recovery.state).toEqual(finished);
	});
});
