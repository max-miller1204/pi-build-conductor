import { randomUUID } from "node:crypto";
import {
	resolveStepInputs,
	type StepArtifactReader,
	type StepExecutionContext,
} from "../domain/step-context.js";
import { type StepDefinition, stepRetryPolicy } from "../domain/steps.js";
import type { RepositoryInfo } from "../git/git.js";
import { stepCapabilityProfile } from "../security/capabilities.js";
import {
	routeStepArtifacts,
	StepArtifactRoutingError,
	type StepArtifactWriter,
} from "./artifact-routing.js";
import {
	appendWorkflowEvent,
	appendWorkflowEvents,
	blockedStepEvents,
	type WorkflowEvent,
	type WorkflowEventBody,
} from "./events.js";
import type {
	PreparedStep,
	StepExecutionResult,
	StepExecutor,
} from "./executor.js";
import type { StepIntegrator } from "./integration.js";
import { classifyStepFailure } from "./retry.js";
import {
	launchableStepIds,
	nextIntegrableStepId,
	reconcileWorkflowSteps,
} from "./scheduler.js";
import type { WorkflowStateStore } from "./state-store.js";
import {
	requireStep,
	TERMINAL_STEP_STATES,
	updateStep,
	updateStepAttempt,
	type WorkflowRunLifecycleState,
	type WorkflowRunState,
	type WorkflowStepAttempt,
} from "./workflow-state.js";
import { workspaceRequirementFor } from "./workspaces.js";

/** Reads declared step inputs and stores declared step outputs. */
export interface WorkflowArtifactStore
	extends StepArtifactReader,
		StepArtifactWriter {}

export interface WorkflowEngineDependencies {
	store: WorkflowStateStore;
	executor: StepExecutor;
	integrator: StepIntegrator;
	repository: RepositoryInfo;
	/** Required for plans whose steps declare inputs or outputs. */
	artifacts?: WorkflowArtifactStore;
	now?: () => string;
	onStateChanged?: (state: WorkflowRunState) => void;
	onEvent?: (event: WorkflowEvent) => void;
	newAttemptId?: (stepId: string, attemptNumber: number) => string;
}

export interface RunWorkflowOptions {
	signal?: AbortSignal;
}

interface LaunchedStep {
	attemptId: string;
	completion: Promise<string>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Drives a workflow plan to completion: it decides when each step may run,
 * gives it exactly the workspace and context its approved authority allows,
 * routes the artifacts it produced, integrates its repository changes, and
 * settles the run onto one ordered, inspectable timeline.
 *
 * The engine owns scheduling, isolation, and state; step handlers own the work.
 */
export class WorkflowEngine {
	private readonly now: () => string;
	private readonly executing = new Map<string, AbortController>();
	private readonly emittedEvents = new Map<string, number>();

	constructor(private readonly dependencies: WorkflowEngineDependencies) {
		this.now = dependencies.now ?? (() => new Date().toISOString());
	}

	async run(
		runId: string,
		options: RunWorkflowOptions = {},
	): Promise<WorkflowRunState> {
		if (this.executing.has(runId)) {
			throw new Error(`Run ${runId} is already executing`);
		}
		const controller = new AbortController();
		const forwardAbort = () => {
			controller.abort(options.signal?.reason);
		};
		options.signal?.addEventListener("abort", forwardAbort, { once: true });
		if (options.signal?.aborted) {
			forwardAbort();
		}
		this.executing.set(runId, controller);
		const active = new Map<string, Promise<string>>();
		try {
			while (true) {
				const integrated = await this.integratePendingSteps(runId);
				if (integrated.state === "running" && !controller.signal.aborted) {
					await this.dispatchLaunchableSteps(runId, active, controller.signal);
				}
				if (active.size === 0) {
					return await this.settleRun(runId, controller.signal.aborted);
				}
				const settledAttemptId = await Promise.race(active.values());
				active.delete(settledAttemptId);
			}
		} finally {
			await Promise.allSettled([...active.values()]);
			this.executing.delete(runId);
			options.signal?.removeEventListener("abort", forwardAbort);
		}
	}

	/**
	 * Requests cancellation. A run this engine is executing stops its steps and
	 * settles itself; a run nobody is executing is settled here so a cancelled
	 * run never stays open.
	 */
	async cancel(
		runId: string,
		reason = "The run was cancelled",
	): Promise<WorkflowRunState> {
		const requested = this.notify(
			await this.dependencies.store.transaction(runId, (current) =>
				appendWorkflowEvent(
					current,
					{ kind: "run_cancellation_requested", reason },
					this.now(),
				),
			),
		);
		const controller = this.executing.get(runId);
		if (controller) {
			controller.abort(new Error(reason));
			return requested;
		}
		return this.settleRun(runId, true);
	}

	private notify(state: WorkflowRunState): WorkflowRunState {
		const emitted = this.emittedEvents.get(state.id) ?? 0;
		if (state.eventSequence > emitted) {
			this.emittedEvents.set(state.id, state.eventSequence);
			for (const event of state.events) {
				if (event.sequence > emitted) {
					try {
						this.dependencies.onEvent?.(event);
					} catch {
						// Observers must never affect persisted lifecycle state.
					}
				}
			}
		}
		try {
			this.dependencies.onStateChanged?.(state);
		} catch {
			// Observers must never affect persisted lifecycle state.
		}
		return state;
	}

	private attemptId(stepId: string, attemptNumber: number): string {
		return this.dependencies.newAttemptId
			? this.dependencies.newAttemptId(stepId, attemptNumber)
			: `${stepId}-${attemptNumber}-${randomUUID().slice(0, 8)}`;
	}

	private async dispatchLaunchableSteps(
		runId: string,
		active: Map<string, Promise<string>>,
		signal: AbortSignal,
	): Promise<void> {
		const state = await this.dependencies.store.load(runId);
		for (const stepId of launchableStepIds(state)) {
			const launched = await this.launchStep(runId, stepId, signal);
			if (!launched) {
				return;
			}
			active.set(launched.attemptId, launched.completion);
		}
	}

	private async executionContext(
		state: WorkflowRunState,
		step: StepDefinition,
		startPoint: string,
	): Promise<StepExecutionContext> {
		const repositorySnapshot = {
			baseBranch: state.baseBranch,
			integrationBranch: state.integrationBranch,
			commit: startPoint,
		};
		if ((step.inputs ?? []).length === 0) {
			return { repositorySnapshot, upstreamArtifacts: [] };
		}
		const artifacts = this.dependencies.artifacts;
		if (!artifacts) {
			throw new Error(
				`Step ${step.id} declares inputs but no artifact store is configured`,
			);
		}
		const resolution = await resolveStepInputs(artifacts, state.id, step);
		if (!resolution.ok) {
			const missing = resolution.missing
				.map((reference) => `${reference.stepId}.${reference.output}`)
				.join(", ");
			throw new Error(`Step ${step.id} is missing required inputs: ${missing}`);
		}
		return { repositorySnapshot, upstreamArtifacts: resolution.inputs };
	}

	private async launchStep(
		runId: string,
		stepId: string,
		signal: AbortSignal,
	): Promise<LaunchedStep | undefined> {
		const state = await this.dependencies.store.load(runId);
		const record = requireStep(state, stepId);
		const step = record.definition;
		const capabilityProfile = stepCapabilityProfile(
			state.capabilityProfiles,
			step,
		);
		const requirement = workspaceRequirementFor(capabilityProfile);
		const attemptNumber = record.attemptIds.length + 1;
		const startPoint = state.integrationHead;
		let prepared: PreparedStep | undefined;
		try {
			const execution = await this.executionContext(state, step, startPoint);
			prepared = await this.dependencies.executor.prepare({
				runId,
				repository: this.dependencies.repository,
				step,
				requirement,
				capabilityProfile,
				attemptNumber,
				startPoint,
			});
			const attempt: WorkflowStepAttempt = {
				id: this.attemptId(stepId, attemptNumber),
				stepId,
				number: attemptNumber,
				state: "prepared",
				workspaceRequirement: prepared.workspace.requirement,
				workspacePath: prepared.workspace.path,
				...(prepared.workspace.branch
					? { branch: prepared.workspace.branch }
					: {}),
				baseCommit: prepared.workspace.baseCommit,
				startedAt: this.now(),
			};
			let reserved = false;
			const stored = await this.dependencies.store.transaction(
				runId,
				(current) => {
					if (!launchableStepIds(current).includes(stepId)) {
						return current;
					}
					reserved = true;
					const currentStep = requireStep(current, stepId);
					return appendWorkflowEvent(
						{
							...updateStep(current, stepId, {
								state: "running",
								attemptIds: [...currentStep.attemptIds, attempt.id],
							}),
							attempts: [...current.attempts, attempt],
							updatedAt: this.now(),
						},
						{
							kind: "step_launched",
							stepId,
							attemptId: attempt.id,
							attemptNumber,
							workspaceRequirement: attempt.workspaceRequirement,
						},
						this.now(),
					);
				},
			);
			if (!reserved) {
				await this.dependencies.executor.discard(prepared);
				return undefined;
			}
			this.notify(stored);
			const running = { ...attempt, state: "running" as const };
			this.notify(
				await this.dependencies.store.transaction(runId, (current) => ({
					...updateStepAttempt(current, attempt.id, { state: "running" }),
					updatedAt: this.now(),
				})),
			);
			const completion = this.dependencies.executor
				.execute({
					prepared,
					attempt: running,
					execution,
					signal,
				})
				.catch(
					(error): StepExecutionResult => ({
						outcome: { status: "failed", error: errorMessage(error) },
						startedAt: attempt.startedAt,
						finishedAt: this.now(),
						timedOut: false,
						workspaceRetained: true,
					}),
				)
				.then(async (result) => {
					await this.settleStep(runId, stepId, running, result);
					return attempt.id;
				});
			return { attemptId: attempt.id, completion };
		} catch (error) {
			if (prepared) {
				await this.dependencies.executor.discard(prepared);
			}
			await this.failStep(runId, stepId, errorMessage(error));
			return undefined;
		}
	}

	/**
	 * Publishes a successful step's declared outputs before the step counts as
	 * finished, so a dependent step can never observe a succeeded producer
	 * whose artifacts are missing.
	 */
	private async routeArtifacts(
		runId: string,
		step: StepDefinition,
		attempt: WorkflowStepAttempt,
		result: StepExecutionResult,
	): Promise<{ artifactIds: string[]; events: WorkflowEventBody[] }> {
		const drafts =
			result.outcome.status === "succeeded"
				? (result.outcome.artifacts ?? [])
				: [];
		if (drafts.length === 0 && (step.outputs ?? []).length === 0) {
			return { artifactIds: [], events: [] };
		}
		const artifacts = this.dependencies.artifacts;
		if (!artifacts) {
			throw new StepArtifactRoutingError(
				`Step ${step.id} declares outputs but no artifact store is configured`,
			);
		}
		const summaries = await routeStepArtifacts(
			artifacts,
			runId,
			step,
			attempt.number,
			drafts,
		);
		return {
			artifactIds: summaries.map((summary) => summary.id),
			events: summaries.map((summary) => ({
				kind: "artifact_published" as const,
				stepId: step.id,
				attemptId: attempt.id,
				artifactId: summary.id,
				output: summary.output,
				artifactKind: summary.kind,
				sizeBytes: summary.sizeBytes,
			})),
		};
	}

	private async settleStep(
		runId: string,
		stepId: string,
		attempt: WorkflowStepAttempt,
		executed: StepExecutionResult,
	): Promise<void> {
		let result = executed;
		let artifactIds: string[] = [];
		let artifactEvents: WorkflowEventBody[] = [];
		if (result.outcome.status === "succeeded") {
			try {
				const routed = await this.routeArtifacts(
					runId,
					requireStep(await this.dependencies.store.load(runId), stepId)
						.definition,
					attempt,
					result,
				);
				artifactIds = routed.artifactIds;
				artifactEvents = routed.events;
			} catch (error) {
				result = {
					...result,
					outcome: {
						status: "failed",
						error: errorMessage(error),
						retryable: !(error instanceof StepArtifactRoutingError),
					},
				};
			}
		}
		const outcome = result.outcome;
		this.notify(
			await this.dependencies.store.transaction(runId, (current) => {
				const step = requireStep(current, stepId).definition;
				const classification =
					outcome.status === "succeeded"
						? undefined
						: classifyStepFailure({
								outcome,
								timedOut: result.timedOut,
								attemptNumber: attempt.number,
								maxAttempts: stepRetryPolicy(step).maxAttempts,
							});
				const attemptState =
					outcome.status === "succeeded"
						? "succeeded"
						: outcome.status === "cancelled"
							? "cancelled"
							: "failed";
				let next = updateStepAttempt(current, attempt.id, {
					state: attemptState,
					finishedAt: result.finishedAt,
					...(outcome.status === "succeeded"
						? {
								...(outcome.summary ? { summary: outcome.summary } : {}),
								...(outcome.commit ? { commit: outcome.commit } : {}),
								...(artifactIds.length > 0 ? { artifactIds } : {}),
							}
						: { error: outcome.error }),
					...(result.workspaceReleaseError
						? { workspaceReleaseError: result.workspaceReleaseError }
						: {}),
				});
				const retrying = classification?.failureClass === "retryable";
				next = updateStep(next, stepId, {
					state:
						outcome.status === "succeeded"
							? "succeeded"
							: retrying
								? "ready"
								: attemptState,
					...(outcome.status === "succeeded" || retrying
						? {}
						: { error: outcome.error }),
				});
				const events: WorkflowEventBody[] = [...artifactEvents];
				if (outcome.status === "succeeded") {
					events.push({
						kind: "step_succeeded",
						stepId,
						attemptId: attempt.id,
						...(outcome.summary ? { summary: outcome.summary } : {}),
					});
				} else if (outcome.status === "cancelled") {
					events.push({
						kind: "step_cancelled",
						stepId,
						attemptId: attempt.id,
						error: outcome.error,
					});
				} else {
					events.push({
						kind: "step_failed",
						stepId,
						attemptId: attempt.id,
						error: outcome.error,
						failureClass: classification?.failureClass ?? "terminal",
						reason: classification?.reason ?? "",
					});
					if (retrying) {
						events.push({
							kind: "step_retry_scheduled",
							stepId,
							attemptId: attempt.id,
							nextAttemptNumber: attempt.number + 1,
							reason: classification?.reason ?? "",
						});
					}
				}
				const reconciled = reconcileWorkflowSteps(next);
				const runState: WorkflowRunLifecycleState =
					reconciled.state !== "running"
						? reconciled.state
						: outcome.status === "cancelled"
							? "cancelled"
							: outcome.status === "failed" && !retrying
								? "failed"
								: "running";
				return appendWorkflowEvents(
					{ ...reconciled, state: runState, updatedAt: this.now() },
					[...events, ...blockedStepEvents(next, reconciled)],
					this.now(),
				);
			}),
		);
	}

	private async failStep(
		runId: string,
		stepId: string,
		message: string,
	): Promise<void> {
		this.notify(
			await this.dependencies.store.transaction(runId, (current) => {
				const failed = updateStep(current, stepId, {
					state: "failed",
					error: message,
				});
				const reconciled = reconcileWorkflowSteps(failed);
				return appendWorkflowEvents(
					{
						...reconciled,
						state:
							reconciled.state === "cancelled" ? reconciled.state : "failed",
						updatedAt: this.now(),
					},
					[
						{
							kind: "step_failed",
							stepId,
							attemptId: "",
							error: message,
							failureClass: "terminal",
							reason: "the step could not start",
						},
						...blockedStepEvents(failed, reconciled),
					],
					this.now(),
				);
			}),
		);
	}

	private async integratePendingSteps(
		runId: string,
	): Promise<WorkflowRunState> {
		while (true) {
			const state = await this.dependencies.store.load(runId);
			if (state.state !== "running") {
				return state;
			}
			const stepId = nextIntegrableStepId(state);
			if (!stepId) {
				return state;
			}
			const attempt = state.attempts.findLast(
				(candidate) =>
					candidate.stepId === stepId && candidate.state === "succeeded",
			);
			if (!attempt) {
				await this.failStep(
					runId,
					stepId,
					`Step ${stepId} succeeded without a recorded attempt`,
				);
				return this.dependencies.store.load(runId);
			}
			try {
				// A mutating step that changed nothing still unblocks dependents:
				// the current head already contains everything it produced.
				const integratedCommit = attempt.commit
					? await this.dependencies.integrator.integrate({
							repositoryRoot: state.repositoryRoot,
							integrationBranch: state.integrationBranch,
							expectedHead: state.integrationHead,
							stepId,
							attempt,
							commit: attempt.commit,
						})
					: state.integrationHead;
				this.notify(
					await this.dependencies.store.transaction(runId, (current) =>
						appendWorkflowEvent(
							reconcileWorkflowSteps({
								...updateStep(current, stepId, { integratedCommit }),
								integrationHead: integratedCommit,
								updatedAt: this.now(),
							}),
							{
								kind: "step_integrated",
								stepId,
								...(attempt.commit ? { commit: attempt.commit } : {}),
								integrationHead: integratedCommit,
							},
							this.now(),
						),
					),
				);
			} catch (error) {
				const message = `Failed to integrate step ${stepId}: ${errorMessage(error)}`;
				this.notify(
					await this.dependencies.store.transaction(runId, (current) => {
						const failed = updateStep(current, stepId, {
							state: "failed",
							integrationError: message,
						});
						const reconciled = reconcileWorkflowSteps(failed);
						return appendWorkflowEvents(
							{ ...reconciled, state: "failed", updatedAt: this.now() },
							[
								{
									kind: "step_failed",
									stepId,
									attemptId: attempt.id,
									error: message,
									failureClass: "terminal",
									reason: "the produced commit could not be integrated",
								},
								...blockedStepEvents(failed, reconciled),
							],
							this.now(),
						);
					}),
				);
				return this.dependencies.store.load(runId);
			}
		}
	}

	private async settleRun(
		runId: string,
		cancelled: boolean,
	): Promise<WorkflowRunState> {
		return this.notify(
			await this.dependencies.store.transaction(runId, (current) => {
				if (current.events.some((event) => event.kind === "run_settled")) {
					return current;
				}
				let next = reconcileWorkflowSteps(current);
				const events: WorkflowEventBody[] = [];
				// A cancelled run ends everything it had not finished, including
				// steps that were only blocked by the cancellation itself.
				const cancelling =
					(cancelled || next.state === "cancelled") &&
					next.state !== "failed" &&
					next.state !== "completed";
				if (cancelling) {
					for (const [stepId, record] of Object.entries(next.steps)) {
						if (
							record.state === "succeeded" ||
							record.state === "failed" ||
							record.state === "cancelled"
						) {
							continue;
						}
						next = updateStep(next, stepId, { state: "cancelled" });
						events.push({ kind: "step_cancelled", stepId });
					}
				}
				const states = Object.values(next.steps).map((step) => step.state);
				const unfinished = states.filter(
					(state) => !TERMINAL_STEP_STATES.has(state),
				);
				const state: WorkflowRunLifecycleState =
					next.state !== "running"
						? next.state
						: unfinished.length > 0
							? "failed"
							: states.every((value) => value === "succeeded")
								? "completed"
								: states.includes("cancelled")
									? "cancelled"
									: "failed";
				const error =
					state === "failed" && unfinished.length > 0
						? "The workflow stopped while steps were still waiting to run"
						: undefined;
				events.push({
					kind: "run_settled",
					state,
					...(error ? { error } : {}),
				});
				return appendWorkflowEvents(
					{
						...next,
						state,
						...(error ? { error } : {}),
						updatedAt: this.now(),
					},
					events,
					this.now(),
				);
			}),
		);
	}
}
