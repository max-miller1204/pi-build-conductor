import type { StepExecutionContext } from "../domain/step-context.js";
import {
	type StepDefinition,
	type StepKind,
	stepProfileName,
} from "../domain/steps.js";
import type {
	CapabilityProfile,
	CapabilityProfileName,
	TaskValidationEvidence,
} from "../domain/types.js";
import type { RepositoryInfo } from "../git/git.js";
import type { StepArtifactDraft } from "./artifact-routing.js";
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
			/** The focused checks that justified the commit. */
			evidence?: TaskValidationEvidence;
			/** One artifact per output the step declared. */
			artifacts?: StepArtifactDraft[];
	  }
	| {
			status: "failed";
			error: string;
			/**
			 * Whether running the step again could succeed. Handlers set this
			 * when they know: a rejected diff is permanent, a lost worker is not.
			 * Undeclared failures stay retryable within the step's retry budget.
			 */
			retryable?: boolean;
	  }
	| { status: "cancelled"; error: string };

/**
 * One step kind's execution strategy. Handlers own how a step is carried out;
 * the engine owns when it runs, where it runs, and what its result means.
 */
export interface StepHandler {
	readonly kind: StepKind;
	/** Defaults to the kind's own profile when a handler serves the default. */
	readonly profile?: CapabilityProfileName;
	execute(context: StepHandlerContext): Promise<StepOutcome>;
}

export function stepHandlerProfile(
	handler: StepHandler,
): CapabilityProfileName {
	return handler.profile ?? handler.kind;
}

export class UnsupportedStepKindError extends Error {
	constructor(readonly profile: CapabilityProfileName) {
		super(`No step handler is registered for ${profile} steps`);
		this.name = "UnsupportedStepKindError";
	}
}

/**
 * Resolves step profiles to handlers, failing closed: a workflow containing a
 * profile this engine cannot execute never starts that step.
 */
export class StepHandlerRegistry {
	private readonly handlers = new Map<CapabilityProfileName, StepHandler>();

	constructor(handlers: readonly StepHandler[] = []) {
		for (const handler of handlers) {
			const profile = stepHandlerProfile(handler);
			if (this.handlers.has(profile)) {
				throw new Error(`Duplicate step handler for kind ${profile}`);
			}
			this.handlers.set(profile, handler);
		}
	}

	kinds(): CapabilityProfileName[] {
		return [...this.handlers.keys()];
	}

	has(profile: CapabilityProfileName): boolean {
		return this.handlers.has(profile);
	}

	handlerFor(step: StepDefinition): StepHandler {
		const profile = stepProfileName(step);
		const handler = this.handlers.get(profile);
		if (!handler) {
			throw new UnsupportedStepKindError(profile);
		}
		return handler;
	}
}
