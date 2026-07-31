import { randomUUID } from "node:crypto";
import { approveRun } from "../domain/run.js";
import { stepProfileName } from "../domain/steps.js";
import type {
	FinalValidationAttempt,
	MergeReadyEvidence,
	OrchestrationRun,
	RunSecurityPolicy,
	WorkerRole,
} from "../domain/types.js";
import { WorkflowEngine } from "../engine/engine.js";
import { appendWorkflowEvents } from "../engine/events.js";
import { StepExecutor } from "../engine/executor.js";
import { finalizeWorkflowRun } from "../engine/finalization.js";
import { StepHandlerRegistry } from "../engine/handlers.js";
import { GitStepIntegrator } from "../engine/integration.js";
import { recoverWorkflowRun } from "../engine/recovery.js";
import { reconcileWorkflowSteps } from "../engine/scheduler.js";
import type { ReviewFindingsPayload } from "../engine/steps/review.js";
import {
	type StepWorkerProgress,
	StepWorkerRunner,
} from "../engine/steps/worker-runner.js";
import {
	createWorkflowRunState,
	type WorkflowRunState,
} from "../engine/workflow-state.js";
import { defaultWorkspaceProviders } from "../engine/workspaces.js";
import type { GitClient, RepositoryInfo } from "../git/git.js";
import type { WorktreeManager } from "../git/worktrees.js";
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
import {
	alignMergeReadyEvidence,
	projectChangeRun,
} from "./change-projection.js";

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
	attemptLogs?: AttemptLogStore;
	now?: () => string;
}

export interface WorkerModelSelection {
	provider: string;
	model: string;
}

export interface EngineLaunchOptions {
	onProgress?: (progress: StepWorkerProgress & { kind: WorkerRole }) => void;
	onRunUpdated?: (run: OrchestrationRun) => void;
	signal?: AbortSignal;
}

export interface EngineLaunchResult {
	run: OrchestrationRun;
	/** Settles with the stored run once the workflow and finalization finish. */
	completion: Promise<OrchestrationRun>;
}

/**
 * The engines executing runs in this process, keyed by state directory and run
 * id. A cancel arrives through its own command and its own runner, so the
 * execution it has to stop can only be found through shared state.
 */
const executingEngines = new Map<string, WorkflowEngine>();

function executionKey(directory: string, runId: string): string {
	return `${directory}\u0000${runId}`;
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
	private readonly findings = new Map<string, ReviewFindingsPayload>();
	private projections: Promise<unknown> = Promise.resolve();

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
		let approved = await this.dependencies.store.transaction(run.id, (stored) =>
			approveRun(stored, this.now(), run.planRevision),
		);
		try {
			const branch = await this.dependencies.worktrees.prepareIntegrationBranch(
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
			options.onRunUpdated?.(approved);
			throw error;
		}
		return this.launch(approved, repository, model, options);
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
		const { state } = await recoverWorkflowRun(
			{
				store: this.dependencies.workflowStates,
				git: this.dependencies.git,
				artifacts: this.dependencies.artifacts,
				now: this.now,
			},
			run.id,
		);
		const projected = await this.project(run.id, state);
		if (state.state !== "running") {
			// Nothing is left to execute; settle the stored run from the snapshot.
			const settled = await this.settle(projected, state, repository, options);
			return { run: settled, completion: Promise.resolve(settled) };
		}
		return this.launch(projected, repository, model, options);
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
		const reset: string[] = [];
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
			throw new Error(`Run ${run.id} has no failed steps to retry`);
		}
		return this.launch(
			await this.project(run.id, state),
			repository,
			model,
			options,
		);
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
		const engine = executing ?? this.engineFor(run, repository, undefined, {});
		const state = await engine.cancel(run.id);
		await this.drainProjections();
		const projected = await this.project(run.id, state);
		if (projected.state === "cancelled") {
			return projected;
		}
		// A run this process is executing stops when its steps notice the
		// cancellation, which is not something the user has to wait for: the
		// decision is already final, so the stored run states it now.
		return this.dependencies.store.transaction(run.id, (stored) =>
			["completed", "failed", "cancelled"].includes(stored.state)
				? stored
				: { ...stored, state: "cancelled", updatedAt: this.now() },
		);
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
		});
		return new WorkflowEngine({
			store: this.dependencies.workflowStates,
			repository,
			artifacts: this.dependencies.artifacts,
			executor: new StepExecutor({
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
				this.scheduleProjection(run.id, state, options);
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

	private launch(
		run: OrchestrationRun,
		repository: RepositoryInfo,
		model: WorkerModelSelection | undefined,
		options: EngineLaunchOptions,
	): EngineLaunchResult {
		const engine = this.engineFor(run, repository, model, options);
		const key = executionKey(
			this.dependencies.workflowStates.directory,
			run.id,
		);
		executingEngines.set(key, engine);
		const completion = engine
			.run(run.id, { ...(options.signal ? { signal: options.signal } : {}) })
			.then(async (state) => {
				await this.drainProjections();
				const projected = await this.project(run.id, state);
				return this.settle(projected, state, repository, options);
			})
			.finally(() => {
				executingEngines.delete(key);
			});
		return { run, completion };
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
	): Promise<OrchestrationRun> {
		if (state.state !== "completed") {
			// The failure itself is already recorded step by step; the stored run
			// only has to stop claiming the lifecycle is still open.
			const settled = await this.dependencies.store.transaction(
				run.id,
				(stored) => ({
					...stored,
					state: state.state === "cancelled" ? "cancelled" : "failed",
					updatedAt: this.now(),
				}),
			);
			options.onRunUpdated?.(settled);
			return settled;
		}
		const attemptNumber = run.finalValidationAttempts.length + 1;
		const startedAt = this.now();
		const result = await finalizeWorkflowRun(
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
				...(options.signal ? { signal: options.signal } : {}),
			},
		);
		const attempt: FinalValidationAttempt = {
			id: `final-${attemptNumber}-${randomUUID().slice(0, 8)}`,
			number: attemptNumber,
			state: result.mergeReady ? "succeeded" : "failed",
			integrationCommit: state.integrationHead,
			worktreePath: result.worktreePath ?? "",
			startedAt,
			finishedAt: this.now(),
			...(result.evidenceGap ? { error: result.evidenceGap } : {}),
			...(result.evidence ? { evidence: result.evidence } : {}),
		};
		const settled = await this.dependencies.store.transaction(
			run.id,
			(stored) => {
				const mergeReady: MergeReadyEvidence | undefined = result.mergeReady
					? alignMergeReadyEvidence(result.mergeReady, stored)
					: undefined;
				return {
					...stored,
					state: mergeReady ? "completed" : "failed",
					finalValidationAttempts: [
						...stored.finalValidationAttempts,
						...(attempt.worktreePath ? [attempt] : []),
					],
					...(mergeReady ? { mergeReadyEvidence: mergeReady } : {}),
					updatedAt: this.now(),
				};
			},
		);
		options.onRunUpdated?.(settled);
		return settled;
	}

	private async fail(runId: string): Promise<OrchestrationRun> {
		return this.dependencies.store.transaction(runId, (stored) => ({
			...stored,
			state: "failed",
			updatedAt: this.now(),
		}));
	}

	private scheduleProjection(
		runId: string,
		state: WorkflowRunState,
		options: EngineLaunchOptions,
	): void {
		this.projections = this.projections.then(async () => {
			try {
				options.onRunUpdated?.(await this.project(runId, state));
			} catch {
				// The engine snapshot is the execution record; a projection that
				// cannot be written must never stop the run that produced it.
			}
		});
	}

	private async drainProjections(): Promise<void> {
		await this.projections;
	}

	/** Reads every review step's published findings once and caches them. */
	private async readFindings(state: WorkflowRunState): Promise<void> {
		for (const [stepId, record] of Object.entries(state.steps)) {
			if (
				stepProfileName(record.definition) !== "review" ||
				record.state !== "succeeded" ||
				this.findings.has(stepId)
			) {
				continue;
			}
			for (const output of record.definition.outputs ?? []) {
				const artifact = await this.dependencies.artifacts.latest(
					state.id,
					stepId,
					output,
				);
				if (artifact) {
					this.findings.set(
						stepId,
						JSON.parse(artifact.payload) as ReviewFindingsPayload,
					);
				}
			}
		}
	}

	private async project(
		runId: string,
		state: WorkflowRunState,
	): Promise<OrchestrationRun> {
		await this.readFindings(state);
		return this.dependencies.store.transaction(runId, (stored) =>
			projectChangeRun(stored, { state, findings: this.findings }, this.now()),
		);
	}
}
