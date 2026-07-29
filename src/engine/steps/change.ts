import type { ChangeStepDefinition } from "../../domain/steps.js";
import type {
	CapabilityProfile,
	RunSecurityPolicy,
	TaskAttempt,
	TaskDefinition,
	TaskValidationEvidence,
	WorkerRole,
} from "../../domain/types.js";
import type { GitClient } from "../../git/git.js";
import { CapabilityViolationError } from "../../security/capabilities.js";
import {
	TaskValidationError,
	type TaskValidator,
} from "../../validation/task-validator.js";
import type { StepArtifactDraft } from "../artifact-routing.js";
import type {
	StepHandler,
	StepHandlerContext,
	StepOutcome,
} from "../handlers.js";
import { assertSupportedOutputs, assertUnchangedWorkspace } from "./outputs.js";
import { buildStepWorkerPrompt } from "./prompt.js";
import type { StepWorkerRunner } from "./worker-runner.js";

/** The outputs a change step may declare, and the artifact kind of each. */
export const CHANGE_STEP_OUTPUTS = {
	evidence: "test-evidence",
	commit: "commit",
} as const;

export interface ValidatedChangeOptions {
	worker: StepWorkerRunner;
	validator: TaskValidator;
	git: Pick<GitClient, "commitTaskWork" | "status">;
	securityPolicy: RunSecurityPolicy;
}

export interface ChangeStepHandlerOptions extends ValidatedChangeOptions {
	requestText?: string;
}

/** The legacy task shape the focused validator already enforces. */
function taskDefinitionOf(step: ChangeStepDefinition): TaskDefinition {
	return {
		id: step.id,
		title: step.title,
		description: step.description,
		dependencies: [...step.dependencies],
		acceptanceCriteria: [...step.acceptanceCriteria],
		allowedPaths: [...step.allowedPaths],
		validationCommands: step.validationCommands.map((command) => ({
			command: command.command,
			args: [...command.args],
		})),
	};
}

function taskAttemptOf(
	context: StepHandlerContext,
	branch: string,
): TaskAttempt {
	return {
		id: context.attempt.id,
		taskId: context.attempt.stepId,
		number: context.attempt.number,
		state: "validating",
		branch,
		worktreePath: context.workspace.path,
		baseCommit: context.workspace.baseCommit,
		startedAt: context.attempt.startedAt,
	};
}

/**
 * Validation enforces the change profile of the policy it is given, so the
 * step's own narrowed profile replaces the run-wide one: a change step that
 * declared away its mutation authority has any diff rejected.
 */
function stepValidationPolicy(
	policy: RunSecurityPolicy,
	profile: CapabilityProfile,
): RunSecurityPolicy {
	if (!policy.workers.capabilityProfiles) {
		return policy;
	}
	return {
		...policy,
		workers: {
			...policy.workers,
			capabilityProfiles: {
				...policy.workers.capabilityProfiles,
				change: profile,
			},
		},
	};
}

function commitMessage(step: ChangeStepDefinition): string {
	return `step(${step.id}): ${step.title.replace(/[\r\n]+/g, " ").trim()}`;
}

function artifactsFor(
	step: ChangeStepDefinition,
	evidence: TaskValidationEvidence,
	commit: string,
	branch: string,
	baseCommit: string,
): StepArtifactDraft[] {
	return (step.outputs ?? []).map((output) =>
		output === "commit"
			? {
					output,
					kind: CHANGE_STEP_OUTPUTS.commit,
					title: `${step.title} commit`,
					payload: {
						format: "json" as const,
						value: { commit, branch, baseCommit },
					},
				}
			: {
					output,
					kind: CHANGE_STEP_OUTPUTS.evidence,
					title: `${step.title} validation evidence`,
					payload: { format: "json" as const, value: evidence },
				},
	);
}

/**
 * Runs one worker-driven repository change to a committed result: the worker
 * inside the step's isolated worktree, then the focused validation the run
 * approved, then one orchestrator-owned commit. The worker never commits, and
 * no diff that fails validation ever reaches the integration branch.
 */
export async function runValidatedChange(
	options: ValidatedChangeOptions,
	context: StepHandlerContext,
	step: ChangeStepDefinition,
	worker: { role: WorkerRole; prompt: string },
): Promise<StepOutcome> {
	const branch = context.workspace.branch;
	const result = await options.worker.run({
		runId: context.runId,
		stepId: step.id,
		attemptId: context.attempt.id,
		role: worker.role,
		profile: context.capabilityProfile,
		cwd: context.workspace.path,
		prompt: worker.prompt,
		signal: context.signal,
	});
	if (result.status !== "succeeded") {
		return result.status === "cancelled"
			? { status: "cancelled", error: result.error }
			: { status: "failed", error: result.error };
	}
	if (!branch) {
		// A step whose narrowed profile lacks mutate-repository runs in a
		// detached read-only workspace. Enforce the boundary it accepted:
		// any observed mutation is a permanent breach, and a clean workspace
		// still cannot deliver the commit a change step must produce.
		try {
			await assertUnchangedWorkspace(
				options.git,
				context.capabilityProfile,
				context.workspace,
			);
		} catch (error) {
			return {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				...(error instanceof CapabilityViolationError
					? { retryable: false }
					: {}),
			};
		}
		return {
			status: "failed",
			error: `Change step ${step.id} holds no mutate-repository authority, so it cannot produce a committable change`,
			retryable: false,
		};
	}
	let evidence: TaskValidationEvidence;
	let snapshot: Awaited<ReturnType<TaskValidator["validate"]>>["snapshot"];
	try {
		const validation = await options.validator.validate({
			task: taskDefinitionOf(step),
			attempt: taskAttemptOf(context, branch),
			securityPolicy: stepValidationPolicy(
				options.securityPolicy,
				context.capabilityProfile,
			),
			signal: context.signal,
		});
		evidence = validation.evidence;
		snapshot = validation.snapshot;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// A worker that exceeded its approved authority is a boundary breach,
		// not a flaky attempt: never spend a retry re-running it.
		const breach =
			error instanceof CapabilityViolationError ||
			(error instanceof TaskValidationError &&
				error.cause instanceof CapabilityViolationError);
		return {
			status: "failed",
			error: message,
			...(breach ? { retryable: false } : {}),
		};
	}
	try {
		const commit = await options.git.commitTaskWork(
			context.workspace.path,
			snapshot,
			commitMessage(step),
		);
		return {
			status: "succeeded",
			summary: `Committed ${evidence.changedFiles.length} changed file(s) as ${commit}`,
			commit,
			artifacts: artifactsFor(
				step,
				evidence,
				commit,
				branch,
				context.workspace.baseCommit,
			),
		};
	} catch (error) {
		return {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Executes one approved repository change through an implementation worker. */
export class ChangeStepHandler implements StepHandler {
	readonly kind = "change" as const;

	constructor(private readonly options: ChangeStepHandlerOptions) {}

	async execute(context: StepHandlerContext): Promise<StepOutcome> {
		const step = context.step;
		if (step.kind !== "change") {
			return {
				status: "failed",
				error: `Change handler received a ${step.kind} step`,
				retryable: false,
			};
		}
		try {
			assertSupportedOutputs(step, Object.keys(CHANGE_STEP_OUTPUTS));
		} catch (error) {
			return {
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				retryable: false,
			};
		}
		return runValidatedChange(this.options, context, step, {
			role: "implementation",
			prompt: buildStepWorkerPrompt({
				runId: context.runId,
				step,
				context: context.execution,
				profile: context.capabilityProfile,
				securityPolicy: this.options.securityPolicy,
				...(this.options.requestText === undefined
					? {}
					: { requestText: this.options.requestText }),
			}),
		});
	}
}
