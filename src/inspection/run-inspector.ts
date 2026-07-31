import { stepProfileName } from "../domain/steps.js";
import type { OrchestrationRun } from "../domain/types.js";
import type { ReviewFindingsPayload } from "../engine/steps/review.js";
import type { WorkflowRunState } from "../engine/workflow-state.js";
import type { ArtifactStore } from "../storage/artifact-store.js";
import type { RunStore } from "../storage/run-store.js";
import type { FileWorkflowStateStore } from "../storage/workflow-state-store.js";
import {
	engineRunView,
	legacyRunView,
	type ReviewFindingsByStep,
	type RunView,
} from "./run-view.js";

export interface RunViewSources {
	runs: Pick<RunStore, "load" | "scan">;
	workflowStates: Pick<FileWorkflowStateStore, "has" | "load">;
	/** Optional: without it, review findings are simply not shown. */
	artifacts?: Pick<ArtifactStore, "latest">;
}

/**
 * Reads every review step's published findings.
 *
 * Findings live in the artifact store rather than the run snapshot, so a view
 * that wants them has to resolve them; a finding that cannot be read is left
 * out rather than guessed at.
 */
export async function readReviewFindings(
	artifacts: Pick<ArtifactStore, "latest">,
	state: WorkflowRunState,
	known: ReviewFindingsByStep = new Map(),
): Promise<ReviewFindingsByStep> {
	const findings = new Map<string, ReviewFindingsPayload>(known);
	for (const [stepId, record] of Object.entries(state.steps)) {
		if (
			stepProfileName(record.definition) !== "review" ||
			record.state !== "succeeded" ||
			findings.has(stepId)
		) {
			continue;
		}
		for (const output of record.definition.outputs ?? []) {
			try {
				const artifact = await artifacts.latest(state.id, stepId, output);
				if (artifact) {
					findings.set(
						stepId,
						JSON.parse(artifact.payload) as ReviewFindingsPayload,
					);
				}
			} catch {
				// An unreadable or malformed findings artifact must never stop a
				// reader from inspecting the rest of the run.
			}
		}
	}
	return findings;
}

/**
 * Reads one run the way every inspection and control surface should.
 *
 * A run with a durable workflow snapshot is read from that snapshot, because
 * the engine is its execution record. A run without one executed under the
 * legacy orchestrator and is read from the stored run itself.
 */
export async function runView(
	sources: RunViewSources,
	run: OrchestrationRun,
): Promise<RunView> {
	if (!(await sources.workflowStates.has(run.id))) {
		return legacyRunView(run);
	}
	const state = await sources.workflowStates.load(run.id);
	const findings = sources.artifacts
		? await readReviewFindings(sources.artifacts, state)
		: new Map();
	return engineRunView(run, state, findings);
}

export async function loadRunView(
	sources: RunViewSources,
	runId: string,
): Promise<RunView> {
	return runView(sources, await sources.runs.load(runId));
}

export interface RunViewScan {
	views: RunView[];
	unreadable: { runId: string; error: string }[];
}

/** Every run of one repository, each read from its own execution record. */
export async function scanRunViews(
	sources: RunViewSources,
	repositoryRoot: string,
): Promise<RunViewScan> {
	const entries = await sources.runs.scan();
	const views: RunView[] = [];
	const unreadable: { runId: string; error: string }[] = [];
	for (const entry of entries) {
		if (entry.kind === "unreadable") {
			unreadable.push({ runId: entry.runId, error: entry.error });
			continue;
		}
		if (entry.run.repositoryRoot !== repositoryRoot) {
			continue;
		}
		try {
			views.push(await runView(sources, entry.run));
		} catch (error) {
			unreadable.push({
				runId: entry.run.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { views, unreadable };
}
