export const RUN_SCHEMA_VERSION = 2 as const;
export const PLAN_SCHEMA_VERSION = 2 as const;
export const MIN_CONCURRENT_WORKERS = 2 as const;
export const MAX_CONCURRENT_WORKERS = 4 as const;

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
	| "validating"
	| "succeeded"
	| "failed"
	| "blocked"
	| "cancelled";

export type AttemptState =
	| "prepared"
	| "launched"
	| "running"
	| "validating"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "interrupted";

export interface ValidationCommand {
	command: string;
	args: string[];
}

export interface ChangedFileEvidence {
	path: string;
	status: string;
	previousPath?: string;
}

export interface ValidationCheckEvidence {
	command: string;
	args: string[];
	startedAt: string;
	finishedAt: string;
	exitCode: number | null;
	stdoutTail: string;
	stderrTail: string;
	passed: boolean;
}

export interface TaskValidationEvidence {
	startedAt: string;
	finishedAt: string;
	passed: boolean;
	changedFiles: ChangedFileEvidence[];
	diffHash: string;
	checks: ValidationCheckEvidence[];
}

export interface TaskDefinition {
	id: string;
	title: string;
	description: string;
	dependencies: string[];
	acceptanceCriteria: string[];
	allowedPaths: string[];
	validationCommands: ValidationCommand[];
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
	baseCommit: string;
	workerId?: string;
	startedAt: string;
	finishedAt?: string;
	error?: string;
	commit?: string;
	evidence?: TaskValidationEvidence;
}

export const ACTIVE_ATTEMPT_STATES: ReadonlySet<AttemptState> = new Set([
	"prepared",
	"launched",
	"running",
	"validating",
]);

export function isActiveAttemptState(state: AttemptState): boolean {
	return ACTIVE_ATTEMPT_STATES.has(state);
}

export interface RunTask {
	definition: TaskDefinition;
	state: TaskState;
	attemptIds: string[];
	integratedCommit?: string;
	integrationError?: string;
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
