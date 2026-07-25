import { posix, win32 } from "node:path";
import {
	PLAN_SCHEMA_VERSION,
	type TaskDefinition,
	type TaskPlan,
	type ValidationCommand,
} from "./types.js";

const TASK_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface PlanValidationIssue {
	code: string;
	path: string;
	message: string;
	taskId?: string;
	relatedTaskIds?: string[];
}

export type PlanValidationResult =
	| { ok: true; plan: TaskPlan; issues: [] }
	| { ok: false; issues: PlanValidationIssue[] };

export interface TaskPlanEdge {
	from: string;
	to: string;
}

export interface TaskPlanAnalysis {
	topologicalOrder: string[];
	layers: string[][];
	edges: TaskPlanEdge[];
	roots: string[];
	leaves: string[];
	widestLayer: number;
}

export class PlanValidationError extends Error {
	readonly issues: string[];
	readonly details: PlanValidationIssue[];

	constructor(issues: string[] | PlanValidationIssue[]) {
		const details = issues.map((issue) =>
			typeof issue === "string"
				? { code: "invalid", path: "plan", message: issue }
				: issue,
		);
		super(
			`Invalid task plan:\n- ${details.map((issue) => issue.message).join("\n- ")}`,
		);
		this.name = "PlanValidationError";
		this.issues = details.map((issue) => issue.message);
		this.details = details;
	}
}

export function addIssue(
	issues: PlanValidationIssue[],
	code: string,
	path: string,
	message: string,
	metadata: Pick<PlanValidationIssue, "taskId" | "relatedTaskIds"> = {},
): void {
	issues.push({ code, path, message, ...metadata });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readNonEmptyString(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		addIssue(
			issues,
			"non_empty_string",
			path,
			`${path} must be a non-empty string`,
		);
		return "";
	}
	return value.trim();
}

export function readStringArray(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
): string[] {
	if (!Array.isArray(value)) {
		addIssue(
			issues,
			"string_array",
			path,
			`${path} must be an array of strings`,
		);
		return [];
	}
	const result: string[] = [];
	for (const [index, item] of value.entries()) {
		result.push(readNonEmptyString(item, `${path}[${index}]`, issues));
	}
	return result;
}

export function readSafeRepositoryPaths(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
): string[] {
	const paths = readStringArray(value, path, issues);
	for (const [index, entry] of paths.entries()) {
		const itemPath = `${path}[${index}]`;
		const directory = entry.endsWith("/");
		const withoutSlash = directory ? entry.slice(0, -1) : entry;
		if (
			entry.includes("\0") ||
			entry.includes("\\") ||
			posix.isAbsolute(entry) ||
			win32.isAbsolute(entry) ||
			withoutSlash.length === 0 ||
			withoutSlash === "." ||
			withoutSlash === ".." ||
			withoutSlash.startsWith("../") ||
			withoutSlash.includes("/../") ||
			/[?*[\]]/.test(entry)
		) {
			addIssue(
				issues,
				"unsafe_path",
				itemPath,
				`${itemPath} must be a safe repository-relative file or directory path`,
			);
			continue;
		}
		const normalized = posix.normalize(withoutSlash);
		const canonical = directory ? `${normalized}/` : normalized;
		if (
			canonical !== entry ||
			normalized === ".git" ||
			normalized.startsWith(".git/")
		) {
			addIssue(
				issues,
				"non_canonical_path",
				itemPath,
				`${itemPath} must be normalized and cannot address Git metadata`,
			);
		}
	}
	if (new Set(paths).size !== paths.length) {
		addIssue(
			issues,
			"duplicate_path",
			path,
			`${path} must not contain duplicates`,
		);
	}
	return paths;
}

export function readAllowedPaths(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
): string[] {
	const paths = readSafeRepositoryPaths(value, path, issues);
	if (paths.length === 0) {
		addIssue(
			issues,
			"required_paths",
			path,
			`${path} must contain at least one repository-relative path`,
		);
	}
	return paths;
}

export function readCommandObject(
	item: unknown,
	itemPath: string,
	issues: PlanValidationIssue[],
): ValidationCommand {
	if (!isRecord(item)) {
		addIssue(
			issues,
			"command_object",
			itemPath,
			`${itemPath} must be an object`,
		);
		return { command: "", args: [] };
	}
	const command = readNonEmptyString(
		item.command,
		`${itemPath}.command`,
		issues,
	);
	if (command.includes("\0")) {
		addIssue(
			issues,
			"nul_byte",
			`${itemPath}.command`,
			`${itemPath}.command cannot contain a NUL byte`,
		);
	}
	if (!Array.isArray(item.args)) {
		addIssue(
			issues,
			"command_args",
			`${itemPath}.args`,
			`${itemPath}.args must be an array of strings`,
		);
		return { command, args: [] };
	}
	const args = item.args.map((argument, argumentIndex) => {
		const argumentPath = `${itemPath}.args[${argumentIndex}]`;
		if (typeof argument !== "string") {
			addIssue(
				issues,
				"command_arg",
				argumentPath,
				`${argumentPath} must be a string`,
			);
			return "";
		}
		if (argument.includes("\0")) {
			addIssue(
				issues,
				"nul_byte",
				argumentPath,
				`${argumentPath} cannot contain a NUL byte`,
			);
		}
		return argument;
	});
	return { command, args };
}

export function readValidationCommands(
	value: unknown,
	path: string,
	issues: PlanValidationIssue[],
): ValidationCommand[] {
	if (!Array.isArray(value) || value.length === 0) {
		addIssue(
			issues,
			"required_commands",
			path,
			`${path} must be a non-empty array of command objects`,
		);
		return [];
	}
	return value.map((item, index) =>
		readCommandObject(item, `${path}[${index}]`, issues),
	);
}

function readTask(
	value: unknown,
	index: number,
	issues: PlanValidationIssue[],
): TaskDefinition {
	const path = `tasks[${index}]`;
	if (!isRecord(value)) {
		addIssue(issues, "task_object", path, `${path} must be an object`);
		return {
			id: "",
			title: "",
			description: "",
			dependencies: [],
			acceptanceCriteria: [],
			allowedPaths: [],
			validationCommands: [],
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
		allowedPaths: readAllowedPaths(
			value.allowedPaths,
			`${path}.allowedPaths`,
			issues,
		),
		validationCommands: readValidationCommands(
			value.validationCommands,
			`${path}.validationCommands`,
			issues,
		),
	};
}

export function findCycle(
	tasks: readonly { id: string; dependencies: string[] }[],
): string[] | undefined {
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

export function validateTaskPlanResult(value: unknown): PlanValidationResult {
	const issues: PlanValidationIssue[] = [];
	if (!isRecord(value)) {
		return {
			ok: false,
			issues: [
				{
					code: "plan_object",
					path: "plan",
					message: "plan must be an object",
				},
			],
		};
	}
	if (value.version !== PLAN_SCHEMA_VERSION) {
		addIssue(
			issues,
			"schema_version",
			"version",
			`version must be ${PLAN_SCHEMA_VERSION}`,
		);
	}
	const title = readNonEmptyString(value.title, "title", issues);
	if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
		addIssue(
			issues,
			"required_tasks",
			"tasks",
			"tasks must be a non-empty array",
		);
	}
	const tasks = Array.isArray(value.tasks)
		? value.tasks.map((task, index) => readTask(task, index, issues))
		: [];
	const finalValidationCommands = readValidationCommands(
		value.finalValidationCommands,
		"finalValidationCommands",
		issues,
	);
	const ids = new Set<string>();
	for (const [index, task] of tasks.entries()) {
		const idPath = `tasks[${index}].id`;
		if (!TASK_ID_PATTERN.test(task.id)) {
			addIssue(
				issues,
				"task_id_format",
				idPath,
				`task id ${JSON.stringify(task.id)} must match ${TASK_ID_PATTERN}`,
				{ taskId: task.id },
			);
		}
		if (ids.has(task.id)) {
			addIssue(
				issues,
				"duplicate_task_id",
				idPath,
				`duplicate task id: ${task.id}`,
				{ taskId: task.id },
			);
		}
		ids.add(task.id);
		const uniqueDependencies = new Set(task.dependencies);
		if (uniqueDependencies.size !== task.dependencies.length) {
			addIssue(
				issues,
				"duplicate_dependency",
				`tasks[${index}].dependencies`,
				`task ${task.id} has duplicate dependencies`,
				{ taskId: task.id },
			);
		}
		if (uniqueDependencies.has(task.id)) {
			addIssue(
				issues,
				"self_dependency",
				`tasks[${index}].dependencies`,
				`task ${task.id} cannot depend on itself`,
				{ taskId: task.id },
			);
		}
	}
	for (const [taskIndex, task] of tasks.entries()) {
		for (const [dependencyIndex, dependency] of task.dependencies.entries()) {
			if (!ids.has(dependency)) {
				addIssue(
					issues,
					"unknown_dependency",
					`tasks[${taskIndex}].dependencies[${dependencyIndex}]`,
					`task ${task.id} depends on unknown task ${dependency}`,
					{ taskId: task.id, relatedTaskIds: [dependency] },
				);
			}
		}
	}
	if (issues.length === 0) {
		const cycle = findCycle(tasks);
		if (cycle) {
			addIssue(
				issues,
				"dependency_cycle",
				"tasks",
				`dependency cycle: ${cycle.join(" -> ")}`,
				{ relatedTaskIds: cycle },
			);
		}
	}
	if (issues.length > 0) {
		return { ok: false, issues };
	}
	return {
		ok: true,
		plan: {
			version: PLAN_SCHEMA_VERSION,
			title,
			tasks,
			finalValidationCommands,
		},
		issues: [],
	};
}

export function validateTaskPlan(value: unknown): TaskPlan {
	const result = validateTaskPlanResult(value);
	if (!result.ok) {
		throw new PlanValidationError(result.issues);
	}
	return result.plan;
}

export function analyzeTaskPlan(plan: TaskPlan): TaskPlanAnalysis {
	const validated = validateTaskPlan(plan);
	const taskOrder = new Map(
		validated.tasks.map((task, index) => [task.id, index]),
	);
	const dependents = new Map<string, string[]>();
	const remainingDependencies = new Map<string, number>();
	const layersByTask = new Map<string, number>();
	const edges: TaskPlanEdge[] = [];
	for (const task of validated.tasks) {
		remainingDependencies.set(task.id, task.dependencies.length);
		for (const dependency of task.dependencies) {
			const current = dependents.get(dependency) ?? [];
			current.push(task.id);
			dependents.set(dependency, current);
			edges.push({ from: dependency, to: task.id });
		}
	}
	const ready = validated.tasks.flatMap((task) =>
		task.dependencies.length === 0 ? [task.id] : [],
	);
	const topologicalOrder: string[] = [];
	while (ready.length > 0) {
		ready.sort(
			(left, right) => (taskOrder.get(left) ?? 0) - (taskOrder.get(right) ?? 0),
		);
		const id = ready.shift();
		if (!id) {
			break;
		}
		topologicalOrder.push(id);
		const task = validated.tasks[taskOrder.get(id) ?? -1];
		const layer =
			task?.dependencies.reduce(
				(maximum, dependency) =>
					Math.max(maximum, (layersByTask.get(dependency) ?? 0) + 1),
				0,
			) ?? 0;
		layersByTask.set(id, layer);
		for (const dependent of dependents.get(id) ?? []) {
			const remaining = (remainingDependencies.get(dependent) ?? 0) - 1;
			remainingDependencies.set(dependent, remaining);
			if (remaining === 0) {
				ready.push(dependent);
			}
		}
	}
	const layers: string[][] = [];
	for (const id of topologicalOrder) {
		const layer = layersByTask.get(id) ?? 0;
		const tasksInLayer = layers[layer] ?? [];
		tasksInLayer.push(id);
		layers[layer] = tasksInLayer;
	}
	const roots = validated.tasks.flatMap((task) =>
		task.dependencies.length === 0 ? [task.id] : [],
	);
	const leaves = validated.tasks.flatMap((task) =>
		(dependents.get(task.id) ?? []).length === 0 ? [task.id] : [],
	);
	return {
		topologicalOrder,
		layers,
		edges,
		roots,
		leaves,
		widestLayer: Math.max(0, ...layers.map((layer) => layer.length)),
	};
}

export function topologicalTaskIds(plan: TaskPlan): string[] {
	return analyzeTaskPlan(plan).topologicalOrder;
}
