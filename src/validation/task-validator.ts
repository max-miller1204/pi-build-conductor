import type {
	RunSecurityPolicy,
	TaskAttempt,
	TaskDefinition,
	TaskValidationEvidence,
	ValidationCheckEvidence,
} from "../domain/types.js";
import type { GitClient, TaskWorktreeSnapshot } from "../git/git.js";
import { executeValidationCommand } from "./command-runner.js";

const DEFAULT_VALIDATION_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_OUTPUT_TAIL_BYTES = 64 * 1024;

export interface TaskValidationInput {
	task: TaskDefinition;
	attempt: TaskAttempt;
	securityPolicy?: RunSecurityPolicy;
	signal?: AbortSignal;
}

export interface TaskValidationResult {
	snapshot: TaskWorktreeSnapshot;
	evidence: TaskValidationEvidence;
}

export interface TaskValidator {
	validate(input: TaskValidationInput): Promise<TaskValidationResult>;
}

export interface LocalTaskValidatorOptions {
	now?: () => string;
	commandTimeoutMs?: number;
	outputTailBytes?: number;
}

export class TaskValidationError extends Error {
	constructor(
		message: string,
		readonly evidence: TaskValidationEvidence,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "TaskValidationError";
	}
}

function pathIsAllowed(path: string, allowedPaths: string[]): boolean {
	return allowedPaths.some((allowed) =>
		allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed,
	);
}

function snapshotsMatch(
	left: TaskWorktreeSnapshot,
	right: TaskWorktreeSnapshot,
): boolean {
	return (
		left.branch === right.branch &&
		left.baseCommit === right.baseCommit &&
		left.diffHash === right.diffHash &&
		JSON.stringify(left.changedFiles) === JSON.stringify(right.changedFiles)
	);
}

export class LocalTaskValidator implements TaskValidator {
	private readonly now: () => string;
	private readonly commandTimeoutMs: number;
	private readonly outputTailBytes: number;

	constructor(
		private readonly git: GitClient,
		options: LocalTaskValidatorOptions = {},
	) {
		this.now = options.now ?? (() => new Date().toISOString());
		this.commandTimeoutMs =
			options.commandTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
		this.outputTailBytes = options.outputTailBytes ?? DEFAULT_OUTPUT_TAIL_BYTES;
		if (!Number.isFinite(this.commandTimeoutMs) || this.commandTimeoutMs <= 0) {
			throw new Error("commandTimeoutMs must be a positive finite number");
		}
		if (!Number.isInteger(this.outputTailBytes) || this.outputTailBytes <= 0) {
			throw new Error("outputTailBytes must be a positive integer");
		}
	}

	async validate(input: TaskValidationInput): Promise<TaskValidationResult> {
		const startedAt = this.now();
		const checks: ValidationCheckEvidence[] = [];
		let snapshot: TaskWorktreeSnapshot | undefined;
		try {
			if (input.signal?.aborted) {
				throw input.signal.reason instanceof Error
					? input.signal.reason
					: new Error("Validation aborted");
			}
			snapshot = await this.git.inspectTaskWorktree(
				input.attempt.worktreePath,
				input.attempt.branch,
				input.attempt.baseCommit,
			);
			const outOfScope = snapshot.changedFiles.flatMap((file) =>
				[file.path, ...(file.previousPath ? [file.previousPath] : [])].filter(
					(path) => !pathIsAllowed(path, input.task.allowedPaths),
				),
			);
			if (outOfScope.length > 0) {
				throw new Error(
					`Task changed paths outside its approved scope: ${[...new Set(outOfScope)].join(", ")}`,
				);
			}
		} catch (error) {
			const evidence: TaskValidationEvidence = {
				startedAt,
				finishedAt: this.now(),
				passed: false,
				changedFiles: snapshot?.changedFiles ?? [],
				diffHash: snapshot?.diffHash ?? "",
				checks,
			};
			throw new TaskValidationError(
				error instanceof Error ? error.message : String(error),
				evidence,
				{ cause: error },
			);
		}

		const diffCheckStartedAt = this.now();
		try {
			await this.git.checkTaskDiff(
				input.attempt.worktreePath,
				input.attempt.baseCommit,
			);
			checks.push({
				command: "git",
				args: ["diff", "--check", input.attempt.baseCommit, "--"],
				startedAt: diffCheckStartedAt,
				finishedAt: this.now(),
				exitCode: 0,
				stdoutTail: "",
				stderrTail: "",
				passed: true,
			});
		} catch (error) {
			checks.push({
				command: "git",
				args: ["diff", "--check", input.attempt.baseCommit, "--"],
				startedAt: diffCheckStartedAt,
				finishedAt: this.now(),
				exitCode: 1,
				stdoutTail: "",
				stderrTail: error instanceof Error ? error.message : String(error),
				passed: false,
			});
			throw this.failure(
				startedAt,
				snapshot,
				checks,
				"git diff --check failed",
				error,
			);
		}

		for (const command of input.task.validationCommands) {
			const commandStartedAt = this.now();
			const result = await executeValidationCommand(
				command,
				input.attempt.worktreePath,
				input.signal,
				this.commandTimeoutMs,
				this.outputTailBytes,
				input.securityPolicy?.validation,
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
				executionBoundary: result.executionBoundary,
			});
			if (!passed) {
				const reason = result.aborted
					? "Validation aborted"
					: result.timedOut
						? `Validation command timed out after ${this.commandTimeoutMs}ms`
						: `Validation command failed: ${command.command} ${command.args.join(" ")}`;
				throw this.failure(startedAt, snapshot, checks, reason);
			}
		}

		let finalSnapshot: TaskWorktreeSnapshot;
		try {
			finalSnapshot = await this.git.inspectTaskWorktree(
				input.attempt.worktreePath,
				input.attempt.branch,
				input.attempt.baseCommit,
			);
		} catch (error) {
			throw this.failure(
				startedAt,
				snapshot,
				checks,
				"Task worktree could not be re-inspected after validation",
				error,
			);
		}
		if (!snapshotsMatch(snapshot, finalSnapshot)) {
			throw this.failure(
				startedAt,
				snapshot,
				checks,
				"Validation commands modified the task worktree",
			);
		}
		return {
			snapshot,
			evidence: {
				startedAt,
				finishedAt: this.now(),
				passed: true,
				changedFiles: snapshot.changedFiles,
				diffHash: snapshot.diffHash,
				checks,
			},
		};
	}

	private failure(
		startedAt: string,
		snapshot: TaskWorktreeSnapshot,
		checks: ValidationCheckEvidence[],
		message: string,
		cause?: unknown,
	): TaskValidationError {
		return new TaskValidationError(
			message,
			{
				startedAt,
				finishedAt: this.now(),
				passed: false,
				changedFiles: snapshot.changedFiles,
				diffHash: snapshot.diffHash,
				checks,
			},
			cause === undefined ? undefined : { cause },
		);
	}
}
