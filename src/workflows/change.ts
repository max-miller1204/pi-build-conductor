import { translateLegacyTaskPlan } from "../domain/plan-translation.js";
import { validateWorkflowPlan, type WorkflowPlan } from "../domain/steps.js";
import {
	REVIEW_CATEGORIES,
	type ReviewCategory,
	type RunSecurityPolicy,
	type TaskPlan,
} from "../domain/types.js";
import type { StepHandler } from "../engine/handlers.js";
import { ChangeStepHandler } from "../engine/steps/change.js";
import { RepairStepHandler } from "../engine/steps/repair.js";
import { ReviewStepHandler } from "../engine/steps/review.js";
import type { StepWorkerRunner } from "../engine/steps/worker-runner.js";
import type { GitClient } from "../git/git.js";
import type { TaskValidator } from "../validation/task-validator.js";

export const REPAIR_STEP_ID = "repair-findings";
export const REVIEW_FINDINGS_OUTPUT = "findings";
export const REPAIR_EVIDENCE_OUTPUT = "evidence";

export function reviewStepId(category: ReviewCategory): string {
	return `review-${category}`;
}

/**
 * The built-in strict change workflow: the approved task DAG as change
 * steps, one independent read-only review per category over the fully
 * integrated result, and one bounded repair pass for the findings the
 * review policy requires. Final validation and merge-ready evidence run
 * through `finalizeWorkflowRun` after the engine settles the run.
 */
export function buildChangeWorkflowPlan(taskPlan: TaskPlan): WorkflowPlan {
	const translated = translateLegacyTaskPlan(taskPlan);
	const reserved = new Set<string>([
		...REVIEW_CATEGORIES.map((category) => reviewStepId(category)),
		REPAIR_STEP_ID,
	]);
	for (const step of translated.steps) {
		if (reserved.has(step.id)) {
			throw new Error(
				`Task id ${step.id} collides with a generated workflow step; rename the task`,
			);
		}
	}
	const changeIds = translated.steps.map((step) => step.id);
	const repairPaths = [
		...new Set(
			translated.steps.flatMap((step) =>
				step.kind === "change" ? step.allowedPaths : [],
			),
		),
	].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	const reviewIds = REVIEW_CATEGORIES.map((category) => reviewStepId(category));
	return validateWorkflowPlan({
		version: 4,
		title: translated.title,
		steps: [
			...translated.steps,
			...REVIEW_CATEGORIES.map((category) => ({
				kind: "investigation",
				id: reviewStepId(category),
				title: `Independent ${category} review`,
				description: `Review the complete integrated result for ${category} problems and report structured findings.`,
				dependencies: [...changeIds],
				profile: "review",
				questions: [
					`Which ${category} problems does the integrated result contain?`,
				],
				outputs: [REVIEW_FINDINGS_OUTPUT],
				capabilities: ["read-repository"],
			})),
			{
				kind: "change",
				id: REPAIR_STEP_ID,
				title: "Repair the review findings",
				description:
					"Apply fixes for the prioritized repair-required findings from the independent reviews. A round with nothing to repair succeeds without touching the repository.",
				dependencies: reviewIds,
				profile: "repair",
				inputs: reviewIds.map((stepId) => ({
					stepId,
					output: REVIEW_FINDINGS_OUTPUT,
				})),
				outputs: [REPAIR_EVIDENCE_OUTPUT],
				acceptanceCriteria: [
					"Every repair-required finding is addressed or explicitly reported as unrepairable",
				],
				allowedPaths: repairPaths,
				validationCommands: translated.finalValidationCommands.map(
					(command) => ({ command: command.command, args: [...command.args] }),
				),
			},
		],
		finalValidationCommands: translated.finalValidationCommands,
	});
}

export interface ChangeWorkflowHandlerOptions {
	worker: StepWorkerRunner;
	validator: TaskValidator;
	git: Pick<GitClient, "commitTaskWork" | "status">;
	securityPolicy: RunSecurityPolicy;
	requestText?: string;
}

/** The handler set the strict change workflow needs on the engine. */
export function changeWorkflowStepHandlers(
	options: ChangeWorkflowHandlerOptions,
): StepHandler[] {
	const requestText =
		options.requestText === undefined
			? {}
			: { requestText: options.requestText };
	const change = {
		worker: options.worker,
		validator: options.validator,
		git: options.git,
		securityPolicy: options.securityPolicy,
		...requestText,
	};
	return [
		new ChangeStepHandler(change),
		new ReviewStepHandler({
			worker: options.worker,
			git: options.git,
			securityPolicy: options.securityPolicy,
			...requestText,
		}),
		new RepairStepHandler(change),
	];
}
