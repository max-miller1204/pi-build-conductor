import type {
	RunSecurityPolicy,
	ValidationCheckEvidence,
} from "../../domain/types.js";
import type { GitClient } from "../../git/git.js";
import { CapabilityViolationError } from "../../security/capabilities.js";
import { executeValidationCommand } from "../../validation/command-runner.js";
import type { StepArtifactDraft } from "../artifact-routing.js";
import type {
	StepHandler,
	StepHandlerContext,
	StepOutcome,
} from "../handlers.js";
import { assertSupportedOutputs, assertUnchangedWorkspace } from "./outputs.js";

export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;
export const DEFAULT_OUTPUT_TAIL_BYTES = 64 * 1024;

/** The outputs a command step may declare. */
export const COMMAND_STEP_OUTPUTS = ["evidence"] as const;

export interface CommandStepHandlerOptions {
	git: Pick<GitClient, "status">;
	securityPolicy: RunSecurityPolicy;
	now?: () => string;
	commandTimeoutMs?: number;
	outputTailBytes?: number;
}

/**
 * Runs one declared command inside the step's workspace under the run's
 * recorded validation boundary. No model is involved, and the command must
 * leave the repository exactly as it found it.
 */
export class CommandStepHandler implements StepHandler {
	readonly kind = "command" as const;
	private readonly now: () => string;
	private readonly commandTimeoutMs: number;
	private readonly outputTailBytes: number;

	constructor(private readonly options: CommandStepHandlerOptions) {
		this.now = options.now ?? (() => new Date().toISOString());
		this.commandTimeoutMs =
			options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
		this.outputTailBytes = options.outputTailBytes ?? DEFAULT_OUTPUT_TAIL_BYTES;
		if (!Number.isFinite(this.commandTimeoutMs) || this.commandTimeoutMs <= 0) {
			throw new Error("commandTimeoutMs must be a positive finite number");
		}
		if (!Number.isInteger(this.outputTailBytes) || this.outputTailBytes <= 0) {
			throw new Error("outputTailBytes must be a positive integer");
		}
	}

	async execute(context: StepHandlerContext): Promise<StepOutcome> {
		const step = context.step;
		if (step.kind !== "command") {
			return {
				status: "failed",
				error: `Command handler received a ${step.kind} step`,
				retryable: false,
			};
		}
		try {
			assertSupportedOutputs(step, COMMAND_STEP_OUTPUTS);
		} catch (error) {
			return {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				retryable: false,
			};
		}
		if (!context.capabilityProfile.capabilities.includes("execute-commands")) {
			const error = new CapabilityViolationError(
				`Command step ${step.id} cannot execute without the execute-commands capability (approved: ${context.capabilityProfile.capabilities.join(", ") || "none"})`,
			);
			return { status: "failed", error: error.message, retryable: false };
		}
		const startedAt = this.now();
		const result = await executeValidationCommand(
			step.command,
			context.workspace.path,
			context.signal,
			this.commandTimeoutMs,
			this.outputTailBytes,
			this.options.securityPolicy.validation,
		);
		const check: ValidationCheckEvidence = {
			command: step.command.command,
			args: [...step.command.args],
			startedAt,
			finishedAt: this.now(),
			exitCode: result.exitCode,
			stdoutTail: result.stdoutTail,
			stderrTail: result.stderrTail,
			passed: result.exitCode === 0 && !result.timedOut && !result.aborted,
			executionBoundary: result.executionBoundary,
		};
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
		if (result.aborted) {
			return {
				status: "cancelled",
				error: result.stderrTail || `Command step ${step.id} was cancelled`,
			};
		}
		const artifacts: StepArtifactDraft[] = (step.outputs ?? []).map(
			(output) => ({
				output,
				kind: "test-evidence",
				title: `${step.title} command evidence`,
				payload: {
					format: "json",
					value: {
						startedAt,
						finishedAt: check.finishedAt,
						passed: check.passed,
						checks: [check],
					},
				},
			}),
		);
		if (!check.passed) {
			return {
				status: "failed",
				error: `${step.command.command} ${step.command.args.join(" ")} exited with ${
					result.timedOut ? "a timeout" : `code ${String(result.exitCode)}`
				}: ${check.stderrTail || check.stdoutTail || "no output"}`,
			};
		}
		return {
			status: "succeeded",
			summary: `${step.command.command} ${step.command.args.join(" ")} passed`,
			...(artifacts.length > 0 ? { artifacts } : {}),
		};
	}
}
