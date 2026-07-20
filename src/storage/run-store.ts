import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { validateTaskPlan } from "../domain/dag.js";
import { recoverInterruptedRun } from "../domain/run.js";
import {
	type AttemptState,
	type BuildRun,
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
	"validating",
	"completed",
	"failed",
	"cancelled",
]);
const TASK_STATES: ReadonlySet<TaskState> = new Set([
	"planned",
	"ready",
	"running",
	"succeeded",
	"failed",
	"blocked",
	"cancelled",
]);
const ATTEMPT_STATES: ReadonlySet<AttemptState> = new Set([
	"prepared",
	"launched",
	"running",
	"succeeded",
	"failed",
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

export function validateStoredRun(value: unknown): BuildRun {
	if (!isRecord(value)) {
		throw new Error("run must be an object");
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
	if (
		!Number.isInteger(value.maxConcurrentWorkers) ||
		(value.maxConcurrentWorkers as number) < 1
	) {
		throw new Error("run.maxConcurrentWorkers must be a positive integer");
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
