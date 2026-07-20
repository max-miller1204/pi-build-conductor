import { reconcileTaskStates } from "./scheduler.js";
import {
	type BuildRun,
	MAX_CONCURRENT_WORKERS,
	MIN_CONCURRENT_WORKERS,
	RUN_SCHEMA_VERSION,
	type RunTask,
	type TaskPlan,
} from "./types.js";

export interface CreateRunInput {
	id: string;
	repositoryRoot: string;
	baseBranch: string;
	baseCommit: string;
	integrationBranch: string;
	handoff: BuildRun["handoff"];
	plan: TaskPlan;
	maxConcurrentWorkers: number;
	now: string;
}

export function createBuildRun(input: CreateRunInput): BuildRun {
	if (
		!Number.isInteger(input.maxConcurrentWorkers) ||
		input.maxConcurrentWorkers < MIN_CONCURRENT_WORKERS ||
		input.maxConcurrentWorkers > MAX_CONCURRENT_WORKERS
	) {
		throw new Error(
			`maxConcurrentWorkers must be an integer from ${MIN_CONCURRENT_WORKERS} to ${MAX_CONCURRENT_WORKERS}`,
		);
	}
	const tasks: Record<string, RunTask> = Object.fromEntries(
		input.plan.tasks.map((definition) => [
			definition.id,
			{ definition, state: "planned", attemptIds: [] },
		]),
	);
	return reconcileTaskStates({
		schemaVersion: RUN_SCHEMA_VERSION,
		id: input.id,
		state: "awaiting_approval",
		repositoryRoot: input.repositoryRoot,
		baseBranch: input.baseBranch,
		baseCommit: input.baseCommit,
		integrationBranch: input.integrationBranch,
		handoff: input.handoff,
		plan: input.plan,
		tasks,
		attempts: [],
		maxConcurrentWorkers: input.maxConcurrentWorkers,
		createdAt: input.now,
		updatedAt: input.now,
	});
}

export function approveRun(run: BuildRun, now: string): BuildRun {
	if (run.state !== "awaiting_approval") {
		throw new Error(`Cannot approve run in state ${run.state}`);
	}
	return { ...run, state: "running", approvedAt: now, updatedAt: now };
}

export function recoverInterruptedRun(run: BuildRun, now: string): BuildRun {
	let changed = false;
	const attempts = run.attempts.map((attempt) => {
		if (
			attempt.state !== "prepared" &&
			attempt.state !== "launched" &&
			attempt.state !== "running" &&
			attempt.state !== "validating"
		) {
			return attempt;
		}
		changed = true;
		return {
			...attempt,
			state: "interrupted" as const,
			finishedAt: now,
			error: "Conductor restarted",
		};
	});
	const tasks = Object.fromEntries(
		Object.entries(run.tasks).map(([id, task]) => {
			if (task.state !== "running" && task.state !== "validating") {
				return [id, task];
			}
			changed = true;
			return [id, { ...task, state: "planned" as const }];
		}),
	);
	if (!changed) {
		return run;
	}
	return reconcileTaskStates({ ...run, attempts, tasks, updatedAt: now });
}
