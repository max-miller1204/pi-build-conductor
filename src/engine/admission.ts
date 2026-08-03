import { PlanValidationError } from "../domain/dag.js";
import {
	type StepDefinition,
	validateWorkflowPlan,
	type WorkflowPlan,
} from "../domain/steps.js";
import {
	AuthorityViolationError,
	planAuthorityIssues,
} from "../security/authority.js";
import { appendWorkflowEvents, type WorkflowEventBody } from "./events.js";
import { reconcileWorkflowSteps } from "./scheduler.js";
import type { WorkflowStateStore } from "./state-store.js";
import type { WorkflowRunState, WorkflowStepRecord } from "./workflow-state.js";

/**
 * The most steps one run's graph may ever hold. A session that chooses its own
 * work needs room to grow, and a bound is what keeps "chooses its own work"
 * from meaning "grows without end"; reaching it refuses further admission.
 */
export const MAX_WORKFLOW_PLAN_STEPS = 200;

export class StepAdmissionError extends Error {
	readonly issues: string[];

	constructor(message: string, issues: readonly string[] = []) {
		super(
			issues.length > 0 ? `${message}:\n- ${issues.join("\n- ")}` : message,
		);
		this.name = "StepAdmissionError";
		this.issues = [...issues];
	}
}

export interface StepAdmissionRequest {
	/** The step definition documents the running session proposes. */
	steps: readonly unknown[];
	/** The running step whose session proposed them. */
	proposedBy: string;
	/** Why this work turned out to be necessary, for the run timeline. */
	reason: string;
}

function requireRunningProposer(
	state: WorkflowRunState,
	proposedBy: string,
): void {
	const proposer = state.steps[proposedBy];
	if (!proposer) {
		throw new StepAdmissionError(
			`Step ${proposedBy} is not part of run ${state.id}, so it cannot propose work for it`,
		);
	}
	// Admission is a running session growing its own graph. Anything else is
	// either a plan revision, which happens before approval, or invalid here.
	if (proposer.state !== "running") {
		throw new StepAdmissionError(
			`Step ${proposedBy} is ${proposer.state}, and only a running step can propose further work`,
		);
	}
}

function grownPlan(
	state: WorkflowRunState,
	proposed: readonly unknown[],
): WorkflowPlan {
	const existing = new Set(state.plan.steps.map((step) => step.id));
	const collisions = proposed.flatMap((step) => {
		const id =
			typeof step === "object" && step !== null
				? (step as { id?: unknown }).id
				: undefined;
		return typeof id === "string" && existing.has(id) ? [id] : [];
	});
	if (collisions.length > 0) {
		throw new StepAdmissionError(
			"Proposed steps collide with steps this run already has",
			[...new Set(collisions)].map((id) => `step id ${id} already exists`),
		);
	}
	let plan: WorkflowPlan;
	try {
		plan = validateWorkflowPlan({
			...state.plan,
			steps: [...state.plan.steps, ...proposed],
		});
	} catch (error) {
		if (error instanceof PlanValidationError) {
			throw new StepAdmissionError(
				"Proposed steps do not form a valid workflow plan",
				error.issues,
			);
		}
		throw error;
	}
	// Growth is append-only. Rewriting an approved step, or the validation the
	// run settles on, is a different decision from adding work to the graph.
	const unchanged = plan.steps.slice(0, state.plan.steps.length);
	if (JSON.stringify(unchanged) !== JSON.stringify(state.plan.steps)) {
		throw new StepAdmissionError(
			"Admitting steps cannot change the steps this run already has",
		);
	}
	return plan;
}

/**
 * Admits the steps a running session proposed into its own workflow graph.
 *
 * Nothing enters the graph that the frozen envelope does not already allow, so
 * a session can decide what work is needed without ever deciding what
 * authority it holds. Growth is append-only and bounded: existing steps, their
 * order, and the validation the run settles on are unchanged, which is what
 * keeps the integrated prefix and every durable invariant true afterwards.
 */
export function admitSteps(
	state: WorkflowRunState,
	request: StepAdmissionRequest,
	at: string,
): WorkflowRunState {
	if (state.state !== "running") {
		throw new StepAdmissionError(
			`Run ${state.id} is ${state.state}, so it can no longer admit steps`,
		);
	}
	const authority = state.authority;
	if (!authority) {
		// Without a frozen envelope there is nothing to bound the growth, and a
		// session must never be the thing that decides its own authority.
		throw new StepAdmissionError(
			`Run ${state.id} has no frozen authority envelope, so it cannot admit steps`,
		);
	}
	if (request.steps.length === 0) {
		throw new StepAdmissionError("At least one step must be proposed");
	}
	if (request.reason.trim().length === 0) {
		throw new StepAdmissionError("Admitted steps must record why they exist");
	}
	requireRunningProposer(state, request.proposedBy);
	if (
		state.plan.steps.length + request.steps.length >
		MAX_WORKFLOW_PLAN_STEPS
	) {
		throw new StepAdmissionError(
			`A run may hold at most ${MAX_WORKFLOW_PLAN_STEPS} steps, and this run already has ${state.plan.steps.length}`,
		);
	}
	const plan = grownPlan(state, request.steps);
	const admitted = plan.steps.slice(state.plan.steps.length);
	const issues = planAuthorityIssues(
		plan,
		authority.envelope,
		state.repositoryRoot,
		state.capabilityProfiles,
	);
	if (issues.length > 0) {
		throw new AuthorityViolationError(issues);
	}
	const steps: Record<string, WorkflowStepRecord> = { ...state.steps };
	for (const definition of admitted) {
		steps[definition.id] = {
			definition,
			state: "planned",
			attemptIds: [],
		};
	}
	const events: WorkflowEventBody[] = admitted.map((definition) => ({
		kind: "step_admitted" as const,
		stepId: definition.id,
		proposedBy: request.proposedBy,
		reason: request.reason,
	}));
	return appendWorkflowEvents(
		reconcileWorkflowSteps({ ...state, plan, steps, updatedAt: at }),
		events,
		at,
	);
}

export interface AdmitWorkflowStepsOptions {
	now?: () => string;
}

/**
 * Admits proposed steps into a durable run, atomically with everything else
 * that transaction observes, so a graph that grew is recoverable exactly like
 * one that was approved whole.
 */
export async function admitWorkflowSteps(
	store: WorkflowStateStore,
	runId: string,
	request: StepAdmissionRequest,
	options: AdmitWorkflowStepsOptions = {},
): Promise<{ state: WorkflowRunState; admitted: StepDefinition[] }> {
	const now = options.now ?? (() => new Date().toISOString());
	let admitted: StepDefinition[] = [];
	const state = await store.transaction(runId, (current) => {
		const before = new Set(Object.keys(current.steps));
		const next = admitSteps(current, request, now());
		admitted = next.plan.steps.filter((step) => !before.has(step.id));
		return next;
	});
	return { state, admitted };
}
