import type {
	FinalValidationEvidence,
	ValidationCheckEvidence,
	ValidationCommand,
} from "../domain/types.js";
import type { GitClient } from "../git/git.js";
import { executeValidationCommand } from "./command-runner.js";

const DEFAULT_FINAL_VALIDATION_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_OUTPUT_TAIL_BYTES = 64 * 1024;

export interface FinalValidationInput {
	worktreePath: string;
	integrationCommit: string;
	commands: ValidationCommand[];
	signal?: AbortSignal;
}

export interface FinalValidator {
	validate(input: FinalValidationInput): Promise<FinalValidationEvidence>;
}

export interface LocalFinalValidatorOptions {
	now?: () => string;
	commandTimeoutMs?: number;
	outputTailBytes?: number;
}

export class FinalValidationError extends Error {
	constructor(
		message: string,
		readonly evidence: FinalValidationEvidence,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "FinalValidationError";
	}
}

export class LocalFinalValidator implements FinalValidator {
	private readonly now: () => string;
	private readonly commandTimeoutMs: number;
	private readonly outputTailBytes: number;

	constructor(
		private readonly git: GitClient,
		options: LocalFinalValidatorOptions = {},
	) {
		this.now = options.now ?? (() => new Date().toISOString());
		this.commandTimeoutMs =
			options.commandTimeoutMs ?? DEFAULT_FINAL_VALIDATION_TIMEOUT_MS;
		this.outputTailBytes = options.outputTailBytes ?? DEFAULT_OUTPUT_TAIL_BYTES;
		if (!Number.isFinite(this.commandTimeoutMs) || this.commandTimeoutMs <= 0) {
			throw new Error("commandTimeoutMs must be a positive finite number");
		}
		if (!Number.isInteger(this.outputTailBytes) || this.outputTailBytes <= 0) {
			throw new Error("outputTailBytes must be a positive integer");
		}
	}

	async validate(
		input: FinalValidationInput,
	): Promise<FinalValidationEvidence> {
		const startedAt = this.now();
		const checks: ValidationCheckEvidence[] = [];
		try {
			await this.git.verifyDetachedWorktree(
				input.worktreePath,
				input.integrationCommit,
			);
		} catch (error) {
			throw this.failure(
				startedAt,
				checks,
				"Final validation worktree is not clean at the expected commit",
				error,
			);
		}
		for (const command of input.commands) {
			const commandStartedAt = this.now();
			const result = await executeValidationCommand(
				command,
				input.worktreePath,
				input.signal,
				this.commandTimeoutMs,
				this.outputTailBytes,
			);
			const passed =
				result.exitCode === 0 && !result.timedOut && !result.aborted;
			checks.push({
				command: command.command,
				args: [...command.args],
				startedAt: commandStartedAt,
				finishedAt: this.now(),
				exitCode: result.exitCode,
				stdoutTail: result.stdoutTail,
				stderrTail: result.stderrTail,
				passed,
			});
			if (!passed) {
				const message = result.aborted
					? "Final validation aborted"
					: result.timedOut
						? `Final validation command timed out after ${this.commandTimeoutMs}ms`
						: `Final validation command failed: ${command.command} ${command.args.join(" ")}`;
				throw this.failure(startedAt, checks, message);
			}
			try {
				await this.git.verifyDetachedWorktree(
					input.worktreePath,
					input.integrationCommit,
				);
			} catch (error) {
				throw this.failure(
					startedAt,
					checks,
					`Final validation command modified the worktree: ${command.command}`,
					error,
				);
			}
		}
		return {
			startedAt,
			finishedAt: this.now(),
			passed: true,
			checks,
		};
	}

	private failure(
		startedAt: string,
		checks: ValidationCheckEvidence[],
		message: string,
		cause?: unknown,
	): FinalValidationError {
		return new FinalValidationError(
			message,
			{
				startedAt,
				finishedAt: this.now(),
				passed: false,
				checks,
			},
			cause === undefined ? undefined : { cause },
		);
	}
}
