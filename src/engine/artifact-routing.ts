import {
	type ArtifactKind,
	type ArtifactPayload,
	type ArtifactRecord,
	type ArtifactSummary,
	artifactSummary,
} from "../domain/artifacts.js";
import type { StepDefinition } from "../domain/steps.js";
import type { ArtifactWriteRequest } from "../storage/artifact-store.js";

/** One value a step handler produced for a declared output. */
export interface StepArtifactDraft {
	output: string;
	kind: ArtifactKind;
	title: string;
	payload: ArtifactPayload;
}

/** The write surface artifact routing needs from the artifact store. */
export interface StepArtifactWriter {
	write(request: ArtifactWriteRequest): Promise<ArtifactRecord>;
}

export class StepArtifactRoutingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StepArtifactRoutingError";
	}
}

/**
 * Validates a step's produced artifacts against its declared outputs before
 * anything is stored. Dependent steps resolve inputs by output name, so a
 * missing, duplicated, or undeclared output is a plan violation, not a
 * detail to discover later in a downstream step.
 */
export function planStepArtifacts(
	runId: string,
	step: StepDefinition,
	attemptNumber: number,
	drafts: readonly StepArtifactDraft[],
): ArtifactWriteRequest[] {
	const declared = new Set(step.outputs ?? []);
	const produced = new Set<string>();
	for (const draft of drafts) {
		if (!declared.has(draft.output)) {
			throw new StepArtifactRoutingError(
				`Step ${step.id} produced an artifact for undeclared output ${draft.output}`,
			);
		}
		if (produced.has(draft.output)) {
			throw new StepArtifactRoutingError(
				`Step ${step.id} produced more than one artifact for output ${draft.output}`,
			);
		}
		produced.add(draft.output);
	}
	const missing = [...declared].filter((output) => !produced.has(output));
	if (missing.length > 0) {
		throw new StepArtifactRoutingError(
			`Step ${step.id} did not produce its declared output${
				missing.length === 1 ? "" : "s"
			}: ${missing.join(", ")}`,
		);
	}
	return drafts.map((draft) => ({
		runId,
		stepId: step.id,
		output: draft.output,
		attempt: attemptNumber,
		kind: draft.kind,
		title: draft.title,
		payload: draft.payload,
	}));
}

export async function routeStepArtifacts(
	writer: StepArtifactWriter,
	runId: string,
	step: StepDefinition,
	attemptNumber: number,
	drafts: readonly StepArtifactDraft[],
): Promise<ArtifactSummary[]> {
	const requests = planStepArtifacts(runId, step, attemptNumber, drafts);
	const summaries: ArtifactSummary[] = [];
	for (const request of requests) {
		summaries.push(artifactSummary(await writer.write(request)));
	}
	return summaries;
}
