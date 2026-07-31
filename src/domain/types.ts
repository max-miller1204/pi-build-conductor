export const RUN_SCHEMA_VERSION = 9 as const;
export const PLAN_SCHEMA_VERSION = 3 as const;
export const MERGE_READY_EVIDENCE_VERSION = 2 as const;
export const MIN_CONCURRENT_WORKERS = 2 as const;
export const MAX_CONCURRENT_WORKERS = 4 as const;

export type RunState =
	| "planning"
	| "awaiting_approval"
	| "running"
	| "integrating"
	| "reviewing"
	| "repairing"
	| "reviewed"
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

/**
 * The capability vocabulary shared by workflow step declarations and worker
 * authority profiles. External effects (deployment, publishing, cloud
 * administration, remote mutation) are deliberately not expressible.
 */
export const STEP_CAPABILITIES = [
	"read-repository",
	"mutate-repository",
	"execute-commands",
] as const;

export type StepCapability = (typeof STEP_CAPABILITIES)[number];

/**
 * A frozen worker authority profile: the capabilities one worker archetype
 * may exercise and the exact tool allowlist that enforces them.
 */
export interface CapabilityProfile {
	capabilities: StepCapability[];
	tools: string[];
	resourceDiscovery: "disabled";
	externalEffects: "forbidden";
}

export const CAPABILITY_PROFILE_NAMES = [
	"investigation",
	"change",
	"command",
	"approval",
	"review",
	"repair",
] as const;

export type CapabilityProfileName = (typeof CAPABILITY_PROFILE_NAMES)[number];

export type RunCapabilityProfiles = Record<
	CapabilityProfileName,
	CapabilityProfile
>;

export type ValidationSandboxMode = "none" | "nono";
export type WorkerRole = "implementation" | "review" | "repair";

export interface ValidationExecutionBoundary {
	sandbox: ValidationSandboxMode;
	network: "host" | "blocked";
	environment: "temporary-home-reduced";
}

export interface WorkerLaunchPolicy {
	version: 1;
	role: WorkerRole;
	tools: string[];
	resourceDiscovery: "disabled";
}

export interface RunSecurityPolicy {
	/**
	 * Version 1 policies predate capability profiles and resolve worker
	 * authority from fixed role defaults. Version 2 policies freeze the
	 * complete capability profile snapshot at run creation.
	 */
	version: 1 | 2;
	source: "configured" | "legacy-migrated";
	workers: {
		isolation: "worktree-only";
		sandbox: "none";
		network: "host";
		toolPolicy:
			| "server-allowlist-v1"
			| "orchestrator-allowlist-v1"
			| "legacy-unrestricted";
		resourceDiscovery: "disabled" | "host";
		credentialExposure: "host-credentials-available-to-worker";
		uiPolicy: BlockedWorkerPolicy;
		/** Present exactly when `version` is 2. */
		capabilityProfiles?: RunCapabilityProfiles;
	};
	validation: ValidationExecutionBoundary & {
		sandboxExecutable?: string;
	};
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
	executionBoundary?: ValidationExecutionBoundary;
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
	finalValidationCommands: ValidationCommand[];
}

export type PlanRevisionSource =
	| "generated"
	| "sidecar"
	| "edited"
	| "restored"
	| "migrated";

export interface PlanRevision {
	number: number;
	createdAt: string;
	source: PlanRevisionSource;
	plan: TaskPlan;
	maxConcurrentWorkers: number;
	restoredFrom?: number;
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

export type WorkerUiMethod = "select" | "confirm" | "input" | "editor";

export type WorkerUiRequest =
	| {
			id: string;
			method: "select";
			title: string;
			options: string[];
			timeoutMs?: number;
	  }
	| {
			id: string;
			method: "confirm";
			title: string;
			message: string;
			timeoutMs?: number;
	  }
	| {
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeoutMs?: number;
	  }
	| {
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
	  };

export type WorkerUiResponse =
	| { kind: "value"; value: string }
	| { kind: "confirmation"; confirmed: boolean }
	| { kind: "cancelled" };

export type BlockedWorkerPolicy = "decline" | "cancel";

export interface BlockedWorkerState {
	attemptKind: "task" | "review" | "repair";
	attemptId: string;
	workerId: string;
	blockedAt: string;
	requestId: string;
	method: WorkerUiMethod;
	timeoutAt?: string;
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

export const REVIEW_CATEGORIES = [
	"correctness",
	"security",
	"maintainability",
	"tests",
	"documentation",
] as const;

export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number];
export type ReviewSeverity = "critical" | "high" | "medium" | "low";
export type ReviewConfidence = "high" | "medium" | "low";
export type ReviewFindingStatus =
	| "repair_required"
	| "deferred"
	| "repaired"
	| "unresolved";

export interface ReviewFinding {
	id: string;
	category: ReviewCategory;
	severity: ReviewSeverity;
	confidence: ReviewConfidence;
	title: string;
	description: string;
	paths: string[];
	recommendation: string;
	status: ReviewFindingStatus;
	repairAttemptId?: string;
}

export interface ReviewAttempt {
	id: string;
	round: number;
	category: ReviewCategory;
	number: number;
	state: AttemptState;
	/** Absent for a review that read a detached, branchless worktree. */
	branch?: string;
	worktreePath: string;
	baseCommit: string;
	workerId?: string;
	startedAt: string;
	finishedAt?: string;
	error?: string;
	summary?: string;
	findings?: ReviewFinding[];
}

export type ReviewRoundState =
	| "running"
	| "repairing"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface ReviewRound {
	number: number;
	state: ReviewRoundState;
	baseCommit: string;
	attemptIds: string[];
	startedAt: string;
	finishedAt?: string;
	repairAttemptId?: string;
	error?: string;
}

export interface RepairAttempt {
	id: string;
	round: number;
	number: number;
	state: AttemptState;
	findingIds: string[];
	branch: string;
	worktreePath: string;
	baseCommit: string;
	workerId?: string;
	startedAt: string;
	finishedAt?: string;
	error?: string;
	commit?: string;
	integratedCommit?: string;
	evidence?: TaskValidationEvidence;
}

export interface RunRequest {
	sourcePath: string;
	text: string;
}

export type FinalValidationAttemptState =
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "interrupted";

export interface FinalValidationEvidence {
	startedAt: string;
	finishedAt: string;
	passed: boolean;
	checks: ValidationCheckEvidence[];
}

export interface FinalValidationAttempt {
	id: string;
	number: number;
	state: FinalValidationAttemptState;
	integrationCommit: string;
	worktreePath: string;
	startedAt: string;
	finishedAt?: string;
	error?: string;
	evidence?: FinalValidationEvidence;
}

export interface IntegratedCommitEvidence {
	kind: "task" | "repair";
	id: string;
	sourceCommit: string;
	integratedCommit: string;
}

export interface GitCommitEvidence {
	hash: string;
	parent: string;
	subject: string;
}

export interface GitVerificationEvidence {
	verifiedAt: string;
	integrationBranch: string;
	integrationHead: string;
	baseBranch: string;
	baseCommit: string;
	commits: GitCommitEvidence[];
	userWorktreeClean: true;
	userBranch: string;
	userHead: string;
}

export interface FinalReviewSummary {
	category: ReviewCategory;
	summary: string;
}

export interface MergeReadyEvidence {
	version: typeof MERGE_READY_EVIDENCE_VERSION;
	generatedAt: string;
	securityPolicy: RunSecurityPolicy;
	integrationBranch: string;
	integrationHead: string;
	baseBranch: string;
	baseCommit: string;
	commits: IntegratedCommitEvidence[];
	finalReviews: FinalReviewSummary[];
	remainingRisks: ReviewFinding[];
	finalChecks: ValidationCheckEvidence[];
	git: GitVerificationEvidence;
}

export interface OrchestrationRun {
	schemaVersion: typeof RUN_SCHEMA_VERSION;
	revision: number;
	id: string;
	state: RunState;
	repositoryRoot: string;
	baseBranch: string;
	baseCommit: string;
	integrationBranch: string;
	request: RunRequest;
	securityPolicy: RunSecurityPolicy;
	plan: TaskPlan;
	planRevision: number;
	planRevisions: PlanRevision[];
	approvedPlanRevision?: number;
	tasks: Record<string, RunTask>;
	attempts: TaskAttempt[];
	integrationHead: string;
	reviewRounds: ReviewRound[];
	reviewAttempts: ReviewAttempt[];
	repairAttempts: RepairAttempt[];
	blockedWorkers: BlockedWorkerState[];
	finalValidationAttempts: FinalValidationAttempt[];
	mergeReadyEvidence?: MergeReadyEvidence;
	maxConcurrentWorkers: number;
	createdAt: string;
	updatedAt: string;
	approvedAt?: string;
}
