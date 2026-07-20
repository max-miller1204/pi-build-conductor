import { randomUUID } from "node:crypto";
import { approveRun, createBuildRun } from "./domain/run.js";
import {
	getLaunchableTaskIds,
	reconcileTaskStates,
} from "./domain/scheduler.js";
import type {
	BuildRun,
	TaskAttempt,
	TaskDefinition,
	TaskPlan,
} from "./domain/types.js";
import type { RepositoryInfo } from "./git/git.js";
import type { WorktreeManager } from "./git/worktrees.js";
import type { RunStore } from "./storage/run-store.js";
import type {
	WorkerBackend,
	WorkerExecutionResult,
	WorkerProgressEvent,
} from "./workers/backend.js";

const DEFAULT_WORKER_TIMEOUT_MS = 60 * 60 * 1_000;
const DEFAULT_WORKER_POLL_INTERVAL_MS = 2_000;

export interface BuildConductorDependencies {
	store: RunStore;
	worktrees: WorktreeManager;
	workers: WorkerBackend;
	now?: () => string;
	workerTimeoutMs?: number;
	workerPollIntervalMs?: number;
}

export interface CreateConductorRunInput {
	repository: RepositoryInfo;
	handoffPath: string;
	handoffText: string;
	plan: TaskPlan;
	maxConcurrentWorkers?: number;
}

export interface WorkerModelSelection {
	provider: string;
	model: string;
}

export interface WorkerLifecycleProgress {
	runId: string;
	taskId: string;
	attemptId: string;
	workerId: string;
	event: WorkerProgressEvent;
}

export interface LaunchOptions {
	onProgress?: (progress: WorkerLifecycleProgress) => void;
	onRunUpdated?: (run: BuildRun) => void;
}

export interface TaskLaunch {
	task: TaskDefinition;
	attempt: TaskAttempt;
}

export interface LaunchResult {
	run: BuildRun;
	launches: TaskLaunch[];
	completion: Promise<BuildRun>;
}

interface ScheduledLaunch {
	run: BuildRun;
	launch: TaskLaunch;
	completion: Promise<BuildRun>;
}

interface DispatchResult {
	run: BuildRun;
	launches: ScheduledLaunch[];
}

interface MonitoredExecution {
	runId: string;
	attemptId: string;
	workerId: string;
	completion: Promise<WorkerExecutionResult>;
	controller: AbortController;
	options: LaunchOptions;
}

function buildWorkerPrompt(run: BuildRun, task: TaskDefinition): string {
	return `You are an isolated implementation worker for build run ${run.id}.

Task: ${task.title}

${task.description}

Acceptance criteria:
${task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}

Relevant handoff:
${run.handoff.text}

Work only in the current worktree and current branch.
Do not create, switch, merge, or delete branches or worktrees.
Do not modify work outside this task's scope.
Implement the task and run focused checks.
Do not commit changes; the conductor will validate and commit them.
When finished, summarize changed files and test evidence.`;
}

const runMutationTails = new Map<string, Promise<void>>();
const activeSchedulingRuns = new Set<string>();
const recoveringRuns = new Set<string>();

function schedulingKey(store: RunStore, runId: string): string {
	return `${store.directory}:${runId}`;
}

function notifyRunUpdated(options: LaunchOptions, run: BuildRun): void {
	try {
		options.onRunUpdated?.(run);
	} catch {
		// UI observers must not affect persisted lifecycle state.
	}
}

async function mutateStoredRun(
	store: RunStore,
	runId: string,
	mutate: (current: BuildRun) => BuildRun,
): Promise<BuildRun> {
	const key = `${store.directory}:${runId}`;
	const previous = runMutationTails.get(key) ?? Promise.resolve();
	let release = () => {};
	const turn = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => turn);
	runMutationTails.set(key, queued);
	await previous;
	try {
		const current = await store.load(runId);
		const updated = mutate(current);
		if (updated !== current) {
			await store.save(updated);
		}
		return updated;
	} finally {
		release();
		if (runMutationTails.get(key) === queued) {
			runMutationTails.delete(key);
		}
	}
}

function updateAttempt(
	run: BuildRun,
	attemptId: string,
	update: Partial<TaskAttempt>,
): BuildRun {
	return {
		...run,
		attempts: run.attempts.map((attempt) =>
			attempt.id === attemptId ? { ...attempt, ...update } : attempt,
		),
	};
}

export class BuildConductor {
	private readonly now: () => string;
	private readonly workerTimeoutMs: number;
	private readonly workerPollIntervalMs: number;
	private readonly activeExecutions = new Map<
		string,
		{ runId: string; controller: AbortController }
	>();
	private readonly workerCleanup = new Map<
		string,
		Promise<string | undefined>
	>();

	constructor(private readonly dependencies: BuildConductorDependencies) {
		this.now = dependencies.now ?? (() => new Date().toISOString());
		this.workerTimeoutMs =
			dependencies.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
		this.workerPollIntervalMs =
			dependencies.workerPollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS;
		if (!Number.isFinite(this.workerTimeoutMs) || this.workerTimeoutMs <= 0) {
			throw new Error("workerTimeoutMs must be a positive finite number");
		}
		if (
			!Number.isFinite(this.workerPollIntervalMs) ||
			this.workerPollIntervalMs <= 0
		) {
			throw new Error("workerPollIntervalMs must be a positive finite number");
		}
	}

	async createRun(input: CreateConductorRunInput): Promise<BuildRun> {
		const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
		const run = createBuildRun({
			id,
			repositoryRoot: input.repository.root,
			baseBranch: input.repository.currentBranch,
			baseCommit: input.repository.head,
			integrationBranch: `conductor/${id}/integration`,
			handoff: { sourcePath: input.handoffPath, text: input.handoffText },
			plan: input.plan,
			maxConcurrentWorkers: input.maxConcurrentWorkers ?? 2,
			now: this.now(),
		});
		await this.dependencies.store.save(run);
		return run;
	}

	async cancelRun(run: BuildRun): Promise<BuildRun> {
		let activeRun = run;
		let shouldCleanup = false;
		const now = this.now();
		let cancelled = await mutateStoredRun(
			this.dependencies.store,
			run.id,
			(current) => {
				activeRun = current;
				if (["completed", "failed", "cancelled"].includes(current.state)) {
					return current;
				}
				shouldCleanup = true;
				return {
					...current,
					state: "cancelled",
					tasks: Object.fromEntries(
						Object.entries(current.tasks).map(([taskId, task]) => [
							taskId,
							task.state === "succeeded"
								? task
								: { ...task, state: "cancelled" as const },
						]),
					),
					attempts: current.attempts.map((attempt) =>
						["prepared", "launched", "running"].includes(attempt.state)
							? {
									...attempt,
									state: "cancelled" as const,
									finishedAt: now,
									error: "Run cancelled",
								}
							: attempt,
					),
					updatedAt: now,
				};
			},
		);
		if (!shouldCleanup) {
			return cancelled;
		}

		for (const active of this.activeExecutions.values()) {
			if (active.runId === activeRun.id) {
				active.controller.abort(new Error("Run cancelled"));
			}
		}
		const cleanupErrors: string[] = [];
		const workerIds = new Set(
			activeRun.attempts.flatMap((attempt) =>
				attempt.workerId &&
				["prepared", "launched", "running"].includes(attempt.state)
					? [attempt.workerId]
					: [],
			),
		);
		for (const workerId of workerIds) {
			const cleanupError = await this.stopWorker(workerId);
			if (cleanupError) {
				cleanupErrors.push(`${workerId}: ${cleanupError}`);
			}
		}
		if (cleanupErrors.length > 0) {
			const cleanupMessage = `Worker cleanup failed: ${cleanupErrors.join("; ")}`;
			cancelled = await mutateStoredRun(
				this.dependencies.store,
				run.id,
				(current) => ({
					...current,
					attempts: current.attempts.map((attempt) =>
						attempt.workerId && workerIds.has(attempt.workerId)
							? {
									...attempt,
									error: `${attempt.error ?? "Run cancelled"}; ${cleanupMessage}`,
								}
							: attempt,
					),
					updatedAt: this.now(),
				}),
			);
		}
		return cancelled;
	}

	async approveAndLaunch(
		run: BuildRun,
		repository: RepositoryInfo,
		model?: WorkerModelSelection,
		options: LaunchOptions = {},
	): Promise<LaunchResult> {
		let current = await mutateStoredRun(
			this.dependencies.store,
			run.id,
			(stored) => approveRun(stored, this.now()),
		);
		try {
			const integrationBranch =
				await this.dependencies.worktrees.prepareIntegrationBranch(
					repository,
					run.id,
				);
			if (integrationBranch !== current.integrationBranch) {
				throw new Error(`Unexpected integration branch: ${integrationBranch}`);
			}
		} catch (error) {
			current = await mutateStoredRun(
				this.dependencies.store,
				run.id,
				(stored) => ({
					...stored,
					state: "failed",
					updatedAt: this.now(),
				}),
			);
			notifyRunUpdated(options, current);
			throw error;
		}
		return this.startScheduling(current, repository, model, options);
	}

	async recoverRun(runId: string): Promise<BuildRun> {
		const key = schedulingKey(this.dependencies.store, runId);
		if (activeSchedulingRuns.has(key) || recoveringRuns.has(key)) {
			throw new Error(
				`Cannot recover run ${runId} while it has active lifecycle work`,
			);
		}
		recoveringRuns.add(key);
		try {
			const run = await this.dependencies.store.load(runId);
			const workers = await this.dependencies.workers.list();
			const liveWorkerIds = new Set(
				workers.flatMap((worker) =>
					["starting", "online", "stopping"].includes(worker.status)
						? [worker.id]
						: [],
				),
			);
			const referencedLiveWorkerIds = run.attempts.flatMap((attempt) =>
				attempt.workerId && liveWorkerIds.has(attempt.workerId)
					? [attempt.workerId]
					: [],
			);
			for (const workerId of new Set(referencedLiveWorkerIds)) {
				await this.dependencies.workers.stop(workerId);
			}
			return await this.dependencies.store.recover(runId, this.now());
		} finally {
			recoveringRuns.delete(key);
		}
	}

	resumeAndLaunch(
		run: BuildRun,
		repository: RepositoryInfo,
		model?: WorkerModelSelection,
		options: LaunchOptions = {},
	): Promise<LaunchResult> {
		if (run.state !== "running") {
			throw new Error(`Cannot resume run in state ${run.state}`);
		}
		return this.startScheduling(run, repository, model, options);
	}

	private stopWorker(workerId: string): Promise<string | undefined> {
		const existing = this.workerCleanup.get(workerId);
		if (existing) {
			return existing;
		}
		const cleanup = this.dependencies.workers.stop(workerId).then(
			() => undefined,
			(error: unknown) =>
				error instanceof Error ? error.message : String(error),
		);
		this.workerCleanup.set(workerId, cleanup);
		void cleanup.then((error) => {
			if (error && this.workerCleanup.get(workerId) === cleanup) {
				this.workerCleanup.delete(workerId);
			}
		});
		return cleanup;
	}

	private async inspectWorkerLifecycle(
		runId: string,
		workerId: string,
	): Promise<string | undefined> {
		const stored = await this.dependencies.store.load(runId);
		if (stored.state === "cancelled") {
			return "Run cancelled";
		}
		const worker = await this.dependencies.workers.status(workerId);
		if (worker.status === "error" || worker.status === "stopped") {
			return `Worker ${workerId} entered ${worker.status} status before Pi settled`;
		}
		return undefined;
	}

	private startWorkerStatusPolling(
		runId: string,
		workerId: string,
		controller: AbortController,
	): NodeJS.Timeout {
		let polling = false;
		let consecutiveFailures = 0;
		const poll = setInterval(() => {
			if (polling || controller.signal.aborted) {
				return;
			}
			polling = true;
			void this.inspectWorkerLifecycle(runId, workerId)
				.then((terminalError) => {
					consecutiveFailures = 0;
					if (terminalError) {
						controller.abort(new Error(terminalError));
					}
				})
				.catch((error: unknown) => {
					consecutiveFailures += 1;
					if (consecutiveFailures >= 3) {
						controller.abort(
							new Error(
								`Worker ${workerId} status checks failed: ${error instanceof Error ? error.message : String(error)}`,
							),
						);
					}
				})
				.finally(() => {
					polling = false;
				});
		}, this.workerPollIntervalMs);
		poll.unref();
		return poll;
	}

	private async waitForExecution(
		completion: Promise<WorkerExecutionResult>,
	): Promise<WorkerExecutionResult> {
		try {
			return await completion;
		} catch (error) {
			return {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async persistExecutionResult(
		execution: MonitoredExecution,
		result: WorkerExecutionResult,
		cleanupError: string | undefined,
		timedOut: boolean,
	): Promise<BuildRun> {
		const updated = await mutateStoredRun(
			this.dependencies.store,
			execution.runId,
			(stored) => {
				if (stored.state === "cancelled") {
					return stored;
				}
				const attempt = stored.attempts.find(
					(item) => item.id === execution.attemptId,
				);
				if (!attempt || !["launched", "running"].includes(attempt.state)) {
					return stored;
				}
				const succeeded = result.status === "succeeded" && !cleanupError;
				let failureMessage: string | undefined;
				if (cleanupError) {
					failureMessage = `Failed to stop worker ${execution.workerId}: ${cleanupError}`;
				} else if (timedOut) {
					failureMessage = `Worker execution timed out after ${this.workerTimeoutMs}ms`;
				} else if (result.status !== "succeeded") {
					failureMessage = result.error;
				}
				let current = updateAttempt(stored, execution.attemptId, {
					state: succeeded ? "succeeded" : "failed",
					finishedAt: this.now(),
					...(failureMessage ? { error: failureMessage } : {}),
				});
				const task = current.tasks[attempt.taskId];
				if (!task) {
					throw new Error(`Missing task for attempt ${execution.attemptId}`);
				}
				current = reconcileTaskStates({
					...current,
					state: succeeded ? current.state : "failed",
					tasks: {
						...current.tasks,
						[attempt.taskId]: {
							...task,
							state: succeeded ? "succeeded" : "failed",
						},
					},
					updatedAt: this.now(),
				});
				if (
					succeeded &&
					Object.values(current.tasks).every(
						(item) => item.state === "succeeded",
					)
				) {
					return { ...current, state: "integrating", updatedAt: this.now() };
				}
				return current;
			},
		);
		try {
			execution.options.onRunUpdated?.(updated);
		} catch {
			// UI observers must not affect persisted lifecycle state.
		}
		return updated;
	}

	private async monitorExecution(
		execution: MonitoredExecution,
	): Promise<BuildRun> {
		this.activeExecutions.set(execution.attemptId, {
			runId: execution.runId,
			controller: execution.controller,
		});
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			execution.controller.abort(
				new Error(`Worker execution timed out after ${this.workerTimeoutMs}ms`),
			);
		}, this.workerTimeoutMs);
		const poll = this.startWorkerStatusPolling(
			execution.runId,
			execution.workerId,
			execution.controller,
		);
		timeout.unref();
		const result = await this.waitForExecution(execution.completion).finally(
			() => {
				clearTimeout(timeout);
				clearInterval(poll);
				this.activeExecutions.delete(execution.attemptId);
			},
		);
		const cleanupError = await this.stopWorker(execution.workerId);
		return this.persistExecutionResult(
			execution,
			result,
			cleanupError,
			timedOut,
		);
	}

	private async startScheduling(
		run: BuildRun,
		repository: RepositoryInfo,
		model: WorkerModelSelection | undefined,
		options: LaunchOptions,
	): Promise<LaunchResult> {
		const key = schedulingKey(this.dependencies.store, run.id);
		if (activeSchedulingRuns.has(key) || recoveringRuns.has(key)) {
			throw new Error(`Run ${run.id} already has active lifecycle work`);
		}
		activeSchedulingRuns.add(key);
		try {
			const initial = await this.dispatchAvailableTasks(
				run.id,
				repository,
				model,
				options,
			);
			const active = new Map<string, Promise<string>>();
			for (const scheduled of initial.launches) {
				active.set(
					scheduled.launch.attempt.id,
					scheduled.completion.then(() => scheduled.launch.attempt.id),
				);
			}
			const completion = this.runSchedulingLoop(
				run.id,
				repository,
				model,
				options,
				active,
			).finally(() => {
				activeSchedulingRuns.delete(key);
			});
			return {
				run: initial.run,
				launches: initial.launches.map((scheduled) => scheduled.launch),
				completion,
			};
		} catch (error) {
			activeSchedulingRuns.delete(key);
			throw error;
		}
	}

	private async runSchedulingLoop(
		runId: string,
		repository: RepositoryInfo,
		model: WorkerModelSelection | undefined,
		options: LaunchOptions,
		active: Map<string, Promise<string>>,
	): Promise<BuildRun> {
		while (true) {
			if (active.size > 0) {
				const settledAttemptId = await Promise.race(active.values());
				active.delete(settledAttemptId);
			}
			const dispatched = await this.dispatchAvailableTasks(
				runId,
				repository,
				model,
				options,
			);
			for (const scheduled of dispatched.launches) {
				active.set(
					scheduled.launch.attempt.id,
					scheduled.completion.then(() => scheduled.launch.attempt.id),
				);
			}
			if (active.size === 0) {
				return dispatched.run;
			}
		}
	}

	private async dispatchAvailableTasks(
		runId: string,
		repository: RepositoryInfo,
		model: WorkerModelSelection | undefined,
		options: LaunchOptions,
	): Promise<DispatchResult> {
		let current = await this.dependencies.store.load(runId);
		const taskIds = getLaunchableTaskIds(current);
		const launches: ScheduledLaunch[] = [];
		for (const taskId of taskIds) {
			try {
				const scheduled = await this.launchTask(
					current,
					taskId,
					repository,
					model,
					options,
				);
				launches.push(scheduled);
				current = scheduled.run;
			} catch (error) {
				current = await this.dependencies.store.load(runId);
				if (current.state === "cancelled") {
					throw new Error("Run cancelled during worker launch", {
						cause: error,
					});
				}
				break;
			}
		}
		return {
			run: await this.dependencies.store.load(runId),
			launches,
		};
	}

	private async launchTask(
		run: BuildRun,
		taskId: string,
		repository: RepositoryInfo,
		model: WorkerModelSelection | undefined,
		options: LaunchOptions,
	): Promise<ScheduledLaunch> {
		let current = run;
		let currentAttemptId: string | undefined;
		let spawnedWorkerId: string | undefined;
		let executionController: AbortController | undefined;
		let reservationRejected = false;
		try {
			const taskRecord = current.tasks[taskId];
			if (!taskRecord) {
				throw new Error(`Task disappeared from run state: ${taskId}`);
			}
			const attemptNumber = taskRecord.attemptIds.length + 1;
			const allocation = await this.dependencies.worktrees.prepareTaskWorktree({
				repository,
				runId: current.id,
				taskId,
				attemptNumber,
				startPoint: current.integrationBranch,
			});
			const attempt: TaskAttempt = {
				id: `${taskId}-${attemptNumber}-${randomUUID().slice(0, 8)}`,
				taskId,
				number: attemptNumber,
				state: "prepared",
				branch: allocation.branch,
				worktreePath: allocation.path,
				startedAt: this.now(),
			};
			current = await mutateStoredRun(
				this.dependencies.store,
				current.id,
				(stored) => {
					if (!getLaunchableTaskIds(stored).includes(taskId)) {
						reservationRejected = true;
						return stored;
					}
					const storedTask = stored.tasks[taskId];
					if (!storedTask) {
						throw new Error(`Task disappeared from run state: ${taskId}`);
					}
					currentAttemptId = attempt.id;
					return {
						...stored,
						tasks: {
							...stored.tasks,
							[taskId]: {
								...storedTask,
								state: "running",
								attemptIds: [...storedTask.attemptIds, attempt.id],
							},
						},
						attempts: [...stored.attempts, attempt],
						updatedAt: this.now(),
					};
				},
			);
			if (reservationRejected) {
				throw new Error(`Task ${taskId} is no longer launchable`);
			}
			notifyRunUpdated(options, current);
			const worker = await this.dependencies.workers.spawn({
				cwd: allocation.path,
				label: `${current.id}:${taskId}`,
				...(model ? { provider: model.provider, model: model.model } : {}),
			});
			spawnedWorkerId = worker.id;
			current = await mutateStoredRun(
				this.dependencies.store,
				current.id,
				(stored) =>
					stored.state === "cancelled"
						? stored
						: {
								...updateAttempt(stored, attempt.id, {
									state: "launched",
									workerId: worker.id,
								}),
								updatedAt: this.now(),
							},
			);
			if (current.state === "cancelled") {
				throw new Error("Run cancelled during worker launch");
			}
			notifyRunUpdated(options, current);
			executionController = new AbortController();
			this.activeExecutions.set(attempt.id, {
				runId: current.id,
				controller: executionController,
			});
			const execution = await this.dependencies.workers.startPrompt(
				worker.id,
				buildWorkerPrompt(current, taskRecord.definition),
				{
					signal: executionController.signal,
					onEvent: (event) => {
						try {
							options.onProgress?.({
								runId: current.id,
								taskId,
								attemptId: attempt.id,
								workerId: worker.id,
								event,
							});
						} catch {
							// UI observers must not affect worker execution.
						}
					},
				},
			);
			current = await mutateStoredRun(
				this.dependencies.store,
				current.id,
				(stored) =>
					stored.state === "cancelled"
						? stored
						: {
								...updateAttempt(stored, attempt.id, { state: "running" }),
								updatedAt: this.now(),
							},
			);
			if (current.state === "cancelled") {
				executionController.abort(new Error("Run cancelled"));
				throw new Error("Run cancelled during worker launch");
			}
			notifyRunUpdated(options, current);
			const launchedAttempt = current.attempts.find(
				(item) => item.id === attempt.id,
			);
			if (!launchedAttempt) {
				throw new Error(`Attempt disappeared from run state: ${attempt.id}`);
			}
			const completion = this.monitorExecution({
				runId: current.id,
				attemptId: attempt.id,
				workerId: worker.id,
				completion: execution.completion,
				controller: executionController,
				options,
			});
			return {
				run: current,
				launch: { task: taskRecord.definition, attempt: launchedAttempt },
				completion,
			};
		} catch (error) {
			if (currentAttemptId) {
				this.activeExecutions.delete(currentAttemptId);
			}
			executionController?.abort(error);
			let failureMessage =
				error instanceof Error ? error.message : String(error);
			if (spawnedWorkerId) {
				const stopError = await this.stopWorker(spawnedWorkerId);
				if (stopError) {
					failureMessage += `; failed to stop worker: ${stopError}`;
				}
			}
			current = await mutateStoredRun(
				this.dependencies.store,
				current.id,
				(stored) => {
					if (stored.state === "cancelled" || reservationRejected) {
						return stored;
					}
					const activeAttempt = currentAttemptId
						? stored.attempts.find((attempt) => attempt.id === currentAttemptId)
						: undefined;
					if (!activeAttempt) {
						return { ...stored, state: "failed", updatedAt: this.now() };
					}
					let failed = updateAttempt(stored, activeAttempt.id, {
						state: "failed",
						finishedAt: this.now(),
						error: failureMessage,
					});
					const task = failed.tasks[activeAttempt.taskId];
					if (task) {
						failed = reconcileTaskStates({
							...failed,
							state: "failed",
							tasks: {
								...failed.tasks,
								[activeAttempt.taskId]: { ...task, state: "failed" },
							},
						});
					}
					return { ...failed, state: "failed", updatedAt: this.now() };
				},
			);
			notifyRunUpdated(options, current);
			throw error;
		}
	}
}
