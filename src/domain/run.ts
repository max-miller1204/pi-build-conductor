import { reconcileTaskStates } from "./scheduler.js";
import {
	type BuildRun,
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
	if (input.maxConcurrentWorkers < 1) {
		throw new Error("maxConcurrentWorkers must be at least 1");
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
		if (attempt.state !== "launched" && attempt.state !== "running") {
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
			if (task.state !== "running") {
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
