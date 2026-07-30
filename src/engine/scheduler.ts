import {
	type StepDefinition,
	stepPathLocks,
	stepResourceLocks,
	topologicalStepIds,
} from "../domain/steps.js";
import { isActiveAttemptState } from "../domain/types.js";
import {
	requireStep,
	type StepRunState,
	TERMINAL_STEP_FAILURE_STATES,
	TERMINAL_STEP_STATES,
	type WorkflowRunState,
	type WorkflowStepRecord,
} from "./workflow-state.js";
import {
	stepConsumesWorkerSlot,
	stepRequiresIntegration,
} from "./workspaces.js";

/**
 * A dependency only unblocks its dependents once its result is present in the
 * repository state those dependents will start from, so a mutating step must
 * also be integrated.
 */
export function stepSatisfiesDependents(
	state: WorkflowRunState,
	record: WorkflowStepRecord,
): boolean {
	if (record.state !== "succeeded") {
		return false;
	}
	return (
		!stepRequiresIntegration(state.capabilityProfiles, record.definition) ||
		record.integratedCommit !== undefined
	);
}

function nextStepState(
	state: WorkflowRunState,
	record: WorkflowStepRecord,
	steps: Record<string, WorkflowStepRecord>,
): StepRunState {
	if (record.state === "running" || TERMINAL_STEP_STATES.has(record.state)) {
		return record.state;
	}
	const dependencies = record.definition.dependencies.map((id) => steps[id]);
	if (
		dependencies.some(
			(dependency) =>
				dependency === undefined ||
				TERMINAL_STEP_FAILURE_STATES.has(dependency.state),
		)
	) {
		return "blocked";
	}
	return dependencies.every((dependency) =>
		dependency ? stepSatisfiesDependents(state, dependency) : false,
	)
		? "ready"
		: "planned";
}

/**
 * Recomputes every non-terminal step state from its dependencies. Blocked
 * steps propagate: a step whose dependency failed can never become ready.
 */
export function reconcileWorkflowSteps(
	state: WorkflowRunState,
): WorkflowRunState {
	const steps = { ...state.steps };
	for (const stepId of topologicalStepIds(state.plan)) {
		const record = steps[stepId];
		if (record) {
			steps[stepId] = {
				...record,
				state: nextStepState(state, record, steps),
			};
		}
	}
	return { ...state, steps };
}

function pathLockCovers(prefix: string, path: string): boolean {
	return prefix.endsWith("/") && path.startsWith(prefix);
}

/** Path locks are exclusive: any containment relation is a conflict. */
export function pathLocksConflict(left: string, right: string): boolean {
	return (
		left === right || pathLockCovers(left, right) || pathLockCovers(right, left)
	);
}

/** Every lock one running step holds, both repository paths and named resources. */
interface HeldLocks {
	paths: string[];
	resources: Set<string>;
}

function heldLocksOf(records: readonly WorkflowStepRecord[]): HeldLocks {
	return {
		paths: records.flatMap((record) => stepPathLocks(record.definition)),
		resources: new Set(
			records.flatMap((record) => stepResourceLocks(record.definition)),
		),
	};
}

function conflictsWithHeldLocks(
	step: StepDefinition,
	held: HeldLocks,
): boolean {
	return (
		stepPathLocks(step).some((lock) =>
			held.paths.some((heldLock) => pathLocksConflict(lock, heldLock)),
		) || stepResourceLocks(step).some((lock) => held.resources.has(lock))
	);
}

function holdLocks(held: HeldLocks, step: StepDefinition): void {
	held.paths.push(...stepPathLocks(step));
	for (const lock of stepResourceLocks(step)) {
		held.resources.add(lock);
	}
}

/**
 * Selects the steps that may start now, in deterministic plan order, honouring
 * dependency readiness, worker-slot concurrency, and exclusive path locks.
 */
export function launchableStepIds(state: WorkflowRunState): string[] {
	if (state.state !== "running") {
		return [];
	}
	const reconciled = reconcileWorkflowSteps(state);
	const activeAttempts = reconciled.attempts.filter((attempt) =>
		isActiveAttemptState(attempt.state),
	);
	const stepsWithActiveAttempts = new Set(
		activeAttempts.map((attempt) => attempt.stepId),
	);
	const consumesSlot = (stepId: string): boolean =>
		stepConsumesWorkerSlot(
			reconciled.capabilityProfiles,
			requireStep(reconciled, stepId).definition,
		);
	// Steps left running by an interrupted process still hold their slot until
	// recovery settles them, so they are counted even without a live attempt.
	const untrackedRunning = Object.entries(reconciled.steps).filter(
		([stepId, record]) =>
			record.state === "running" && !stepsWithActiveAttempts.has(stepId),
	);
	const occupiedSlots =
		activeAttempts.filter((attempt) => consumesSlot(attempt.stepId)).length +
		untrackedRunning.filter(([stepId]) => consumesSlot(stepId)).length;
	let availableSlots = Math.max(
		0,
		reconciled.maxConcurrentWorkers - occupiedSlots,
	);
	const held = heldLocksOf(
		Object.values(reconciled.steps).filter(
			(record) => record.state === "running",
		),
	);
	const launchable: string[] = [];
	for (const stepId of topologicalStepIds(reconciled.plan)) {
		const record = reconciled.steps[stepId];
		if (
			!record ||
			record.state !== "ready" ||
			stepsWithActiveAttempts.has(stepId)
		) {
			continue;
		}
		if (conflictsWithHeldLocks(record.definition, held)) {
			continue;
		}
		const needsSlot = consumesSlot(stepId);
		if (needsSlot && availableSlots === 0) {
			continue;
		}
		launchable.push(stepId);
		holdLocks(held, record.definition);
		if (needsSlot) {
			availableSlots -= 1;
		}
	}
	return launchable;
}

/** The first mutating step whose commit still has to reach the integration branch. */
export function nextIntegrableStepId(
	state: WorkflowRunState,
): string | undefined {
	for (const stepId of topologicalStepIds(state.plan)) {
		const record = state.steps[stepId];
		if (!record) {
			continue;
		}
		if (!stepRequiresIntegration(state.capabilityProfiles, record.definition)) {
			continue;
		}
		if (record.integratedCommit) {
			continue;
		}
		return record.state === "succeeded" ? stepId : undefined;
	}
	return undefined;
}
