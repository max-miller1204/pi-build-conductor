import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type {
	RunSecurityPolicy,
	ValidationCommand,
	ValidationExecutionBoundary,
} from "../domain/types.js";

export interface CommandExecutionResult {
	exitCode: number | null;
	stdoutTail: string;
	stderrTail: string;
	timedOut: boolean;
	aborted: boolean;
	executionBoundary: ValidationExecutionBoundary;
}

export interface ValidationInvocation {
	command: string;
	args: string[];
}

const UNSANDBOXED_BOUNDARY: ValidationExecutionBoundary = {
	sandbox: "none",
	network: "host",
	environment: "temporary-home-reduced",
};

function validationDirectoryEnvironment(
	runtimeRoot: string,
): NodeJS.ProcessEnv {
	return {
		HOME: join(runtimeRoot, "home"),
		XDG_CONFIG_HOME: join(runtimeRoot, "config"),
		XDG_CACHE_HOME: join(runtimeRoot, "cache"),
		XDG_DATA_HOME: join(runtimeRoot, "data"),
		XDG_STATE_HOME: join(runtimeRoot, "state"),
		TMPDIR: join(runtimeRoot, "tmp"),
		TMP: join(runtimeRoot, "tmp"),
		TEMP: join(runtimeRoot, "tmp"),
	};
}

export function buildValidationEnvironment(
	runtimeRoot: string,
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		CI: "true",
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "Never",
		...validationDirectoryEnvironment(runtimeRoot),
	};
	for (const name of [
		"PATH",
		"SYSTEMROOT",
		"COMSPEC",
		"PATHEXT",
		"LANG",
		"LC_ALL",
	] as const) {
		const value = source[name];
		if (value !== undefined) {
			environment[name] = value;
		}
	}
	return environment;
}

export function buildValidationInvocation(
	command: ValidationCommand,
	runtimeRoot: string,
	policy?: RunSecurityPolicy["validation"],
	options: {
		nonoProfilePath?: string;
		sourceEnvironment?: NodeJS.ProcessEnv;
	} = {},
): ValidationInvocation {
	if (!policy || policy.sandbox === "none") {
		return { command: command.command, args: [...command.args] };
	}
	if (!policy.sandboxExecutable) {
		throw new Error("Nono validation sandbox has no configured executable");
	}
	const sourceEnvironment = options.sourceEnvironment ?? process.env;
	const pathUsesNix = (sourceEnvironment.PATH ?? "")
		.split(delimiter)
		.some((entry) => entry.startsWith("/nix/"));
	const nixStoreArguments =
		command.command.startsWith("/nix/store/") || pathUsesNix
			? ["--read", "/nix/store"]
			: [];
	return {
		command: policy.sandboxExecutable,
		args: [
			"run",
			"--profile",
			options.nonoProfilePath ?? join(runtimeRoot, "nono-profile.json"),
			"--allow-cwd",
			"--allow",
			runtimeRoot,
			...nixStoreArguments,
			"--block-net",
			"--",
			command.command,
			...command.args,
		],
	};
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

function abortMessage(signal: AbortSignal): string {
	return signal.reason instanceof Error
		? signal.reason.message
		: "Validation aborted";
}

export async function executeValidationCommand(
	command: ValidationCommand,
	cwd: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
	outputTailBytes: number,
	policy?: RunSecurityPolicy["validation"],
): Promise<CommandExecutionResult> {
	const executionBoundary: ValidationExecutionBoundary = policy
		? {
				sandbox: policy.sandbox,
				network: policy.network,
				environment: policy.environment,
			}
		: UNSANDBOXED_BOUNDARY;
	if (signal?.aborted) {
		return {
			exitCode: null,
			stdoutTail: "",
			stderrTail: abortMessage(signal),
			timedOut: false,
			aborted: true,
			executionBoundary,
		};
	}
	const executionRoot = await mkdtemp(
		join(tmpdir(), "pi-build-conductor-validation-"),
	);
	const runtimeRoot = join(executionRoot, "runtime");
	const nonoControlRoot = join(executionRoot, "nono-control");
	let invocation: ValidationInvocation;
	try {
		const roots =
			policy?.sandbox === "nono"
				? [runtimeRoot, nonoControlRoot]
				: [runtimeRoot];
		await Promise.all(
			roots.flatMap((root) =>
				["home", "config", "cache", "data", "state", "tmp"].map((directory) =>
					mkdir(join(root, directory), { recursive: true }),
				),
			),
		);
		const nonoProfilePath = join(nonoControlRoot, "profile.json");
		if (policy?.sandbox === "nono") {
			await writeFile(
				nonoProfilePath,
				JSON.stringify({
					environment: {
						allow_vars: [
							"PATH",
							"LANG",
							"LC_ALL",
							"CI",
							"GIT_TERMINAL_PROMPT",
							"GCM_INTERACTIVE",
						],
						set_vars: validationDirectoryEnvironment(runtimeRoot),
					},
				}),
				{ encoding: "utf8", mode: 0o600 },
			);
		}
		invocation = buildValidationInvocation(command, runtimeRoot, policy, {
			nonoProfilePath,
		});
	} catch (error) {
		await rm(executionRoot, { recursive: true, force: true });
		throw error;
	}
	return new Promise<CommandExecutionResult>((resolvePromise) => {
		let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let timedOut = false;
		let aborted = false;
		let settled = false;
		let closeExitCode: number | null | undefined;
		let spawnFailed = false;
		let forceKill: NodeJS.Timeout | undefined;
		let forceKillCompleted = false;
		const detached = process.platform !== "win32";
		const child = spawn(invocation.command, invocation.args, {
			cwd,
			detached,
			env: buildValidationEnvironment(
				policy?.sandbox === "nono" ? nonoControlRoot : runtimeRoot,
			),
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
		const finish = () => {
			if (
				settled ||
				closeExitCode === undefined ||
				((timedOut || aborted) && !forceKillCompleted)
			) {
				return;
			}
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			if (forceKill) {
				clearTimeout(forceKill);
			}
			void rm(executionRoot, { recursive: true, force: true }).then(
				() => {
					resolvePromise({
						exitCode: closeExitCode ?? null,
						stdoutTail: stdout.toString("utf8"),
						stderrTail: stderr.toString("utf8"),
						timedOut,
						aborted,
						executionBoundary,
					});
				},
				(error: unknown) => {
					resolvePromise({
						exitCode: closeExitCode ?? null,
						stdoutTail: stdout.toString("utf8"),
						stderrTail: appendTail(
							stderr,
							Buffer.from(
								`\nFailed to remove validation runtime: ${error instanceof Error ? error.message : String(error)}`,
							),
							outputTailBytes,
						).toString("utf8"),
						timedOut,
						aborted,
						executionBoundary,
					});
				},
			);
		};
		const terminate = () => {
			kill("SIGTERM");
			if (!forceKill) {
				forceKill = setTimeout(() => {
					kill("SIGKILL");
					forceKillCompleted = true;
					finish();
				}, 1_000);
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
			spawnFailed = true;
			stderr = appendTail(stderr, Buffer.from(error.message), outputTailBytes);
		});
		child.on("close", (exitCode) => {
			closeExitCode = spawnFailed ? null : exitCode;
			clearTimeout(timeout);
			forceKillCompleted = true;
			finish();
		});
	});
}
