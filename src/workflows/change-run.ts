import { randomUUID } from "node:crypto";
import { approveRun } from "../domain/run.js";
import type {
	FinalValidationAttempt,
	OrchestrationRun,
	RunSecurityPolicy,
	WorkerRole,
} from "../domain/types.js";
import { WorkflowEngine } from "../engine/engine.js";
import { appendWorkflowEvents } from "../engine/events.js";
import { StepExecutor } from "../engine/executor.js";
import {
	finalizeWorkflowRun,
	type WorkflowFinalizationResult,
} from "../engine/finalization.js";
import { StepHandlerRegistry } from "../engine/handlers.js";
import { GitStepIntegrator } from "../engine/integration.js";
import {
	type RecoveredAttempt,
	recoverWorkflowRun,
} from "../engine/recovery.js";
import { reconcileWorkflowSteps } from "../engine/scheduler.js";
import type { ReviewFindingsPayload } from "../engine/steps/review.js";
import {
	type StepWorkerProgress,
	StepWorkerRunner,
} from "../engine/steps/worker-runner.js";
import {
	createWorkflowRunState,
	updateStepAttempt,
	type WorkflowRunState,
} from "../engine/workflow-state.js";
import { defaultWorkspaceProviders } from "../engine/workspaces.js";
import type { GitClient, RepositoryInfo } from "../git/git.js";
import type { WorktreeManager } from "../git/worktrees.js";
import { retryableRunWork } from "../inspection/run-control.js";
import { readReviewFindings } from "../inspection/run-inspector.js";
import { engineRunView, type RunView } from "../inspection/run-view.js";
import { defaultCapabilityProfiles } from "../security/capabilities.js";
import { workerLaunchPolicy } from "../security/policy.js";
import type { ArtifactStore } from "../storage/artifact-store.js";
import type { AttemptLogStore } from "../storage/attempt-log-store.js";
import type { RunStore } from "../storage/run-store.js";
import type { FileWorkflowStateStore } from "../storage/workflow-state-store.js";
import type { FinalValidator } from "../validation/final-validator.js";
import type { TaskValidator } from "../validation/task-validator.js";
import type { WorkerBackend } from "../workers/backend.js";
import {
	buildChangeWorkflowPlan,
	changeWorkflowStepHandlers,
} from "./change.js";

export interface EngineChangeRunDependencies {
	store: RunStore;
	workflowStates: FileWorkflowStateStore;
	artifacts: ArtifactStore;
	workers: WorkerBackend;
	git: GitClient;
	worktrees: WorktreeManager;
	validator: TaskValidator;
	finalValidator: FinalValidator;
	securityPolicy: RunSecurityPolicy;
	/** The configured bound on one worker step, when the user set one. */
	workerTimeoutMs?: number;
	attemptLogs?: AttemptLogStore;
	now?: () => string;
}

export interface WorkerModelSelection {
	provider: string;
	model: string;
}

export interface EngineLaunchOptions {
	onProgress?: (progress: StepWorkerProgress & { kind: WorkerRole }) => void;
	onRunUpdated?: (view: RunView) => void;
	signal?: AbortSignal;
}

export interface EngineLaunchResult {
	run: RunView;
	/** Settles once the workflow and its finalization finish. */
	completion: Promise<RunView>;
}

interface ActiveEngineExecution {
	controller: AbortController;
	detachSignal: () => void;
	releaseLease?: () => Promise<void>;
	engine?: WorkflowEngine;
}

const executingEngines = new Map<string, ActiveEngineExecution>();

function executionKey(directory: string, runId: string): string {
	return `${directory}\u0000${runId}`;
}

async function claimExecution(
	store: RunStore,
	directory: string,
	runId: string,
	action: string,
	signal: AbortSignal | undefined,
): Promise<ActiveEngineExecution> {
	const key = executionKey(directory, runId);
	if (executingEngines.has(key)) {
		throw new Error(
			`Cannot ${action} run ${runId} while it has active lifecycle work`,
		);
	}
	const controller = new AbortController();
	const forwardAbort = () => {
		controller.abort(signal?.reason);
	};
	signal?.addEventListener("abort", forwardAbort, { once: true });
	if (signal?.aborted) {
		forwardAbort();
	}
	const execution: ActiveEngineExecution = {
		controller,
		detachSignal: () => signal?.removeEventListener("abort", forwardAbort),
	};
	executingEngines.set(key, execution);
	try {
		execution.releaseLease = await store.acquireLifecycleLease(runId);
		return execution;
	} catch (error) {
		executingEngines.delete(key);
		execution.detachSignal();
		throw error;
	}
}

async function releaseExecution(
	directory: string,
	runId: string,
	execution: ActiveEngineExecution,
): Promise<void> {
	const key = executionKey(directory, runId);
	if (executingEngines.get(key) === execution) {
		executingEngines.delete(key);
		execution.detachSignal();
		await execution.releaseLease?.();
	}
}

function signalError(signal: AbortSignal): string {
	return signal.reason instanceof Error
		? signal.reason.message
		: "The run was cancelled";
}

/** The historical worker role a step's profile reports progress under. */
function progressRole(profile: string): WorkerRole {
	return profile === "review" || profile === "repair"
		? profile
		: "implementation";
}

/**
 * Whether a stored run already executed under the legacy orchestrator. Such a
 * run keeps running there: its attempts, worktrees, and review rounds were
 * created by that lifecycle, and the engine has no snapshot to resume.
 */
export function hasLegacyExecutionState(run: OrchestrationRun): boolean {
	return (
		run.attempts.length > 0 ||
		run.reviewAttempts.length > 0 ||
		run.repairAttempts.length > 0 ||
		run.finalValidationAttempts.length > 0
	);
}

/**
 * Executes an approved orchestration run as a strict change workflow on the
 * engine.
 *
 * Approval, plan editing, and revisions stay in the run store exactly as they
 * were; only the execution underneath changes. The engine's own snapshot is
 * the durable execution record, and every change to it is projected back onto
 * the stored run so existing inspection and control keep working.
 */
export class EngineChangeRunner {
	private readonly now: () => string;
	private findings: ReadonlyMap<string, ReviewFindingsPayload> = new Map();
	private views: Promise<unknown> = Promise.resolve();

	constructor(private readonly dependencies: EngineChangeRunDependencies) {
		this.now = dependencies.now ?? (() => new Date().toISOString());
	}

	/** Whether this run has a durable engine snapshot to resume. */
	async hasWorkflowState(runId: string): Promise<boolean> {
		return this.dependencies.workflowStates.has(runId);
	}

	async approveAndLaunch(
		run: OrchestrationRun,
		repository: RepositoryInfo,
		model?: WorkerModelSelection,
		options: EngineLaunchOptions = {},
	): Promise<EngineLaunchResult> {
		const execution = await claimExecution(
			this.dependencies.store,
			this.dependencies.workflowStates.directory,
			run.id,
			"start",
			options.signal,
		);
		try {
			if (
				!repository.isClean ||
				repository.root !== run.repositoryRoot ||
				repository.currentBranch !== run.baseBranch ||
				repository.head !== run.baseCommit
			) {
				throw new Error(
					"Repository must be clean and match the recorded plan base before approval",
				);
			}
			await this.preflightWorkerPolicies(run);
			let approved = await this.dependencies.store.transaction(
				run.id,
				(stored) => approveRun(stored, this.now(), run.planRevision),
			);
			try {
				const branch =
					await this.dependencies.worktrees.prepareIntegrationBranch(
						repository,
						run.id,
					);
				if (branch !== approved.integrationBranch) {
					throw new Error(`Unexpected integration branch: ${branch}`);
				}
				await this.dependencies.workflowStates.create(
					this.initialState(approved, this.now()),
				);
			} catch (error) {
				approved = await this.fail(approved.id);
				throw error;
			}
			return this.launch(approved, repository, model, options, execution);
		} catch (error) {
			await releaseExecution(
				this.dependencies.workflowStates.directory,
				run.id,
				execution,
			);
			throw error;
		}
	}

	/**
	 * Resumes an interrupted run: every attempt still marked active is settled
	 * from durable Git and artifact state before anything new starts.
	 */
	async resume(
		run: OrchestrationRun,
		repository: RepositoryInfo,
		model?: WorkerModelSelection,
		options: EngineLaunchOptions = {},
	): Promise<EngineLaunchResult> {
		const execution = await claimExecution(
			this.dependencies.store,
			this.dependencies.workflowStates.directory,
			run.id,
			"resume",
			options.signal,
		);
		try {
			if (!(await this.hasWorkflowState(run.id))) {
				// The run was approved but its snapshot never reached disk. Nothing
				// has executed, so the workflow simply starts from the approved plan.
				if (hasLegacyExecutionState(run)) {
					throw new Error(
						`Run ${run.id} executed under the legacy orchestrator and has no engine snapshot to resume`,
					);
				}
				await this.dependencies.worktrees.prepareIntegrationBranch(
					repository,
					run.id,
				);
				await this.dependencies.workflowStates.create(
					this.initialState(run, this.now()),
				);
			}
			await this.interruptStaleFinalValidation(run.id);
			await this.markExecuting(run.id);
			const { state, recovered } = await recoverWorkflowRun(
				{
					store: this.dependencies.workflowStates,
					git: this.dependencies.git,
					artifacts: this.dependencies.artifacts,
					now: this.now,
				},
				run.id,
			);
			const relaunched = await this.relaunchInterruptedSteps(
				run.id,
				state,
				recovered,
			);
			if (relaunched.state !== "running") {
				const view = await this.loadView(run.id, relaunched);
				const completion = this.settle(
					run,
					relaunched,
					repository,
					options,
					execution.controller.signal,
				).finally(async () => {
					await releaseExecution(
						this.dependencies.workflowStates.directory,
						run.id,
						execution,
					);
				});
				return { run: view, completion };
			}
			return this.launch(run, repository, model, options, execution);
		} catch (error) {
			await releaseExecution(
				this.dependencies.workflowStates.directory,
				run.id,
				execution,
			);
			throw error;
		}
	}

	/**
	 * Runs again the work an interruption stopped.
	 *
	 * Recovery settles an attempt it cannot adopt as terminally failed once the
	 * step's automatic retry budget is spent, but being interrupted is not the
	 * step failing on its merits: resuming a run is the user asking for exactly
	 * that work to be carried out, so those steps run again here rather than
	 * leaving the run unresumable and unretryable.
	 */
	private async relaunchInterruptedSteps(
		runId: string,
		state: WorkflowRunState,
		recovered: readonly RecoveredAttempt[],
	): Promise<WorkflowRunState> {
		const stopped = [
			...new Set(
				recovered
					.filter((entry) => entry.outcome === "failed")
					.map((entry) => entry.stepId),
			),
		].filter((stepId) => state.steps[stepId]?.state === "failed");
		if (stopped.length === 0) {
			return state;
		}
		return this.dependencies.workflowStates.transaction(runId, (current) => {
			let next = current;
			// Everything waiting behind the interrupted work was only blocked by
			// it, so it becomes runnable again with it.
			const runnable = [
				...stopped,
				...Object.entries(current.steps).flatMap(([stepId, record]) =>
					record.state === "blocked" ? [stepId] : [],
				),
			];
			for (const stepId of runnable) {
				const record = current.steps[stepId];
				if (!record || !["failed", "blocked"].includes(record.state)) {
					continue;
				}
				const { error: _error, ...retained } = record;
				next = {
					...next,
					steps: { ...next.steps, [stepId]: { ...retained, state: "planned" } },
				};
			}
			const { error: _settled, ...rest } = next;
			return appendWorkflowEvents(
				reconcileWorkflowSteps({
					...rest,
					state: "running",
					updatedAt: this.now(),
				}),
				stopped.map((stepId) => ({
					kind: "step_retry_scheduled" as const,
					stepId,
					attemptId: current.steps[stepId]?.attemptIds.at(-1) ?? "",
					nextAttemptNumber:
						(current.steps[stepId]?.attemptIds.length ?? 0) + 1,
					reason: "the resumed run runs the interrupted work again",
				})),
				this.now(),
			);
		});
	}

	/**
	 * Retries the failed work of a settled run.
	 *
	 * Every step the run stopped on becomes runnable again, keeping its
	 * attempt history: a retry is another attempt at the same approved plan,
	 * never a new plan and never a rewrite of what already happened.
	 */
	async retry(
		run: OrchestrationRun,
		repository: RepositoryInfo,
		model?: WorkerModelSelection,
		options: EngineLaunchOptions = {},
	): Promise<EngineLaunchResult> {
		const execution = await claimExecution(
			this.dependencies.store,
			this.dependencies.workflowStates.directory,
			run.id,
			"retry",
			options.signal,
		);
		try {
			const assessment = retryableRunWork(await this.loadView(run.id));
			if (!assessment.retryable) {
				throw new Error(assessment.reason);
			}
			await this.markExecuting(run.id);
			const reset: string[] = [];
			let retryFinalization = false;
			const state = await this.dependencies.workflowStates.transaction(
				run.id,
				(current) => {
					if (current.state === "cancelled") {
						throw new Error(`Cancelled run ${run.id} cannot be retried`);
					}
					let next = current;
					for (const [stepId, record] of Object.entries(current.steps)) {
						if (record.state !== "failed" && record.state !== "blocked") {
							continue;
						}
						reset.push(stepId);
						const {
							error: _error,
							integrationError: _integrationError,
							...retained
						} = record;
						next = {
							...next,
							steps: {
								...next.steps,
								[stepId]: { ...retained, state: "planned" },
							},
						};
					}
					if (reset.length === 0) {
						retryFinalization =
							assessment.phase === "final-validation" &&
							current.state === "completed";
						return current;
					}
					const { error: _settled, ...rest } = next;
					return appendWorkflowEvents(
						reconcileWorkflowSteps({
							...rest,
							state: "running",
							updatedAt: this.now(),
						}),
						reset.map((stepId) => ({
							kind: "step_retry_scheduled" as const,
							stepId,
							attemptId: current.steps[stepId]?.attemptIds.at(-1) ?? "",
							nextAttemptNumber:
								(current.steps[stepId]?.attemptIds.length ?? 0) + 1,
							reason: "the user retried the failed work of this run",
						})),
						this.now(),
					);
				},
			);
			if (reset.length === 0) {
				if (retryFinalization) {
					const view = await this.loadView(run.id, state);
					const completion = this.settle(
						run,
						state,
						repository,
						options,
						execution.controller.signal,
					).finally(async () => {
						await releaseExecution(
							this.dependencies.workflowStates.directory,
							run.id,
							execution,
						);
					});
					return { run: view, completion };
				}
				throw new Error(`Run ${run.id} has no failed steps to retry`);
			}
			return this.launch(run, repository, model, options, execution);
		} catch (error) {
			await releaseExecution(
				this.dependencies.workflowStates.directory,
				run.id,
				execution,
			);
			throw error;
		}
	}

	/**
	 * Cancels a run. A run this process is executing stops its own workers; a
	 * run started elsewhere is settled here from its durable snapshot, so a
	 * cancelled run never stays open.
	 */
	async cancel(
		run: OrchestrationRun,
		repository: RepositoryInfo,
	): Promise<OrchestrationRun> {
		if (["completed", "failed", "cancelled"].includes(run.state)) {
			return run;
		}
		const executing = executingEngines.get(
			executionKey(this.dependencies.workflowStates.directory, run.id),
		);
		executing?.controller.abort(new Error("The run was cancelled"));
		const engine =
			executing?.engine ?? this.engineFor(run, repository, undefined, {});
		await engine.cancel(run.id);
		await this.drainViewUpdates();
		// The engine settles its own steps; the stored run stops claiming the
		// lifecycle is open, whichever phase the cancellation interrupted.
		return this.cancelStoredRun(run.id);
	}

	/** The engine run an approved orchestration run starts as. */
	private initialState(
		run: OrchestrationRun,
		createdAt: string,
	): WorkflowRunState {
		return createWorkflowRunState({
			id: run.id,
			plan: buildChangeWorkflowPlan(run.plan),
			repositoryRoot: run.repositoryRoot,
			baseBranch: run.baseBranch,
			baseCommit: run.baseCommit,
			integrationBranch: run.integrationBranch,
			integrationHead: run.baseCommit,
			capabilityProfiles:
				run.securityPolicy.workers.capabilityProfiles ??
				defaultCapabilityProfiles(),
			maxConcurrentWorkers: run.maxConcurrentWorkers,
			createdAt,
		});
	}

	private async preflightWorkerPolicies(run: OrchestrationRun): Promise<void> {
		const preflight = this.dependencies.workers.preflightPolicy;
		if (!preflight) {
			return;
		}
		for (const role of [
			"implementation",
			"review",
			"repair",
		] as const satisfies readonly WorkerRole[]) {
			const policy = workerLaunchPolicy(run.securityPolicy, role);
			if (policy) {
				await preflight.call(this.dependencies.workers, policy);
			}
		}
	}

	private engineFor(
		run: OrchestrationRun,
		repository: RepositoryInfo,
		model: WorkerModelSelection | undefined,
		options: EngineLaunchOptions,
	): WorkflowEngine {
		const worker = new StepWorkerRunner({
			workers: this.dependencies.workers,
			securityPolicy: run.securityPolicy,
			...(this.dependencies.attemptLogs
				? { attemptLogs: this.dependencies.attemptLogs }
				: {}),
			...(model ? { provider: model.provider, model: model.model } : {}),
			onProgress: (progress) => {
				options.onProgress?.({
					...progress,
					kind: progressRole(this.profileOf(run, progress.stepId)),
				});
			},
			onSpawn: async (spawn) => {
				const state = await this.dependencies.workflowStates.transaction(
					spawn.runId,
					(current) => ({
						...updateStepAttempt(current, spawn.attemptId, {
							workerId: spawn.workerId,
						}),
						updatedAt: this.now(),
					}),
				);
				this.scheduleViewUpdate(run.id, state, options);
				await this.drainViewUpdates();
			},
		});
		return new WorkflowEngine({
			store: this.dependencies.workflowStates,
			repository,
			artifacts: this.dependencies.artifacts,
			executor: new StepExecutor({
				...(this.dependencies.workerTimeoutMs === undefined
					? {}
					: { defaultTimeoutMs: this.dependencies.workerTimeoutMs }),
				workspaces: defaultWorkspaceProviders(this.dependencies.worktrees),
				handlers: new StepHandlerRegistry(
					changeWorkflowStepHandlers({
						worker,
						validator: this.dependencies.validator,
						git: this.dependencies.git,
						securityPolicy: run.securityPolicy,
						requestText: run.request.text,
					}),
				),
			}),
			integrator: new GitStepIntegrator(this.dependencies.git),
			now: this.now,
			onStateChanged: (state) => {
				this.scheduleViewUpdate(run.id, state, options);
			},
		});
	}

	private profileOf(run: OrchestrationRun, stepId: string): string {
		return run.plan.tasks.some((task) => task.id === stepId)
			? "change"
			: stepId.startsWith("review-")
				? "review"
				: "repair";
	}

	private async launch(
		run: OrchestrationRun,
		repository: RepositoryInfo,
		model: WorkerModelSelection | undefined,
		options: EngineLaunchOptions,
		execution: ActiveEngineExecution,
	): Promise<EngineLaunchResult> {
		const engine = this.engineFor(run, repository, model, options);
		execution.engine = engine;
		const view = await this.loadView(run.id);
		const completion = engine
			.run(run.id, { signal: execution.controller.signal })
			.then(async (state) => {
				await this.drainViewUpdates();
				return this.settle(
					run,
					state,
					repository,
					options,
					execution.controller.signal,
				);
			})
			.finally(async () => {
				await releaseExecution(
					this.dependencies.workflowStates.directory,
					run.id,
					execution,
				);
			});
		return { run: view, completion };
	}

	/**
	 * Turns a settled workflow into the run's final answer: final validation
	 * and merge-ready evidence for a completed workflow, and the failure the
	 * steps recorded otherwise.
	 */
	private async settle(
		run: OrchestrationRun,
		state: WorkflowRunState,
		repository: RepositoryInfo,
		options: EngineLaunchOptions,
		signal: AbortSignal,
	): Promise<RunView> {
		if (state.state !== "completed") {
			// The failure itself is already recorded step by step; the stored run
			// only has to stop claiming the lifecycle is still open.
			const settled = await this.dependencies.store.transaction(
				run.id,
				(stored) =>
					stored.state === "cancelled"
						? stored
						: {
								...stored,
								state: state.state === "cancelled" ? "cancelled" : "failed",
								...(state.error ? { error: state.error } : {}),
								updatedAt: this.now(),
							},
			);
			return this.publish(settled, state, options);
		}
		const attemptNumber =
			(await this.dependencies.store.load(run.id)).finalValidationAttempts
				.length + 1;
		const startedAt = this.now();
		const attempt: FinalValidationAttempt = {
			id: `final-${attemptNumber}-${randomUUID().slice(0, 8)}`,
			number: attemptNumber,
			state: "running",
			integrationCommit: state.integrationHead,
			worktreePath: this.dependencies.worktrees.finalValidationWorktreePath(
				run.id,
				attemptNumber,
			),
			startedAt,
		};
		let attemptStarted = false;
		let result: WorkflowFinalizationResult;
		try {
			result = await finalizeWorkflowRun(
				{
					finalValidator: this.dependencies.finalValidator,
					worktrees: this.dependencies.worktrees,
					git: this.dependencies.git,
					securityPolicy: run.securityPolicy,
					artifacts: this.dependencies.artifacts,
					now: this.now,
				},
				{
					state,
					repository,
					attemptNumber,
					signal,
					onValidationReady: async () => {
						const validating = await this.dependencies.store.transaction(
							run.id,
							(stored) =>
								stored.state === "cancelled"
									? stored
									: {
											...stored,
											state: "validating",
											// The head under validation is the head this run
											// settles on, and its evidence must match it.
											integrationHead: state.integrationHead,
											finalValidationAttempts: [
												...stored.finalValidationAttempts,
												attempt,
											],
											updatedAt: this.now(),
										},
						);
						if (validating.state === "cancelled") {
							throw new Error("The run was cancelled");
						}
						attemptStarted = validating.finalValidationAttempts.some(
							(candidate) =>
								candidate.id === attempt.id && candidate.state === "running",
						);
						if (!attemptStarted) {
							throw new Error(
								`Final validation attempt ${attempt.id} did not start`,
							);
						}
						await this.publish(validating, state, options);
					},
				},
			);
		} catch (error) {
			return this.settleFinalizationException(
				run.id,
				state,
				attempt,
				attemptStarted,
				signal,
				error,
				options,
			);
		}
		if (result.evidenceGap) {
			return this.settleReviewFailure(
				run.id,
				state,
				result.evidenceGap,
				options,
			);
		}
		const cancelled = signal.aborted;
		const finishedAt = this.now();
		const settled = await this.dependencies.store.transaction(
			run.id,
			(stored) => {
				if (stored.state === "cancelled") {
					return stored;
				}
				const mergeReady = result.mergeReady;
				return {
					...stored,
					state: cancelled ? "cancelled" : mergeReady ? "completed" : "failed",
					finalValidationAttempts: stored.finalValidationAttempts.map((item) =>
						item.id === attempt.id && item.state === "running"
							? {
									...item,
									state: cancelled
										? ("cancelled" as const)
										: mergeReady
											? ("succeeded" as const)
											: ("failed" as const),
									finishedAt,
									...(cancelled
										? { error: signalError(signal) }
										: result.evidenceGap
											? { error: result.evidenceGap }
											: {}),
									...(result.evidence ? { evidence: result.evidence } : {}),
								}
							: item,
					),
					...(!cancelled && mergeReady
						? { mergeReadyEvidence: mergeReady }
						: {}),
					...(cancelled || mergeReady
						? {}
						: { error: "Final validation failed" }),
					updatedAt: finishedAt,
				};
			},
		);
		return this.publish(settled, state, options);
	}

	/**
	 * Records a failure that belongs to no attempt: the reviews backing this
	 * head are incomplete, so the run never spends a final validation attempt.
	 */
	private async settleReviewFailure(
		runId: string,
		state: WorkflowRunState,
		error: string,
		options: EngineLaunchOptions,
	): Promise<RunView> {
		const finishedAt = this.now();
		const settled = await this.dependencies.store.transaction(
			runId,
			(stored) =>
				stored.state === "cancelled"
					? stored
					: { ...stored, state: "failed", error, updatedAt: finishedAt },
		);
		return this.publish(settled, state, options);
	}

	private async settleFinalizationException(
		runId: string,
		state: WorkflowRunState,
		attempt: FinalValidationAttempt,
		attemptStarted: boolean,
		signal: AbortSignal,
		error: unknown,
		options: EngineLaunchOptions,
	): Promise<RunView> {
		const message = error instanceof Error ? error.message : String(error);
		if (!attemptStarted) {
			if (signal.aborted) {
				return this.publish(await this.cancelStoredRun(runId), state, options);
			}
			return this.settleReviewFailure(runId, state, message, options);
		}
		const finishedAt = this.now();
		const settled = await this.dependencies.store.transaction(
			runId,
			(stored) => {
				if (stored.state === "cancelled") {
					return stored;
				}
				const cancelled = signal.aborted;
				return {
					...stored,
					state: cancelled ? "cancelled" : "failed",
					finalValidationAttempts: stored.finalValidationAttempts.map(
						(candidate) =>
							candidate.id === attempt.id && candidate.state === "running"
								? {
										...candidate,
										state: cancelled
											? ("cancelled" as const)
											: ("failed" as const),
										finishedAt,
										error: cancelled ? signalError(signal) : message,
									}
								: candidate,
					),
					updatedAt: finishedAt,
				};
			},
		);
		return this.publish(settled, state, options);
	}

	private async interruptStaleFinalValidation(
		runId: string,
	): Promise<OrchestrationRun> {
		const finishedAt = this.now();
		return this.dependencies.store.transaction(runId, (stored) => {
			if (stored.state !== "validating") {
				return stored;
			}
			return {
				...stored,
				state: "reviewed",
				finalValidationAttempts: stored.finalValidationAttempts.map(
					(attempt) =>
						attempt.state === "running"
							? {
									...attempt,
									state: "interrupted" as const,
									finishedAt,
									error: "Final validation lifecycle restarted",
								}
							: attempt,
				),
				updatedAt: finishedAt,
			};
		});
	}

	/**
	 * Records that the run is executing again.
	 *
	 * A resumed or retried run is no longer settled, and the failure that
	 * settled it is no longer the run's answer, so neither may be left behind
	 * for a reader to find. A cancelled run stays cancelled: only the user
	 * reopens it, by starting a new run.
	 */
	private async markExecuting(runId: string): Promise<OrchestrationRun> {
		return this.dependencies.store.transaction(runId, (stored) => {
			if (
				stored.state === "cancelled" ||
				(stored.state === "running" && stored.error === undefined)
			) {
				return stored;
			}
			const { error: _error, ...retained } = stored;
			return { ...retained, state: "running", updatedAt: this.now() };
		});
	}

	private async cancelStoredRun(runId: string): Promise<OrchestrationRun> {
		const finishedAt = this.now();
		return this.dependencies.store.transaction(runId, (stored) =>
			["completed", "failed", "cancelled"].includes(stored.state)
				? stored
				: {
						...stored,
						state: "cancelled",
						finalValidationAttempts: stored.finalValidationAttempts.map(
							(attempt) =>
								attempt.state === "running"
									? {
											...attempt,
											state: "cancelled" as const,
											finishedAt,
											error: "The run was cancelled",
										}
									: attempt,
						),
						updatedAt: finishedAt,
					},
		);
	}

	private async fail(runId: string): Promise<OrchestrationRun> {
		return this.dependencies.store.transaction(runId, (stored) => ({
			...stored,
			state: "failed",
			updatedAt: this.now(),
		}));
	}

	/**
	 * Tells a watcher what the run looks like now.
	 *
	 * The engine snapshot is the execution record, so a view that cannot be
	 * built must never stop the run that produced it.
	 */
	private scheduleViewUpdate(
		runId: string,
		state: WorkflowRunState,
		options: EngineLaunchOptions,
	): void {
		if (!options.onRunUpdated) {
			return;
		}
		this.views = this.views.then(async () => {
			try {
				options.onRunUpdated?.(await this.loadView(runId, state));
			} catch {
				// Reported through the run's own lifecycle instead.
			}
		});
	}

	private async drainViewUpdates(): Promise<void> {
		await this.views;
	}

	private async publish(
		run: OrchestrationRun,
		state: WorkflowRunState,
		options: EngineLaunchOptions,
	): Promise<RunView> {
		const view = await this.viewOf(run, state);
		options.onRunUpdated?.(view);
		return view;
	}

	/** How this run reads, from the engine snapshot that is executing it. */
	private async viewOf(
		run: OrchestrationRun,
		state: WorkflowRunState,
	): Promise<RunView> {
		this.findings = await readReviewFindings(
			this.dependencies.artifacts,
			state,
			this.findings,
		);
		return engineRunView(run, state, this.findings);
	}

	private async loadView(
		runId: string,
		state?: WorkflowRunState,
	): Promise<RunView> {
		const [run, current] = await Promise.all([
			this.dependencies.store.load(runId),
			state ?? this.dependencies.workflowStates.load(runId),
		]);
		return this.viewOf(run, current);
	}
}
