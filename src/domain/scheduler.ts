import { topologicalTaskIds } from "./dag.js";
import type { BuildRun, RunTask, TaskState } from "./types.js";

const TERMINAL_FAILURE_STATES: ReadonlySet<TaskState> = new Set([
	"failed",
	"blocked",
	"cancelled",
]);

function nextState(task: RunTask, tasks: Record<string, RunTask>): TaskState {
	if (["running", "succeeded", "failed", "cancelled"].includes(task.state)) {
		return task.state;
	}
	const dependencyStates = task.definition.dependencies.map(
		(id) => tasks[id]?.state,
	);
	if (
		dependencyStates.some(
			(state) => state === undefined || TERMINAL_FAILURE_STATES.has(state),
		)
	) {
		return "blocked";
	}
	if (dependencyStates.every((state) => state === "succeeded")) {
		return "ready";
	}
	return "planned";
}

export function reconcileTaskStates(run: BuildRun): BuildRun {
	const tasks: Record<string, RunTask> = {};
	for (const [id, task] of Object.entries(run.tasks)) {
		tasks[id] = { ...task, state: nextState(task, run.tasks) };
	}
	return { ...run, tasks };
}

export function getLaunchableTaskIds(run: BuildRun): string[] {
	const reconciled = reconcileTaskStates(run);
	const activeCount = Object.values(reconciled.tasks).filter(
		(task) => task.state === "running",
	).length;
	const availableSlots = Math.max(
		0,
		reconciled.maxConcurrentWorkers - activeCount,
	);
	if (availableSlots === 0) {
		return [];
	}
	return topologicalTaskIds(reconciled.plan)
		.filter((taskId) => reconciled.tasks[taskId]?.state === "ready")
		.slice(0, availableSlots);
}
