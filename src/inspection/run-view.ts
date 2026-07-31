import {
	type StepDefinition,
	stepProfileName,
	topologicalStepIds,
} from "../domain/steps.js";
import {
	type AttemptState,
	type BlockedWorkerState,
	type FinalValidationAttempt,
	type MergeReadyEvidence,
	type OrchestrationRun,
	REVIEW_CATEGORIES,
	type RepairAttempt,
	type ReviewAttempt,
	type ReviewCategory,
	type ReviewFinding,
	type RunSecurityPolicy,
	type RunState,
	type TaskAttempt,
	type TaskState,
	type ValidationCommand,
} from "../domain/types.js";
import { repairStepId } from "../engine/steps/repair.js";
import {
	parseReviewStepId,
	type ReviewFindingsPayload,
	reviewStepId,
} from "../engine/steps/review.js";
import type {
	WorkflowRunState,
	WorkflowStepAttempt,
	WorkflowStepRecord,
} from "../engine/workflow-state.js";
import { requiresAutomaticRepair } from "../review/review-policy.js";

/** Which execution record a view was read from. */
export type RunViewSource = "engine" | "legacy";

/**
 * What a unit of run work is, in the vocabulary a reader recognizes. Reviews
 * and repairs are ordinary workflow steps on the engine, so they are units
 * here too rather than a parallel lifecycle.
 */
export type RunUnitRole =
	| "change"
	| "review"
	| "repair"
	| "investigation"
	| "command"
	| "approval";

export interface RunUnitView {
	id: string;
	role: RunUnitRole;
	title: string;
	description: string;
	state: TaskState;
	dependencies: string[];
	attemptIds: string[];
	acceptanceCriteria: string[];
	allowedPaths: string[];
	validationCommands: ValidationCommand[];
	integratedCommit?: string;
	integrationError?: string;
	error?: string;
	/** The review round and category a review unit reports on. */
	review?: { round: number; category: ReviewCategory };
	/** The review round a repair unit answers. */
	repairRound?: number;
}

export interface RunAttemptView {
	id: string;
	unitId: string;
	role: RunUnitRole;
	number: number;
	state: AttemptState;
	startedAt: string;
	workspacePath: string;
	baseCommit: string;
	workerId?: string;
	/** Absent for an attempt that ran in a detached, branchless worktree. */
	branch?: string;
	finishedAt?: string;
	summary?: string;
	error?: string;
	commit?: string;
	integratedCommit?: string;
	evidence?: TaskAttempt["evidence"];
	artifactIds?: string[];
	/** The structured findings a succeeded review attempt reported. */
	findings?: ReviewFinding[];
}

/**
 * One run as every inspection and control surface reads it.
 *
 * The engine snapshot and the legacy stored run are two different execution
 * records of the same thing; this is the single shape both project onto, so
 * the commands never branch on which one produced a run.
 */
export interface RunView {
	source: RunViewSource;
	id: string;
	title: string;
	state: RunState;
	schemaVersion: number;
	revision: number;
	createdAt: string;
	updatedAt: string;
	approvedAt?: string;
	repositoryRoot: string;
	baseBranch: string;
	baseCommit: string;
	integrationBranch: string;
	integrationHead: string;
	requestPath: string;
	planRevision: number;
	approvedPlanRevision?: number;
	maxConcurrentWorkers: number;
	securityPolicy: RunSecurityPolicy;
	units: RunUnitView[];
	attempts: RunAttemptView[];
	blockedWorkers: BlockedWorkerState[];
	finalValidationAttempts: FinalValidationAttempt[];
	mergeReadyEvidence?: MergeReadyEvidence;
	error?: string;
}

/** The review findings each review step published, by step id. */
export type ReviewFindingsByStep = ReadonlyMap<string, ReviewFindingsPayload>;

function runHeader(
	run: OrchestrationRun,
	source: RunViewSource,
): Omit<
	RunView,
	| "state"
	| "integrationHead"
	| "units"
	| "attempts"
	| "blockedWorkers"
	| "finalValidationAttempts"
> {
	return {
		source,
		id: run.id,
		title: run.plan.title,
		schemaVersion: run.schemaVersion,
		revision: run.revision,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		repositoryRoot: run.repositoryRoot,
		baseBranch: run.baseBranch,
		baseCommit: run.baseCommit,
		integrationBranch: run.integrationBranch,
		requestPath: run.request.sourcePath,
		planRevision: run.planRevision,
		maxConcurrentWorkers: run.maxConcurrentWorkers,
		securityPolicy: run.securityPolicy,
		...(run.approvedAt ? { approvedAt: run.approvedAt } : {}),
		...(run.approvedPlanRevision === undefined
			? {}
			: { approvedPlanRevision: run.approvedPlanRevision }),
		...(run.mergeReadyEvidence
			? { mergeReadyEvidence: run.mergeReadyEvidence }
			: {}),
	};
}

function unitRole(definition: StepDefinition): RunUnitRole {
	const profile = stepProfileName(definition);
	if (profile === "review" || profile === "repair") {
		return profile;
	}
	return definition.kind;
}

function changeUnitFields(
	definition: StepDefinition,
): Pick<
	RunUnitView,
	"acceptanceCriteria" | "allowedPaths" | "validationCommands"
> {
	return definition.kind === "change"
		? {
				acceptanceCriteria: [...definition.acceptanceCriteria],
				allowedPaths: [...definition.allowedPaths],
				validationCommands: definition.validationCommands.map((command) => ({
					command: command.command,
					args: [...command.args],
				})),
			}
		: { acceptanceCriteria: [], allowedPaths: [], validationCommands: [] };
}

/**
 * Applies the review policy to a review step's published findings, so a reader
 * sees which findings a repair had to address, which one addressed them, and
 * which remain open.
 */
function findingsWithStatus(
	payload: ReviewFindingsPayload | undefined,
	repairAttemptId: string | undefined,
): ReviewFinding[] {
	return (payload?.findings ?? []).map((finding) => {
		if (!requiresAutomaticRepair(finding)) {
			return { ...finding, status: "deferred" as const };
		}
		return repairAttemptId
			? {
					...finding,
					status: "repaired" as const,
					repairAttemptId,
				}
			: { ...finding, status: "repair_required" as const };
	});
}

function engineUnit(
	stepId: string,
	record: WorkflowStepRecord,
	attemptIds: string[],
): RunUnitView {
	const role = unitRole(record.definition);
	return {
		id: stepId,
		role,
		title: record.definition.title,
		description: record.definition.description,
		state: record.state,
		dependencies: [...record.definition.dependencies],
		attemptIds,
		...changeUnitFields(record.definition),
		...(record.integratedCommit
			? { integratedCommit: record.integratedCommit }
			: {}),
		...(record.integrationError
			? { integrationError: record.integrationError }
			: {}),
		...(record.error ? { error: record.error } : {}),
		...(role === "review" ? { review: parseReviewStepId(stepId) } : {}),
		...(role === "repair"
			? { repairRound: Number.parseInt(stepId.slice("repair-".length), 10) }
			: {}),
	};
}

function engineAttempt(
	attempt: WorkflowStepAttempt,
	record: WorkflowStepRecord,
	findings: ReviewFinding[] | undefined,
): RunAttemptView {
	const role = unitRole(record.definition);
	return {
		id: attempt.id,
		unitId: attempt.stepId,
		role,
		number: attempt.number,
		state: attempt.state,
		startedAt: attempt.startedAt,
		workspacePath: attempt.workspacePath,
		baseCommit: attempt.baseCommit,
		...(attempt.workerId ? { workerId: attempt.workerId } : {}),
		...(attempt.branch ? { branch: attempt.branch } : {}),
		...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
		...(attempt.summary ? { summary: attempt.summary } : {}),
		...(attempt.error ? { error: attempt.error } : {}),
		...(attempt.commit ? { commit: attempt.commit } : {}),
		...(attempt.commit && record.integratedCommit
			? { integratedCommit: record.integratedCommit }
			: {}),
		...(attempt.evidence ? { evidence: attempt.evidence } : {}),
		...(attempt.artifactIds ? { artifactIds: [...attempt.artifactIds] } : {}),
		...(findings ? { findings } : {}),
	};
}

/**
 * Which repair attempt, if any, carried a round's required fixes into the
 * integration branch. A repair that committed nothing repaired nothing.
 */
function integratedRepairAttemptId(
	state: WorkflowRunState,
	round: number,
): string | undefined {
	const stepId = repairStepId(round);
	const record = state.steps[stepId];
	if (!record?.integratedCommit) {
		return undefined;
	}
	return state.attempts.findLast(
		(attempt) => attempt.stepId === stepId && attempt.state === "succeeded",
	)?.id;
}

/**
 * The run lifecycle phase a reader sees, derived on read rather than stored.
 *
 * The stored run owns the phases the engine knows nothing about - approval,
 * final validation, and the terminal outcome - and the engine snapshot owns
 * everything between them.
 */
export function engineRunState(
	stored: RunState,
	state: WorkflowRunState,
): RunState {
	if (stored === "planning" || stored === "awaiting_approval") {
		return stored;
	}
	if (state.state === "cancelled" || stored === "cancelled") {
		return "cancelled";
	}
	if (
		stored === "completed" ||
		stored === "failed" ||
		stored === "validating"
	) {
		return stored;
	}
	if (state.state === "failed") {
		return "failed";
	}
	if (state.state === "completed") {
		return "reviewed";
	}
	const active = (role: RunUnitRole) =>
		Object.values(state.steps).some(
			(record) =>
				unitRole(record.definition) === role &&
				(record.state === "ready" || record.state === "running"),
		);
	if (active("repair")) {
		return "repairing";
	}
	if (active("review")) {
		return "reviewing";
	}
	const changesDone = Object.values(state.steps).every(
		(record) =>
			unitRole(record.definition) !== "change" || record.state === "succeeded",
	);
	return changesDone ? "integrating" : "running";
}

/**
 * Reads an engine-backed run: the durable workflow snapshot is the execution
 * record, and the stored run supplies only the request, plan, approval, and
 * the final-validation phase it owns itself.
 */
export function engineRunView(
	run: OrchestrationRun,
	state: WorkflowRunState,
	findings: ReviewFindingsByStep = new Map(),
): RunView {
	const attemptIdsByStep = new Map<string, string[]>();
	for (const attempt of state.attempts) {
		attemptIdsByStep.set(attempt.stepId, [
			...(attemptIdsByStep.get(attempt.stepId) ?? []),
			attempt.id,
		]);
	}
	const orderedStepIds = topologicalStepIds(state.plan);
	const units = orderedStepIds.flatMap((stepId) => {
		const record = state.steps[stepId];
		return record
			? [engineUnit(stepId, record, attemptIdsByStep.get(stepId) ?? [])]
			: [];
	});
	const attempts = state.attempts.flatMap((attempt) => {
		const record = state.steps[attempt.stepId];
		if (!record) {
			return [];
		}
		const isReview = unitRole(record.definition) === "review";
		const reviewFindings =
			isReview && attempt.state === "succeeded"
				? findingsWithStatus(
						findings.get(attempt.stepId),
						integratedRepairAttemptId(
							state,
							parseReviewStepId(attempt.stepId).round,
						),
					)
				: undefined;
		return [engineAttempt(attempt, record, reviewFindings)];
	});
	return {
		...runHeader(run, "engine"),
		state: engineRunState(run.state, state),
		integrationHead: state.integrationHead,
		units,
		attempts,
		blockedWorkers: [],
		finalValidationAttempts: run.finalValidationAttempts,
		...((run.error ?? state.error)
			? { error: (run.error ?? state.error) as string }
			: {}),
	};
}

function unitStateFromAttempts(states: readonly AttemptState[]): TaskState {
	const latest = states.at(-1);
	switch (latest) {
		case undefined:
			return "planned";
		case "succeeded":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "validating":
			return "validating";
		default:
			return "running";
	}
}

/**
 * A legacy review round always covers every review category, so a category
 * that has not reported yet is a planned unit rather than an absent one.
 */
function legacyReviewUnits(run: OrchestrationRun): RunUnitView[] {
	const byUnit = new Map<string, ReviewAttempt[]>();
	for (const attempt of run.reviewAttempts) {
		const id = reviewStepId(attempt.round, attempt.category);
		byUnit.set(id, [...(byUnit.get(id) ?? []), attempt]);
	}
	const rounds = [
		...new Set([
			...run.reviewRounds.map((round) => round.number),
			...run.reviewAttempts.map((attempt) => attempt.round),
		]),
	].sort((left, right) => left - right);
	return rounds.flatMap((round) =>
		REVIEW_CATEGORIES.map((category): RunUnitView => {
			const id = reviewStepId(round, category);
			const attempts = byUnit.get(id) ?? [];
			const error = attempts.findLast((attempt) => attempt.error)?.error;
			return {
				id,
				role: "review",
				title: `Independent ${category} review (round ${round})`,
				description: `Review the complete integrated result for ${category} problems and report structured findings.`,
				state: unitStateFromAttempts(attempts.map((attempt) => attempt.state)),
				dependencies: [],
				attemptIds: attempts.map((attempt) => attempt.id),
				acceptanceCriteria: [],
				allowedPaths: [],
				validationCommands: [],
				review: { round, category },
				...(error ? { error } : {}),
			};
		}),
	);
}

function legacyRepairUnits(run: OrchestrationRun): RunUnitView[] {
	const byRound = new Map<number, RepairAttempt[]>();
	for (const attempt of run.repairAttempts) {
		byRound.set(attempt.round, [
			...(byRound.get(attempt.round) ?? []),
			attempt,
		]);
	}
	return [...byRound].map(([round, attempts]) => {
		const integrated = attempts.findLast(
			(attempt) => attempt.integratedCommit,
		)?.integratedCommit;
		return {
			id: repairStepId(round),
			role: "repair" as const,
			title: `Repair the round ${round} review findings`,
			description:
				"Apply fixes for the prioritized repair-required findings from the independent reviews.",
			state: unitStateFromAttempts(attempts.map((attempt) => attempt.state)),
			dependencies: [],
			attemptIds: attempts.map((attempt) => attempt.id),
			acceptanceCriteria: [],
			allowedPaths: [],
			validationCommands: [],
			repairRound: round,
			...(integrated ? { integratedCommit: integrated } : {}),
			...(attempts.findLast((attempt) => attempt.error)?.error
				? {
						error: attempts.findLast((attempt) => attempt.error)
							?.error as string,
					}
				: {}),
		};
	});
}

function legacyTaskAttempt(
	attempt: TaskAttempt,
	integratedCommit: string | undefined,
): RunAttemptView {
	return {
		id: attempt.id,
		unitId: attempt.taskId,
		role: "change",
		number: attempt.number,
		state: attempt.state,
		startedAt: attempt.startedAt,
		workspacePath: attempt.worktreePath,
		baseCommit: attempt.baseCommit,
		...(attempt.workerId ? { workerId: attempt.workerId } : {}),
		...(attempt.branch ? { branch: attempt.branch } : {}),
		...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
		...(attempt.error ? { error: attempt.error } : {}),
		...(attempt.commit ? { commit: attempt.commit } : {}),
		...(attempt.commit && integratedCommit ? { integratedCommit } : {}),
		...(attempt.evidence ? { evidence: attempt.evidence } : {}),
	};
}

/**
 * Reads a run that executed under the legacy orchestrator. Its rounds and
 * categories carry the same step identities the engine uses, so one
 * presentation serves both records.
 */
export function legacyRunView(run: OrchestrationRun): RunView {
	const taskUnits = run.plan.tasks.map((definition): RunUnitView => {
		const task = run.tasks[definition.id];
		return {
			id: definition.id,
			role: "change",
			title: definition.title,
			description: definition.description,
			state: task?.state ?? "planned",
			dependencies: [...definition.dependencies],
			attemptIds: task ? [...task.attemptIds] : [],
			acceptanceCriteria: [...definition.acceptanceCriteria],
			allowedPaths: [...definition.allowedPaths],
			validationCommands: definition.validationCommands.map((command) => ({
				command: command.command,
				args: [...command.args],
			})),
			...(task?.integratedCommit
				? { integratedCommit: task.integratedCommit }
				: {}),
			...(task?.integrationError
				? { integrationError: task.integrationError }
				: {}),
		};
	});
	const attempts: RunAttemptView[] = [
		...run.attempts.map((attempt) =>
			legacyTaskAttempt(attempt, run.tasks[attempt.taskId]?.integratedCommit),
		),
		...run.reviewAttempts.map(
			(attempt): RunAttemptView => ({
				id: attempt.id,
				unitId: reviewStepId(attempt.round, attempt.category),
				role: "review",
				number: attempt.number,
				state: attempt.state,
				startedAt: attempt.startedAt,
				workspacePath: attempt.worktreePath,
				baseCommit: attempt.baseCommit,
				...(attempt.workerId ? { workerId: attempt.workerId } : {}),
				...(attempt.branch ? { branch: attempt.branch } : {}),
				...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
				...(attempt.summary ? { summary: attempt.summary } : {}),
				...(attempt.error ? { error: attempt.error } : {}),
				...(attempt.findings ? { findings: attempt.findings } : {}),
			}),
		),
		...run.repairAttempts.map(
			(attempt): RunAttemptView => ({
				id: attempt.id,
				unitId: repairStepId(attempt.round),
				role: "repair",
				number: attempt.number,
				state: attempt.state,
				startedAt: attempt.startedAt,
				workspacePath: attempt.worktreePath,
				baseCommit: attempt.baseCommit,
				...(attempt.workerId ? { workerId: attempt.workerId } : {}),
				...(attempt.branch ? { branch: attempt.branch } : {}),
				...(attempt.finishedAt ? { finishedAt: attempt.finishedAt } : {}),
				...(attempt.error ? { error: attempt.error } : {}),
				...(attempt.commit ? { commit: attempt.commit } : {}),
				...(attempt.integratedCommit
					? { integratedCommit: attempt.integratedCommit }
					: {}),
				...(attempt.evidence ? { evidence: attempt.evidence } : {}),
			}),
		),
	];
	return {
		...runHeader(run, "legacy"),
		state: run.state,
		integrationHead: run.integrationHead,
		units: [...taskUnits, ...legacyReviewUnits(run), ...legacyRepairUnits(run)],
		attempts,
		blockedWorkers: run.blockedWorkers,
		finalValidationAttempts: run.finalValidationAttempts,
		...(run.error ? { error: run.error } : {}),
	};
}

export function findUnit(
	view: RunView,
	unitId: string,
): RunUnitView | undefined {
	return view.units.find((unit) => unit.id === unitId);
}

export function findAttempt(
	view: RunView,
	attemptId: string,
): RunAttemptView | undefined {
	return view.attempts.find((attempt) => attempt.id === attemptId);
}

/** The units a reader thinks of as the run's own work, not its review of it. */
export function workUnits(view: RunView): RunUnitView[] {
	return view.units.filter(
		(unit) => unit.role !== "review" && unit.role !== "repair",
	);
}

export function reviewRounds(view: RunView): number[] {
	return [
		...new Set(
			view.units.flatMap((unit) => (unit.review ? [unit.review.round] : [])),
		),
	].sort((left, right) => left - right);
}

export type ReviewRoundViewState =
	| "running"
	| "repairing"
	| "succeeded"
	| "failed"
	| "cancelled";

export interface ReviewRoundView {
	number: number;
	state: ReviewRoundViewState;
	/** How many of the run's review categories reported. */
	reported: number;
	categories: number;
	findings: Record<ReviewFinding["status"], number>;
	baseCommit?: string;
	startedAt?: string;
	finishedAt?: string;
	repairAttemptId?: string;
	error?: string;
}

function roundState(
	reported: number,
	categories: number,
	cancelled: boolean,
	failed: boolean,
	repairRequired: number,
	repairUnit: RunUnitView | undefined,
): ReviewRoundViewState {
	if (cancelled) {
		return "cancelled";
	}
	if (failed) {
		return "failed";
	}
	if (reported !== categories) {
		return "running";
	}
	if (repairRequired === 0) {
		return "succeeded";
	}
	if (!repairUnit) {
		// The last round is the evidence that stands, so findings it still
		// requires repaired are the reason this run cannot merge.
		return "failed";
	}
	switch (repairUnit.state) {
		case "succeeded":
			return "succeeded";
		case "failed":
		case "cancelled":
			return "failed";
		default:
			return "repairing";
	}
}

/**
 * The review rounds a reader sees, derived from the review and repair units.
 *
 * Rounds are a reading of the step graph rather than stored lifecycle state,
 * so both execution records describe their reviews the same way.
 */
export function reviewRoundViews(view: RunView): ReviewRoundView[] {
	return reviewRounds(view).map((number) => {
		const units = view.units.filter((unit) => unit.review?.round === number);
		const attempts = view.attempts.filter((attempt) =>
			units.some((unit) => unit.id === attempt.unitId),
		);
		const repairUnit = view.units.find((unit) => unit.repairRound === number);
		const repairAttempt = repairUnit
			? view.attempts.findLast(
					(attempt) =>
						attempt.unitId === repairUnit.id && attempt.state === "succeeded",
				)
			: undefined;
		const findings: Record<ReviewFinding["status"], number> = {
			repair_required: 0,
			deferred: 0,
			repaired: 0,
			unresolved: 0,
		};
		for (const attempt of attempts) {
			for (const finding of attempt.findings ?? []) {
				findings[finding.status] += 1;
			}
		}
		const reported = new Set(
			units.flatMap((unit) => (unit.state === "succeeded" ? [unit.id] : [])),
		).size;
		const state = roundState(
			reported,
			units.length,
			units.some((unit) => unit.state === "cancelled"),
			units.some((unit) => unit.state === "failed" || unit.state === "blocked"),
			findings.repair_required,
			repairUnit,
		);
		const error =
			state === "failed"
				? (repairUnit?.error ??
					units.find((unit) => unit.error)?.error ??
					attempts.find((attempt) => attempt.error)?.error ??
					(findings.repair_required > 0 && !repairUnit
						? "Important findings remain after the approved repair rounds"
						: "The review round did not complete"))
				: undefined;
		const finished = attempts.every((attempt) => attempt.finishedAt)
			? attempts
					.map((attempt) => attempt.finishedAt ?? "")
					.sort()
					.at(-1)
			: undefined;
		return {
			number,
			state,
			reported,
			categories: units.length,
			findings,
			...(attempts[0]?.baseCommit
				? { baseCommit: attempts[0].baseCommit }
				: {}),
			...(attempts[0]?.startedAt ? { startedAt: attempts[0].startedAt } : {}),
			...(finished ? { finishedAt: finished } : {}),
			...(repairAttempt ? { repairAttemptId: repairAttempt.id } : {}),
			...(error ? { error } : {}),
		};
	});
}
