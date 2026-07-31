import type { StepDefinition, WorkflowPlan } from "../domain/steps.js";
import type {
	AttemptState,
	RunCapabilityProfiles,
	TaskValidationEvidence,
} from "../domain/types.js";
import type { WorkflowEvent } from "./events.js";
import type { WorkspaceRequirement } from "./workspaces.js";

/**
 * The lifecycle of one workflow step inside an engine run. The vocabulary
 * matches the legacy task lifecycle so a persisted run can project onto it
 * without inventing new state names.
 */
export type StepRunState =
	| "planned"
	| "ready"
	| "running"
	| "succeeded"
	| "failed"
	| "blocked"
	| "cancelled";

export type WorkflowRunLifecycleState =
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export const TERMINAL_STEP_STATES: ReadonlySet<StepRunState> = new Set([
	"succeeded",
	"failed",
	"blocked",
	"cancelled",
]);

export const TERMINAL_STEP_FAILURE_STATES: ReadonlySet<StepRunState> = new Set([
	"failed",
	"blocked",
	"cancelled",
]);

/** One execution of one step, including the workspace it ran in. */
export interface WorkflowStepAttempt {
	id: string;
	stepId: string;
	number: number;
	state: AttemptState;
	workspaceRequirement: WorkspaceRequirement;
	workspacePath: string;
	branch?: string;
	baseCommit: string;
	startedAt: string;
	finishedAt?: string;
	summary?: string;
	error?: string;
	/** The worker process that ran this attempt, for output inspection. */
	workerId?: string;
	commit?: string;
	/** The focused checks that justified this attempt's commit. */
	evidence?: TaskValidationEvidence;
	/** The artifacts this attempt published for the step's declared outputs. */
	artifactIds?: string[];
	/**
	 * A workspace that could not be released after a successful step. The
	 * workspace of an unsuccessful step is deliberately retained as evidence.
	 */
	workspaceReleaseError?: string;
}

export interface WorkflowStepRecord {
	definition: StepDefinition;
	state: StepRunState;
	attemptIds: string[];
	/**
	 * The integration-branch commit carrying this step's repository changes.
	 * Steps without `mutate-repository` authority never produce one.
	 */
	integratedCommit?: string;
	integrationError?: string;
	error?: string;
}

export interface WorkflowRunState {
	id: string;
	state: WorkflowRunLifecycleState;
	plan: WorkflowPlan;
	repositoryRoot: string;
	baseBranch: string;
	baseCommit: string;
	integrationBranch: string;
	integrationHead: string;
	capabilityProfiles: RunCapabilityProfiles;
	steps: Record<string, WorkflowStepRecord>;
	attempts: WorkflowStepAttempt[];
	/** The retained tail of the ordered run timeline. */
	events: WorkflowEvent[];
	/** The highest event sequence ever assigned, including dropped events. */
	eventSequence: number;
	/** How many timeline entries fell out of the retained window. */
	droppedEvents: number;
	maxConcurrentWorkers: number;
	/** Why the run stopped, when the reason is not a single step's failure. */
	error?: string;
	createdAt: string;
	updatedAt: string;
}

export interface CreateWorkflowRunStateInput {
	id: string;
	plan: WorkflowPlan;
	repositoryRoot: string;
	baseBranch: string;
	baseCommit: string;
	integrationBranch: string;
	integrationHead: string;
	capabilityProfiles: RunCapabilityProfiles;
	maxConcurrentWorkers: number;
	createdAt?: string;
}

export function createWorkflowRunState(
	input: CreateWorkflowRunStateInput,
): WorkflowRunState {
	if (
		!Number.isSafeInteger(input.maxConcurrentWorkers) ||
		input.maxConcurrentWorkers < 1
	) {
		throw new Error("maxConcurrentWorkers must be a positive integer");
	}
	const createdAt = input.createdAt ?? new Date().toISOString();
	const steps: Record<string, WorkflowStepRecord> = {};
	for (const definition of input.plan.steps) {
		steps[definition.id] = {
			definition,
			state: definition.dependencies.length === 0 ? "ready" : "planned",
			attemptIds: [],
		};
	}
	return {
		id: input.id,
		state: "running",
		plan: input.plan,
		repositoryRoot: input.repositoryRoot,
		baseBranch: input.baseBranch,
		baseCommit: input.baseCommit,
		integrationBranch: input.integrationBranch,
		integrationHead: input.integrationHead,
		capabilityProfiles: input.capabilityProfiles,
		steps,
		attempts: [],
		events: [],
		eventSequence: 0,
		droppedEvents: 0,
		maxConcurrentWorkers: input.maxConcurrentWorkers,
		createdAt,
		updatedAt: createdAt,
	};
}

export function requireStep(
	state: WorkflowRunState,
	stepId: string,
): WorkflowStepRecord {
	const record = state.steps[stepId];
	if (!record) {
		throw new Error(`Step disappeared from run state: ${stepId}`);
	}
	return record;
}

export function stepDefinition(
	state: WorkflowRunState,
	stepId: string,
): StepDefinition {
	return requireStep(state, stepId).definition;
}

export function updateStep(
	state: WorkflowRunState,
	stepId: string,
	update: Partial<WorkflowStepRecord>,
): WorkflowRunState {
	const record = requireStep(state, stepId);
	return {
		...state,
		steps: { ...state.steps, [stepId]: { ...record, ...update } },
	};
}

export function updateStepAttempt(
	state: WorkflowRunState,
	attemptId: string,
	update: Partial<WorkflowStepAttempt>,
): WorkflowRunState {
	return {
		...state,
		attempts: state.attempts.map((attempt) =>
			attempt.id === attemptId ? { ...attempt, ...update } : attempt,
		),
	};
}

export function findStepAttempt(
	state: WorkflowRunState,
	attemptId: string,
): WorkflowStepAttempt | undefined {
	return state.attempts.find((attempt) => attempt.id === attemptId);
}
