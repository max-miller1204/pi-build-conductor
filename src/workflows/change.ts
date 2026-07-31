import { translateLegacyTaskPlan } from "../domain/plan-translation.js";
import { validateWorkflowPlan, type WorkflowPlan } from "../domain/steps.js";
import {
	REVIEW_CATEGORIES,
	type RunSecurityPolicy,
	type TaskPlan,
} from "../domain/types.js";
import type { StepHandler } from "../engine/handlers.js";
import { ChangeStepHandler } from "../engine/steps/change.js";
import { RepairStepHandler } from "../engine/steps/repair.js";
import { ReviewStepHandler, reviewStepId } from "../engine/steps/review.js";
import type { StepWorkerRunner } from "../engine/steps/worker-runner.js";
import type { GitClient } from "../git/git.js";
import type { TaskValidator } from "../validation/task-validator.js";

export const REVIEW_FINDINGS_OUTPUT = "findings";
export const REPAIR_EVIDENCE_OUTPUT = "evidence";

/**
 * How many bounded repair passes the strict change workflow allows, matching
 * the legacy lifecycle's budget. Every pass is followed by another review
 * round, so the last round always reviews the final integrated head.
 */
export const CHANGE_WORKFLOW_REPAIR_ROUNDS = 2;

export function repairStepId(round: number): string {
	return `repair-${round}`;
}

export { reviewStepId };

function reviewRoundStepIds(round: number): string[] {
	return REVIEW_CATEGORIES.map((category) => reviewStepId(round, category));
}

function reviewRoundSteps(
	round: number,
	dependencies: string[],
): Record<string, unknown>[] {
	// Round 1 reviews the integrated change steps. Every later round reviews
	// what the repair before it changed, and reads that round's findings so it
	// can adopt them unchanged when the repair committed nothing.
	const previous = round > 1 ? round - 1 : undefined;
	return REVIEW_CATEGORIES.map((category) => ({
		kind: "investigation",
		id: reviewStepId(round, category),
		title: `Independent ${category} review (round ${round})`,
		description: `Review the complete integrated result for ${category} problems and report structured findings.`,
		dependencies:
			previous === undefined
				? dependencies
				: [...dependencies, reviewStepId(previous, category)],
		profile: "review",
		questions: [
			`Which ${category} problems does the integrated result contain?`,
		],
		...(previous === undefined
			? {}
			: {
					inputs: [
						{
							stepId: reviewStepId(previous, category),
							output: REVIEW_FINDINGS_OUTPUT,
						},
					],
				}),
		outputs: [REVIEW_FINDINGS_OUTPUT],
		capabilities: ["read-repository"],
	}));
}

function repairRoundStep(
	round: number,
	allowedPaths: string[],
	validationCommands: WorkflowPlan["finalValidationCommands"],
): Record<string, unknown> {
	const reviewIds = reviewRoundStepIds(round);
	return {
		kind: "change",
		id: repairStepId(round),
		title: `Repair the round ${round} review findings`,
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
		allowedPaths,
		validationCommands: validationCommands.map((command) => ({
			command: command.command,
			args: [...command.args],
		})),
	};
}

/**
 * The built-in strict change workflow: the approved task DAG as change steps,
 * then alternating rounds of one independent read-only review per category
 * over the fully integrated result and one bounded repair pass for the
 * findings the review policy requires.
 *
 * The workflow always ends on a review round, so the reviews backing
 * merge-ready evidence describe the head that would actually be merged. A
 * round whose repair changed nothing costs no workers, because each review
 * adopts the previous round's findings for the identical commit. Final
 * validation and merge-ready evidence run through `finalizeWorkflowRun` after
 * the engine settles the run.
 */
export function buildChangeWorkflowPlan(taskPlan: TaskPlan): WorkflowPlan {
	const translated = translateLegacyTaskPlan(taskPlan);
	const rounds = CHANGE_WORKFLOW_REPAIR_ROUNDS + 1;
	const reserved = new Set<string>();
	for (let round = 1; round <= rounds; round += 1) {
		for (const stepId of reviewRoundStepIds(round)) {
			reserved.add(stepId);
		}
		reserved.add(repairStepId(round));
	}
	for (const step of translated.steps) {
		if (reserved.has(step.id)) {
			throw new Error(
				`Task id ${step.id} collides with a generated workflow step; rename the task`,
			);
		}
	}
	// Every change step publishes the focused checks that justified its commit.
	// The evidence is what a later reader, and recovery after a restart, use to
	// tell validated work from a commit whose justification is unknown.
	const changeSteps = translated.steps.map((step) => ({
		...step,
		outputs: [...(step.outputs ?? []), REPAIR_EVIDENCE_OUTPUT],
	}));
	const changeIds = changeSteps.map((step) => step.id);
	const repairPaths = [
		...new Set(
			translated.steps.flatMap((step) =>
				step.kind === "change" ? step.allowedPaths : [],
			),
		),
	].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	const generated: Record<string, unknown>[] = [];
	for (let round = 1; round <= rounds; round += 1) {
		generated.push(
			...reviewRoundSteps(
				round,
				round === 1 ? [...changeIds] : [repairStepId(round - 1)],
			),
		);
		if (round < rounds) {
			generated.push(
				repairRoundStep(round, repairPaths, translated.finalValidationCommands),
			);
		}
	}
	return validateWorkflowPlan({
		version: 4,
		title: translated.title,
		steps: [...changeSteps, ...generated],
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
