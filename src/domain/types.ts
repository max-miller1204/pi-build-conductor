export const RUN_SCHEMA_VERSION = 1 as const;
export const PLAN_SCHEMA_VERSION = 1 as const;

export type RunState =
	| "planning"
	| "awaiting_approval"
	| "running"
	| "integrating"
	| "validating"
	| "completed"
	| "failed"
	| "cancelled";

export type TaskState =
	| "planned"
	| "ready"
	| "running"
	| "succeeded"
	| "failed"
	| "blocked"
	| "cancelled";

export type AttemptState =
	| "prepared"
	| "launched"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "interrupted";

export interface TaskDefinition {
	id: string;
	title: string;
	description: string;
	dependencies: string[];
	acceptanceCriteria: string[];
}

export interface TaskPlan {
	version: typeof PLAN_SCHEMA_VERSION;
	title: string;
	tasks: TaskDefinition[];
}

export interface TaskAttempt {
	id: string;
	taskId: string;
	number: number;
	state: AttemptState;
	branch: string;
	worktreePath: string;
	workerId?: string;
	startedAt: string;
	finishedAt?: string;
	error?: string;
	commit?: string;
}

export interface RunTask {
	definition: TaskDefinition;
	state: TaskState;
	attemptIds: string[];
	integratedCommit?: string;
}

export interface HandoffRecord {
	sourcePath: string;
	text: string;
}

export interface BuildRun {
	schemaVersion: typeof RUN_SCHEMA_VERSION;
	id: string;
	state: RunState;
	repositoryRoot: string;
	baseBranch: string;
	baseCommit: string;
	integrationBranch: string;
	handoff: HandoffRecord;
	plan: TaskPlan;
	tasks: Record<string, RunTask>;
	attempts: TaskAttempt[];
	maxConcurrentWorkers: number;
	createdAt: string;
	updatedAt: string;
	approvedAt?: string;
}
