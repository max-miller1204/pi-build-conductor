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
import type { WorkerBackend } from "./workers/backend.js";

export interface BuildConductorDependencies {
	store: RunStore;
	worktrees: WorktreeManager;
	workers: WorkerBackend;
	now?: () => string;
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

export interface LaunchResult {
	run: BuildRun;
	task: TaskDefinition;
	attempt: TaskAttempt;
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

	constructor(private readonly dependencies: BuildConductorDependencies) {
		this.now = dependencies.now ?? (() => new Date().toISOString());
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
		const cancelled = {
			...run,
			state: "cancelled" as const,
			updatedAt: this.now(),
		};
		await this.dependencies.store.save(cancelled);
		return cancelled;
	}

	async approveAndLaunch(
		run: BuildRun,
		repository: RepositoryInfo,
		model?: WorkerModelSelection,
	): Promise<LaunchResult> {
		let current = approveRun(run, this.now());
		await this.dependencies.store.save(current);
		try {
			const integrationBranch =
				await this.dependencies.worktrees.prepareIntegrationBranch(
					repository,
					run.id,
				);
			if (integrationBranch !== run.integrationBranch) {
				throw new Error(`Unexpected integration branch: ${integrationBranch}`);
			}
			const taskId = getLaunchableTaskIds(current)[0];
			const taskRecord = taskId ? current.tasks[taskId] : undefined;
			if (!taskId || !taskRecord) {
				throw new Error("Approved plan has no launchable task");
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
			current = {
				...current,
				tasks: {
					...current.tasks,
					[taskId]: {
						...taskRecord,
						state: "running",
						attemptIds: [...taskRecord.attemptIds, attempt.id],
					},
				},
				attempts: [...current.attempts, attempt],
				updatedAt: this.now(),
			};
			await this.dependencies.store.save(current);
			const worker = await this.dependencies.workers.spawn({
				cwd: allocation.path,
				label: `${current.id}:${taskId}`,
				...(model ? { provider: model.provider, model: model.model } : {}),
			});
			current = updateAttempt(current, attempt.id, {
				state: "launched",
				workerId: worker.id,
			});
			await this.dependencies.store.save(current);
			await this.dependencies.workers.sendPrompt(
				worker.id,
				buildWorkerPrompt(current, taskRecord.definition),
			);
			current = updateAttempt(current, attempt.id, { state: "running" });
			current = { ...current, updatedAt: this.now() };
			await this.dependencies.store.save(current);
			const launchedAttempt = current.attempts.find(
				(item) => item.id === attempt.id,
			);
			if (!launchedAttempt) {
				throw new Error(`Attempt disappeared from run state: ${attempt.id}`);
			}
			return {
				run: current,
				task: taskRecord.definition,
				attempt: launchedAttempt,
			};
		} catch (error) {
			const activeAttempt = current.attempts.find(
				(attempt) =>
					attempt.state === "prepared" || attempt.state === "launched",
			);
			let failureMessage =
				error instanceof Error ? error.message : String(error);
			if (activeAttempt?.workerId) {
				try {
					await this.dependencies.workers.stop(activeAttempt.workerId);
				} catch (stopError) {
					failureMessage += `; failed to stop worker: ${stopError instanceof Error ? stopError.message : String(stopError)}`;
				}
			}
			if (activeAttempt) {
				current = updateAttempt(current, activeAttempt.id, {
					state: "failed",
					finishedAt: this.now(),
					error: failureMessage,
				});
				const task = current.tasks[activeAttempt.taskId];
				if (task) {
					current = reconcileTaskStates({
						...current,
						tasks: {
							...current.tasks,
							[activeAttempt.taskId]: { ...task, state: "planned" },
						},
					});
				}
			} else {
				current = { ...current, state: "failed" };
			}
			current = { ...current, updatedAt: this.now() };
			await this.dependencies.store.save(current);
			throw error;
		}
	}
}
