import { describe, expect, it } from "vitest";
import type { StepExecutionContext } from "../src/domain/step-context.js";
import {
	type StepDefinition,
	validateWorkflowPlan,
} from "../src/domain/steps.js";
import { StepExecutor } from "../src/engine/executor.js";
import {
	type StepHandler,
	type StepHandlerContext,
	StepHandlerRegistry,
	type StepOutcome,
	UnsupportedStepKindError,
} from "../src/engine/handlers.js";
import { classifyStepFailure } from "../src/engine/retry.js";
import type { WorkflowStepAttempt } from "../src/engine/workflow-state.js";
import {
	DetachedWorkspaceProvider,
	stepWorkspaceRequirement,
	type Workspace,
	type WorkspaceProvider,
	WorkspaceProviderRegistry,
	type WorkspaceRequest,
	WorktreeWorkspaceProvider,
} from "../src/engine/workspaces.js";
import type { RepositoryInfo } from "../src/git/git.js";
import type {
	PrepareTaskWorktreeInput,
	WorktreeAllocation,
	WorktreeManager,
} from "../src/git/worktrees.js";
import {
	capabilityProfileFor,
	defaultCapabilityProfiles,
} from "../src/security/capabilities.js";

const repository: RepositoryInfo = {
	root: "/repo",
	commonDirectory: "/repo/.git",
	currentBranch: "main",
	head: "base",
	isClean: true,
};

const execution: StepExecutionContext = {
	repositorySnapshot: {
		baseBranch: "main",
		integrationBranch: "conductor/run-1/integration",
		commit: "base",
	},
	upstreamArtifacts: [],
};

function stepOf(value: Record<string, unknown>): StepDefinition {
	const plan = validateWorkflowPlan({
		version: 4,
		title: "Plan",
		steps: [value],
		finalValidationCommands: [{ command: "node", args: ["-e", ""] }],
	});
	const step = plan.steps[0];
	if (!step) {
		throw new Error("missing step");
	}
	return step;
}

function investigation(extra: Record<string, unknown> = {}): StepDefinition {
	return stepOf({
		kind: "investigation",
		id: "survey",
		title: "Survey",
		description: "Survey the repository",
		dependencies: [],
		questions: ["What exists?"],
		...extra,
	});
}

function change(extra: Record<string, unknown> = {}): StepDefinition {
	return stepOf({
		kind: "change",
		id: "api",
		title: "API",
		description: "Implement the API",
		dependencies: [],
		acceptanceCriteria: ["it works"],
		allowedPaths: ["src/api/"],
		validationCommands: [{ command: "node", args: ["-e", ""] }],
		...extra,
	});
}

function attemptOf(workspace: Workspace): WorkflowStepAttempt {
	return {
		id: "survey-1",
		stepId: "survey",
		number: 1,
		state: "running",
		workspaceRequirement: workspace.requirement,
		workspacePath: workspace.path,
		baseCommit: workspace.baseCommit,
		startedAt: "2026-07-29T00:00:00.000Z",
	};
}

class RecordingProvider implements WorkspaceProvider {
	acquired: WorkspaceRequest[] = [];
	released: string[] = [];
	releaseError?: Error;

	constructor(readonly requirement: Workspace["requirement"]) {}

	async acquire(request: WorkspaceRequest): Promise<Workspace> {
		this.acquired.push(request);
		return {
			requirement: this.requirement,
			path: `/workspaces/${request.stepId}`,
			branch: `conductor/${request.runId}/task/${request.stepId}/attempt-1`,
			baseCommit: request.startPoint,
		};
	}

	async release(_repositoryRoot: string, workspace: Workspace): Promise<void> {
		if (this.releaseError) {
			throw this.releaseError;
		}
		this.released.push(workspace.path);
	}
}

function registryWith(provider: RecordingProvider): WorkspaceProviderRegistry {
	const providers: WorkspaceProvider[] = [
		new DetachedWorkspaceProvider(),
		new RecordingProvider("read-only"),
		new RecordingProvider("mutable"),
	].filter((candidate) => candidate.requirement !== provider.requirement);
	return new WorkspaceProviderRegistry([...providers, provider]);
}

function handlerOf(
	kind: StepDefinition["kind"],
	body: (context: StepHandlerContext) => Promise<StepOutcome>,
): StepHandler {
	return { kind, execute: body };
}

describe("workspace requirements", () => {
	const profiles = defaultCapabilityProfiles();

	it("derives the workspace each step kind needs", () => {
		expect(stepWorkspaceRequirement(profiles, investigation())).toBe(
			"read-only",
		);
		expect(stepWorkspaceRequirement(profiles, change())).toBe("mutable");
		expect(
			stepWorkspaceRequirement(
				profiles,
				stepOf({
					kind: "command",
					id: "audit",
					title: "Audit",
					description: "Run the audit",
					dependencies: [],
					command: { command: "node", args: ["-e", ""] },
				}),
			),
		).toBe("read-only");
		expect(
			stepWorkspaceRequirement(
				profiles,
				stepOf({
					kind: "approval",
					id: "ship",
					title: "Ship",
					description: "Approve the release",
					dependencies: [],
					prompt: "Ship it?",
				}),
			),
		).toBe("none");
	});

	it("narrows the workspace when a step narrows its capabilities", () => {
		expect(
			stepWorkspaceRequirement(
				profiles,
				change({ capabilities: ["read-repository"] }),
			),
		).toBe("read-only");
	});

	it("narrows the workspace when the frozen run profile is narrower", () => {
		const frozen = {
			...profiles,
			change: capabilityProfileFor(["read-repository"]),
		};

		expect(stepWorkspaceRequirement(frozen, change())).toBe("read-only");
	});

	it("requires exactly one provider per requirement", () => {
		expect(
			() =>
				new WorkspaceProviderRegistry([
					new DetachedWorkspaceProvider(),
					new DetachedWorkspaceProvider(),
				]),
		).toThrow(/Duplicate workspace provider/);
		expect(
			() => new WorkspaceProviderRegistry([new DetachedWorkspaceProvider()]),
		).toThrow(/Missing workspace provider/);
	});

	it("allocates an isolated worktree through the worktree manager", async () => {
		const prepared: PrepareTaskWorktreeInput[] = [];
		const removed: string[] = [];
		const worktrees: WorktreeManager = {
			async prepareIntegrationBranch(): Promise<string> {
				throw new Error("unused");
			},
			async prepareTaskWorktree(
				input: PrepareTaskWorktreeInput,
			): Promise<WorktreeAllocation> {
				prepared.push(input);
				return {
					branch: "conductor/run-1/task/api/attempt-2",
					path: "/wt/api",
				};
			},
			async prepareReadOnlyWorktree(): Promise<string> {
				throw new Error("mutable steps never use read-only worktrees");
			},
			finalValidationWorktreePath(): string {
				throw new Error("unused");
			},
			async prepareFinalValidationWorktree(): Promise<string> {
				throw new Error("unused");
			},
			async removeTaskWorktree(_root: string, path: string): Promise<void> {
				removed.push(path);
			},
		};
		const provider = new WorktreeWorkspaceProvider(worktrees, "mutable");

		const workspace = await provider.acquire({
			repository,
			runId: "run-1",
			stepId: "api",
			attemptNumber: 2,
			startPoint: "head-1",
		});
		await provider.release(repository.root, workspace);

		expect(prepared).toEqual([
			{
				repository,
				runId: "run-1",
				taskId: "api",
				attemptNumber: 2,
				startPoint: "head-1",
			},
		]);
		expect(workspace).toEqual({
			requirement: "mutable",
			path: "/wt/api",
			branch: "conductor/run-1/task/api/attempt-2",
			baseCommit: "head-1",
		});
		expect(removed).toEqual(["/wt/api"]);
	});

	it("gives read-only steps a detached, branchless worktree", async () => {
		const prepared: PrepareTaskWorktreeInput[] = [];
		const worktrees: WorktreeManager = {
			async prepareIntegrationBranch(): Promise<string> {
				throw new Error("unused");
			},
			async prepareTaskWorktree(): Promise<WorktreeAllocation> {
				throw new Error("read-only steps never receive a branch worktree");
			},
			async prepareReadOnlyWorktree(
				input: PrepareTaskWorktreeInput,
			): Promise<string> {
				prepared.push(input);
				return "/wt/review";
			},
			finalValidationWorktreePath(): string {
				throw new Error("unused");
			},
			async prepareFinalValidationWorktree(): Promise<string> {
				throw new Error("unused");
			},
			async removeTaskWorktree(): Promise<void> {},
		};
		const provider = new WorktreeWorkspaceProvider(worktrees, "read-only");

		const workspace = await provider.acquire({
			repository,
			runId: "run-1",
			stepId: "review-security",
			attemptNumber: 1,
			startPoint: "head-1",
		});

		expect(prepared).toHaveLength(1);
		expect(workspace).toEqual({
			requirement: "read-only",
			path: "/wt/review",
			baseCommit: "head-1",
		});
	});
});

describe("step handler registry", () => {
	it("rejects duplicate handlers for one kind", () => {
		const handler = handlerOf("change", async () => ({ status: "succeeded" }));

		expect(() => new StepHandlerRegistry([handler, handler])).toThrow(
			/Duplicate step handler/,
		);
	});

	it("fails closed for an unregistered kind", () => {
		const registry = new StepHandlerRegistry([
			handlerOf("change", async () => ({ status: "succeeded" })),
		]);

		expect(registry.kinds()).toEqual(["change"]);
		expect(registry.has("approval")).toBe(false);
		expect(() => registry.handlerFor(investigation())).toThrow(
			UnsupportedStepKindError,
		);
	});
});

describe("step executor", () => {
	const profiles = defaultCapabilityProfiles();

	function executorWith(
		provider: RecordingProvider,
		handlers: StepHandler[],
		defaultTimeoutMs?: number,
	): StepExecutor {
		return new StepExecutor({
			workspaces: registryWith(provider),
			handlers: new StepHandlerRegistry(handlers),
			...(defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs }),
		});
	}

	async function prepared(
		executor: StepExecutor,
		step: StepDefinition,
	): Promise<Awaited<ReturnType<StepExecutor["prepare"]>>> {
		return executor.prepare({
			runId: "run-1",
			repository,
			step,
			requirement: stepWorkspaceRequirement(profiles, step),
			capabilityProfile: profiles[step.kind],
			attemptNumber: 1,
			startPoint: "base",
		});
	}

	it("resolves the handler before allocating any workspace", async () => {
		const provider = new RecordingProvider("read-only");
		const executor = executorWith(provider, []);

		await expect(prepared(executor, investigation())).rejects.toThrow(
			UnsupportedStepKindError,
		);
		expect(provider.acquired).toEqual([]);
	});

	it("gives the handler its workspace and releases it after success", async () => {
		const provider = new RecordingProvider("read-only");
		const seen: StepHandlerContext[] = [];
		const executor = executorWith(provider, [
			handlerOf("investigation", async (context) => {
				seen.push(context);
				return { status: "succeeded", summary: "done" };
			}),
		]);
		const step = investigation();
		const preparedStep = await prepared(executor, step);

		const result = await executor.execute({
			prepared: preparedStep,
			attempt: attemptOf(preparedStep.workspace),
			execution,
		});

		expect(result.outcome).toEqual({ status: "succeeded", summary: "done" });
		expect(result.workspaceRetained).toBe(false);
		expect(provider.released).toEqual(["/workspaces/survey"]);
		expect(seen[0]?.workspace.path).toBe("/workspaces/survey");
		expect(seen[0]?.capabilityProfile.capabilities).toEqual([
			"read-repository",
		]);
		expect(seen[0]?.execution).toBe(execution);
	});

	it("keeps an unsuccessful workspace as evidence", async () => {
		const provider = new RecordingProvider("read-only");
		const executor = executorWith(provider, [
			handlerOf("investigation", async () => ({
				status: "failed",
				error: "no answer",
			})),
		]);
		const preparedStep = await prepared(executor, investigation());

		const result = await executor.execute({
			prepared: preparedStep,
			attempt: attemptOf(preparedStep.workspace),
			execution,
		});

		expect(result.outcome).toEqual({ status: "failed", error: "no answer" });
		expect(result.workspaceRetained).toBe(true);
		expect(provider.released).toEqual([]);
	});

	it("reports a workspace that cannot be released after success", async () => {
		const provider = new RecordingProvider("read-only");
		provider.releaseError = new Error("worktree is locked");
		const executor = executorWith(provider, [
			handlerOf("investigation", async () => ({ status: "succeeded" })),
		]);
		const preparedStep = await prepared(executor, investigation());

		const result = await executor.execute({
			prepared: preparedStep,
			attempt: attemptOf(preparedStep.workspace),
			execution,
		});

		expect(result.outcome.status).toBe("succeeded");
		expect(result.workspaceReleaseError).toBe("worktree is locked");
	});

	it("turns a thrown handler error into a failed outcome", async () => {
		const provider = new RecordingProvider("read-only");
		const executor = executorWith(provider, [
			handlerOf("investigation", async () => {
				throw new Error("worker crashed");
			}),
		]);
		const preparedStep = await prepared(executor, investigation());

		const result = await executor.execute({
			prepared: preparedStep,
			attempt: attemptOf(preparedStep.workspace),
			execution,
		});

		expect(result.outcome).toEqual({
			status: "failed",
			error: "worker crashed",
		});
	});

	it("aborts and fails a step that outlives its timeout", async () => {
		const provider = new RecordingProvider("read-only");
		let aborted = false;
		const executor = executorWith(provider, [
			handlerOf("investigation", async (context) => {
				await new Promise<void>((resolve) => {
					context.signal.addEventListener("abort", () => {
						aborted = true;
						resolve();
					});
				});
				return { status: "succeeded" };
			}),
		]);
		const preparedStep = await prepared(
			executor,
			investigation({
				timeoutMs: 20,
			}),
		);

		const result = await executor.execute({
			prepared: preparedStep,
			attempt: attemptOf(preparedStep.workspace),
			execution,
		});

		expect(aborted).toBe(true);
		expect(result.timedOut).toBe(true);
		expect(result.outcome).toEqual({
			status: "failed",
			error: "Step survey timed out after 20ms",
		});
		expect(result.workspaceRetained).toBe(true);
	});

	it("applies the default timeout when a step declares none", async () => {
		const provider = new RecordingProvider("read-only");
		const executor = executorWith(
			provider,
			[
				handlerOf("investigation", async (context) => {
					await new Promise<void>((resolve) => {
						context.signal.addEventListener("abort", () => {
							resolve();
						});
					});
					return { status: "succeeded" };
				}),
			],
			15,
		);
		const preparedStep = await prepared(executor, investigation());

		const result = await executor.execute({
			prepared: preparedStep,
			attempt: attemptOf(preparedStep.workspace),
			execution,
		});

		expect(result.outcome).toEqual({
			status: "failed",
			error: "Step survey timed out after 15ms",
		});
	});

	it("classifies an aborted run as cancellation rather than failure", async () => {
		const provider = new RecordingProvider("read-only");
		const controller = new AbortController();
		const executor = executorWith(provider, [
			handlerOf("investigation", async (context) => {
				controller.abort(new Error("run cancelled"));
				context.signal.throwIfAborted();
				return { status: "succeeded" };
			}),
		]);
		const preparedStep = await prepared(executor, investigation());

		const result = await executor.execute({
			prepared: preparedStep,
			attempt: attemptOf(preparedStep.workspace),
			execution,
			signal: controller.signal,
		});

		expect(result.outcome).toEqual({
			status: "cancelled",
			error: "run cancelled",
		});
		expect(result.timedOut).toBe(false);
	});

	it("passes produced artifacts through to the outcome", async () => {
		const provider = new RecordingProvider("read-only");
		const executor = executorWith(provider, [
			handlerOf("investigation", async () => ({
				status: "succeeded",
				artifacts: [
					{
						output: "findings",
						kind: "findings",
						title: "Findings",
						payload: { format: "json", value: { count: 1 } },
					},
				],
			})),
		]);
		const preparedStep = await prepared(executor, investigation());

		const result = await executor.execute({
			prepared: preparedStep,
			attempt: attemptOf(preparedStep.workspace),
			execution,
		});

		expect(
			result.outcome.status === "succeeded" ? result.outcome.artifacts : [],
		).toHaveLength(1);
	});

	it("rejects a non-positive default timeout", () => {
		expect(
			() =>
				new StepExecutor({
					workspaces: registryWith(new RecordingProvider("read-only")),
					handlers: new StepHandlerRegistry([]),
					defaultTimeoutMs: 0,
				}),
		).toThrow(/defaultTimeoutMs/);
	});
});

describe("step failure classification", () => {
	it("never retries a cancelled step", () => {
		expect(
			classifyStepFailure({
				outcome: { status: "cancelled", error: "run cancelled" },
				timedOut: false,
				attemptNumber: 1,
				maxAttempts: 3,
			}),
		).toEqual({
			failureClass: "terminal",
			reason: "the step was cancelled",
		});
	});

	it("never retries a failure the handler declared permanent", () => {
		expect(
			classifyStepFailure({
				outcome: { status: "failed", error: "rejected diff", retryable: false },
				timedOut: false,
				attemptNumber: 1,
				maxAttempts: 3,
			}).failureClass,
		).toBe("terminal");
	});

	it("retries while the declared budget lasts", () => {
		expect(
			classifyStepFailure({
				outcome: { status: "failed", error: "lost worker" },
				timedOut: false,
				attemptNumber: 1,
				maxAttempts: 2,
			}).failureClass,
		).toBe("retryable");
		expect(
			classifyStepFailure({
				outcome: { status: "failed", error: "lost worker" },
				timedOut: false,
				attemptNumber: 2,
				maxAttempts: 2,
			}),
		).toEqual({
			failureClass: "terminal",
			reason: "the retry budget of 2 attempts is exhausted",
		});
	});

	it("treats the default single-attempt budget as terminal", () => {
		expect(
			classifyStepFailure({
				outcome: { status: "failed", error: "lost worker" },
				timedOut: false,
				attemptNumber: 1,
				maxAttempts: 1,
			}),
		).toEqual({
			failureClass: "terminal",
			reason: "the retry budget of 1 attempt is exhausted",
		});
	});

	it("retries a timeout and says so", () => {
		expect(
			classifyStepFailure({
				outcome: { status: "failed", error: "Step survey timed out" },
				timedOut: true,
				attemptNumber: 1,
				maxAttempts: 3,
			}),
		).toEqual({
			failureClass: "retryable",
			reason: "the step timed out with 2 attempt(s) remaining",
		});
	});
});
