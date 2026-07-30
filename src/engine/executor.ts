import type { StepExecutionContext } from "../domain/step-context.js";
import type { StepDefinition } from "../domain/steps.js";
import type { CapabilityProfile } from "../domain/types.js";
import type { RepositoryInfo } from "../git/git.js";
import type {
	StepHandler,
	StepHandlerContext,
	StepHandlerRegistry,
	StepOutcome,
} from "./handlers.js";
import type { WorkflowStepAttempt } from "./workflow-state.js";
import type {
	Workspace,
	WorkspaceProvider,
	WorkspaceProviderRegistry,
	WorkspaceRequirement,
} from "./workspaces.js";

export const DEFAULT_STEP_TIMEOUT_MS = 60 * 60 * 1_000;

export interface StepExecutorOptions {
	workspaces: WorkspaceProviderRegistry;
	handlers: StepHandlerRegistry;
	now?: () => string;
	defaultTimeoutMs?: number;
}

export interface PrepareStepRequest {
	runId: string;
	repository: RepositoryInfo;
	step: StepDefinition;
	requirement: WorkspaceRequirement;
	capabilityProfile: CapabilityProfile;
	attemptNumber: number;
	startPoint: string;
}

/** An acquired workspace bound to the handler that will use it. */
export interface PreparedStep {
	runId: string;
	repository: RepositoryInfo;
	step: StepDefinition;
	handler: StepHandler;
	provider: WorkspaceProvider;
	workspace: Workspace;
	capabilityProfile: CapabilityProfile;
}

export interface ExecuteStepRequest {
	prepared: PreparedStep;
	attempt: WorkflowStepAttempt;
	execution: StepExecutionContext;
	signal?: AbortSignal;
}

export interface StepExecutionResult {
	outcome: StepOutcome;
	startedAt: string;
	finishedAt: string;
	timedOut: boolean;
	workspaceRetained: boolean;
	workspaceReleaseError?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one prepared step: acquires and releases its workspace, bounds it by
 * its declared timeout, links it to run cancellation, and normalizes every
 * failure mode into one outcome shape.
 */
export class StepExecutor {
	private readonly now: () => string;
	private readonly defaultTimeoutMs: number;

	constructor(private readonly options: StepExecutorOptions) {
		this.now = options.now ?? (() => new Date().toISOString());
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
		if (!Number.isFinite(this.defaultTimeoutMs) || this.defaultTimeoutMs <= 0) {
			throw new Error("defaultTimeoutMs must be a positive finite number");
		}
	}

	/**
	 * Resolves the handler before allocating anything, so an unexecutable step
	 * kind never creates a branch or a worktree.
	 */
	async prepare(request: PrepareStepRequest): Promise<PreparedStep> {
		const handler = this.options.handlers.handlerFor(request.step);
		const provider = this.options.workspaces.providerFor(request.requirement);
		const workspace = await provider.acquire({
			repository: request.repository,
			runId: request.runId,
			stepId: request.step.id,
			attemptNumber: request.attemptNumber,
			startPoint: request.startPoint,
		});
		return {
			runId: request.runId,
			repository: request.repository,
			step: request.step,
			handler,
			provider,
			workspace,
			capabilityProfile: request.capabilityProfile,
		};
	}

	/** Releases a prepared workspace that will never execute. */
	async discard(prepared: PreparedStep): Promise<string | undefined> {
		try {
			await prepared.provider.release(
				prepared.repository.root,
				prepared.workspace,
			);
			return undefined;
		} catch (error) {
			return errorMessage(error);
		}
	}

	async execute(request: ExecuteStepRequest): Promise<StepExecutionResult> {
		const { prepared } = request;
		const startedAt = this.now();
		const timeoutMs = prepared.step.timeoutMs ?? this.defaultTimeoutMs;
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error(`Step ${prepared.step.id} timed out`));
		}, timeoutMs);
		const forwardAbort = () => {
			controller.abort(request.signal?.reason);
		};
		request.signal?.addEventListener("abort", forwardAbort, { once: true });
		if (request.signal?.aborted) {
			forwardAbort();
		}
		let outcome: StepOutcome;
		try {
			const aborted = new Promise<StepOutcome>((resolve) => {
				const settle = () => {
					resolve(
						timedOut
							? {
									status: "failed",
									error: `Step ${prepared.step.id} timed out after ${timeoutMs}ms`,
								}
							: {
									status: "cancelled",
									error: errorMessage(
										controller.signal.reason ?? "Step execution cancelled",
									),
								},
					);
				};
				controller.signal.addEventListener("abort", settle, { once: true });
				if (controller.signal.aborted) {
					settle();
				}
			});
			const context: StepHandlerContext = {
				runId: prepared.runId,
				repository: prepared.repository,
				step: prepared.step,
				attempt: request.attempt,
				workspace: prepared.workspace,
				execution: request.execution,
				capabilityProfile: prepared.capabilityProfile,
				signal: controller.signal,
				now: this.now,
			};
			const execution = prepared.handler
				.execute(context)
				.catch((error) =>
					request.signal?.aborted
						? { status: "cancelled" as const, error: errorMessage(error) }
						: { status: "failed" as const, error: errorMessage(error) },
				);
			outcome = await Promise.race([aborted, execution]);
		} catch (error) {
			outcome = request.signal?.aborted
				? { status: "cancelled", error: errorMessage(error) }
				: { status: "failed", error: errorMessage(error) };
		} finally {
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", forwardAbort);
		}
		// An expired step never counts as successful, however its handler chose
		// to return once its signal was aborted.
		if (timedOut) {
			outcome = {
				status: "failed",
				error: `Step ${prepared.step.id} timed out after ${timeoutMs}ms`,
			};
		}
		// A failed workspace is kept as evidence, matching how an unsuccessful
		// attempt's worktree stays inspectable until the run is pruned.
		const workspaceRetained = outcome.status !== "succeeded";
		const workspaceReleaseError = workspaceRetained
			? undefined
			: await this.discard(prepared);
		return {
			outcome,
			startedAt,
			finishedAt: this.now(),
			timedOut,
			workspaceRetained,
			...(workspaceReleaseError ? { workspaceReleaseError } : {}),
		};
	}
}
