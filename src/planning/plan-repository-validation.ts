import type { TaskDefinition, TaskPlan } from "../domain/types.js";
import type { DetectedValidationCommand } from "./repository-discovery.js";

export type PlanRepositoryIssueSeverity = "error" | "warning";

export type PlanRepositoryIssueCode =
	| "unknown_path"
	| "undetected_command"
	| "conflicting_mutation_scopes";

/** One repository-level plan issue: schema-valid but wrong for this repo. */
export interface PlanRepositoryIssue {
	severity: PlanRepositoryIssueSeverity;
	code: PlanRepositoryIssueCode;
	message: string;
	/** The tasks involved; empty for final-validation issues. */
	taskIds: string[];
}

export interface PlanRepositoryValidationResult {
	/** True when no error-severity issue exists; warnings do not block. */
	ok: boolean;
	issues: PlanRepositoryIssue[];
}

export interface PlanRepositoryValidationInput {
	/** Every tracked file path at the commit the plan will execute against. */
	paths: readonly string[];
	detectedCommands: readonly DetectedValidationCommand[];
}

function directoriesOf(paths: readonly string[]): Set<string> {
	const directories = new Set<string>();
	for (const path of paths) {
		let separator = path.indexOf("/");
		while (separator > 0) {
			directories.add(path.slice(0, separator));
			separator = path.indexOf("/", separator + 1);
		}
	}
	return directories;
}

/**
 * True when the two approved path scopes can touch the same file: equal
 * paths, or one path inside the other's directory scope.
 */
export function mutationScopesOverlap(left: string, right: string): boolean {
	if (left === right) {
		return true;
	}
	return (
		(left.endsWith("/") && right.startsWith(left)) ||
		(right.endsWith("/") && left.startsWith(right))
	);
}

function reachabilityFrom(
	tasks: readonly TaskDefinition[],
): Map<string, Set<string>> {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const reachable = new Map<string, Set<string>>();
	const visit = (id: string): Set<string> => {
		const existing = reachable.get(id);
		if (existing) {
			return existing;
		}
		// The schema validator already rejected cycles, so this terminates.
		const collected = new Set<string>();
		reachable.set(id, collected);
		for (const dependency of byId.get(id)?.dependencies ?? []) {
			collected.add(dependency);
			for (const transitive of visit(dependency)) {
				collected.add(transitive);
			}
		}
		return collected;
	};
	for (const task of tasks) {
		visit(task.id);
	}
	return reachable;
}

function validateTaskPaths(
	task: TaskDefinition,
	files: ReadonlySet<string>,
	directories: ReadonlySet<string>,
	issues: PlanRepositoryIssue[],
): void {
	for (const path of task.allowedPaths) {
		if (path.endsWith("/")) {
			if (!directories.has(path.slice(0, -1))) {
				issues.push({
					severity: "error",
					code: "unknown_path",
					message: `task ${task.id} allows directory ${path} which does not exist at the planned commit`,
					taskIds: [task.id],
				});
			}
			continue;
		}
		if (files.has(path)) {
			continue;
		}
		const separator = path.lastIndexOf("/");
		const parent = separator < 0 ? undefined : path.slice(0, separator);
		if (parent !== undefined && !directories.has(parent)) {
			issues.push({
				severity: "error",
				code: "unknown_path",
				message: `task ${task.id} allows ${path}, but neither the file nor its parent directory ${parent}/ exists at the planned commit`,
				taskIds: [task.id],
			});
		}
	}
}

function validateCommands(
	plan: TaskPlan,
	detectedCommands: readonly DetectedValidationCommand[],
	issues: PlanRepositoryIssue[],
): void {
	const detectedBinaries = new Set(
		detectedCommands.map((command) => command.command),
	);
	const usage = new Map<string, Set<string>>();
	const record = (binary: string, scope: string): void => {
		const scopes = usage.get(binary) ?? new Set<string>();
		scopes.add(scope);
		usage.set(binary, scopes);
	};
	for (const task of plan.tasks) {
		for (const command of task.validationCommands) {
			record(command.command, task.id);
		}
	}
	for (const command of plan.finalValidationCommands) {
		record(command.command, "final validation");
	}
	for (const [binary, scopes] of usage) {
		if (detectedBinaries.has(binary)) {
			continue;
		}
		const taskIds = [...scopes].filter((scope) => scope !== "final validation");
		issues.push({
			severity: "warning",
			code: "undetected_command",
			message: `command ${binary} (used by ${[...scopes].sort().join(", ")}) is not among the commands detected in the repository; verify the repository actually defines it`,
			taskIds: taskIds.sort(),
		});
	}
}

function validateMutationScopes(
	plan: TaskPlan,
	issues: PlanRepositoryIssue[],
): void {
	const reachable = reachabilityFrom(plan.tasks);
	for (const [leftIndex, left] of plan.tasks.entries()) {
		for (const right of plan.tasks.slice(leftIndex + 1)) {
			if (
				reachable.get(left.id)?.has(right.id) ||
				reachable.get(right.id)?.has(left.id)
			) {
				continue;
			}
			const overlaps: string[] = [];
			for (const leftPath of left.allowedPaths) {
				for (const rightPath of right.allowedPaths) {
					if (mutationScopesOverlap(leftPath, rightPath)) {
						overlaps.push(`${leftPath} vs ${rightPath}`);
					}
				}
			}
			if (overlaps.length > 0) {
				issues.push({
					severity: "error",
					code: "conflicting_mutation_scopes",
					message: `tasks ${left.id} and ${right.id} may run concurrently (no dependency orders them) but their allowed paths overlap: ${overlaps.join("; ")}`,
					taskIds: [left.id, right.id],
				});
			}
		}
	}
}

/**
 * Validates a schema-valid plan against the actual repository: every
 * selected path must exist (or be a new file in an existing directory),
 * commands should come from detected repository commands, and tasks that no
 * dependency orders must not share mutation scopes, because independent
 * ready tasks execute concurrently.
 */
export function validatePlanAgainstRepository(
	plan: TaskPlan,
	input: PlanRepositoryValidationInput,
): PlanRepositoryValidationResult {
	const issues: PlanRepositoryIssue[] = [];
	const files = new Set(input.paths);
	const directories = directoriesOf(input.paths);
	for (const task of plan.tasks) {
		validateTaskPaths(task, files, directories, issues);
	}
	validateCommands(plan, input.detectedCommands, issues);
	validateMutationScopes(plan, issues);
	return {
		ok: !issues.some((issue) => issue.severity === "error"),
		issues,
	};
}

/** Renders repository validation issues as bounded display lines. */
export function renderPlanRepositoryIssues(
	issues: readonly PlanRepositoryIssue[],
): string[] {
	return issues.map(
		(issue) => `- [${issue.severity}] ${issue.code}: ${issue.message}`,
	);
}
