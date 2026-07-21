import {
	type PlanValidationIssue,
	validateTaskPlanResult,
} from "../domain/dag.js";
import {
	MAX_CONCURRENT_WORKERS,
	MIN_CONCURRENT_WORKERS,
	type PlanRevision,
	type TaskDefinition,
	type TaskPlan,
	type ValidationCommand,
} from "../domain/types.js";
import {
	formatValidationIssues,
	renderDagOverview,
	renderPlanDetails,
} from "./plan-presentation.js";

export interface PlanEditorUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	editor(title: string, prefilled?: string): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface PlanEditorSnapshot {
	plan: TaskPlan;
	maxConcurrentWorkers: number;
	planRevision: number;
	planRevisions: PlanRevision[];
}

export interface PlanEditorPersistence {
	save(
		plan: TaskPlan,
		maxConcurrentWorkers: number,
		expectedPlanRevision: number,
	): Promise<PlanEditorSnapshot>;
	restore(
		revisionNumber: number,
		expectedPlanRevision: number,
	): Promise<PlanEditorSnapshot>;
	reload(): Promise<PlanEditorSnapshot>;
}

export type PlanEditorResult =
	| { action: "continue"; snapshot: PlanEditorSnapshot }
	| { action: "exit"; snapshot: PlanEditorSnapshot }
	| { action: "cancel"; snapshot: PlanEditorSnapshot };

const ACTIONS = {
	viewDag: "View DAG overview",
	viewDetails: "View task details",
	editTask: "Edit a task node",
	addTask: "Add a task node",
	renameTask: "Rename a task node",
	removeTask: "Remove a task node",
	dependencies: "Edit task dependencies",
	reorder: "Reorder tasks",
	title: "Edit plan title",
	finalCommands: "Edit final validation commands",
	workers: "Set worker limit",
	raw: "Edit full plan JSON",
	history: "View or restore revision history",
	continue: "Continue to final approval",
	cancel: "Cancel build review",
} as const;

function taskOptions(plan: TaskPlan): Map<string, string> {
	return new Map(
		plan.tasks.map((task) => [`${task.id}: ${task.title}`, task.id]),
	);
}

async function chooseTask(
	ui: PlanEditorUI,
	plan: TaskPlan,
	title: string,
): Promise<string | undefined> {
	const options = taskOptions(plan);
	const selected = await ui.select(title, [...options.keys()]);
	return selected ? options.get(selected) : undefined;
}

function issuesFromUnknown(error: unknown): PlanValidationIssue[] {
	return [
		{
			code: "invalid_json",
			path: "plan",
			message: error instanceof Error ? error.message : String(error),
		},
	];
}

function valuesEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function displayedValue(value: unknown): string {
	return value === undefined ? "(absent)" : JSON.stringify(value);
}

function mergeValue<T>(
	path: string,
	base: T,
	candidate: T,
	latest: T,
	conflicts: string[],
): T {
	if (valuesEqual(candidate, base)) {
		return latest;
	}
	if (valuesEqual(latest, base) || valuesEqual(candidate, latest)) {
		return candidate;
	}
	conflicts.push(
		`${path}: latest=${displayedValue(latest)}, yours=${displayedValue(candidate)}`,
	);
	return candidate;
}

function mergeTasks(
	base: TaskDefinition[],
	candidate: TaskDefinition[],
	latest: TaskDefinition[],
	conflicts: string[],
): TaskDefinition[] {
	const baseOrder = base.map((task) => task.id);
	const candidateOrder = candidate.map((task) => task.id);
	const latestOrder = latest.map((task) => task.id);
	const mergedOrder = mergeValue(
		"task order",
		baseOrder,
		candidateOrder,
		latestOrder,
		conflicts,
	);
	const baseById = new Map(base.map((task) => [task.id, task]));
	const candidateById = new Map(candidate.map((task) => [task.id, task]));
	const latestById = new Map(latest.map((task) => [task.id, task]));
	const allIds = new Set([...latestOrder, ...candidateOrder, ...baseOrder]);
	const mergedById = new Map<string, TaskDefinition>();
	for (const id of allIds) {
		const merged = mergeValue(
			`task ${id}`,
			baseById.get(id),
			candidateById.get(id),
			latestById.get(id),
			conflicts,
		);
		if (merged) {
			mergedById.set(id, merged);
		}
	}
	return [...mergedOrder, ...allIds]
		.filter((id, index, ids) => ids.indexOf(id) === index)
		.flatMap((id) => {
			const task = mergedById.get(id);
			return task ? [task] : [];
		});
}

function mergeConcurrentCandidate(
	base: PlanEditorSnapshot,
	candidate: TaskPlan,
	candidateWorkerLimit: number,
	latest: PlanEditorSnapshot,
): {
	plan: TaskPlan;
	maxConcurrentWorkers: number;
	conflicts: string[];
} {
	const conflicts: string[] = [];
	return {
		plan: {
			version: candidate.version,
			title: mergeValue(
				"title",
				base.plan.title,
				candidate.title,
				latest.plan.title,
				conflicts,
			),
			tasks: mergeTasks(
				base.plan.tasks,
				candidate.tasks,
				latest.plan.tasks,
				conflicts,
			),
			finalValidationCommands: mergeValue(
				"final validation commands",
				base.plan.finalValidationCommands,
				candidate.finalValidationCommands,
				latest.plan.finalValidationCommands,
				conflicts,
			),
		},
		maxConcurrentWorkers: mergeValue(
			"worker limit",
			base.maxConcurrentWorkers,
			candidateWorkerLimit,
			latest.maxConcurrentWorkers,
			conflicts,
		),
		conflicts,
	};
}

async function persistCandidate(
	ui: PlanEditorUI,
	persistence: PlanEditorPersistence,
	current: PlanEditorSnapshot,
	candidate: unknown,
	maxConcurrentWorkers = current.maxConcurrentWorkers,
): Promise<PlanEditorSnapshot> {
	const validation = validateTaskPlanResult(candidate);
	if (!validation.ok) {
		ui.notify(formatValidationIssues(validation.issues), "error");
		const corrected = await editJson(
			ui,
			"Fix invalid plan candidate",
			candidate,
		);
		return corrected === undefined
			? current
			: persistCandidate(
					ui,
					persistence,
					current,
					corrected,
					maxConcurrentWorkers,
				);
	}
	try {
		const saved = await persistence.save(
			validation.plan,
			maxConcurrentWorkers,
			current.planRevision,
		);
		if (saved.planRevision === current.planRevision) {
			ui.notify("No plan changes to save", "info");
		} else {
			ui.notify(`Saved plan revision ${saved.planRevision}`, "info");
		}
		return saved;
	} catch (error) {
		ui.notify(
			`Could not save plan revision: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		const fresh = await persistence.reload();
		const merged = mergeConcurrentCandidate(
			current,
			validation.plan,
			maxConcurrentWorkers,
			fresh,
		);
		const workerConflict = merged.conflicts.find((conflict) =>
			conflict.startsWith("worker limit:"),
		);
		if (workerConflict) {
			const mine = `Use my worker limit (${maxConcurrentWorkers})`;
			const latest = `Use latest worker limit (${fresh.maxConcurrentWorkers})`;
			const selected = await ui.select(
				`Worker limit changed concurrently: ${workerConflict}`,
				[mine, latest],
			);
			if (!selected) {
				return fresh;
			}
			merged.maxConcurrentWorkers =
				selected === mine ? maxConcurrentWorkers : fresh.maxConcurrentWorkers;
			merged.conflicts = merged.conflicts.filter(
				(conflict) => conflict !== workerConflict,
			);
		}
		if (merged.conflicts.length === 0) {
			ui.notify(
				`Merged your unsaved changes with revision ${fresh.planRevision}`,
				"info",
			);
			return persistCandidate(
				ui,
				persistence,
				fresh,
				merged.plan,
				merged.maxConcurrentWorkers,
			);
		}
		ui.notify(
			`Concurrent changes need review:\n${merged.conflicts.map((conflict) => `- ${conflict}`).join("\n")}`,
			"warning",
		);
		const rebased = await editJson(
			ui,
			`Resolve conflicts against revision ${fresh.planRevision}; the draft currently keeps your conflicting values`,
			merged.plan,
		);
		return rebased === undefined
			? fresh
			: persistCandidate(
					ui,
					persistence,
					fresh,
					rebased,
					merged.maxConcurrentWorkers,
				);
	}
}

function replacementPlan(
	current: PlanEditorSnapshot,
	tasks: TaskDefinition[],
): TaskPlan {
	return { ...current.plan, tasks };
}

function newTaskTemplate(plan: TaskPlan): TaskDefinition {
	let suffix = 1;
	let id = "new-task";
	const ids = new Set(plan.tasks.map((task) => task.id));
	while (ids.has(id)) {
		suffix += 1;
		id = `new-task-${suffix}`;
	}
	return {
		id,
		title: "New task",
		description: "Describe the isolated implementation work.",
		dependencies: [],
		acceptanceCriteria: ["Describe a verifiable outcome."],
		allowedPaths: ["src/"],
		validationCommands: plan.tasks[0]?.validationCommands ?? [
			{ command: "npm", args: ["test"] },
		],
	};
}

async function editJson<T>(
	ui: PlanEditorUI,
	title: string,
	value: T,
): Promise<unknown | undefined> {
	let draft = `${JSON.stringify(value, null, 2)}\n`;
	for (;;) {
		const edited = await ui.editor(title, draft);
		if (edited === undefined) {
			return undefined;
		}
		try {
			return JSON.parse(edited) as unknown;
		} catch (error) {
			ui.notify(formatValidationIssues(issuesFromUnknown(error)), "error");
			draft = edited;
		}
	}
}

export async function reviewPlanInteractively(
	ui: PlanEditorUI,
	initial: PlanEditorSnapshot,
	persistence: PlanEditorPersistence,
): Promise<PlanEditorResult> {
	let current = initial;
	ui.notify(renderDagOverview(current.plan), "info");
	for (;;) {
		const action = await ui.select(
			`Plan revision ${current.planRevision} - ${current.plan.title} - ${current.maxConcurrentWorkers} workers`,
			Object.values(ACTIONS),
		);
		if (action === undefined) {
			return { action: "exit", snapshot: current };
		}
		if (action === ACTIONS.cancel) {
			return { action: "cancel", snapshot: current };
		}
		if (action === ACTIONS.continue) {
			return { action: "continue", snapshot: current };
		}
		if (action === ACTIONS.viewDag) {
			ui.notify(renderDagOverview(current.plan), "info");
			continue;
		}
		if (action === ACTIONS.viewDetails) {
			ui.notify(renderPlanDetails(current.plan), "info");
			continue;
		}
		if (action === ACTIONS.editTask) {
			const taskId = await chooseTask(ui, current.plan, "Edit which task?");
			const index = current.plan.tasks.findIndex((task) => task.id === taskId);
			const task = current.plan.tasks[index];
			if (!task) continue;
			const edited = await editJson(ui, `Edit task ${task.id}`, task);
			if (edited === undefined) continue;
			const tasks = [...current.plan.tasks];
			tasks[index] = edited as TaskDefinition;
			current = await persistCandidate(
				ui,
				persistence,
				current,
				replacementPlan(current, tasks),
			);
			continue;
		}
		if (action === ACTIONS.addTask) {
			const edited = await editJson(
				ui,
				"Add task node",
				newTaskTemplate(current.plan),
			);
			if (edited === undefined) continue;
			current = await persistCandidate(
				ui,
				persistence,
				current,
				replacementPlan(current, [
					...current.plan.tasks,
					edited as TaskDefinition,
				]),
			);
			continue;
		}
		if (action === ACTIONS.renameTask) {
			const taskId = await chooseTask(ui, current.plan, "Rename which task?");
			if (!taskId) continue;
			const nextId = (await ui.input("New task id", taskId))?.trim();
			if (!nextId || nextId === taskId) continue;
			const tasks = current.plan.tasks.map((task) => ({
				...task,
				id: task.id === taskId ? nextId : task.id,
				dependencies: task.dependencies.map((dependency) =>
					dependency === taskId ? nextId : dependency,
				),
			}));
			current = await persistCandidate(
				ui,
				persistence,
				current,
				replacementPlan(current, tasks),
			);
			continue;
		}
		if (action === ACTIONS.removeTask) {
			const taskId = await chooseTask(ui, current.plan, "Remove which task?");
			if (!taskId) continue;
			if (current.plan.tasks.length === 1) {
				ui.notify("A plan must contain at least one task", "error");
				continue;
			}
			const dependents = current.plan.tasks
				.filter((task) => task.dependencies.includes(taskId))
				.map((task) => task.id);
			if (dependents.length > 0) {
				ui.notify(
					`Remove dependencies from ${dependents.join(", ")} before deleting ${taskId}`,
					"error",
				);
				continue;
			}
			current = await persistCandidate(
				ui,
				persistence,
				current,
				replacementPlan(
					current,
					current.plan.tasks.filter((task) => task.id !== taskId),
				),
			);
			continue;
		}
		if (action === ACTIONS.dependencies) {
			const taskId = await chooseTask(
				ui,
				current.plan,
				"Edit dependencies for which task?",
			);
			const task = current.plan.tasks.find((item) => item.id === taskId);
			if (!task) continue;
			const value = await ui.input(
				`Dependencies for ${task.id} (comma-separated, blank for none)`,
				task.dependencies.join(", "),
			);
			if (value === undefined) continue;
			const dependencies = value
				.split(",")
				.flatMap((item) => (item.trim() ? [item.trim()] : []));
			const tasks = current.plan.tasks.map((item) =>
				item.id === task.id ? { ...item, dependencies } : item,
			);
			current = await persistCandidate(
				ui,
				persistence,
				current,
				replacementPlan(current, tasks),
			);
			continue;
		}
		if (action === ACTIONS.reorder) {
			const order = await ui.input(
				"Task ids in the desired order (comma-separated)",
				current.plan.tasks.map((task) => task.id).join(", "),
			);
			if (order === undefined) continue;
			const ids = order
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean);
			const byId = new Map(current.plan.tasks.map((task) => [task.id, task]));
			if (
				ids.length !== current.plan.tasks.length ||
				new Set(ids).size !== ids.length ||
				ids.some((id) => !byId.has(id))
			) {
				ui.notify("Order must contain every task id exactly once", "error");
				continue;
			}
			const tasks = ids.map((id) => byId.get(id) as TaskDefinition);
			current = await persistCandidate(
				ui,
				persistence,
				current,
				replacementPlan(current, tasks),
			);
			continue;
		}
		if (action === ACTIONS.title) {
			const title = (await ui.input("Plan title", current.plan.title))?.trim();
			if (!title) continue;
			current = await persistCandidate(ui, persistence, current, {
				...current.plan,
				title,
			});
			continue;
		}
		if (action === ACTIONS.finalCommands) {
			const commands = await editJson(
				ui,
				"Edit final validation commands",
				current.plan.finalValidationCommands,
			);
			if (commands === undefined) continue;
			current = await persistCandidate(ui, persistence, current, {
				...current.plan,
				finalValidationCommands: commands as ValidationCommand[],
			});
			continue;
		}
		if (action === ACTIONS.workers) {
			const options = Array.from(
				{ length: MAX_CONCURRENT_WORKERS - MIN_CONCURRENT_WORKERS + 1 },
				(_, index) => String(index + MIN_CONCURRENT_WORKERS),
			);
			const selected = await ui.select(
				`Maximum concurrent workers (current: ${current.maxConcurrentWorkers})`,
				options,
			);
			if (!selected) continue;
			current = await persistCandidate(
				ui,
				persistence,
				current,
				current.plan,
				Number(selected),
			);
			continue;
		}
		if (action === ACTIONS.raw) {
			const edited = await editJson(ui, "Edit full plan JSON", current.plan);
			if (edited === undefined) continue;
			current = await persistCandidate(ui, persistence, current, edited);
			continue;
		}
		if (action === ACTIONS.history) {
			const labels = new Map(
				current.planRevisions.map((revision) => [
					`Revision ${revision.number}: ${revision.source}, ${revision.plan.tasks.length} tasks, ${revision.maxConcurrentWorkers} workers`,
					revision.number,
				]),
			);
			const selected = await ui.select(
				"Select a revision to restore as a new revision",
				[...labels.keys()].toReversed(),
			);
			const revisionNumber = selected ? labels.get(selected) : undefined;
			if (!revisionNumber || revisionNumber === current.planRevision) continue;
			try {
				current = await persistence.restore(
					revisionNumber,
					current.planRevision,
				);
				ui.notify(
					`Restored revision ${revisionNumber} as revision ${current.planRevision}`,
					"info",
				);
			} catch (error) {
				ui.notify(
					`Could not restore revision: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				current = await persistence.reload();
			}
		}
	}
}
