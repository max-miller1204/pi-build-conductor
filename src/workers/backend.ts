export type WorkerStatus =
	| "starting"
	| "online"
	| "stopping"
	| "stopped"
	| "error";

export interface WorkerInstance {
	id: string;
	status: WorkerStatus;
	cwd: string;
	label?: string;
	sessionId?: string;
	sessionFile?: string;
}

export interface SpawnWorkerRequest {
	cwd: string;
	label?: string;
	provider?: string;
	model?: string;
}

export type WorkerProgressEvent =
	| { type: "agent_started" }
	| { type: "text_delta"; text: string }
	| { type: "tool_started"; toolName: string }
	| { type: "tool_finished"; toolName: string; isError: boolean }
	| { type: "retrying"; message: string };

export interface WorkerExecutionOptions {
	signal?: AbortSignal;
	onEvent?: (event: WorkerProgressEvent) => void;
}

export type WorkerExecutionResult =
	| { status: "succeeded"; output?: string }
	| { status: "failed"; error: string }
	| { status: "aborted"; error: string };

export interface WorkerExecution {
	completion: Promise<WorkerExecutionResult>;
}

export interface WorkerBackend {
	spawn(request: SpawnWorkerRequest): Promise<WorkerInstance>;
	list(): Promise<WorkerInstance[]>;
	status(workerId: string): Promise<WorkerInstance>;
	startPrompt(
		workerId: string,
		prompt: string,
		options?: WorkerExecutionOptions,
	): Promise<WorkerExecution>;
	stop(workerId: string): Promise<void>;
}
