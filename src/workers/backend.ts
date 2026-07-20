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

export interface WorkerBackend {
	spawn(request: SpawnWorkerRequest): Promise<WorkerInstance>;
	list(): Promise<WorkerInstance[]>;
	status(workerId: string): Promise<WorkerInstance>;
	sendPrompt(workerId: string, prompt: string): Promise<void>;
	stop(workerId: string): Promise<void>;
}
