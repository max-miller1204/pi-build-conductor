import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
	SpawnWorkerRequest,
	WorkerBackend,
	WorkerExecution,
	WorkerExecutionOptions,
	WorkerExecutionResult,
	WorkerInstance,
	WorkerProgressEvent,
	WorkerStatus,
} from "./backend.js";

const MAX_FINAL_OUTPUT_BYTES = 256 * 1024;
const MAX_STREAM_FRAME_BYTES = 1024 * 1024;

interface InstanceSummary {
	id: string;
	status: WorkerStatus;
	cwd: string;
	label?: string;
	sessionId?: string;
	sessionFile?: string;
}

interface WireResponse {
	type: string;
	ok: boolean;
	error?: string;
	instance?: InstanceSummary;
	instances?: InstanceSummary[];
	response?: {
		success: boolean;
		command: string;
		error?: string;
	};
}

interface StreamMessage {
	type?: string;
	id?: string;
	ok?: boolean;
	success?: boolean;
	command?: string;
	error?: string;
	errorMessage?: string;
	finalError?: string;
	toolName?: string;
	isError?: boolean;
	assistantMessageEvent?: {
		type?: string;
		delta?: string;
	};
	messages?: Array<{
		role?: string;
		stopReason?: string;
		errorMessage?: string;
		content?: Array<{
			type?: string;
			text?: string;
		}>;
	}>;
}

export interface OfficialOrchestratorBackendOptions {
	socketPath?: string;
	requestTimeoutMs?: number;
}

function defaultSocketPath(): string {
	const orchestratorDirectory = process.env.PI_ORCHESTRATOR_DIR;
	if (orchestratorDirectory) {
		return join(orchestratorDirectory, "orchestrator.sock");
	}
	const piDirectory = process.env.PI_CONFIG_DIR ?? join(homedir(), ".pi");
	return join(piDirectory, "orchestrator", "orchestrator.sock");
}

function requireInstance(
	response: WireResponse,
	operation: string,
): WorkerInstance {
	if (!response.ok || !response.instance) {
		throw new Error(
			response.error ??
				`Official orchestrator ${operation} returned no instance`,
		);
	}
	return response.instance;
}

function abortMessage(signal: AbortSignal): string {
	if (signal.reason instanceof Error) {
		return signal.reason.message;
	}
	if (typeof signal.reason === "string") {
		return signal.reason;
	}
	return "Worker execution aborted";
}

function progressEvent(
	message: StreamMessage,
): WorkerProgressEvent | undefined {
	switch (message.type) {
		case "agent_start":
			return { type: "agent_started" };
		case "message_update":
			return message.assistantMessageEvent?.type === "text_delta" &&
				typeof message.assistantMessageEvent.delta === "string"
				? { type: "text_delta", text: message.assistantMessageEvent.delta }
				: undefined;
		case "tool_execution_start":
			return typeof message.toolName === "string"
				? { type: "tool_started", toolName: message.toolName }
				: undefined;
		case "tool_execution_end":
			return typeof message.toolName === "string"
				? {
						type: "tool_finished",
						toolName: message.toolName,
						isError: message.isError === true,
					}
				: undefined;
		case "auto_retry_start":
			return {
				type: "retrying",
				message: message.errorMessage ?? "Pi is retrying a transient failure",
			};
		default:
			return undefined;
	}
}

function assistantOutput(message: StreamMessage): string | undefined {
	if (message.type !== "agent_end") {
		return undefined;
	}
	const assistant = message.messages
		?.toReversed()
		.find((item) => item.role === "assistant");
	const textParts = assistant?.content?.flatMap((item) =>
		item.type === "text" && typeof item.text === "string" ? [item.text] : [],
	);
	let outputBytes = 0;
	for (const text of textParts ?? []) {
		outputBytes += Buffer.byteLength(text, "utf8");
		if (outputBytes > MAX_FINAL_OUTPUT_BYTES) {
			throw new Error(
				`Final assistant output exceeds ${MAX_FINAL_OUTPUT_BYTES} bytes`,
			);
		}
	}
	const output = textParts?.join("");
	return output?.trim() ? output : undefined;
}

function agentFailure(message: StreamMessage): string | undefined {
	if (message.type === "auto_retry_end" && message.success === false) {
		return message.finalError ?? "Pi exhausted its automatic retries";
	}
	if (message.type !== "agent_end") {
		return undefined;
	}
	const assistant = message.messages
		?.toReversed()
		.find((item) => item.role === "assistant");
	if (
		assistant?.stopReason === "error" ||
		assistant?.stopReason === "aborted"
	) {
		return (
			assistant.errorMessage ??
			`Pi finished with stop reason ${assistant.stopReason}`
		);
	}
	return undefined;
}

/**
 * Thin adapter around the experimental first-party orchestrator JSONL socket API.
 * Keep all upstream protocol assumptions in this module so they can be replaced
 * when @earendil-works/pi-orchestrator changes or becomes directly publishable.
 */
export class OfficialOrchestratorBackend implements WorkerBackend {
	private readonly socketPath: string;
	private readonly requestTimeoutMs: number;

	constructor(options: OfficialOrchestratorBackendOptions = {}) {
		this.socketPath = options.socketPath ?? defaultSocketPath();
		this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
	}

	private request(
		payload: object,
		options: { timeoutAfterConnect?: boolean } = {},
	): Promise<WireResponse> {
		return new Promise<WireResponse>((resolve, reject) => {
			const socket = createConnection(this.socketPath);
			let buffer = "";
			let settled = false;
			let timer: NodeJS.Timeout | undefined;

			const finish = (error?: Error, response?: WireResponse) => {
				if (settled) {
					return;
				}
				settled = true;
				if (timer) {
					clearTimeout(timer);
				}
				socket.destroy();
				if (error) {
					reject(error);
					return;
				}
				if (!response) {
					reject(new Error("Official orchestrator returned an empty response"));
					return;
				}
				resolve(response);
			};

			timer = setTimeout(() => {
				finish(
					new Error(
						`Official orchestrator request timed out at ${this.socketPath}`,
					),
				);
			}, this.requestTimeoutMs);

			socket.on("connect", () => {
				if (options.timeoutAfterConnect === false && timer) {
					clearTimeout(timer);
					timer = undefined;
				}
				socket.write(`${JSON.stringify(payload)}\n`);
			});
			socket.on("data", (chunk: Buffer | string) => {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				const frame = newline === -1 ? buffer : buffer.slice(0, newline);
				if (Buffer.byteLength(frame, "utf8") > MAX_STREAM_FRAME_BYTES) {
					finish(
						new Error(
							`Official orchestrator response exceeds ${MAX_STREAM_FRAME_BYTES} bytes`,
						),
					);
					return;
				}
				if (newline === -1) {
					return;
				}
				try {
					finish(
						undefined,
						JSON.parse(buffer.slice(0, newline)) as WireResponse,
					);
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			});
			socket.on("error", (error) => finish(error));
			socket.on("end", () => {
				if (!settled) {
					finish(
						new Error(
							`Official orchestrator closed ${this.socketPath} without a response`,
						),
					);
				}
			});
		});
	}

	private async rpc(workerId: string, command: object): Promise<void> {
		const response = await this.request({
			type: "rpc",
			instanceId: workerId,
			command,
		});
		if (!response.ok || !response.response?.success) {
			throw new Error(
				response.error ??
					response.response?.error ??
					"Official orchestrator RPC failed",
			);
		}
	}

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		if ((request.provider === undefined) !== (request.model === undefined)) {
			throw new Error("provider and model must be supplied together");
		}
		const payload: Record<string, unknown> = {
			type: "spawn",
			cwd: request.cwd,
		};
		if (request.label) {
			payload.label = request.label;
		}
		if (request.provider && request.model) {
			payload.provider = request.provider;
			payload.model = request.model;
		}
		const instance = requireInstance(
			await this.request(payload, { timeoutAfterConnect: false }),
			"spawn",
		);
		if (!request.provider || !request.model) {
			return instance;
		}
		try {
			await this.rpc(instance.id, {
				type: "set_model",
				provider: request.provider,
				modelId: request.model,
			});
			return instance;
		} catch (error) {
			try {
				await this.stop(instance.id);
			} catch (stopError) {
				throw new Error(
					`Failed to configure worker ${instance.id}, then failed to stop it: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
					{ cause: error },
				);
			}
			throw error;
		}
	}

	async list(): Promise<WorkerInstance[]> {
		const response = await this.request({ type: "list" });
		if (!response.ok || !response.instances) {
			throw new Error(response.error ?? "Official orchestrator list failed");
		}
		return response.instances;
	}

	async status(workerId: string): Promise<WorkerInstance> {
		return requireInstance(
			await this.request({ type: "status", instanceId: workerId }),
			"status",
		);
	}

	async sendPrompt(workerId: string, prompt: string): Promise<void> {
		await this.rpc(workerId, { type: "prompt", message: prompt });
	}

	async startPrompt(
		workerId: string,
		prompt: string,
		options: WorkerExecutionOptions = {},
	): Promise<WorkerExecution> {
		const socket = createConnection(this.socketPath);
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		let startSettled = false;
		let terminal = false;
		let disconnectHandled = false;
		let agentRunFailure: string | undefined;
		let retryFailure: string | undefined;
		let finalOutput: string | undefined;
		let resolveCompletion: (result: WorkerExecutionResult) => void;
		const completion = new Promise<WorkerExecutionResult>((resolve) => {
			resolveCompletion = resolve;
		});

		return new Promise<WorkerExecution>((resolve, reject) => {
			const removeAbortListener = () => {
				options.signal?.removeEventListener("abort", handleAbort);
			};
			const finishCompletion = (result: WorkerExecutionResult) => {
				if (terminal) {
					return;
				}
				terminal = true;
				resolveCompletion(result);
				if (startSettled) {
					clearTimeout(startTimer);
					removeAbortListener();
					socket.destroy();
				}
			};
			const failStart = (error: Error) => {
				if (startSettled) {
					finishCompletion({ status: "failed", error: error.message });
					return;
				}
				startSettled = true;
				terminal = true;
				clearTimeout(startTimer);
				removeAbortListener();
				socket.destroy();
				resolveCompletion({ status: "failed", error: error.message });
				reject(error);
			};
			const handleAbort = () => {
				const error = abortMessage(options.signal as AbortSignal);
				if (!startSettled) {
					failStart(new Error(error));
					return;
				}
				finishCompletion({ status: "aborted", error });
			};
			const handleDisconnect = (socketError?: Error) => {
				if (disconnectHandled) {
					return;
				}
				disconnectHandled = true;
				if (terminal) {
					if (!startSettled) {
						failStart(
							socketError ??
								new Error(
									"Official orchestrator stream closed before prompt acceptance",
								),
						);
					}
					return;
				}
				if (!startSettled) {
					failStart(
						socketError ??
							new Error(
								"Official orchestrator stream closed before prompt acceptance",
							),
					);
					return;
				}
				void this.status(workerId).then(
					(instance) => {
						let statusDetail = `closed its event stream while ${instance.status}`;
						if (instance.status === "error") {
							statusDetail = "entered error status";
						} else if (instance.status === "stopped") {
							statusDetail = "stopped before Pi settled";
						}
						finishCompletion({
							status: "failed",
							error:
								socketError?.message ?? `Worker ${workerId} ${statusDetail}`,
						});
					},
					(statusError: unknown) => {
						finishCompletion({
							status: "failed",
							error:
								socketError?.message ??
								`Worker ${workerId} disconnected: ${statusError instanceof Error ? statusError.message : String(statusError)}`,
						});
					},
				);
			};
			const handleMessage = (message: StreamMessage) => {
				if (message.type === "rpc_ready") {
					if (message.ok !== true) {
						failStart(
							new Error(
								message.error ??
									`Official orchestrator could not stream worker ${workerId}`,
							),
						);
						return;
					}
					socket.write(
						`${JSON.stringify({ id: "conductor_prompt", type: "prompt", message: prompt })}\n`,
					);
					return;
				}
				if (message.type === "response" && message.id === "conductor_prompt") {
					if (message.success !== true) {
						failStart(
							new Error(
								message.error ?? "Official orchestrator rejected prompt",
							),
						);
						return;
					}
					if (!startSettled) {
						startSettled = true;
						clearTimeout(startTimer);
						resolve({ completion });
						if (terminal) {
							removeAbortListener();
							socket.destroy();
						}
					}
					return;
				}
				if (message.type === "error" && message.ok === false) {
					failStart(
						new Error(message.error ?? "Official orchestrator stream failed"),
					);
					return;
				}
				const event = progressEvent(message);
				if (event) {
					try {
						options.onEvent?.(event);
					} catch {
						// UI observers must not affect worker execution.
					}
				}
				if (message.type === "agent_end") {
					agentRunFailure = agentFailure(message);
					finalOutput = assistantOutput(message);
				} else if (message.type === "auto_retry_end") {
					retryFailure =
						message.success === true ? undefined : agentFailure(message);
				}
				if (message.type === "agent_settled") {
					const terminalFailure = retryFailure ?? agentRunFailure;
					let result: WorkerExecutionResult;
					if (terminalFailure) {
						result = { status: "failed", error: terminalFailure };
					} else {
						result = {
							status: "succeeded",
							...(finalOutput ? { output: finalOutput } : {}),
						};
					}
					finishCompletion(result);
				}
			};
			const processChunk = (chunk: string) => {
				buffer += chunk;
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline === -1) {
						if (Buffer.byteLength(buffer, "utf8") > MAX_STREAM_FRAME_BYTES) {
							failStart(
								new Error(
									`Official orchestrator frame exceeds ${MAX_STREAM_FRAME_BYTES} bytes`,
								),
							);
						}
						return;
					}
					const line = buffer.slice(0, newline).replace(/\r$/, "");
					buffer = buffer.slice(newline + 1);
					if (!line) {
						continue;
					}
					if (Buffer.byteLength(line, "utf8") > MAX_STREAM_FRAME_BYTES) {
						failStart(
							new Error(
								`Official orchestrator frame exceeds ${MAX_STREAM_FRAME_BYTES} bytes`,
							),
						);
						return;
					}
					try {
						handleMessage(JSON.parse(line) as StreamMessage);
					} catch (error) {
						failStart(
							error instanceof Error ? error : new Error(String(error)),
						);
					}
				}
			};
			const startTimer = setTimeout(() => {
				failStart(
					new Error(
						`Official orchestrator stream timed out at ${this.socketPath}`,
					),
				);
			}, this.requestTimeoutMs);

			socket.on("connect", () => {
				socket.write(
					`${JSON.stringify({ type: "rpc_stream", instanceId: workerId })}\n`,
				);
			});
			socket.on("data", (chunk: Buffer | string) => {
				processChunk(typeof chunk === "string" ? chunk : decoder.write(chunk));
			});
			socket.on("error", (error) => handleDisconnect(error));
			socket.on("end", () => {
				processChunk(decoder.end());
				handleDisconnect();
			});
			if (options.signal?.aborted) {
				handleAbort();
			} else {
				options.signal?.addEventListener("abort", handleAbort, { once: true });
			}
		});
	}

	async stop(workerId: string): Promise<void> {
		const response = await this.request({ type: "stop", instanceId: workerId });
		if (!response.ok) {
			throw new Error(response.error ?? "Official orchestrator stop failed");
		}
	}
}
