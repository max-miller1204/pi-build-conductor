import type { StepExecutionContext } from "../domain/step-context.js";
import type { StepDefinition, StepKind } from "../domain/steps.js";
import type { CapabilityProfile } from "../domain/types.js";
import type { RepositoryInfo } from "../git/git.js";
import type { WorkflowStepAttempt } from "./workflow-state.js";
import type { Workspace } from "./workspaces.js";

/** Everything a step handler is given, and the only authority it may use. */
export interface StepHandlerContext {
	runId: string;
	repository: RepositoryInfo;
	step: StepDefinition;
	attempt: WorkflowStepAttempt;
	workspace: Workspace;
	/** The repository snapshot and resolved upstream artifacts of this step. */
	execution: StepExecutionContext;
	/** The frozen run profile narrowed to this step's declared capabilities. */
	capabilityProfile: CapabilityProfile;
	/** Aborted when the step times out or the run is cancelled. */
	signal: AbortSignal;
	now(): string;
}

export type StepOutcome =
	| {
			status: "succeeded";
			summary?: string;
			/** The step branch commit an integrating step produced. */
			commit?: string;
	  }
	| { status: "failed"; error: string }
	| { status: "cancelled"; error: string };

/**
 * One step kind's execution strategy. Handlers own how a step is carried out;
 * the engine owns when it runs, where it runs, and what its result means.
 */
export interface StepHandler {
	readonly kind: StepKind;
	execute(context: StepHandlerContext): Promise<StepOutcome>;
}

export class UnsupportedStepKindError extends Error {
	constructor(readonly kind: StepKind) {
		super(`No step handler is registered for ${kind} steps`);
		this.name = "UnsupportedStepKindError";
	}
}

/**
 * Resolves step kinds to handlers, failing closed: a workflow containing a
 * kind this engine cannot execute never starts that step.
 */
export class StepHandlerRegistry {
	private readonly handlers = new Map<StepKind, StepHandler>();

	constructor(handlers: readonly StepHandler[] = []) {
		for (const handler of handlers) {
			if (this.handlers.has(handler.kind)) {
				throw new Error(`Duplicate step handler for kind ${handler.kind}`);
			}
			this.handlers.set(handler.kind, handler);
		}
	}

	kinds(): StepKind[] {
		return [...this.handlers.keys()];
	}

	has(kind: StepKind): boolean {
		return this.handlers.has(kind);
	}

	handlerFor(step: StepDefinition): StepHandler {
		const handler = this.handlers.get(step.kind);
		if (!handler) {
			throw new UnsupportedStepKindError(step.kind);
		}
		return handler;
	}
}
