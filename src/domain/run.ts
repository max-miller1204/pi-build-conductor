import { legacySecurityPolicy } from "../security/policy.js";
import { validateTaskPlan } from "./dag.js";
import { reconcileTaskStates } from "./scheduler.js";
import {
	type BuildRun,
	MAX_CONCURRENT_WORKERS,
	MIN_CONCURRENT_WORKERS,
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
	handoff: BuildRun["handoff"];
	securityPolicy?: RunSecurityPolicy;
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

function assertPlanEditable(run: BuildRun): void {
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

export function createBuildRun(input: CreateRunInput): BuildRun {
	assertWorkerLimit(input.maxConcurrentWorkers);
	const plan = cloneTaskPlan(validateTaskPlan(input.plan));
	const planRevision = 1;
	return reconcileTaskStates({
		schemaVersion: RUN_SCHEMA_VERSION,
		revision: 0,
		id: input.id,
		state: "awaiting_approval",
		repositoryRoot: input.repositoryRoot,
		baseBranch: input.baseBranch,
		baseCommit: input.baseCommit,
		integrationBranch: input.integrationBranch,
		handoff: input.handoff,
		securityPolicy: structuredClone(
			input.securityPolicy ?? legacySecurityPolicy(),
		),
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
	run: BuildRun,
	input: ReviseRunPlanInput,
): BuildRun {
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
	return reconcileTaskStates({
		...run,
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
	run: BuildRun,
	revisionNumber: number,
	expectedPlanRevision: number,
	now: string,
): BuildRun {
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
	return reconcileTaskStates({
		...run,
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
	run: BuildRun,
	now: string,
	expectedPlanRevision = run.planRevision,
): BuildRun {
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

export function recoverInterruptedRun(run: BuildRun, now: string): BuildRun {
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
			error: "Conductor restarted",
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
			error: "Conductor restarted",
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
			error: "Conductor restarted",
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
			error: "Conductor restarted",
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
