import type { GitClient } from "../../git/git.js";
import {
	GitRepositoryReader,
	type RepositoryFileReader,
} from "../../git/repository-reader.js";
import {
	renderPlanRepositoryIssues,
	validatePlanAgainstRepository,
} from "../../planning/plan-repository-validation.js";
import type {
	PlanningDocument,
	PlanningWorker,
} from "../../planning/planning-worker.js";
import {
	discoverRepositoryProfile,
	type RepositoryDiscoveryOptions,
} from "../../planning/repository-discovery.js";
import { CapabilityViolationError } from "../../security/capabilities.js";
import type {
	StepHandler,
	StepHandlerContext,
	StepOutcome,
} from "../handlers.js";
import { assertUnchangedWorkspace } from "./outputs.js";

export interface PlanningStepHandlerOptions {
	worker: PlanningWorker;
	git: Pick<GitClient, "status">;
	/** The user request the proposed plan must fulfil. */
	requestText: string;
	discoveryOptions?: RepositoryDiscoveryOptions;
	/** Test seam; defaults to a Git reader over the step workspace. */
	readerFor?: (workspacePath: string) => RepositoryFileReader;
}

/**
 * Executes the read-only planning flow as one workflow step: deterministic
 * repository discovery at the step's snapshot commit, the planning worker,
 * repository-level plan validation, and one decision artifact holding the
 * validated, evidence-backed plan document.
 */
export class PlanningStepHandler implements StepHandler {
	readonly kind = "investigation" as const;

	constructor(private readonly options: PlanningStepHandlerOptions) {}

	async execute(context: StepHandlerContext): Promise<StepOutcome> {
		const step = context.step;
		if (step.kind !== "investigation") {
			return {
				status: "failed",
				error: `Planning handler received a ${step.kind} step`,
				retryable: false,
			};
		}
		const output = (step.outputs ?? [])[0];
		if (!output || (step.outputs ?? []).length !== 1) {
			return {
				status: "failed",
				error: `Planning step ${step.id} must declare exactly one plan document output`,
				retryable: false,
			};
		}
		const reader =
			this.options.readerFor?.(context.workspace.path) ??
			new GitRepositoryReader(context.workspace.path);
		const commit = context.execution.repositorySnapshot.commit;
		let document: PlanningDocument;
		let repositoryPaths: string[];
		let warnings: string[];
		try {
			const listing = await reader.listFiles(commit);
			const profile = await discoverRepositoryProfile(reader, commit, {
				...this.options.discoveryOptions,
				listing,
			});
			document = await this.options.worker.plan({
				repositoryRoot: context.workspace.path,
				requestText: this.options.requestText,
				profile,
				signal: context.signal,
				identity: {
					runId: context.runId,
					stepId: step.id,
					attemptId: context.attempt.id,
				},
			});
			repositoryPaths = listing.files.map((file) => file.path);
			const validation = validatePlanAgainstRepository(document.plan, {
				paths: repositoryPaths,
				detectedCommands: profile.detectedCommands,
			});
			if (!validation.ok) {
				const errors = validation.issues.filter(
					(issue) => issue.severity === "error",
				);
				return {
					status: "failed",
					error: `The proposed plan conflicts with the repository at ${commit}:\n${renderPlanRepositoryIssues(errors).join("\n")}`,
				};
			}
			warnings = renderPlanRepositoryIssues(
				validation.issues.filter((issue) => issue.severity === "warning"),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return context.signal.aborted
				? { status: "cancelled", error: message }
				: { status: "failed", error: message };
		}
		try {
			await assertUnchangedWorkspace(
				this.options.git,
				context.capabilityProfile,
				context.workspace,
			);
		} catch (error) {
			return {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				retryable: !(error instanceof CapabilityViolationError),
			};
		}
		const summary = [
			`Proposed plan "${document.plan.title}" with ${document.plan.tasks.length} tasks and ${document.observations.length} observations`,
			...(warnings.length > 0
				? [`${warnings.length} repository validation warnings:`, ...warnings]
				: []),
		].join("\n");
		return {
			status: "succeeded",
			summary: summary.slice(0, 1_000),
			artifacts: [
				{
					output,
					kind: "decision",
					title: `Proposed plan: ${document.plan.title}`.slice(0, 200),
					payload: { format: "json", value: document },
				},
			],
		};
	}
}
