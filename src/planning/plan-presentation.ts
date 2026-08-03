import { analyzeTaskPlan, type PlanValidationIssue } from "../domain/dag.js";
import { formatCommand } from "../domain/command-format.js";
import { readWorkflowPlanDocument } from "../domain/plan-translation.js";
import {
	type StepDefinition,
	stepCapabilities,
	stepPathLocks,
	stepResourceLocks,
	stepRetryPolicy,
	topologicalStepIds,
	type WorkflowPlan,
} from "../domain/steps.js";
import type {
	OrchestrationRun,
	PlanRevision,
	RunSecurityPolicy,
	TaskPlan,
	ValidationCommand,
} from "../domain/types.js";
import {
	capabilityProfileFor,
	describeCapabilityProfile,
	EXTERNAL_EFFECT_BOUNDARY,
	narrowCapabilityProfile,
	stepCapabilityProfile,
} from "../security/capabilities.js";
import {
	authorityEnvelopeLines,
	envelopeFromApprovedRun,
} from "../security/envelope.js";
import { securityPolicyLines } from "../security/policy.js";

export { formatCommand };

export function formatValidationIssues(issues: PlanValidationIssue[]): string {
	return issues
		.map(
			(issue, index) =>
				`${index + 1}. [${issue.code}] ${issue.path}: ${issue.message.replace(`${issue.path} `, "")}`,
		)
		.join("\n");
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

function stepPaths(step: StepDefinition): string[] {
	return step.kind === "change" ? step.allowedPaths : stepPathLocks(step);
}

function stepChecks(step: StepDefinition): ValidationCommand[] {
	switch (step.kind) {
		case "change":
			return step.validationCommands;
		case "command":
			return [step.command];
		default:
			return [];
	}
}

/**
 * Renders the exact per-step authority a user approves: capabilities from
 * the frozen profile snapshot, approved paths, locks, and the
 * external-effect boundary.
 */
export function renderStepAuthorityLines(
	plan: WorkflowPlan,
	policy: RunSecurityPolicy,
): string[] {
	const profiles = policy.workers.capabilityProfiles;
	const lines = plan.steps.flatMap((step) => {
		const paths = stepPaths(step);
		const profile = profiles
			? stepCapabilityProfile(profiles, step)
			: narrowCapabilityProfile(
					capabilityProfileFor(stepCapabilities(step)),
					stepCapabilities(step),
				);
		const authority = profiles
			? describeCapabilityProfile(profile)
			: `${describeCapabilityProfile(profile)} (derived; this legacy policy predates frozen profiles)`;
		const resourceLocks = stepResourceLocks(step);
		const retry = stepRetryPolicy(step);
		const limits = [
			...(step.timeoutMs !== undefined ? [`timeout ${step.timeoutMs}ms`] : []),
			...(retry.maxAttempts > 1 ? [`retry up to ${retry.maxAttempts}`] : []),
			...(resourceLocks.length > 0
				? [`resource locks: ${resourceLocks.join(", ")}`]
				: []),
		];
		return [
			`- ${step.id} (${step.title}) paths: ${paths.join(", ") || "none"}`,
			`  authority: ${step.kind} step; ${authority}`,
			...(limits.length > 0 ? [`  limits: ${limits.join(" | ")}`] : []),
			...stepChecks(step).map(
				(command) => `  check: ${formatCommand(command)}`,
			),
		];
	});
	return [...lines, EXTERNAL_EFFECT_BOUNDARY];
}

export function renderApprovalSummary(run: OrchestrationRun): string {
	const plan = readWorkflowPlanDocument(run.plan);
	const orderedStepIds = topologicalStepIds(plan);
	const layerByStep = new Map<string, number>();
	for (const stepId of orderedStepIds) {
		const step = plan.steps.find((candidate) => candidate.id === stepId);
		layerByStep.set(
			stepId,
			Math.max(
				0,
				...(step?.dependencies ?? []).map(
					(dependency) => (layerByStep.get(dependency) ?? 0) + 1,
				),
			),
		);
	}
	const layers: string[][] = [];
	for (const stepId of orderedStepIds) {
		const layer = layerByStep.get(stepId) ?? 0;
		const steps = layers[layer] ?? [];
		steps.push(stepId);
		layers[layer] = steps;
	}
	const dependencyCount = plan.steps.reduce(
		(total, step) => total + step.dependencies.length,
		0,
	);
	const pathCount = new Set(
		plan.steps.flatMap((step) =>
			step.kind === "change" ? step.allowedPaths : [],
		),
	).size;
	const focusedCommandCount = plan.steps.reduce(
		(total, step) =>
			total + (step.kind === "change" ? step.validationCommands.length : 0),
		0,
	);
	const layerPreview = layers
		.slice(0, 6)
		.map((layer, index) => `${index + 1}: ${layer.join(", ")}`)
		.join(" | ");
	const stepAuthority = renderStepAuthorityLines(plan, run.securityPolicy);
	const finalCommands = plan.finalValidationCommands.map(
		(command) => `- ${formatCommand(command)}`,
	);
	return [
		`Run ${run.id}: ${plan.title}`,
		`Plan revision: ${run.planRevision} | Tasks: ${plan.steps.length} | Dependencies: ${dependencyCount}`,
		`DAG layers: ${layerPreview}`,
		`Worker limit: ${run.maxConcurrentWorkers} | Approved paths: ${pathCount} | Focused checks: ${focusedCommandCount}`,
		`Integration branch: ${run.integrationBranch}`,
		// The objective-level authority this approval grants. Today it is read
		// back from the plan the user is approving; once the envelope is
		// approved first, the step authority below derives from it instead.
		"Authority envelope:",
		...authorityEnvelopeLines(envelopeFromApprovedRun(run)),
		"Step authority:",
		...stepAuthority,
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
		"Only orchestrator metadata has been persisted. No Git refs, worktrees, workers, or validation commands have started.",
	].join("\n");
}
