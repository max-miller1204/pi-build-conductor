import { analyzeTaskPlan, type PlanValidationIssue } from "../domain/dag.js";
import type {
	BuildRun,
	PlanRevision,
	TaskPlan,
	ValidationCommand,
} from "../domain/types.js";
import { securityPolicyLines } from "../security/policy.js";

const SIMPLE_ARGUMENT = /^[A-Za-z0-9_./:@%+=,-]+$/;

export function formatValidationIssues(issues: PlanValidationIssue[]): string {
	return issues
		.map(
			(issue, index) =>
				`${index + 1}. [${issue.code}] ${issue.path}: ${issue.message.replace(`${issue.path} `, "")}`,
		)
		.join("\n");
}

function quoteArgument(value: string): string {
	return value.length > 0 && SIMPLE_ARGUMENT.test(value)
		? value
		: JSON.stringify(value);
}

export function formatCommand(command: ValidationCommand): string {
	return [command.command, ...command.args].map(quoteArgument).join(" ");
}

export function renderDagOverview(plan: TaskPlan): string {
	const analysis = analyzeTaskPlan(plan);
	const layerLines = analysis.layers.map(
		(layer, index) => `Layer ${index + 1}: ${layer.join("  |  ")}`,
	);
	const edgeLines =
		analysis.edges.length > 0
			? analysis.edges.map((edge) => `${edge.from} -> ${edge.to}`).join(", ")
			: "none";
	return [
		`${plan.title} - ${plan.tasks.length} task(s), ${analysis.layers.length} layer(s), ${analysis.edges.length} edge(s)`,
		...layerLines,
		`Edges: ${edgeLines}`,
		`Roots: ${analysis.roots.join(", ")} | Leaves: ${analysis.leaves.join(", ")}`,
	].join("\n");
}

export function renderPlanDetails(plan: TaskPlan): string {
	return plan.tasks
		.map((task, index) => {
			const dependencies = task.dependencies.join(", ") || "none";
			return [
				`${index + 1}. ${task.title} (${task.id})`,
				`   depends on: ${dependencies}`,
				`   paths: ${task.allowedPaths.join(", ")}`,
				`   checks: ${task.validationCommands.map(formatCommand).join("; ")}`,
			].join("\n");
		})
		.join("\n");
}

export function diffPlanRevisions(
	previous: PlanRevision,
	current: PlanRevision,
): string {
	const previousTasks = new Set(previous.plan.tasks.map((task) => task.id));
	const currentTasks = new Set(current.plan.tasks.map((task) => task.id));
	const added = [...currentTasks].filter((task) => !previousTasks.has(task));
	const removed = [...previousTasks].filter((task) => !currentTasks.has(task));
	const changed = current.plan.tasks.flatMap((task) => {
		const oldTask = previous.plan.tasks.find((item) => item.id === task.id);
		return oldTask && JSON.stringify(oldTask) !== JSON.stringify(task)
			? [task.id]
			: [];
	});
	return [
		`Revision ${previous.number} -> ${current.number}`,
		`Added: ${added.join(", ") || "none"}`,
		`Removed: ${removed.join(", ") || "none"}`,
		`Changed: ${changed.join(", ") || "none"}`,
		`Workers: ${previous.maxConcurrentWorkers} -> ${current.maxConcurrentWorkers}`,
	].join("\n");
}

export function renderApprovalSummary(run: BuildRun): string {
	const analysis = analyzeTaskPlan(run.plan);
	const pathCount = new Set(run.plan.tasks.flatMap((task) => task.allowedPaths))
		.size;
	const focusedCommandCount = run.plan.tasks.reduce(
		(total, task) => total + task.validationCommands.length,
		0,
	);
	const layerPreview = analysis.layers
		.slice(0, 6)
		.map((layer, index) => `${index + 1}: ${layer.join(", ")}`)
		.join(" | ");
	const taskAuthority = run.plan.tasks.flatMap((task) => [
		`- ${task.id} (${task.title}) paths: ${task.allowedPaths.join(", ")}`,
		...task.validationCommands.map(
			(command) => `  check: ${formatCommand(command)}`,
		),
	]);
	const finalCommands = run.plan.finalValidationCommands.map(
		(command) => `- ${formatCommand(command)}`,
	);
	return [
		`Run ${run.id}: ${run.plan.title}`,
		`Plan revision: ${run.planRevision} | Tasks: ${run.plan.tasks.length} | Dependencies: ${analysis.edges.length}`,
		`DAG layers: ${layerPreview}`,
		`Worker limit: ${run.maxConcurrentWorkers} | Approved paths: ${pathCount} | Focused checks: ${focusedCommandCount}`,
		`Integration branch: ${run.integrationBranch}`,
		"Task authority:",
		...taskAuthority,
		"Final validation:",
		...finalCommands,
		"Security boundary:",
		...securityPolicyLines(run.securityPolicy),
		"After approval: create worktree-isolated workers, integrate validated commits, run five independent reviews and repairs, then run final validation.",
		...(run.securityPolicy.validation.sandbox === "none"
			? [
					"WARNING: validation executes untrusted repository code without an OS sandbox.",
				]
			: []),
		"Prompt instructions and post-run diff checks cannot prevent host or external side effects.",
		"Merge-ready evidence proves recorded Git and validation state, not the absence of external side effects.",
		"Only conductor metadata has been persisted. No Git refs, worktrees, workers, or validation commands have started.",
	].join("\n");
}
