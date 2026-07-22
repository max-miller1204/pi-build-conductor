import type {
	BlockedWorkerPolicy,
	WorkerUiMethod,
	WorkerUiRequest,
	WorkerUiResponse,
} from "../domain/types.js";

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

export type WorkerUiResolutionOutcome =
	| "responded"
	| "declined"
	| "cancelled"
	| "request_timeout"
	| "execution_aborted"
	| "stream_closed"
	| "recovery_interrupted";

export type WorkerProgressEvent =
	| { type: "agent_started" }
	| { type: "text_delta"; text: string }
	| { type: "tool_started"; toolName: string }
	| { type: "tool_finished"; toolName: string; isError: boolean }
	| { type: "retrying"; message: string }
	| {
			type: "ui_blocked";
			requestId: string;
			method: WorkerUiMethod;
	  }
	| {
			type: "ui_decision";
			requestId: string;
			method: WorkerUiMethod;
			policy: BlockedWorkerPolicy;
			outcome: "declined" | "cancelled";
	  }
	| {
			type: "ui_resolved";
			requestId: string;
			method: WorkerUiMethod;
			outcome: WorkerUiResolutionOutcome;
	  };

export type WorkerUiResponder = (response: WorkerUiResponse) => Promise<void>;

export interface WorkerExecutionOptions {
	signal?: AbortSignal;
	onEvent?: (event: WorkerProgressEvent) => void;
	onUiRequest?: (
		request: WorkerUiRequest,
		respond: WorkerUiResponder,
	) => void | Promise<void>;
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
