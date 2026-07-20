import {
	PLAN_SCHEMA_VERSION,
	type TaskDefinition,
	type TaskPlan,
} from "./types.js";

const TASK_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export class PlanValidationError extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		super(`Invalid task plan:\n- ${issues.join("\n- ")}`);
		this.name = "PlanValidationError";
		this.issues = issues;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(
	value: unknown,
	path: string,
	issues: string[],
): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		issues.push(`${path} must be a non-empty string`);
		return "";
	}
	return value.trim();
}

function readStringArray(
	value: unknown,
	path: string,
	issues: string[],
): string[] {
	if (!Array.isArray(value)) {
		issues.push(`${path} must be an array of strings`);
		return [];
	}
	const result: string[] = [];
	for (const [index, item] of value.entries()) {
		result.push(readNonEmptyString(item, `${path}[${index}]`, issues));
	}
	return result;
}

function readTask(
	value: unknown,
	index: number,
	issues: string[],
): TaskDefinition {
	const path = `tasks[${index}]`;
	if (!isRecord(value)) {
		issues.push(`${path} must be an object`);
		return {
			id: "",
			title: "",
			description: "",
			dependencies: [],
			acceptanceCriteria: [],
		};
	}
	return {
		id: readNonEmptyString(value.id, `${path}.id`, issues),
		title: readNonEmptyString(value.title, `${path}.title`, issues),
		description: readNonEmptyString(
			value.description,
			`${path}.description`,
			issues,
		),
		dependencies: readStringArray(
			value.dependencies,
			`${path}.dependencies`,
			issues,
		),
		acceptanceCriteria: readStringArray(
			value.acceptanceCriteria,
			`${path}.acceptanceCriteria`,
			issues,
		),
	};
}

function findCycle(tasks: TaskDefinition[]): string[] | undefined {
	const dependencies = new Map(
		tasks.map((task) => [task.id, task.dependencies]),
	);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const path: string[] = [];

	const visit = (id: string): string[] | undefined => {
		if (visiting.has(id)) {
			const cycleStart = path.indexOf(id);
			return [...path.slice(cycleStart), id];
		}
		if (visited.has(id)) {
			return undefined;
		}
		visiting.add(id);
		path.push(id);
		for (const dependency of dependencies.get(id) ?? []) {
			const cycle = visit(dependency);
			if (cycle) {
				return cycle;
			}
		}
		path.pop();
		visiting.delete(id);
		visited.add(id);
		return undefined;
	};

	for (const task of tasks) {
		const cycle = visit(task.id);
		if (cycle) {
			return cycle;
		}
	}
	return undefined;
}

export function validateTaskPlan(value: unknown): TaskPlan {
	const issues: string[] = [];
	if (!isRecord(value)) {
		throw new PlanValidationError(["plan must be an object"]);
	}
	if (value.version !== PLAN_SCHEMA_VERSION) {
		issues.push(`version must be ${PLAN_SCHEMA_VERSION}`);
	}
	const title = readNonEmptyString(value.title, "title", issues);
	if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
		issues.push("tasks must be a non-empty array");
	}
	const tasks = Array.isArray(value.tasks)
		? value.tasks.map((task, index) => readTask(task, index, issues))
		: [];
	const ids = new Set<string>();
	for (const task of tasks) {
		if (!TASK_ID_PATTERN.test(task.id)) {
			issues.push(
				`task id ${JSON.stringify(task.id)} must match ${TASK_ID_PATTERN}`,
			);
		}
		if (ids.has(task.id)) {
			issues.push(`duplicate task id: ${task.id}`);
		}
		ids.add(task.id);
		const uniqueDependencies = new Set(task.dependencies);
		if (uniqueDependencies.size !== task.dependencies.length) {
			issues.push(`task ${task.id} has duplicate dependencies`);
		}
		if (uniqueDependencies.has(task.id)) {
			issues.push(`task ${task.id} cannot depend on itself`);
		}
	}
	for (const task of tasks) {
		for (const dependency of task.dependencies) {
			if (!ids.has(dependency)) {
				issues.push(`task ${task.id} depends on unknown task ${dependency}`);
			}
		}
	}
	if (issues.length === 0) {
		const cycle = findCycle(tasks);
		if (cycle) {
			issues.push(`dependency cycle: ${cycle.join(" -> ")}`);
		}
	}
	if (issues.length > 0) {
		throw new PlanValidationError(issues);
	}
	return { version: PLAN_SCHEMA_VERSION, title, tasks };
}

export function topologicalTaskIds(plan: TaskPlan): string[] {
	const validated = validateTaskPlan(plan);
	const taskOrder = new Map(
		validated.tasks.map((task, index) => [task.id, index]),
	);
	const dependents = new Map<string, string[]>();
	const remainingDependencies = new Map<string, number>();
	for (const task of validated.tasks) {
		remainingDependencies.set(task.id, task.dependencies.length);
		for (const dependency of task.dependencies) {
			const current = dependents.get(dependency) ?? [];
			current.push(task.id);
			dependents.set(dependency, current);
		}
	}
	const ready = validated.tasks.flatMap((task) =>
		task.dependencies.length === 0 ? [task.id] : [],
	);
	const result: string[] = [];
	while (ready.length > 0) {
		ready.sort(
			(left, right) => (taskOrder.get(left) ?? 0) - (taskOrder.get(right) ?? 0),
		);
		const id = ready.shift();
		if (!id) {
			break;
		}
		result.push(id);
		for (const dependent of dependents.get(id) ?? []) {
			const remaining = (remainingDependencies.get(dependent) ?? 0) - 1;
			remainingDependencies.set(dependent, remaining);
			if (remaining === 0) {
				ready.push(dependent);
			}
		}
	}
	return result;
}
