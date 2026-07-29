import type { StepOutcome } from "./handlers.js";

/**
 * Whether an unsuccessful step may run again. Classification is deliberately
 * conservative about authority: cancellation and deterministic rejections are
 * never retried, and every retry still costs the step's declared budget.
 */
export type StepFailureClass = "retryable" | "terminal";

export interface StepFailureClassification {
	failureClass: StepFailureClass;
	reason: string;
}

export interface ClassifyStepFailureInput {
	outcome: Exclude<StepOutcome, { status: "succeeded" }>;
	timedOut: boolean;
	attemptNumber: number;
	maxAttempts: number;
}

export function classifyStepFailure(
	input: ClassifyStepFailureInput,
): StepFailureClassification {
	if (input.outcome.status === "cancelled") {
		return {
			failureClass: "terminal",
			reason: "the step was cancelled",
		};
	}
	if (input.outcome.retryable === false) {
		return {
			failureClass: "terminal",
			reason: "the failure cannot be resolved by running the step again",
		};
	}
	if (input.attemptNumber >= input.maxAttempts) {
		return {
			failureClass: "terminal",
			reason: `the retry budget of ${input.maxAttempts} attempt${
				input.maxAttempts === 1 ? "" : "s"
			} is exhausted`,
		};
	}
	return {
		failureClass: "retryable",
		reason: input.timedOut
			? `the step timed out with ${input.maxAttempts - input.attemptNumber} attempt(s) remaining`
			: `the step failed with ${input.maxAttempts - input.attemptNumber} attempt(s) remaining`,
	};
}
