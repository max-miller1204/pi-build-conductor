import { spawn } from "node:child_process";
import type {
	TaskAttempt,
	TaskDefinition,
	TaskValidationEvidence,
	ValidationCheckEvidence,
	ValidationCommand,
} from "../domain/types.js";
import type { GitClient, TaskWorktreeSnapshot } from "../git/git.js";

const DEFAULT_VALIDATION_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_OUTPUT_TAIL_BYTES = 64 * 1024;

export interface TaskValidationInput {
	task: TaskDefinition;
	attempt: TaskAttempt;
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

function reducedEnvironment(): NodeJS.ProcessEnv {
	const allowedNames = [
		"PATH",
		"HOME",
		"TMPDIR",
		"TMP",
		"TEMP",
		"SYSTEMROOT",
		"COMSPEC",
		"PATHEXT",
		"LANG",
		"LC_ALL",
	];
	const environment: NodeJS.ProcessEnv = { CI: "true" };
	for (const name of allowedNames) {
		const value = process.env[name];
		if (value !== undefined) {
			environment[name] = value;
		}
	}
	return environment;
}

function appendTail(current: Buffer, chunk: Buffer, maximum: number): Buffer {
	if (chunk.length >= maximum) {
		return chunk.subarray(chunk.length - maximum);
	}
	const combined = Buffer.concat([current, chunk]);
	return combined.length <= maximum
		? combined
		: combined.subarray(combined.length - maximum);
}

interface CommandResult {
	exitCode: number | null;
	stdoutTail: string;
	stderrTail: string;
	timedOut: boolean;
	aborted: boolean;
}

async function executeCommand(
	command: ValidationCommand,
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	outputTailBytes: number,
): Promise<CommandResult> {
	if (signal?.aborted) {
		return {
			exitCode: null,
			stdoutTail: "",
			stderrTail:
				signal.reason instanceof Error
					? signal.reason.message
					: "Validation aborted",
			timedOut: false,
			aborted: true,
		};
	}
	return new Promise<CommandResult>((resolvePromise) => {
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let timedOut = false;
		let aborted = false;
		let settled = false;
		let forceKill: NodeJS.Timeout | undefined;
		const detached = process.platform !== "win32";
		const child = spawn(command.command, command.args, {
			cwd,
			detached,
			env: reducedEnvironment(),
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const kill = (signalName: NodeJS.Signals) => {
			if (child.pid && detached) {
				try {
					process.kill(-child.pid, signalName);
				} catch {
					// The process may already have exited.
				}
			}
			child.kill(signalName);
		};
		const terminate = () => {
			kill("SIGTERM");
			if (!forceKill) {
				forceKill = setTimeout(() => kill("SIGKILL"), 1_000);
				forceKill.unref();
			}
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			terminate();
		}, timeoutMs);
		timeout.unref();
		const onAbort = () => {
			aborted = true;
			terminate();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) {
			onAbort();
		}
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = appendTail(stdout, chunk, outputTailBytes);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = appendTail(stderr, chunk, outputTailBytes);
		});
		child.on("error", (error) => {
			stderr = appendTail(stderr, Buffer.from(error.message), outputTailBytes);
		});
		child.on("close", (exitCode) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			if (forceKill) {
				clearTimeout(forceKill);
			}
			signal?.removeEventListener("abort", onAbort);
			resolvePromise({
				exitCode,
				stdoutTail: stdout.toString("utf8"),
				stderrTail: stderr.toString("utf8"),
				timedOut,
				aborted,
			});
		});
	});
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
			const result = await executeCommand(
				command,
				input.attempt.worktreePath,
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
