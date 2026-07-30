import { validateWorkflowPlan, type WorkflowPlan } from "../domain/steps.js";
import type { StepHandler } from "../engine/handlers.js";
import {
	InvestigationStepHandler,
	type InvestigationStepHandlerOptions,
} from "../engine/steps/investigation.js";
import { workflowTitleFromRequest } from "./plan-only.js";

export const INVESTIGATE_REPORT_OUTPUT = "report";
export const SYNTHESIS_STEP_ID = "synthesize-findings";
export const MAX_INVESTIGATION_QUESTIONS = 4 as const;
export const MAX_INVESTIGATION_QUESTION_CHARS = 500 as const;

export function investigationStepId(index: number): string {
	return `investigate-${index + 1}`;
}

/**
 * Derives the investigation questions from free request text: every
 * non-empty line ending in a question mark, or the whole request as one
 * question when it asks nothing explicitly.
 */
export function investigationQuestionsFromRequest(
	requestText: string,
): string[] {
	const lines = requestText
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const questions = lines.filter((line) => line.endsWith("?"));
	if (questions.length === 0) {
		const fallback = lines.join(" ");
		return fallback.length > 0
			? [fallback.slice(0, MAX_INVESTIGATION_QUESTION_CHARS)]
			: [];
	}
	return questions
		.slice(0, MAX_INVESTIGATION_QUESTIONS)
		.map((question) => question.slice(0, MAX_INVESTIGATION_QUESTION_CHARS));
}

export interface InvestigateWorkflowInput {
	requestText: string;
	/** One read-only investigation per question, at most four. */
	questions: string[];
}

/**
 * The built-in read-only investigate workflow: one investigation step per
 * question running concurrently where worker slots allow, then one synthesis
 * step that reads every report artifact and answers the original request.
 * Nothing mutates the repository and no final validation applies.
 */
export function buildInvestigateWorkflowPlan(
	input: InvestigateWorkflowInput,
): WorkflowPlan {
	const questions = input.questions.map((question) => question.trim());
	if (
		questions.length === 0 ||
		questions.length > MAX_INVESTIGATION_QUESTIONS
	) {
		throw new Error(
			`An investigate workflow needs 1 to ${MAX_INVESTIGATION_QUESTIONS} questions, received ${questions.length}`,
		);
	}
	for (const question of questions) {
		if (
			question.length === 0 ||
			question.length > MAX_INVESTIGATION_QUESTION_CHARS
		) {
			throw new Error(
				`Every investigation question must be 1 to ${MAX_INVESTIGATION_QUESTION_CHARS} characters`,
			);
		}
	}
	const investigationIds = questions.map((_question, index) =>
		investigationStepId(index),
	);
	return validateWorkflowPlan({
		version: 4,
		title: workflowTitleFromRequest("Investigate", input.requestText),
		steps: [
			...questions.map((question, index) => ({
				kind: "investigation",
				id: investigationStepId(index),
				title: `Investigate: ${question.slice(0, 80)}`,
				description: `Answer this question from repository evidence: ${question}`,
				dependencies: [],
				questions: [question],
				outputs: [INVESTIGATE_REPORT_OUTPUT],
				capabilities: ["read-repository"],
			})),
			{
				kind: "investigation",
				id: SYNTHESIS_STEP_ID,
				title: "Synthesize the investigation findings",
				description:
					"Combine every upstream investigation report into one coherent answer to the original request, reconciling contradictions and stating what remains uncertain.",
				dependencies: investigationIds,
				inputs: investigationIds.map((stepId) => ({
					stepId,
					output: INVESTIGATE_REPORT_OUTPUT,
				})),
				questions: [
					"What is the complete, evidence-backed answer to the original request, based on the upstream investigation reports?",
				],
				outputs: [INVESTIGATE_REPORT_OUTPUT],
				capabilities: ["read-repository"],
			},
		],
	});
}

/** The handler set the investigate workflow needs on the engine. */
export function investigateStepHandlers(
	options: InvestigationStepHandlerOptions,
): StepHandler[] {
	return [new InvestigationStepHandler(options)];
}
