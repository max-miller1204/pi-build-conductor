import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { topologicalTaskIds, validateTaskPlan } from "../domain/dag.js";
import { recoverInterruptedRun } from "../domain/run.js";
import {
	type AttemptState,
	type BuildRun,
	type FinalValidationAttemptState,
	isActiveAttemptState,
	MAX_CONCURRENT_WORKERS,
	MERGE_READY_EVIDENCE_VERSION,
	MIN_CONCURRENT_WORKERS,
	REVIEW_CATEGORIES,
	type ReviewCategory,
	type ReviewConfidence,
	type ReviewFindingStatus,
	type ReviewRoundState,
	type ReviewSeverity,
	RUN_SCHEMA_VERSION,
	type RunState,
	type TaskState,
} from "../domain/types.js";

const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const RUN_STATES: ReadonlySet<RunState> = new Set([
	"planning",
	"awaiting_approval",
	"running",
	"integrating",
	"reviewing",
	"repairing",
	"reviewed",
	"validating",
	"completed",
	"failed",
	"cancelled",
]);
const TASK_STATES: ReadonlySet<TaskState> = new Set([
	"planned",
	"ready",
	"running",
	"validating",
	"succeeded",
	"failed",
	"blocked",
	"cancelled",
]);
const REVIEW_CATEGORY_SET: ReadonlySet<ReviewCategory> = new Set(
	REVIEW_CATEGORIES,
);
const REVIEW_SEVERITIES: ReadonlySet<ReviewSeverity> = new Set([
	"critical",
	"high",
	"medium",
	"low",
]);
const REVIEW_CONFIDENCES: ReadonlySet<ReviewConfidence> = new Set([
	"high",
	"medium",
	"low",
]);
const FINDING_STATES: ReadonlySet<ReviewFindingStatus> = new Set([
	"repair_required",
	"deferred",
	"repaired",
	"unresolved",
]);
const REVIEW_ROUND_STATES: ReadonlySet<ReviewRoundState> = new Set([
	"running",
	"repairing",
	"succeeded",
	"failed",
	"cancelled",
]);
const FINAL_VALIDATION_ATTEMPT_STATES: ReadonlySet<FinalValidationAttemptState> =
	new Set(["running", "succeeded", "failed", "cancelled", "interrupted"]);
const ATTEMPT_STATES: ReadonlySet<AttemptState> = new Set([
	"prepared",
	"launched",
	"running",
	"validating",
	"succeeded",
	"failed",
	"cancelled",
	"interrupted",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${path} must be a non-empty string`);
	}
}

function validateEvidence(value: unknown, path: string): void {
	if (!isRecord(value)) {
		throw new Error(`${path} must be an object`);
	}
	assertString(value.startedAt, `${path}.startedAt`);
	assertString(value.finishedAt, `${path}.finishedAt`);
	if (typeof value.passed !== "boolean") {
		throw new Error(`${path}.passed must be a boolean`);
	}
	if (!Array.isArray(value.changedFiles)) {
		throw new Error(`${path}.changedFiles must be an array`);
	}
	for (const [index, file] of value.changedFiles.entries()) {
		if (!isRecord(file)) {
			throw new Error(`${path}.changedFiles[${index}] must be an object`);
		}
		assertString(file.path, `${path}.changedFiles[${index}].path`);
		assertString(file.status, `${path}.changedFiles[${index}].status`);
		if (file.previousPath !== undefined) {
			assertString(
				file.previousPath,
				`${path}.changedFiles[${index}].previousPath`,
			);
		}
	}
	if (typeof value.diffHash !== "string") {
		throw new Error(`${path}.diffHash must be a string`);
	}
	if (!Array.isArray(value.checks)) {
		throw new Error(`${path}.checks must be an array`);
	}
	for (const [index, check] of value.checks.entries()) {
		const checkPath = `${path}.checks[${index}]`;
		if (!isRecord(check)) {
			throw new Error(`${checkPath} must be an object`);
		}
		for (const field of [
			"command",
			"startedAt",
			"finishedAt",
			"stdoutTail",
			"stderrTail",
		] as const) {
			if (typeof check[field] !== "string") {
				throw new Error(`${checkPath}.${field} must be a string`);
			}
		}
		if (
			!Array.isArray(check.args) ||
			check.args.some((arg) => typeof arg !== "string")
		) {
			throw new Error(`${checkPath}.args must be an array of strings`);
		}
		if (check.exitCode !== null && !Number.isInteger(check.exitCode)) {
			throw new Error(`${checkPath}.exitCode must be an integer or null`);
		}
		if (typeof check.passed !== "boolean") {
			throw new Error(`${checkPath}.passed must be a boolean`);
		}
	}
}

export function validateStoredRun(value: unknown): BuildRun {
	if (!isRecord(value)) {
		throw new Error("run must be an object");
	}
	if (value.schemaVersion === 2 || value.schemaVersion === 3) {
		throw new Error(
			"Legacy run snapshots cannot become merge-ready because they lack an explicitly approved final validation suite; start a new approved run",
		);
	}
	if (value.schemaVersion !== RUN_SCHEMA_VERSION) {
		throw new Error(
			`Unsupported run schema version: ${String(value.schemaVersion)}`,
		);
	}
	assertString(value.id, "run.id");
	if (!SAFE_RUN_ID.test(value.id)) {
		throw new Error(`Unsafe run id: ${value.id}`);
	}
	if (
		typeof value.state !== "string" ||
		!RUN_STATES.has(value.state as RunState)
	) {
		throw new Error(`Invalid run state: ${String(value.state)}`);
	}
	for (const field of [
		"repositoryRoot",
		"baseBranch",
		"baseCommit",
		"integrationBranch",
		"createdAt",
		"updatedAt",
	] as const) {
		assertString(value[field], `run.${field}`);
	}
	const expectedIntegrationBranch = `conductor/${value.id}/integration`;
	if (value.integrationBranch !== expectedIntegrationBranch) {
		throw new Error(
			`run.integrationBranch must be ${expectedIntegrationBranch}`,
		);
	}
	if (value.integrationBranch === value.baseBranch) {
		throw new Error("run.integrationBranch must differ from run.baseBranch");
	}
	const plan = validateTaskPlan(value.plan);
	if (!isRecord(value.tasks)) {
		throw new Error("run.tasks must be an object");
	}
	const planById = new Map(plan.tasks.map((task) => [task.id, task]));
	if (Object.keys(value.tasks).length !== planById.size) {
		throw new Error("run.tasks must contain exactly the plan tasks");
	}
	for (const [id, definition] of planById) {
		const task = value.tasks[id];
		if (
			!isRecord(task) ||
			typeof task.state !== "string" ||
			!TASK_STATES.has(task.state as TaskState)
		) {
			throw new Error(`Invalid state for task ${id}`);
		}
		if (JSON.stringify(task.definition) !== JSON.stringify(definition)) {
			throw new Error(`Task definition does not match plan for ${id}`);
		}
		if (
			!Array.isArray(task.attemptIds) ||
			task.attemptIds.some((attemptId) => typeof attemptId !== "string")
		) {
			throw new Error(`Invalid attempt ids for task ${id}`);
		}
		for (const field of ["integratedCommit", "integrationError"] as const) {
			if (task[field] !== undefined) {
				assertString(task[field], `run.tasks.${id}.${field}`);
			}
		}
		if (
			task.integratedCommit !== undefined &&
			task.integrationError !== undefined
		) {
			throw new Error(
				`Task ${id} cannot have both an integrated commit and integration error`,
			);
		}
		if (task.integratedCommit !== undefined && task.state !== "succeeded") {
			throw new Error(`Integrated task ${id} must be succeeded`);
		}
		if (task.integrationError !== undefined && task.state !== "failed") {
			throw new Error(`Task ${id} has an integration error without failing`);
		}
	}
	let foundUnintegratedTask = false;
	for (const taskId of topologicalTaskIds(plan)) {
		const task = value.tasks[taskId];
		if (!isRecord(task)) {
			continue;
		}
		if (task.integratedCommit === undefined) {
			foundUnintegratedTask = true;
		} else if (foundUnintegratedTask) {
			throw new Error(
				`Integrated tasks must form a deterministic topological prefix; ${taskId} is out of order`,
			);
		}
	}
	if (!Array.isArray(value.attempts)) {
		throw new Error("run.attempts must be an array");
	}
	const attemptsById = new Map<string, Record<string, unknown>>();
	for (const [index, attempt] of value.attempts.entries()) {
		const path = `run.attempts[${index}]`;
		if (!isRecord(attempt)) {
			throw new Error(`${path} must be an object`);
		}
		for (const field of [
			"id",
			"taskId",
			"branch",
			"worktreePath",
			"baseCommit",
			"startedAt",
		] as const) {
			assertString(attempt[field], `${path}.${field}`);
		}
		if (!planById.has(attempt.taskId as string)) {
			throw new Error(`${path}.taskId references an unknown task`);
		}
		if (!Number.isInteger(attempt.number) || (attempt.number as number) < 1) {
			throw new Error(`${path}.number must be a positive integer`);
		}
		if (
			typeof attempt.state !== "string" ||
			!ATTEMPT_STATES.has(attempt.state as AttemptState)
		) {
			throw new Error(`${path}.state is invalid`);
		}
		for (const field of [
			"workerId",
			"finishedAt",
			"error",
			"commit",
		] as const) {
			if (attempt[field] !== undefined && typeof attempt[field] !== "string") {
				throw new Error(`${path}.${field} must be a string when present`);
			}
		}
		if (attempt.evidence !== undefined) {
			validateEvidence(attempt.evidence, `${path}.evidence`);
		}
		if (
			attempt.commit !== undefined &&
			(!isRecord(attempt.evidence) || attempt.evidence.passed !== true)
		) {
			throw new Error(
				`${path} has a commit without passing validation evidence`,
			);
		}
		if (attempt.state === "succeeded") {
			assertString(attempt.finishedAt, `${path}.finishedAt`);
			assertString(attempt.commit, `${path}.commit`);
		}
		if (attemptsById.has(attempt.id as string)) {
			throw new Error(`Duplicate attempt id: ${String(attempt.id)}`);
		}
		attemptsById.set(attempt.id as string, attempt);
	}
	const referencedAttemptIds = new Set<string>();
	for (const [taskId, task] of Object.entries(value.tasks)) {
		if (!isRecord(task) || !Array.isArray(task.attemptIds)) {
			continue;
		}
		const uniqueAttemptIds = new Set(task.attemptIds);
		if (uniqueAttemptIds.size !== task.attemptIds.length) {
			throw new Error(`Task ${taskId} has duplicate attempt ids`);
		}
		for (const attemptId of uniqueAttemptIds) {
			const normalizedAttemptId = String(attemptId);
			const attempt = attemptsById.get(normalizedAttemptId);
			if (!attempt || attempt.taskId !== taskId) {
				throw new Error(
					`Task ${taskId} references invalid attempt ${normalizedAttemptId}`,
				);
			}
			referencedAttemptIds.add(normalizedAttemptId);
		}
	}
	if (referencedAttemptIds.size !== attemptsById.size) {
		throw new Error("Every run attempt must be referenced by its task");
	}
	assertString(value.integrationHead, "run.integrationHead");
	if (!Array.isArray(value.reviewAttempts)) {
		throw new Error("run.reviewAttempts must be an array");
	}
	const reviewAttemptsById = new Map<string, Record<string, unknown>>();
	const findingIds = new Set<string>();
	const findingRounds = new Map<string, number>();
	for (const [index, attempt] of value.reviewAttempts.entries()) {
		const path = `run.reviewAttempts[${index}]`;
		if (!isRecord(attempt)) {
			throw new Error(`${path} must be an object`);
		}
		for (const field of [
			"id",
			"branch",
			"worktreePath",
			"baseCommit",
			"startedAt",
		] as const) {
			assertString(attempt[field], `${path}.${field}`);
		}
		if (!Number.isInteger(attempt.round) || (attempt.round as number) < 1) {
			throw new Error(`${path}.round must be a positive integer`);
		}
		if (!Number.isInteger(attempt.number) || (attempt.number as number) < 1) {
			throw new Error(`${path}.number must be a positive integer`);
		}
		if (
			typeof attempt.category !== "string" ||
			!REVIEW_CATEGORY_SET.has(attempt.category as ReviewCategory)
		) {
			throw new Error(`${path}.category is invalid`);
		}
		if (
			typeof attempt.state !== "string" ||
			!ATTEMPT_STATES.has(attempt.state as AttemptState)
		) {
			throw new Error(`${path}.state is invalid`);
		}
		for (const field of [
			"workerId",
			"finishedAt",
			"error",
			"summary",
		] as const) {
			if (attempt[field] !== undefined && typeof attempt[field] !== "string") {
				throw new Error(`${path}.${field} must be a string when present`);
			}
		}
		if (attempt.findings !== undefined) {
			if (!Array.isArray(attempt.findings)) {
				throw new Error(`${path}.findings must be an array`);
			}
			for (const [findingIndex, finding] of attempt.findings.entries()) {
				const findingPath = `${path}.findings[${findingIndex}]`;
				if (!isRecord(finding)) {
					throw new Error(`${findingPath} must be an object`);
				}
				for (const field of [
					"id",
					"title",
					"description",
					"recommendation",
				] as const) {
					assertString(finding[field], `${findingPath}.${field}`);
				}
				if (finding.category !== attempt.category) {
					throw new Error(
						`${findingPath}.category must match its review attempt`,
					);
				}
				if (
					typeof finding.severity !== "string" ||
					!REVIEW_SEVERITIES.has(finding.severity as ReviewSeverity)
				) {
					throw new Error(`${findingPath}.severity is invalid`);
				}
				if (
					typeof finding.confidence !== "string" ||
					!REVIEW_CONFIDENCES.has(finding.confidence as ReviewConfidence)
				) {
					throw new Error(`${findingPath}.confidence is invalid`);
				}
				if (
					typeof finding.status !== "string" ||
					!FINDING_STATES.has(finding.status as ReviewFindingStatus)
				) {
					throw new Error(`${findingPath}.status is invalid`);
				}
				if (
					!Array.isArray(finding.paths) ||
					finding.paths.length === 0 ||
					finding.paths.some((item) => typeof item !== "string" || !item)
				) {
					throw new Error(`${findingPath}.paths must be non-empty strings`);
				}
				if (finding.repairAttemptId !== undefined) {
					assertString(
						finding.repairAttemptId,
						`${findingPath}.repairAttemptId`,
					);
				}
				if (findingIds.has(finding.id as string)) {
					throw new Error(`Duplicate review finding id: ${String(finding.id)}`);
				}
				findingIds.add(finding.id as string);
				findingRounds.set(finding.id as string, attempt.round as number);
			}
		}
		if (attempt.state === "succeeded") {
			assertString(attempt.finishedAt, `${path}.finishedAt`);
			assertString(attempt.summary, `${path}.summary`);
			if (!Array.isArray(attempt.findings)) {
				throw new Error(`${path}.findings must be present when succeeded`);
			}
		}
		if (reviewAttemptsById.has(attempt.id as string)) {
			throw new Error(`Duplicate review attempt id: ${String(attempt.id)}`);
		}
		reviewAttemptsById.set(attempt.id as string, attempt);
	}
	if (!Array.isArray(value.repairAttempts)) {
		throw new Error("run.repairAttempts must be an array");
	}
	const repairAttemptsById = new Map<string, Record<string, unknown>>();
	const storedTasks = value.tasks as Record<string, unknown>;
	let expectedIntegrationHead = topologicalTaskIds(plan).reduce(
		(head, taskId) => {
			const task = storedTasks[taskId];
			return isRecord(task) && typeof task.integratedCommit === "string"
				? task.integratedCommit
				: head;
		},
		value.baseCommit as string,
	);
	for (const [index, attempt] of value.repairAttempts.entries()) {
		const path = `run.repairAttempts[${index}]`;
		if (!isRecord(attempt)) {
			throw new Error(`${path} must be an object`);
		}
		for (const field of [
			"id",
			"branch",
			"worktreePath",
			"baseCommit",
			"startedAt",
		] as const) {
			assertString(attempt[field], `${path}.${field}`);
		}
		if (!Number.isInteger(attempt.round) || (attempt.round as number) < 1) {
			throw new Error(`${path}.round must be a positive integer`);
		}
		if (!Number.isInteger(attempt.number) || (attempt.number as number) < 1) {
			throw new Error(`${path}.number must be a positive integer`);
		}
		if (
			typeof attempt.state !== "string" ||
			!ATTEMPT_STATES.has(attempt.state as AttemptState)
		) {
			throw new Error(`${path}.state is invalid`);
		}
		if (
			!Array.isArray(attempt.findingIds) ||
			attempt.findingIds.length === 0 ||
			attempt.findingIds.some(
				(id) =>
					typeof id !== "string" ||
					!findingIds.has(id) ||
					findingRounds.get(id) !== attempt.round,
			)
		) {
			throw new Error(`${path}.findingIds must reference review findings`);
		}
		for (const field of [
			"workerId",
			"finishedAt",
			"error",
			"commit",
			"integratedCommit",
		] as const) {
			if (attempt[field] !== undefined && typeof attempt[field] !== "string") {
				throw new Error(`${path}.${field} must be a string when present`);
			}
		}
		if (attempt.evidence !== undefined) {
			validateEvidence(attempt.evidence, `${path}.evidence`);
		}
		if (
			attempt.commit !== undefined &&
			(!isRecord(attempt.evidence) || attempt.evidence.passed !== true)
		) {
			throw new Error(
				`${path} has a commit without passing validation evidence`,
			);
		}
		if (attempt.integratedCommit !== undefined) {
			assertString(attempt.commit, `${path}.commit`);
			if (attempt.baseCommit !== expectedIntegrationHead) {
				throw new Error(`${path}.baseCommit breaks the integration chain`);
			}
			expectedIntegrationHead = attempt.integratedCommit as string;
		}
		if (attempt.state === "succeeded") {
			assertString(attempt.finishedAt, `${path}.finishedAt`);
			assertString(attempt.integratedCommit, `${path}.integratedCommit`);
		}
		if (repairAttemptsById.has(attempt.id as string)) {
			throw new Error(`Duplicate repair attempt id: ${String(attempt.id)}`);
		}
		repairAttemptsById.set(attempt.id as string, attempt);
	}
	if (value.integrationHead !== expectedIntegrationHead) {
		throw new Error(
			`run.integrationHead must match integrated task and repair commits (${expectedIntegrationHead})`,
		);
	}
	if (!Array.isArray(value.reviewRounds)) {
		throw new Error("run.reviewRounds must be an array");
	}
	const referencedReviewAttemptIds = new Set<string>();
	for (const [index, round] of value.reviewRounds.entries()) {
		const path = `run.reviewRounds[${index}]`;
		if (!isRecord(round)) {
			throw new Error(`${path} must be an object`);
		}
		if (round.number !== index + 1) {
			throw new Error(`${path}.number must be sequential`);
		}
		assertString(round.baseCommit, `${path}.baseCommit`);
		assertString(round.startedAt, `${path}.startedAt`);
		if (
			typeof round.state !== "string" ||
			!REVIEW_ROUND_STATES.has(round.state as ReviewRoundState)
		) {
			throw new Error(`${path}.state is invalid`);
		}
		if (
			!Array.isArray(round.attemptIds) ||
			new Set(round.attemptIds).size !== round.attemptIds.length
		) {
			throw new Error(`${path}.attemptIds must be a unique array`);
		}
		const categories = new Set<unknown>();
		for (const attemptId of round.attemptIds) {
			const normalizedAttemptId = String(attemptId);
			referencedReviewAttemptIds.add(normalizedAttemptId);
			const attempt = reviewAttemptsById.get(normalizedAttemptId);
			if (
				!attempt ||
				attempt.round !== round.number ||
				attempt.baseCommit !== round.baseCommit
			) {
				throw new Error(
					`${path} references invalid review attempt ${String(attemptId)}`,
				);
			}
			if (categories.has(attempt.category)) {
				throw new Error(`${path} has duplicate succeeded review categories`);
			}
			if (attempt.state === "succeeded") {
				categories.add(attempt.category);
			}
		}
		for (const field of ["finishedAt", "repairAttemptId", "error"] as const) {
			if (round[field] !== undefined && typeof round[field] !== "string") {
				throw new Error(`${path}.${field} must be a string when present`);
			}
		}
		if (round.repairAttemptId !== undefined) {
			const repair = repairAttemptsById.get(round.repairAttemptId as string);
			if (!repair || repair.round !== round.number) {
				throw new Error(`${path}.repairAttemptId is invalid`);
			}
		}
		if (
			round.state === "succeeded" &&
			categories.size !== REVIEW_CATEGORIES.length
		) {
			throw new Error(`${path} succeeded without all review categories`);
		}
	}
	if (referencedReviewAttemptIds.size !== reviewAttemptsById.size) {
		throw new Error(
			"Every review attempt must be referenced by a review round",
		);
	}
	for (const attempt of reviewAttemptsById.values()) {
		if (!Array.isArray(attempt.findings)) {
			continue;
		}
		for (const finding of attempt.findings) {
			if (!isRecord(finding) || finding.status !== "repaired") {
				continue;
			}
			const repair = repairAttemptsById.get(String(finding.repairAttemptId));
			if (
				repair?.state !== "succeeded" ||
				!repair.integratedCommit ||
				!Array.isArray(repair.findingIds) ||
				!repair.findingIds.includes(finding.id)
			) {
				throw new Error(
					`Repaired finding ${String(finding.id)} must reference an integrated repair attempt`,
				);
			}
		}
	}
	if (["reviewed", "validating", "completed"].includes(String(value.state))) {
		const latestRound = value.reviewRounds.at(-1);
		if (!isRecord(latestRound) || latestRound.state !== "succeeded") {
			throw new Error("Reviewed run must have a succeeded final review round");
		}
		const unresolved = [...reviewAttemptsById.values()].some(
			(attempt) =>
				Array.isArray(attempt.findings) &&
				attempt.findings.some(
					(finding) =>
						isRecord(finding) &&
						["repair_required", "unresolved"].includes(String(finding.status)),
				),
		);
		if (unresolved) {
			throw new Error(
				"Reviewed run cannot contain unresolved important findings",
			);
		}
	}
	if (!Array.isArray(value.finalValidationAttempts)) {
		throw new Error("run.finalValidationAttempts must be an array");
	}
	const finalAttemptIds = new Set<string>();
	for (const [index, attempt] of value.finalValidationAttempts.entries()) {
		const path = `run.finalValidationAttempts[${index}]`;
		if (!isRecord(attempt)) {
			throw new Error(`${path} must be an object`);
		}
		assertString(attempt.id, `${path}.id`);
		assertString(attempt.integrationCommit, `${path}.integrationCommit`);
		assertString(attempt.worktreePath, `${path}.worktreePath`);
		assertString(attempt.startedAt, `${path}.startedAt`);
		if (attempt.number !== index + 1) {
			throw new Error(`${path}.number must be sequential`);
		}
		if (
			typeof attempt.state !== "string" ||
			!FINAL_VALIDATION_ATTEMPT_STATES.has(
				attempt.state as FinalValidationAttemptState,
			)
		) {
			throw new Error(`${path}.state is invalid`);
		}
		for (const field of ["finishedAt", "error"] as const) {
			if (attempt[field] !== undefined) {
				assertString(attempt[field], `${path}.${field}`);
			}
		}
		if (attempt.evidence !== undefined) {
			if (!isRecord(attempt.evidence)) {
				throw new Error(`${path}.evidence must be an object`);
			}
			assertString(attempt.evidence.startedAt, `${path}.evidence.startedAt`);
			assertString(attempt.evidence.finishedAt, `${path}.evidence.finishedAt`);
			if (typeof attempt.evidence.passed !== "boolean") {
				throw new Error(`${path}.evidence.passed must be a boolean`);
			}
			if (!Array.isArray(attempt.evidence.checks)) {
				throw new Error(`${path}.evidence.checks must be an array`);
			}
			validateEvidence(
				{
					...attempt.evidence,
					changedFiles: [],
					diffHash: "",
				},
				`${path}.evidence`,
			);
		}
		if (attempt.state === "succeeded") {
			assertString(attempt.finishedAt, `${path}.finishedAt`);
			if (!isRecord(attempt.evidence) || attempt.evidence.passed !== true) {
				throw new Error(`${path} succeeded without passing evidence`);
			}
			const checks = attempt.evidence.checks;
			if (
				!Array.isArray(checks) ||
				checks.length !== plan.finalValidationCommands.length ||
				checks.some((check, checkIndex) => {
					const command = plan.finalValidationCommands[checkIndex];
					return (
						!isRecord(check) ||
						check.passed !== true ||
						check.command !== command?.command ||
						JSON.stringify(check.args) !== JSON.stringify(command?.args)
					);
				})
			) {
				throw new Error(
					`${path} evidence must match every approved final validation command in order`,
				);
			}
		}
		if (finalAttemptIds.has(attempt.id as string)) {
			throw new Error(
				`Duplicate final validation attempt id: ${String(attempt.id)}`,
			);
		}
		finalAttemptIds.add(attempt.id as string);
	}
	const runningFinalAttempts = value.finalValidationAttempts.filter(
		(attempt) => isRecord(attempt) && attempt.state === "running",
	);
	if (runningFinalAttempts.length > 1) {
		throw new Error(
			"Run cannot have more than one active final validation attempt",
		);
	}
	if ((value.state === "validating") !== (runningFinalAttempts.length === 1)) {
		throw new Error(
			"Validating run state must have exactly one running final validation attempt",
		);
	}
	const mergeReady = value.mergeReadyEvidence;
	if (mergeReady !== undefined) {
		if (
			!isRecord(mergeReady) ||
			mergeReady.version !== MERGE_READY_EVIDENCE_VERSION
		) {
			throw new Error("run.mergeReadyEvidence has an unsupported version");
		}
		for (const field of [
			"generatedAt",
			"integrationBranch",
			"integrationHead",
			"baseBranch",
			"baseCommit",
		] as const) {
			assertString(mergeReady[field], `run.mergeReadyEvidence.${field}`);
		}
		if (
			mergeReady.integrationBranch !== value.integrationBranch ||
			mergeReady.integrationHead !== value.integrationHead ||
			mergeReady.baseBranch !== value.baseBranch ||
			mergeReady.baseCommit !== value.baseCommit
		) {
			throw new Error("run.mergeReadyEvidence does not match the run refs");
		}
		for (const field of [
			"commits",
			"finalReviews",
			"remainingRisks",
			"finalChecks",
		] as const) {
			if (!Array.isArray(mergeReady[field])) {
				throw new Error(`run.mergeReadyEvidence.${field} must be an array`);
			}
		}
		if (!isRecord(mergeReady.git)) {
			throw new Error("run.mergeReadyEvidence.git must be an object");
		}
		for (const field of [
			"verifiedAt",
			"integrationBranch",
			"integrationHead",
			"baseBranch",
			"baseCommit",
			"userBranch",
			"userHead",
		] as const) {
			assertString(
				mergeReady.git[field],
				`run.mergeReadyEvidence.git.${field}`,
			);
		}
		if (
			mergeReady.git.userWorktreeClean !== true ||
			mergeReady.git.integrationBranch !== value.integrationBranch ||
			mergeReady.git.integrationHead !== value.integrationHead ||
			mergeReady.git.baseBranch !== value.baseBranch ||
			mergeReady.git.baseCommit !== value.baseCommit ||
			mergeReady.git.userBranch !== value.baseBranch ||
			mergeReady.git.userHead !== value.baseCommit
		) {
			throw new Error(
				"run.mergeReadyEvidence.git does not prove untouched refs",
			);
		}
		if (!Array.isArray(mergeReady.git.commits)) {
			throw new Error("run.mergeReadyEvidence.git.commits must be an array");
		}
		const storedAttempts = value.attempts as unknown[];
		const expectedCommits = topologicalTaskIds(plan).map((taskId) => {
			const task = storedTasks[taskId];
			if (!isRecord(task)) {
				throw new Error(`Missing persisted task ${taskId}`);
			}
			const attemptIds = Array.isArray(task.attemptIds)
				? new Set(task.attemptIds.map(String))
				: new Set<string>();
			const source = storedAttempts.findLast(
				(attempt: unknown) =>
					isRecord(attempt) &&
					attemptIds.has(String(attempt.id)) &&
					attempt.state === "succeeded" &&
					typeof attempt.commit === "string",
			);
			if (!isRecord(source) || typeof source.commit !== "string") {
				throw new Error(`Task ${taskId} lacks source commit evidence`);
			}
			return {
				kind: "task",
				id: taskId,
				sourceCommit: source.commit,
				integratedCommit: String(task.integratedCommit),
			};
		});
		for (const repair of value.repairAttempts) {
			if (
				isRecord(repair) &&
				repair.state === "succeeded" &&
				typeof repair.commit === "string" &&
				typeof repair.integratedCommit === "string"
			) {
				expectedCommits.push({
					kind: "repair",
					id: String(repair.id),
					sourceCommit: repair.commit,
					integratedCommit: repair.integratedCommit,
				});
			}
		}
		if (
			JSON.stringify(mergeReady.commits) !== JSON.stringify(expectedCommits)
		) {
			throw new Error(
				"run.mergeReadyEvidence.commits must exactly match integrated task and repair order",
			);
		}
		const expectedGitCommits = expectedCommits.map((commit, index) => ({
			hash: commit.integratedCommit,
			parent:
				index === 0
					? value.baseCommit
					: expectedCommits[index - 1]?.integratedCommit,
		}));
		if (
			mergeReady.git.commits.length !== expectedGitCommits.length ||
			mergeReady.git.commits.some((commit, index) => {
				if (!isRecord(commit)) {
					return true;
				}
				assertString(
					commit.subject,
					`run.mergeReadyEvidence.git.commits[${index}].subject`,
				);
				const expected = expectedGitCommits[index];
				return (
					!expected ||
					commit.hash !== expected.hash ||
					commit.parent !== expected.parent
				);
			})
		) {
			throw new Error(
				"run.mergeReadyEvidence.git.commits must match the exact linear integration chain",
			);
		}
		const latestRound = value.reviewRounds.at(-1);
		if (!isRecord(latestRound) || typeof latestRound.number !== "number") {
			throw new Error(
				"run.mergeReadyEvidence requires a completed final review round",
			);
		}
		const finalReviewAttempts = value.reviewAttempts.filter(
			(attempt) =>
				isRecord(attempt) &&
				attempt.round === latestRound.number &&
				attempt.state === "succeeded",
		);
		const expectedFinalReviews = REVIEW_CATEGORIES.map((category) => {
			const attempt = finalReviewAttempts.find(
				(item) => item.category === category,
			);
			if (!attempt || typeof attempt.summary !== "string") {
				throw new Error(
					`run.mergeReadyEvidence is missing the final ${category} review`,
				);
			}
			return { category, summary: attempt.summary };
		});
		if (
			JSON.stringify(mergeReady.finalReviews) !==
			JSON.stringify(expectedFinalReviews)
		) {
			throw new Error(
				"run.mergeReadyEvidence.finalReviews must match the final review round",
			);
		}
		const expectedRemainingRisks = finalReviewAttempts
			.flatMap((attempt) =>
				Array.isArray(attempt.findings) ? attempt.findings : [],
			)
			.filter((finding) => isRecord(finding) && finding.status === "deferred")
			.sort((left, right) => String(left.id).localeCompare(String(right.id)));
		if (
			JSON.stringify(mergeReady.remainingRisks) !==
			JSON.stringify(expectedRemainingRisks)
		) {
			throw new Error(
				"run.mergeReadyEvidence.remainingRisks must match deferred findings from the final review round",
			);
		}
		const successfulValidation = value.finalValidationAttempts.findLast(
			(attempt) =>
				isRecord(attempt) &&
				attempt.state === "succeeded" &&
				attempt.integrationCommit === value.integrationHead,
		);
		if (
			!successfulValidation ||
			!isRecord(successfulValidation.evidence) ||
			JSON.stringify(mergeReady.finalChecks) !==
				JSON.stringify(successfulValidation.evidence.checks)
		) {
			throw new Error(
				"run.mergeReadyEvidence.finalChecks must match passing final validation evidence",
			);
		}
	}
	if (value.state === "completed") {
		const succeeded = value.finalValidationAttempts.findLast(
			(attempt) =>
				isRecord(attempt) &&
				attempt.state === "succeeded" &&
				attempt.integrationCommit === value.integrationHead,
		);
		if (!succeeded || mergeReady === undefined) {
			throw new Error(
				"Completed run requires passing final validation at integrationHead and merge-ready evidence",
			);
		}
	}
	if (
		["failed", "cancelled"].includes(String(value.state)) &&
		mergeReady !== undefined
	) {
		throw new Error(
			`${String(value.state)} run cannot have merge-ready evidence`,
		);
	}
	if (
		!Number.isInteger(value.maxConcurrentWorkers) ||
		(value.maxConcurrentWorkers as number) < MIN_CONCURRENT_WORKERS ||
		(value.maxConcurrentWorkers as number) > MAX_CONCURRENT_WORKERS
	) {
		throw new Error(
			`run.maxConcurrentWorkers must be an integer from ${MIN_CONCURRENT_WORKERS} to ${MAX_CONCURRENT_WORKERS}`,
		);
	}
	const activeTaskAttempts = [...attemptsById.values()].filter((attempt) =>
		isActiveAttemptState(attempt.state as AttemptState),
	);
	const activeAttempts = [
		...activeTaskAttempts,
		...reviewAttemptsById.values(),
		...repairAttemptsById.values(),
	].filter((attempt) => isActiveAttemptState(attempt.state as AttemptState));
	if (activeAttempts.length > (value.maxConcurrentWorkers as number)) {
		throw new Error("Run has more active attempts than its concurrency limit");
	}
	const activeAttemptCountByTask = new Map<string, number>();
	for (const attempt of activeTaskAttempts) {
		const taskId = String(attempt.taskId);
		activeAttemptCountByTask.set(
			taskId,
			(activeAttemptCountByTask.get(taskId) ?? 0) + 1,
		);
	}
	for (const [taskId, count] of activeAttemptCountByTask) {
		if (count > 1) {
			throw new Error(`Task ${taskId} has more than one active attempt`);
		}
	}
	for (const [taskId, task] of Object.entries(value.tasks)) {
		if (
			isRecord(task) &&
			["running", "validating"].includes(String(task.state)) &&
			!activeAttemptCountByTask.has(taskId)
		) {
			throw new Error(`Active task ${taskId} has no active attempt`);
		}
		if (isRecord(task) && task.state === "succeeded") {
			const hasSucceededAttempt =
				Array.isArray(task.attemptIds) &&
				task.attemptIds.some(
					(attemptId) =>
						attemptsById.get(String(attemptId))?.state === "succeeded",
				);
			if (!hasSucceededAttempt) {
				throw new Error(
					`Succeeded task ${taskId} has no succeeded committed attempt`,
				);
			}
		}
	}
	if (!isRecord(value.handoff)) {
		throw new Error("run.handoff must be an object");
	}
	assertString(value.handoff.sourcePath, "run.handoff.sourcePath");
	assertString(value.handoff.text, "run.handoff.text");
	return value as unknown as BuildRun;
}

export class RunStore {
	constructor(readonly directory: string) {}

	private pathFor(runId: string): string {
		if (!SAFE_RUN_ID.test(runId)) {
			throw new Error(`Unsafe run id: ${runId}`);
		}
		return join(this.directory, `${runId}.json`);
	}

	async save(run: BuildRun): Promise<void> {
		const validated = validateStoredRun(run);
		await mkdir(this.directory, { recursive: true });
		const destination = this.pathFor(validated.id);
		const temporary = join(
			this.directory,
			`.${validated.id}.${randomUUID()}.tmp`,
		);
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(temporary, destination);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	async load(runId: string): Promise<BuildRun> {
		const path = this.pathFor(runId);
		try {
			return validateStoredRun(JSON.parse(await readFile(path, "utf8")));
		} catch (error) {
			throw new Error(`Failed to load run ${runId} from ${path}`, {
				cause: error,
			});
		}
	}

	async list(): Promise<BuildRun[]> {
		let entries: string[];
		try {
			entries = await readdir(this.directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return [];
			}
			throw error;
		}
		const runIds = entries
			.flatMap((entry) =>
				entry.endsWith(".json") ? [entry.slice(0, -".json".length)] : [],
			)
			.sort((left, right) => left.localeCompare(right));
		return Promise.all(runIds.map((runId) => this.load(runId)));
	}

	async recover(
		runId: string,
		now = new Date().toISOString(),
	): Promise<BuildRun> {
		const run = await this.load(runId);
		const recovered = recoverInterruptedRun(run, now);
		if (recovered !== run) {
			await this.save(recovered);
		}
		return recovered;
	}
}
