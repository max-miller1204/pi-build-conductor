import { randomUUID } from "node:crypto";
import {
	resolveStepInputs,
	type StepArtifactReader,
	type StepExecutionContext,
} from "../domain/step-context.js";
import type { StepDefinition } from "../domain/steps.js";
import type { RepositoryInfo } from "../git/git.js";
import { stepCapabilityProfile } from "../security/capabilities.js";
import type {
	PreparedStep,
	StepExecutionResult,
	StepExecutor,
} from "./executor.js";
import type { StepIntegrator } from "./integration.js";
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

export interface WorkflowEngineDependencies {
	store: WorkflowStateStore;
	executor: StepExecutor;
	integrator: StepIntegrator;
	repository: RepositoryInfo;
	/** Required only for plans whose steps declare inputs. */
	artifacts?: StepArtifactReader;
	now?: () => string;
	onStateChanged?: (state: WorkflowRunState) => void;
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
 * integrates the repository changes it produced, and settles the run.
 *
 * The engine owns scheduling, isolation, and state; step handlers own the work.
 */
export class WorkflowEngine {
	private readonly now: () => string;

	constructor(private readonly dependencies: WorkflowEngineDependencies) {
		this.now = dependencies.now ?? (() => new Date().toISOString());
	}

	async run(
		runId: string,
		options: RunWorkflowOptions = {},
	): Promise<WorkflowRunState> {
		const active = new Map<string, Promise<string>>();
		try {
			while (true) {
				const integrated = await this.integratePendingSteps(runId);
				if (integrated.state === "running" && !options.signal?.aborted) {
					await this.dispatchLaunchableSteps(runId, active, options);
				}
				if (active.size === 0) {
					return await this.settleRun(runId, options.signal?.aborted === true);
				}
				const settledAttemptId = await Promise.race(active.values());
				active.delete(settledAttemptId);
			}
		} finally {
			await Promise.allSettled([...active.values()]);
		}
	}

	private notify(state: WorkflowRunState): WorkflowRunState {
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
		options: RunWorkflowOptions,
	): Promise<void> {
		const state = await this.dependencies.store.load(runId);
		for (const stepId of launchableStepIds(state)) {
			const launched = await this.launchStep(runId, stepId, options);
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
		options: RunWorkflowOptions,
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
					return {
						...updateStep(current, stepId, {
							state: "running",
							attemptIds: [...currentStep.attemptIds, attempt.id],
						}),
						attempts: [...current.attempts, attempt],
						updatedAt: this.now(),
					};
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
					...(options.signal ? { signal: options.signal } : {}),
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
					await this.settleStep(runId, stepId, attempt.id, result);
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

	private async settleStep(
		runId: string,
		stepId: string,
		attemptId: string,
		result: StepExecutionResult,
	): Promise<void> {
		const { outcome } = result;
		const settledState =
			outcome.status === "succeeded"
				? "succeeded"
				: outcome.status === "cancelled"
					? "cancelled"
					: "failed";
		this.notify(
			await this.dependencies.store.transaction(runId, (current) => {
				let next = updateStepAttempt(current, attemptId, {
					state: settledState,
					finishedAt: result.finishedAt,
					...(outcome.status === "succeeded"
						? {
								...(outcome.summary ? { summary: outcome.summary } : {}),
								...(outcome.commit ? { commit: outcome.commit } : {}),
							}
						: { error: outcome.error }),
					...(result.workspaceReleaseError
						? { workspaceReleaseError: result.workspaceReleaseError }
						: {}),
				});
				next = updateStep(next, stepId, {
					state: settledState,
					...(outcome.status === "succeeded" ? {} : { error: outcome.error }),
				});
				next = reconcileWorkflowSteps(next);
				const runState: WorkflowRunLifecycleState =
					next.state !== "running"
						? next.state
						: outcome.status === "cancelled"
							? "cancelled"
							: outcome.status === "failed"
								? "failed"
								: "running";
				return { ...next, state: runState, updatedAt: this.now() };
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
				const next = reconcileWorkflowSteps(
					updateStep(current, stepId, { state: "failed", error: message }),
				);
				return {
					...next,
					state: next.state === "cancelled" ? next.state : "failed",
					updatedAt: this.now(),
				};
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
						reconcileWorkflowSteps({
							...updateStep(current, stepId, { integratedCommit }),
							integrationHead: integratedCommit,
							updatedAt: this.now(),
						}),
					),
				);
			} catch (error) {
				const message = `Failed to integrate step ${stepId}: ${errorMessage(error)}`;
				this.notify(
					await this.dependencies.store.transaction(runId, (current) => {
						const next = reconcileWorkflowSteps(
							updateStep(current, stepId, {
								state: "failed",
								integrationError: message,
							}),
						);
						return { ...next, state: "failed", updatedAt: this.now() };
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
				if (current.state !== "running") {
					return current;
				}
				const next = reconcileWorkflowSteps(current);
				const states = Object.values(next.steps).map((step) => step.state);
				const unfinished = states.filter(
					(state) => !TERMINAL_STEP_STATES.has(state),
				);
				if (unfinished.length > 0) {
					return {
						...next,
						state: cancelled ? "cancelled" : "failed",
						...(cancelled
							? {}
							: {
									error:
										"The workflow stopped while steps were still waiting to run",
								}),
						updatedAt: this.now(),
					};
				}
				const state: WorkflowRunLifecycleState = states.every(
					(value) => value === "succeeded",
				)
					? "completed"
					: states.includes("cancelled")
						? "cancelled"
						: "failed";
				return { ...next, state, updatedAt: this.now() };
			}),
		);
	}
}
