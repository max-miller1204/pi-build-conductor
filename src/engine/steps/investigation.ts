import type { RunSecurityPolicy } from "../../domain/types.js";
import type { GitClient } from "../../git/git.js";
import { CapabilityViolationError } from "../../security/capabilities.js";
import type { StepArtifactDraft } from "../artifact-routing.js";
import type {
	StepHandler,
	StepHandlerContext,
	StepOutcome,
} from "../handlers.js";
import { assertUnchangedWorkspace } from "./outputs.js";
import { buildStepWorkerPrompt } from "./prompt.js";
import type { StepWorkerRunner } from "./worker-runner.js";

export interface InvestigationStepHandlerOptions {
	worker: StepWorkerRunner;
	git: Pick<GitClient, "status">;
	securityPolicy: RunSecurityPolicy;
	requestText?: string;
}

/**
 * Executes a read-only investigation through a Pi worker and stores its
 * answer as the step's declared report artifact. An investigation may declare
 * at most one output because it produces exactly one answer.
 */
export class InvestigationStepHandler implements StepHandler {
	readonly kind = "investigation" as const;

	constructor(private readonly options: InvestigationStepHandlerOptions) {}

	async execute(context: StepHandlerContext): Promise<StepOutcome> {
		const step = context.step;
		if (step.kind !== "investigation") {
			return {
				status: "failed",
				error: `Investigation handler received a ${step.kind} step`,
				retryable: false,
			};
		}
		// The output name is free because an investigation answer is a report
		// whatever the plan chose to call it, but there is only ever one answer.
		const outputs = step.outputs ?? [];
		if (outputs.length > 1) {
			return {
				status: "failed",
				error: `Investigation step ${step.id} may declare at most one output; it declared ${outputs.join(", ")}`,
				retryable: false,
			};
		}
		const result = await this.options.worker.run({
			runId: context.runId,
			stepId: step.id,
			attemptId: context.attempt.id,
			role: "review",
			profile: context.capabilityProfile,
			cwd: context.workspace.path,
			prompt: buildStepWorkerPrompt({
				runId: context.runId,
				step,
				context: context.execution,
				profile: context.capabilityProfile,
				securityPolicy: this.options.securityPolicy,
				...(this.options.requestText === undefined
					? {}
					: { requestText: this.options.requestText }),
			}),
			signal: context.signal,
		});
		if (result.status !== "succeeded") {
			return result.status === "cancelled"
				? { status: "cancelled", error: result.error }
				: { status: "failed", error: result.error };
		}
		try {
			await assertUnchangedWorkspace(
				this.options.git,
				context.capabilityProfile,
				context.workspace,
			);
		} catch (error) {
			return {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				retryable: !(error instanceof CapabilityViolationError),
			};
		}
		const answer = result.output ?? "";
		const output = outputs[0];
		if (output && answer.trim().length === 0) {
			return {
				status: "failed",
				error: `Investigation step ${step.id} produced no answer for output ${output}`,
			};
		}
		const artifacts: StepArtifactDraft[] = output
			? [
					{
						output,
						kind: "report",
						title: step.title,
						payload: { format: "text", text: answer },
					},
				]
			: [];
		return {
			status: "succeeded",
			summary: answer.slice(0, 500),
			...(artifacts.length > 0 ? { artifacts } : {}),
		};
	}
}
