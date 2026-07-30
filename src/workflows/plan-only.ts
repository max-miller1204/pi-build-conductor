import { validateWorkflowPlan, type WorkflowPlan } from "../domain/steps.js";
import type { StepHandler } from "../engine/handlers.js";
import {
	PlanningStepHandler,
	type PlanningStepHandlerOptions,
} from "../engine/steps/planning.js";

export const PLAN_ONLY_STEP_ID = "propose-plan";
export const PLAN_ONLY_PLAN_OUTPUT = "plan-document";

const MAX_WORKFLOW_TITLE_CHARS = 120;

/** Derives a bounded single-line workflow title from free request text. */
export function workflowTitleFromRequest(
	prefix: string,
	requestText: string,
): string {
	const firstLine =
		requestText
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "untitled request";
	const title = `${prefix}: ${firstLine}`;
	return title.length > MAX_WORKFLOW_TITLE_CHARS
		? `${title.slice(0, MAX_WORKFLOW_TITLE_CHARS - 1)}…`
		: title;
}

/**
 * The built-in plan-only workflow: one read-only planning step that inspects
 * the repository and publishes an evidence-backed plan document for later
 * approval, without any repository mutation or final validation burden.
 */
export function buildPlanOnlyWorkflowPlan(requestText: string): WorkflowPlan {
	return validateWorkflowPlan({
		version: 4,
		title: workflowTitleFromRequest("Plan only", requestText),
		steps: [
			{
				kind: "investigation",
				id: PLAN_ONLY_STEP_ID,
				title: "Propose an evidence-backed task plan",
				description:
					"Inspect the repository read-only and propose an evidence-backed task DAG for approval. The proposed plan is published as a decision artifact and nothing is executed.",
				dependencies: [],
				questions: [
					"What is the smallest dependency-ordered task DAG that fulfils the request, and what repository evidence supports it?",
				],
				outputs: [PLAN_ONLY_PLAN_OUTPUT],
				capabilities: ["read-repository"],
			},
		],
	});
}

/** The handler set the plan-only workflow needs on the engine. */
export function planOnlyStepHandlers(
	options: PlanningStepHandlerOptions,
): StepHandler[] {
	return [new PlanningStepHandler(options)];
}
