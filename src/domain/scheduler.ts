import { topologicalTaskIds } from "./dag.js";
import {
	type BuildRun,
	isActiveAttemptState,
	type RunTask,
	type TaskState,
} from "./types.js";

const TERMINAL_FAILURE_STATES: ReadonlySet<TaskState> = new Set([
	"failed",
	"blocked",
	"cancelled",
]);
function nextState(task: RunTask, tasks: Record<string, RunTask>): TaskState {
	if (
		["running", "validating", "succeeded", "failed", "cancelled"].includes(
			task.state,
		)
	) {
		return task.state;
	}
	const dependencies = task.definition.dependencies.map((id) => tasks[id]);
	if (
		dependencies.some(
			(dependency) =>
				dependency === undefined ||
				TERMINAL_FAILURE_STATES.has(dependency.state),
		)
	) {
		return "blocked";
	}
	if (dependencies.every((dependency) => dependency?.integratedCommit)) {
		return "ready";
	}
	return "planned";
}

export function reconcileTaskStates(run: BuildRun): BuildRun {
	const tasks = { ...run.tasks };
	for (const id of topologicalTaskIds(run.plan)) {
		const task = tasks[id];
		if (task) {
			tasks[id] = { ...task, state: nextState(task, tasks) };
		}
	}
	return { ...run, tasks };
}

export function getLaunchableTaskIds(run: BuildRun): string[] {
	if (run.state !== "running") {
		return [];
	}
	const reconciled = reconcileTaskStates(run);
	const activeAttempts = reconciled.attempts.filter((attempt) =>
		isActiveAttemptState(attempt.state),
	);
	const tasksWithActiveAttempts = new Set(
		activeAttempts.map((attempt) => attempt.taskId),
	);
	const untrackedRunningTasks = Object.entries(reconciled.tasks).filter(
		([taskId, task]) =>
			["running", "validating"].includes(task.state) &&
			!tasksWithActiveAttempts.has(taskId),
	).length;
	const availableSlots = Math.max(
		0,
		reconciled.maxConcurrentWorkers -
			activeAttempts.length -
			untrackedRunningTasks,
	);
	if (availableSlots === 0) {
		return [];
	}
	return topologicalTaskIds(reconciled.plan)
		.filter(
			(taskId) =>
				reconciled.tasks[taskId]?.state === "ready" &&
				!tasksWithActiveAttempts.has(taskId),
		)
		.slice(0, availableSlots);
}
