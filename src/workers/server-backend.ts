import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
	WorkerLaunchPolicy,
	WorkerUiRequest,
	WorkerUiResponse,
} from "../domain/types.js";
import type {
	SpawnWorkerRequest,
	WorkerBackend,
	WorkerExecution,
	WorkerExecutionOptions,
	WorkerExecutionResult,
	WorkerInstance,
	WorkerProgressEvent,
	WorkerStatus,
	WorkerUiResolutionOutcome,
} from "./backend.js";

const MAX_FINAL_OUTPUT_BYTES = 256 * 1024;
const MAX_STREAM_FRAME_BYTES = 1024 * 1024;
const MAX_UI_REQUEST_ID_LENGTH = 256;
const MAX_UI_TITLE_LENGTH = 4_096;
const MAX_UI_TEXT_LENGTH = 64 * 1024;
const MAX_UI_OPTIONS = 1_000;

interface InstanceSummary {
	id: string;
	status: WorkerStatus;
	cwd: string;
	label?: string;
	sessionId?: string;
	sessionFile?: string;
	appliedPolicy?: WorkerLaunchPolicy;
}

interface WireResponse {
	type: string;
	ok: boolean;
	error?: string;
	instance?: InstanceSummary;
	instances?: InstanceSummary[];
	capabilities?: {
		workerLaunchPolicyVersions?: number[];
	};
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
	method?: string;
	title?: string;
	message?: string;
	options?: unknown;
	placeholder?: string;
	prefill?: string;
	timeout?: number;
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

export interface OfficialServerBackendOptions {
	socketPath?: string;
	requestTimeoutMs?: number;
}

export function defaultServerSocketPath(
	env: NodeJS.ProcessEnv = process.env,
	homeDirectory = homedir(),
): string {
	const serverDirectory = env.PI_SERVER_DIR;
	if (serverDirectory) {
		return join(serverDirectory, "server.sock");
	}
	const piDirectory = env.PI_CONFIG_DIR ?? join(homeDirectory, ".pi");
	return join(piDirectory, "server", "server.sock");
}

function requireInstance(
	response: WireResponse,
	operation: string,
): WorkerInstance {
	if (!response.ok || !response.instance) {
		throw new Error(
			response.error ?? `Official server ${operation} returned no instance`,
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

function boundedUiString(
	value: unknown,
	field: string,
	maximum: number,
): string {
	if (typeof value !== "string") {
		throw new Error(`Worker UI request ${field} must be a string`);
	}
	if (value.length > maximum) {
		throw new Error(`Worker UI request ${field} exceeds ${maximum} characters`);
	}
	return value;
}

function uiRequestTimeout(message: StreamMessage): number | undefined {
	if (message.timeout === undefined) {
		return undefined;
	}
	if (!Number.isFinite(message.timeout) || message.timeout <= 0) {
		throw new Error("Worker UI request timeout must be a positive number");
	}
	return message.timeout;
}

function blockingUiRequest(
	message: StreamMessage,
): WorkerUiRequest | undefined {
	if (message.type !== "extension_ui_request") {
		return undefined;
	}
	if (
		message.method !== "select" &&
		message.method !== "confirm" &&
		message.method !== "input" &&
		message.method !== "editor"
	) {
		return undefined;
	}
	const id = boundedUiString(message.id, "id", MAX_UI_REQUEST_ID_LENGTH);
	if (id.length === 0) {
		throw new Error("Worker UI request id must not be empty");
	}
	const title = boundedUiString(message.title, "title", MAX_UI_TITLE_LENGTH);
	if (message.method === "select") {
		if (
			!Array.isArray(message.options) ||
			message.options.length > MAX_UI_OPTIONS ||
			message.options.some(
				(option) =>
					typeof option !== "string" || option.length > MAX_UI_TEXT_LENGTH,
			)
		) {
			throw new Error(
				`Worker UI request options must contain at most ${MAX_UI_OPTIONS} bounded strings`,
			);
		}
		const timeoutMs = uiRequestTimeout(message);
		return {
			id,
			method: "select",
			title,
			options: message.options as string[],
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		};
	}
	if (message.method === "confirm") {
		const timeoutMs = uiRequestTimeout(message);
		return {
			id,
			method: "confirm",
			title,
			message: boundedUiString(message.message, "message", MAX_UI_TEXT_LENGTH),
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		};
	}
	if (message.method === "input") {
		const timeoutMs = uiRequestTimeout(message);
		return {
			id,
			method: "input",
			title,
			...(message.placeholder === undefined
				? {}
				: {
						placeholder: boundedUiString(
							message.placeholder,
							"placeholder",
							MAX_UI_TEXT_LENGTH,
						),
					}),
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		};
	}
	return {
		id,
		method: "editor",
		title,
		...(message.prefill === undefined
			? {}
			: {
					prefill: boundedUiString(
						message.prefill,
						"prefill",
						MAX_UI_TEXT_LENGTH,
					),
				}),
	};
}

function wireUiResponse(
	request: WorkerUiRequest,
	response: WorkerUiResponse,
): { command: object; outcome: WorkerUiResolutionOutcome } {
	if (response.kind === "cancelled") {
		return {
			command: {
				type: "extension_ui_response",
				id: request.id,
				cancelled: true,
			},
			outcome: "cancelled",
		};
	}
	if (response.kind === "confirmation") {
		if (request.method !== "confirm") {
			throw new Error(
				`Worker UI request ${request.id} (${request.method}) does not accept a confirmation response`,
			);
		}
		return {
			command: {
				type: "extension_ui_response",
				id: request.id,
				confirmed: response.confirmed,
			},
			outcome: response.confirmed ? "responded" : "declined",
		};
	}
	if (request.method === "confirm") {
		throw new Error(
			`Worker UI request ${request.id} (confirm) does not accept a value response`,
		);
	}
	return {
		command: {
			type: "extension_ui_response",
			id: request.id,
			value: response.value,
		},
		outcome: "responded",
	};
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
 * Thin adapter around the experimental first-party server JSONL socket API.
 * Keep all upstream protocol assumptions in this module so they can be replaced
 * when @earendil-works/pi-server changes or becomes directly publishable.
 */
export class OfficialServerBackend implements WorkerBackend {
	private readonly socketPath: string;
	private readonly requestTimeoutMs: number;

	constructor(options: OfficialServerBackendOptions = {}) {
		this.socketPath = options.socketPath ?? defaultServerSocketPath();
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
					reject(new Error("Official server returned an empty response"));
					return;
				}
				resolve(response);
			};

			timer = setTimeout(() => {
				finish(
					new Error(`Official server request timed out at ${this.socketPath}`),
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
							`Official server response exceeds ${MAX_STREAM_FRAME_BYTES} bytes`,
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
							`Official server closed ${this.socketPath} without a response`,
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
					"Official server RPC failed",
			);
		}
	}

	async preflightPolicy(policy: WorkerLaunchPolicy): Promise<void> {
		const response = await this.request({ type: "capabilities" });
		if (
			!response.ok ||
			!response.capabilities?.workerLaunchPolicyVersions?.includes(
				policy.version,
			)
		) {
			throw new Error(
				response.error ??
					`Official server does not support worker launch policy v${policy.version}`,
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
		if (request.launchPolicy) {
			payload.launchPolicy = request.launchPolicy;
		}
		const instance = requireInstance(
			await this.request(payload, { timeoutAfterConnect: false }),
			"spawn",
		);
		try {
			if (
				request.launchPolicy &&
				JSON.stringify(instance.appliedPolicy) !==
					JSON.stringify(request.launchPolicy)
			) {
				throw new Error(
					`Official server did not attest worker launch policy v${request.launchPolicy.version}`,
				);
			}
			if (request.provider && request.model) {
				await this.rpc(instance.id, {
					type: "set_model",
					provider: request.provider,
					modelId: request.model,
				});
			}
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
			throw new Error(response.error ?? "Official server list failed");
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
		const pendingUiRequests = new Map<
			string,
			{
				request: WorkerUiRequest;
				responding: boolean;
				timer?: NodeJS.Timeout;
			}
		>();
		const completion = new Promise<WorkerExecutionResult>((resolve) => {
			resolveCompletion = resolve;
		});
		const emitProgress = (event: WorkerProgressEvent) => {
			try {
				options.onEvent?.(event);
			} catch {
				// UI observers must not affect worker execution.
			}
		};
		const resolveUiRequest = (
			request: WorkerUiRequest,
			outcome: WorkerUiResolutionOutcome,
		) => {
			const pending = pendingUiRequests.get(request.id);
			if (!pending || pending.request !== request) {
				return;
			}
			pendingUiRequests.delete(request.id);
			if (pending.timer) {
				clearTimeout(pending.timer);
			}
			emitProgress({
				type: "ui_resolved",
				requestId: request.id,
				method: request.method,
				outcome,
			});
		};
		const invalidateUiRequests = (outcome: WorkerUiResolutionOutcome) => {
			for (const { request } of [...pendingUiRequests.values()]) {
				resolveUiRequest(request, outcome);
			}
		};

		return new Promise<WorkerExecution>((resolve, reject) => {
			const removeAbortListener = () => {
				options.signal?.removeEventListener("abort", handleAbort);
			};
			const finishCompletion = (result: WorkerExecutionResult) => {
				if (terminal) {
					return;
				}
				terminal = true;
				invalidateUiRequests(
					result.status === "aborted" ? "execution_aborted" : "stream_closed",
				);
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
				invalidateUiRequests("stream_closed");
				clearTimeout(startTimer);
				removeAbortListener();
				socket.destroy();
				resolveCompletion({ status: "failed", error: error.message });
				reject(error);
			};
			const handleAbort = () => {
				const error = abortMessage(options.signal as AbortSignal);
				if (!startSettled) {
					invalidateUiRequests("execution_aborted");
					failStart(new Error(error));
					return;
				}
				finishCompletion({ status: "aborted", error });
			};
			const respondToUiRequest = async (
				request: WorkerUiRequest,
				response: WorkerUiResponse,
			): Promise<void> => {
				const pending = pendingUiRequests.get(request.id);
				if (!pending || pending.request !== request) {
					throw new Error(
						`Worker UI request ${request.id} is no longer pending`,
					);
				}
				if (pending.responding) {
					throw new Error(
						`Worker UI request ${request.id} already has a response in progress`,
					);
				}
				const wire = wireUiResponse(request, response);
				pending.responding = true;
				try {
					await new Promise<void>((resolveWrite, rejectWrite) => {
						if (terminal || socket.destroyed || !socket.writable) {
							rejectWrite(
								new Error(
									`Worker UI request ${request.id} cannot be answered because the stream is closed`,
								),
							);
							return;
						}
						socket.write(`${JSON.stringify(wire.command)}\n`, (error) => {
							if (error) {
								rejectWrite(error);
								return;
							}
							resolveWrite();
						});
					});
				} catch (error) {
					pending.responding = false;
					throw error;
				}
				if (pendingUiRequests.get(request.id) !== pending) {
					throw new Error(
						`Worker UI request ${request.id} expired while its response was being written`,
					);
				}
				resolveUiRequest(request, wire.outcome);
			};
			const registerUiRequest = (request: WorkerUiRequest) => {
				if (pendingUiRequests.has(request.id)) {
					throw new Error(`Duplicate worker UI request id: ${request.id}`);
				}
				const pending: {
					request: WorkerUiRequest;
					responding: boolean;
					timer?: NodeJS.Timeout;
				} = { request, responding: false };
				const timeoutMs =
					"timeoutMs" in request ? request.timeoutMs : undefined;
				if (timeoutMs !== undefined) {
					pending.timer = setTimeout(() => {
						resolveUiRequest(request, "request_timeout");
					}, timeoutMs);
					pending.timer.unref();
				}
				pendingUiRequests.set(request.id, pending);
				emitProgress({
					type: "ui_blocked",
					requestId: request.id,
					method: request.method,
				});
				if (!options.onUiRequest) {
					return;
				}
				let handling: void | Promise<void>;
				try {
					handling = options.onUiRequest(request, (response) =>
						respondToUiRequest(request, response),
					);
				} catch (error) {
					throw error instanceof Error ? error : new Error(String(error));
				}
				void Promise.resolve(handling).catch((error: unknown) => {
					if (pendingUiRequests.get(request.id) !== pending) {
						return;
					}
					failStart(
						new Error(
							`Failed to handle worker UI request ${request.id}: ${error instanceof Error ? error.message : String(error)}`,
						),
					);
				});
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
									"Official server stream closed before prompt acceptance",
								),
						);
					}
					return;
				}
				if (!startSettled) {
					failStart(
						socketError ??
							new Error(
								"Official server stream closed before prompt acceptance",
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
									`Official server could not stream worker ${workerId}`,
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
							new Error(message.error ?? "Official server rejected prompt"),
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
						new Error(message.error ?? "Official server stream failed"),
					);
					return;
				}
				const request = blockingUiRequest(message);
				if (request) {
					registerUiRequest(request);
					return;
				}
				const event = progressEvent(message);
				if (event) {
					emitProgress(event);
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
									`Official server frame exceeds ${MAX_STREAM_FRAME_BYTES} bytes`,
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
								`Official server frame exceeds ${MAX_STREAM_FRAME_BYTES} bytes`,
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
					new Error(`Official server stream timed out at ${this.socketPath}`),
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
			throw new Error(response.error ?? "Official server stop failed");
		}
	}
}
