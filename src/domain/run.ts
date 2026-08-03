import {
	AuthorityViolationError,
	type FrozenAuthority,
	type FrozenRunAuthority,
	freezeRunAuthority,
	reviseRunAuthority,
} from "../security/authority.js";
import type { AuthorityEnvelope } from "../security/envelope.js";
import { legacySecurityPolicy } from "../security/policy.js";
import { validateTaskPlan } from "./dag.js";
import { reconcileTaskStates } from "./scheduler.js";
import {
	MAX_CONCURRENT_WORKERS,
	MIN_CONCURRENT_WORKERS,
	type OrchestrationRun,
	type PlanRevisionSource,
	RUN_SCHEMA_VERSION,
	type RunSecurityPolicy,
	type RunTask,
	type TaskPlan,
} from "./types.js";

export interface CreateRunInput {
	id: string;
	repositoryRoot: string;
	baseBranch: string;
	baseCommit: string;
	integrationBranch: string;
	request: OrchestrationRun["request"];
	securityPolicy?: RunSecurityPolicy;
	/**
	 * The authority envelope the user approved before the work was known. When
	 * one is given it is the source: the plan must fit inside it and the run's
	 * capability profiles derive from it.
	 */
	envelope?: AuthorityEnvelope;
	plan: TaskPlan;
	maxConcurrentWorkers: number;
	planSource?: Exclude<PlanRevisionSource, "edited" | "restored" | "migrated">;
	now: string;
}

export interface ReviseRunPlanInput {
	plan: TaskPlan;
	maxConcurrentWorkers: number;
	expectedPlanRevision: number;
	now: string;
	source?: "edited";
}

/**
 * Freezes the authority a new run executes under, when its security policy
 * can enforce one. A version 1 policy predates capability profiles, so such a
 * run keeps its historical fixed-role authority and an approved envelope is
 * refused rather than accepted unenforced.
 */
function frozenAuthorityFor(
	input: Pick<
		CreateRunInput,
		"envelope" | "repositoryRoot" | "securityPolicy"
	> & { plan: TaskPlan; securityPolicy: RunSecurityPolicy },
): FrozenRunAuthority | undefined {
	if (input.securityPolicy.version !== 2) {
		if (input.envelope) {
			throw new AuthorityViolationError([
				{
					code: "policy_cannot_enforce_envelope",
					path: "securityPolicy.version",
					message:
						"An approved authority envelope requires security policy version 2, which freezes capability profiles",
				},
			]);
		}
		return undefined;
	}
	return freezeRunAuthority({
		repositoryRoot: input.repositoryRoot,
		plan: input.plan,
		securityPolicy: input.securityPolicy,
		...(input.envelope ? { envelope: input.envelope } : {}),
	});
}

/**
 * The authority a revised plan executes under, keeping an authored one.
 *
 * The capability profiles were frozen when the run was created, so a revision
 * that would change them is refused rather than silently refreezing them: the
 * authority a run executes under is settled before any work starts.
 */
function revisedAuthorityFor(
	run: OrchestrationRun,
	plan: TaskPlan,
): FrozenAuthority | undefined {
	if (!run.authority) {
		return undefined;
	}
	const revised = reviseRunAuthority(run.authority, {
		repositoryRoot: run.repositoryRoot,
		plan,
		securityPolicy: run.securityPolicy,
	});
	if (
		JSON.stringify(revised.securityPolicy) !==
		JSON.stringify(run.securityPolicy)
	) {
		throw new AuthorityViolationError([
			{
				code: "frozen_profiles_would_change",
				path: "securityPolicy.workers.capabilityProfiles",
				message:
					"A plan revision cannot change the capability profiles frozen at run creation",
				condition: "widen-mutation-authority",
			},
		]);
	}
	return revised.authority;
}

function assertWorkerLimit(maxConcurrentWorkers: number): void {
	if (
		!Number.isInteger(maxConcurrentWorkers) ||
		maxConcurrentWorkers < MIN_CONCURRENT_WORKERS ||
		maxConcurrentWorkers > MAX_CONCURRENT_WORKERS
	) {
		throw new Error(
			`maxConcurrentWorkers must be an integer from ${MIN_CONCURRENT_WORKERS} to ${MAX_CONCURRENT_WORKERS}`,
		);
	}
}

function cloneTaskPlan(plan: TaskPlan): TaskPlan {
	return structuredClone(plan);
}

function tasksForPlan(plan: TaskPlan): Record<string, RunTask> {
	return Object.fromEntries(
		plan.tasks.map((definition) => [
			definition.id,
			{
				definition: structuredClone(definition),
				state: "planned",
				attemptIds: [],
			},
		]),
	);
}

function assertPlanEditable(run: OrchestrationRun): void {
	if (!["planning", "awaiting_approval"].includes(run.state)) {
		throw new Error(`Cannot revise plan in state ${run.state}`);
	}
	if (
		run.approvedAt !== undefined ||
		run.approvedPlanRevision !== undefined ||
		run.attempts.length > 0 ||
		run.reviewRounds.length > 0 ||
		run.reviewAttempts.length > 0 ||
		run.repairAttempts.length > 0 ||
		run.finalValidationAttempts.length > 0 ||
		run.integrationHead !== run.baseCommit ||
		run.mergeReadyEvidence !== undefined
	) {
		throw new Error("Cannot revise a plan after execution resources exist");
	}
}

export function createOrchestrationRun(
	input: CreateRunInput,
): OrchestrationRun {
	assertWorkerLimit(input.maxConcurrentWorkers);
	const plan = cloneTaskPlan(validateTaskPlan(input.plan));
	const planRevision = 1;
	const securityPolicy = structuredClone(
		input.securityPolicy ?? legacySecurityPolicy(),
	);
	const frozen = frozenAuthorityFor({ ...input, plan, securityPolicy });
	return reconcileTaskStates({
		schemaVersion: RUN_SCHEMA_VERSION,
		revision: 0,
		id: input.id,
		state: "awaiting_approval",
		repositoryRoot: input.repositoryRoot,
		baseBranch: input.baseBranch,
		baseCommit: input.baseCommit,
		integrationBranch: input.integrationBranch,
		request: input.request,
		securityPolicy: frozen?.securityPolicy ?? securityPolicy,
		...(frozen ? { authority: frozen.authority } : {}),
		plan,
		planRevision,
		planRevisions: [
			{
				number: planRevision,
				createdAt: input.now,
				source: input.planSource ?? "generated",
				plan: cloneTaskPlan(plan),
				maxConcurrentWorkers: input.maxConcurrentWorkers,
			},
		],
		tasks: tasksForPlan(plan),
		attempts: [],
		integrationHead: input.baseCommit,
		reviewRounds: [],
		reviewAttempts: [],
		repairAttempts: [],
		blockedWorkers: [],
		finalValidationAttempts: [],
		maxConcurrentWorkers: input.maxConcurrentWorkers,
		createdAt: input.now,
		updatedAt: input.now,
	});
}

export function reviseRunPlan(
	run: OrchestrationRun,
	input: ReviseRunPlanInput,
): OrchestrationRun {
	assertPlanEditable(run);
	if (run.planRevision !== input.expectedPlanRevision) {
		throw new Error(
			`Stale plan revision ${input.expectedPlanRevision}; current revision is ${run.planRevision}`,
		);
	}
	assertWorkerLimit(input.maxConcurrentWorkers);
	const plan = cloneTaskPlan(validateTaskPlan(input.plan));
	if (
		JSON.stringify(plan) === JSON.stringify(run.plan) &&
		input.maxConcurrentWorkers === run.maxConcurrentWorkers
	) {
		return run;
	}
	const planRevision = run.planRevision + 1;
	const revised = revisedAuthorityFor(run, plan);
	return reconcileTaskStates({
		...run,
		...(revised ? { authority: revised } : {}),
		plan,
		planRevision,
		planRevisions: [
			...run.planRevisions,
			{
				number: planRevision,
				createdAt: input.now,
				source: input.source ?? "edited",
				plan: cloneTaskPlan(plan),
				maxConcurrentWorkers: input.maxConcurrentWorkers,
			},
		],
		tasks: tasksForPlan(plan),
		maxConcurrentWorkers: input.maxConcurrentWorkers,
		updatedAt: input.now,
	});
}

export function restoreRunPlanRevision(
	run: OrchestrationRun,
	revisionNumber: number,
	expectedPlanRevision: number,
	now: string,
): OrchestrationRun {
	assertPlanEditable(run);
	if (run.planRevision !== expectedPlanRevision) {
		throw new Error(
			`Stale plan revision ${expectedPlanRevision}; current revision is ${run.planRevision}`,
		);
	}
	const restored = run.planRevisions.find(
		(revision) => revision.number === revisionNumber,
	);
	if (!restored) {
		throw new Error(`Unknown plan revision ${revisionNumber}`);
	}
	const plan = cloneTaskPlan(restored.plan);
	const planRevision = run.planRevision + 1;
	const revised = revisedAuthorityFor(run, plan);
	return reconcileTaskStates({
		...run,
		...(revised ? { authority: revised } : {}),
		plan,
		planRevision,
		planRevisions: [
			...run.planRevisions,
			{
				number: planRevision,
				createdAt: now,
				source: "restored",
				restoredFrom: revisionNumber,
				plan: cloneTaskPlan(plan),
				maxConcurrentWorkers: restored.maxConcurrentWorkers,
			},
		],
		tasks: tasksForPlan(plan),
		maxConcurrentWorkers: restored.maxConcurrentWorkers,
		updatedAt: now,
	});
}

export function approveRun(
	run: OrchestrationRun,
	now: string,
	expectedPlanRevision = run.planRevision,
): OrchestrationRun {
	if (run.state !== "awaiting_approval") {
		throw new Error(`Cannot approve run in state ${run.state}`);
	}
	if (run.planRevision !== expectedPlanRevision) {
		throw new Error(
			`Stale plan revision ${expectedPlanRevision}; current revision is ${run.planRevision}`,
		);
	}
	return {
		...run,
		state: "running",
		approvedPlanRevision: run.planRevision,
		approvedAt: now,
		updatedAt: now,
	};
}

export function recoverInterruptedRun(
	run: OrchestrationRun,
	now: string,
): OrchestrationRun {
	let changed = run.blockedWorkers.length > 0;
	const attempts = run.attempts.map((attempt) => {
		if (
			attempt.state !== "prepared" &&
			attempt.state !== "launched" &&
			attempt.state !== "running" &&
			attempt.state !== "validating"
		) {
			return attempt;
		}
		changed = true;
		return {
			...attempt,
			state: "interrupted" as const,
			finishedAt: now,
			error: "Orchestrator restarted",
		};
	});
	const reviewAttempts = run.reviewAttempts.map((attempt) => {
		if (
			attempt.state !== "prepared" &&
			attempt.state !== "launched" &&
			attempt.state !== "running" &&
			attempt.state !== "validating"
		) {
			return attempt;
		}
		changed = true;
		return {
			...attempt,
			state: "interrupted" as const,
			finishedAt: now,
			error: "Orchestrator restarted",
		};
	});
	const repairAttempts = run.repairAttempts.map((attempt) => {
		if (
			attempt.state !== "prepared" &&
			attempt.state !== "launched" &&
			attempt.state !== "running" &&
			attempt.state !== "validating"
		) {
			return attempt;
		}
		changed = true;
		return {
			...attempt,
			state: "interrupted" as const,
			finishedAt: now,
			error: "Orchestrator restarted",
		};
	});
	const finalValidationAttempts = run.finalValidationAttempts.map((attempt) => {
		if (attempt.state !== "running") {
			return attempt;
		}
		changed = true;
		return {
			...attempt,
			state: "interrupted" as const,
			finishedAt: now,
			error: "Orchestrator restarted",
		};
	});
	const tasks = Object.fromEntries(
		Object.entries(run.tasks).map(([id, task]) => {
			if (task.state !== "running" && task.state !== "validating") {
				return [id, task];
			}
			changed = true;
			return [id, { ...task, state: "planned" as const }];
		}),
	);
	if (!changed) {
		return run;
	}
	return reconcileTaskStates({
		...run,
		state: run.state === "validating" ? "reviewed" : run.state,
		attempts,
		reviewAttempts,
		repairAttempts,
		blockedWorkers: [],
		finalValidationAttempts,
		tasks,
		updatedAt: now,
	});
}
