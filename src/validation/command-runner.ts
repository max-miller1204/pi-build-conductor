import { spawn } from "node:child_process";
import type { ValidationCommand } from "../domain/types.js";

export interface CommandExecutionResult {
	exitCode: number | null;
	stdoutTail: string;
	stderrTail: string;
	timedOut: boolean;
	aborted: boolean;
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

export async function executeValidationCommand(
	command: ValidationCommand,
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	outputTailBytes: number,
): Promise<CommandExecutionResult> {
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
	return new Promise<CommandExecutionResult>((resolvePromise) => {
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
