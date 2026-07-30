import type { ArtifactKind } from "../domain/artifacts.js";
import type { StepFailureClass } from "./retry.js";
import type {
	WorkflowRunLifecycleState,
	WorkflowRunState,
} from "./workflow-state.js";
import type { WorkspaceRequirement } from "./workspaces.js";

/**
 * The retained event window. Older events are dropped and counted so a long
 * run stays bounded without ever pretending its timeline is complete.
 */
export const MAX_WORKFLOW_EVENTS = 2_000;

export interface WorkflowEventEnvelope {
	sequence: number;
	at: string;
}

export type WorkflowEventBody =
	| {
			kind: "step_launched";
			stepId: string;
			attemptId: string;
			attemptNumber: number;
			workspaceRequirement: WorkspaceRequirement;
	  }
	| {
			kind: "step_succeeded";
			stepId: string;
			attemptId: string;
			summary?: string;
	  }
	| {
			kind: "step_failed";
			stepId: string;
			attemptId: string;
			error: string;
			failureClass: StepFailureClass;
			reason: string;
	  }
	| {
			kind: "step_retry_scheduled";
			stepId: string;
			attemptId: string;
			nextAttemptNumber: number;
			reason: string;
	  }
	| {
			kind: "step_cancelled";
			stepId: string;
			attemptId?: string;
			error?: string;
	  }
	| { kind: "step_blocked"; stepId: string; blockedBy: string[] }
	| {
			kind: "artifact_published";
			stepId: string;
			attemptId: string;
			artifactId: string;
			output: string;
			artifactKind: ArtifactKind;
			sizeBytes: number;
	  }
	| {
			kind: "step_integrated";
			stepId: string;
			commit?: string;
			integrationHead: string;
	  }
	| { kind: "run_cancellation_requested"; reason: string }
	| {
			kind: "run_settled";
			state: WorkflowRunLifecycleState;
			error?: string;
	  };

export type WorkflowEvent = WorkflowEventEnvelope & WorkflowEventBody;

export function appendWorkflowEvents(
	state: WorkflowRunState,
	bodies: readonly WorkflowEventBody[],
	at: string,
): WorkflowRunState {
	if (bodies.length === 0) {
		return state;
	}
	let sequence = state.eventSequence;
	const events = [...state.events];
	for (const body of bodies) {
		sequence += 1;
		events.push({ sequence, at, ...body });
	}
	const dropped = Math.max(0, events.length - MAX_WORKFLOW_EVENTS);
	return {
		...state,
		events: dropped > 0 ? events.slice(dropped) : events,
		eventSequence: sequence,
		droppedEvents: state.droppedEvents + dropped,
	};
}

export function appendWorkflowEvent(
	state: WorkflowRunState,
	body: WorkflowEventBody,
	at: string,
): WorkflowRunState {
	return appendWorkflowEvents(state, [body], at);
}

/**
 * Derives the `step_blocked` entries of a reconciliation: exactly the steps
 * that just lost every path to running, and the terminal dependencies that
 * stopped them.
 */
export function blockedStepEvents(
	previous: WorkflowRunState,
	next: WorkflowRunState,
): WorkflowEventBody[] {
	const events: WorkflowEventBody[] = [];
	for (const [stepId, record] of Object.entries(next.steps)) {
		if (
			record.state !== "blocked" ||
			previous.steps[stepId]?.state === "blocked"
		) {
			continue;
		}
		const blockedBy = record.definition.dependencies.filter((dependencyId) => {
			const dependency = next.steps[dependencyId];
			return (
				dependency === undefined ||
				dependency.state === "failed" ||
				dependency.state === "blocked" ||
				dependency.state === "cancelled"
			);
		});
		events.push({ kind: "step_blocked", stepId, blockedBy });
	}
	return events;
}
