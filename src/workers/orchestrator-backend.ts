import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	SpawnWorkerRequest,
	WorkerBackend,
	WorkerInstance,
	WorkerStatus,
} from "./backend.js";

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

	async stop(workerId: string): Promise<void> {
		const response = await this.request({ type: "stop", instanceId: workerId });
		if (!response.ok) {
			throw new Error(response.error ?? "Official orchestrator stop failed");
		}
	}
}
