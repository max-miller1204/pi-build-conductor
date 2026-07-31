import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_KINDS } from "../domain/artifacts.js";
import { isRecord } from "../domain/dag.js";
import {
	type StepDefinition,
	topologicalStepIds,
	validateWorkflowPlan,
	type WorkflowPlan,
} from "../domain/steps.js";
import {
	type AttemptState,
	isActiveAttemptState,
	MAX_CONCURRENT_WORKERS,
	type RunCapabilityProfiles,
} from "../domain/types.js";
import { MAX_WORKFLOW_EVENTS, type WorkflowEvent } from "../engine/events.js";
import type { WorkflowStateStore } from "../engine/state-store.js";
import type {
	StepRunState,
	WorkflowRunLifecycleState,
	WorkflowRunState,
} from "../engine/workflow-state.js";
import {
	stepConsumesWorkerSlot,
	stepRequiresIntegration,
	stepWorkspaceRequirement,
	WORKSPACE_REQUIREMENTS,
} from "../engine/workspaces.js";
import { assertCapabilityProfiles } from "../security/capabilities.js";
import {
	acquireStorageLock,
	validateStoredEvidence,
	writeFileAtomic,
} from "./file-storage.js";

/**
 * The stored engine run schema. It is versioned independently of the legacy
 * `RunStore` schema because the two describe different execution models and
 * never migrate into one another.
 */
export const WORKFLOW_RUN_SCHEMA_VERSION = 1 as const;

/** The storage-root subdirectory holding engine workflow run snapshots. */
export const WORKFLOW_RUNS_DIRECTORY_NAME = "workflow-runs";

const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const LIFECYCLE_STATES: readonly WorkflowRunLifecycleState[] = [
	"running",
	"completed",
	"failed",
	"cancelled",
];
const STEP_RUN_STATES: ReadonlySet<StepRunState> = new Set([
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
	"validating",
	"succeeded",
	"failed",
	"cancelled",
	"interrupted",
]);

/**
 * One durably stored engine run. The envelope keeps the schema version and the
 * write revision outside the run model itself, so the `WorkflowRunState` the
 * engine mutates stays free of storage concerns.
 */
export interface StoredWorkflowRun {
	schemaVersion: typeof WORKFLOW_RUN_SCHEMA_VERSION;
	revision: number;
	run: WorkflowRunState;
}

export type StoredWorkflowRunEntry =
	| { kind: "run"; run: WorkflowRunState }
	| { kind: "unreadable"; runId: string; error: string };

function assertString(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${path} must be a non-empty string`);
	}
}

function assertOptionalString(value: unknown, path: string): void {
	if (value !== undefined) {
		assertString(value, path);
	}
}

function assertOptionalText(value: unknown, path: string): void {
	if (value !== undefined && typeof value !== "string") {
		throw new Error(`${path} must be a string when present`);
	}
}

function assertPositiveInteger(value: unknown, path: string): void {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		throw new Error(`${path} must be a positive safe integer`);
	}
}

function assertCountingInteger(value: unknown, path: string): void {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${path} must be a non-negative safe integer`);
	}
}

function assertStringArray(value: unknown, path: string): void {
	if (
		!Array.isArray(value) ||
		value.some((entry) => typeof entry !== "string")
	) {
		throw new Error(`${path} must be an array of strings`);
	}
}

/**
 * The exact shape of every timeline event body. Requiring an exhaustive match
 * makes adding an event field a deliberate schema decision instead of a silent
 * change to what a stored run may contain.
 */
interface EventShape {
	/** Fields that must be strings; an engine-supplied "" stays valid. */
	text?: readonly string[];
	optionalText?: readonly string[];
	integers?: readonly string[];
	enums?: Readonly<Record<string, readonly string[]>>;
	textArrays?: readonly string[];
}

const EVENT_SHAPES: Readonly<Record<WorkflowEvent["kind"], EventShape>> = {
	step_launched: {
		text: ["stepId", "attemptId"],
		integers: ["attemptNumber"],
		enums: { workspaceRequirement: WORKSPACE_REQUIREMENTS },
	},
	step_succeeded: { text: ["stepId", "attemptId"], optionalText: ["summary"] },
	step_failed: {
		text: ["stepId", "attemptId", "error", "reason"],
		enums: { failureClass: ["retryable", "terminal"] },
	},
	step_retry_scheduled: {
		text: ["stepId", "attemptId", "reason"],
		integers: ["nextAttemptNumber"],
	},
	step_cancelled: { text: ["stepId"], optionalText: ["attemptId", "error"] },
	step_blocked: { text: ["stepId"], textArrays: ["blockedBy"] },
	artifact_published: {
		text: ["stepId", "attemptId", "artifactId", "output"],
		integers: ["sizeBytes"],
		enums: { artifactKind: ARTIFACT_KINDS },
	},
	step_integrated: {
		text: ["stepId", "integrationHead"],
		optionalText: ["commit"],
	},
	run_cancellation_requested: { text: ["reason"] },
	run_settled: { optionalText: ["error"], enums: { state: LIFECYCLE_STATES } },
};

function validateEvent(value: unknown, path: string): WorkflowEvent {
	if (!isRecord(value)) {
		throw new Error(`${path} must be an object`);
	}
	const shape = EVENT_SHAPES[value.kind as WorkflowEvent["kind"]];
	if (!shape) {
		throw new Error(`${path}.kind is unknown: ${String(value.kind)}`);
	}
	assertPositiveInteger(value.sequence, `${path}.sequence`);
	assertString(value.at, `${path}.at`);
	for (const field of shape.text ?? []) {
		if (typeof value[field] !== "string") {
			throw new Error(`${path}.${field} must be a string`);
		}
	}
	for (const field of shape.optionalText ?? []) {
		if (value[field] !== undefined && typeof value[field] !== "string") {
			throw new Error(`${path}.${field} must be a string when present`);
		}
	}
	for (const field of shape.integers ?? []) {
		assertCountingInteger(value[field], `${path}.${field}`);
	}
	for (const [field, allowed] of Object.entries(shape.enums ?? {})) {
		if (!allowed.includes(String(value[field]))) {
			throw new Error(`${path}.${field} is invalid: ${String(value[field])}`);
		}
	}
	for (const field of shape.textArrays ?? []) {
		assertStringArray(value[field], `${path}.${field}`);
	}
	const known = new Set([
		"kind",
		"sequence",
		"at",
		...(shape.text ?? []),
		...(shape.optionalText ?? []),
		...(shape.integers ?? []),
		...Object.keys(shape.enums ?? {}),
		...(shape.textArrays ?? []),
	]);
	const unexpected = Object.keys(value).filter((field) => !known.has(field));
	if (unexpected.length > 0) {
		throw new Error(
			`${path} has unexpected ${String(value.kind)} fields: ${unexpected.join(", ")}`,
		);
	}
	return value as unknown as WorkflowEvent;
}

function validateStoredEvents(run: Record<string, unknown>): void {
	if (!Array.isArray(run.events)) {
		throw new Error("run.events must be an array");
	}
	if (run.events.length > MAX_WORKFLOW_EVENTS) {
		throw new Error(
			`run.events retains ${run.events.length} entries; the window is ${MAX_WORKFLOW_EVENTS}`,
		);
	}
	assertCountingInteger(run.eventSequence, "run.eventSequence");
	assertCountingInteger(run.droppedEvents, "run.droppedEvents");
	const eventSequence = run.eventSequence as number;
	let previous = 0;
	let last = 0;
	for (const [index, event] of run.events.entries()) {
		const validated = validateEvent(event, `run.events[${index}]`);
		if (validated.sequence <= previous) {
			throw new Error(
				`run.events[${index}].sequence must increase strictly along the timeline`,
			);
		}
		previous = validated.sequence;
		last = validated.sequence;
	}
	// Every event ever appended is either retained or counted as dropped, so a
	// truncated timeline can never be mistaken for a complete one.
	if (eventSequence !== run.events.length + (run.droppedEvents as number)) {
		throw new Error(
			"run.eventSequence must equal the retained events plus the dropped events",
		);
	}
	if (run.events.length > 0 && last !== eventSequence) {
		throw new Error("run.events must end at the highest assigned sequence");
	}
}

function validateStoredSteps(
	run: Record<string, unknown>,
	plan: WorkflowPlan,
	profiles: RunCapabilityProfiles,
): Map<string, StepDefinition> {
	if (!isRecord(run.steps)) {
		throw new Error("run.steps must be an object");
	}
	const definitions = new Map(plan.steps.map((step) => [step.id, step]));
	if (Object.keys(run.steps).length !== definitions.size) {
		throw new Error("run.steps must contain exactly the plan steps");
	}
	for (const [stepId, definition] of definitions) {
		const record = run.steps[stepId];
		const path = `run.steps.${stepId}`;
		if (!isRecord(record)) {
			throw new Error(`${path} must be an object`);
		}
		if (!STEP_RUN_STATES.has(record.state as StepRunState)) {
			throw new Error(`${path}.state is invalid: ${String(record.state)}`);
		}
		if (JSON.stringify(record.definition) !== JSON.stringify(definition)) {
			throw new Error(`${path}.definition does not match the plan`);
		}
		assertStringArray(record.attemptIds, `${path}.attemptIds`);
		const attemptIds = record.attemptIds as string[];
		if (new Set(attemptIds).size !== attemptIds.length) {
			throw new Error(`${path}.attemptIds must be unique`);
		}
		assertOptionalString(record.integratedCommit, `${path}.integratedCommit`);
		for (const field of ["integrationError", "error"] as const) {
			assertOptionalText(record[field], `${path}.${field}`);
		}
		if (
			record.integratedCommit !== undefined &&
			record.integrationError !== undefined
		) {
			throw new Error(
				`${path} cannot have both an integrated commit and an integration error`,
			);
		}
		if (record.integratedCommit !== undefined && record.state !== "succeeded") {
			throw new Error(`${path} is integrated without having succeeded`);
		}
		if (
			record.integratedCommit !== undefined &&
			!stepRequiresIntegration(profiles, definition)
		) {
			throw new Error(
				`${path} is integrated without mutate-repository authority`,
			);
		}
	}
	return definitions;
}

function validateStoredAttempts(
	run: Record<string, unknown>,
	definitions: Map<string, StepDefinition>,
	profiles: RunCapabilityProfiles,
): void {
	if (!Array.isArray(run.attempts)) {
		throw new Error("run.attempts must be an array");
	}
	const attempts = new Map<string, Record<string, unknown>>();
	const numbersByStep = new Set<string>();
	const activeSteps = new Set<string>();
	for (const [index, attempt] of run.attempts.entries()) {
		const path = `run.attempts[${index}]`;
		if (!isRecord(attempt)) {
			throw new Error(`${path} must be an object`);
		}
		for (const field of ["id", "stepId", "baseCommit", "startedAt"] as const) {
			assertString(attempt[field], `${path}.${field}`);
		}
		for (const field of [
			"branch",
			"finishedAt",
			"commit",
			"workerId",
		] as const) {
			assertOptionalString(attempt[field], `${path}.${field}`);
		}
		for (const field of [
			"summary",
			"error",
			"workspaceReleaseError",
		] as const) {
			assertOptionalText(attempt[field], `${path}.${field}`);
		}
		if (!definitions.has(attempt.stepId as string)) {
			throw new Error(`${path}.stepId references an unknown step`);
		}
		assertPositiveInteger(attempt.number, `${path}.number`);
		if (!ATTEMPT_STATES.has(attempt.state as AttemptState)) {
			throw new Error(`${path}.state is invalid: ${String(attempt.state)}`);
		}
		const requirement = String(attempt.workspaceRequirement);
		if (!(WORKSPACE_REQUIREMENTS as readonly string[]).includes(requirement)) {
			throw new Error(`${path}.workspaceRequirement is invalid`);
		}
		// The workspace a step received is derived from its frozen profile, so a
		// stored attempt claiming a different one ran outside approved authority.
		const definition = definitions.get(attempt.stepId as string);
		const approved = definition
			? stepWorkspaceRequirement(profiles, definition)
			: undefined;
		if (requirement !== approved) {
			throw new Error(
				`${path}.workspaceRequirement is ${requirement}, but ${String(attempt.stepId)} is approved for ${String(approved)}`,
			);
		}
		if (typeof attempt.workspacePath !== "string") {
			throw new Error(`${path}.workspacePath must be a string`);
		}
		// A workspace path is empty exactly when the step received no workspace,
		// and only a mutable workspace carries a branch it could ever commit to.
		if ((attempt.workspacePath === "") !== (requirement === "none")) {
			throw new Error(
				`${path}.workspacePath must be empty exactly for a step without a workspace`,
			);
		}
		if ((attempt.branch !== undefined) !== (requirement === "mutable")) {
			throw new Error(
				`${path}.branch must be present exactly for a mutable workspace`,
			);
		}
		if (attempt.commit !== undefined && requirement !== "mutable") {
			throw new Error(`${path} recorded a commit without a mutable workspace`);
		}
		if (attempt.artifactIds !== undefined) {
			assertStringArray(attempt.artifactIds, `${path}.artifactIds`);
		}
		if (attempt.evidence !== undefined) {
			validateStoredEvidence(attempt.evidence, `${path}.evidence`);
			if (attempt.commit === undefined) {
				throw new Error(
					`${path}.evidence records checks for a commit this attempt never made`,
				);
			}
		}
		if (attempt.state === "succeeded") {
			assertString(attempt.finishedAt, `${path}.finishedAt`);
		}
		if (attempts.has(attempt.id as string)) {
			throw new Error(`Duplicate attempt id: ${String(attempt.id)}`);
		}
		attempts.set(attempt.id as string, attempt);
		const key = `${String(attempt.stepId)}\0${String(attempt.number)}`;
		if (numbersByStep.has(key)) {
			throw new Error(
				`Duplicate attempt number ${String(attempt.number)} for step ${String(attempt.stepId)}`,
			);
		}
		numbersByStep.add(key);
		if (isActiveAttemptState(attempt.state as AttemptState)) {
			const stepId = attempt.stepId as string;
			if (activeSteps.has(stepId)) {
				throw new Error(`Step ${stepId} has more than one active attempt`);
			}
			activeSteps.add(stepId);
		}
	}
	const referenced = new Set<string>();
	for (const [stepId, record] of Object.entries(
		run.steps as Record<string, Record<string, unknown>>,
	)) {
		for (const attemptId of record.attemptIds as string[]) {
			if (attempts.get(attemptId)?.stepId !== stepId) {
				throw new Error(
					`run.steps.${stepId} references invalid attempt ${attemptId}`,
				);
			}
			referenced.add(attemptId);
		}
	}
	if (referenced.size !== attempts.size) {
		throw new Error("Every attempt must be referenced by its step");
	}
	// Approval steps wait on a person rather than on a worker slot, so only the
	// steps occupying a workspace count against the concurrency limit.
	const occupiedSlots = [...activeSteps].filter((stepId) => {
		const definition = definitions.get(stepId);
		return definition !== undefined
			? stepConsumesWorkerSlot(profiles, definition)
			: false;
	}).length;
	if (occupiedSlots > (run.maxConcurrentWorkers as number)) {
		throw new Error("Run has more active attempts than its concurrency limit");
	}
}

function validateStoredIntegration(
	run: Record<string, unknown>,
	plan: WorkflowPlan,
	definitions: Map<string, StepDefinition>,
	profiles: RunCapabilityProfiles,
): void {
	const steps = run.steps as Record<string, Record<string, unknown>>;
	let expectedHead = run.baseCommit as string;
	let sawUnintegrated = false;
	for (const stepId of topologicalStepIds(plan)) {
		const definition = definitions.get(stepId);
		const record = steps[stepId];
		if (
			!definition ||
			!record ||
			!stepRequiresIntegration(profiles, definition)
		) {
			continue;
		}
		if (record.integratedCommit === undefined) {
			sawUnintegrated = true;
			continue;
		}
		if (sawUnintegrated) {
			throw new Error(
				`Integrated steps must form a deterministic topological prefix; ${stepId} is out of order`,
			);
		}
		expectedHead = record.integratedCommit as string;
	}
	if (run.integrationHead !== expectedHead) {
		throw new Error(
			`run.integrationHead must match the last integrated step commit (${expectedHead})`,
		);
	}
	// A run whose steps may commit must integrate somewhere other than the
	// branch the user is sitting on.
	if (
		plan.steps.some((step) => stepRequiresIntegration(profiles, step)) &&
		run.integrationBranch === run.baseBranch
	) {
		throw new Error(
			"run.integrationBranch must differ from run.baseBranch when a step may commit",
		);
	}
	if (run.state !== "completed") {
		return;
	}
	for (const [stepId, record] of Object.entries(steps)) {
		if (record.state !== "succeeded") {
			throw new Error(
				`Completed run cannot contain step ${stepId} in state ${String(record.state)}`,
			);
		}
		const definition = definitions.get(stepId);
		if (
			definition &&
			stepRequiresIntegration(profiles, definition) &&
			record.integratedCommit === undefined
		) {
			throw new Error(
				`Completed run cannot contain unintegrated step ${stepId}`,
			);
		}
	}
}

/**
 * Validates one stored engine run completely before the engine may act on it.
 *
 * A recovered run drives real repository operations, so every structural and
 * lifecycle invariant the engine relies on is rechecked here instead of being
 * assumed from the fact that some earlier process wrote the file.
 */
export function validateStoredWorkflowRun(value: unknown): StoredWorkflowRun {
	if (!isRecord(value)) {
		throw new Error("stored workflow run must be an object");
	}
	if (value.schemaVersion !== WORKFLOW_RUN_SCHEMA_VERSION) {
		throw new Error(
			`Unsupported workflow run schema version: ${String(value.schemaVersion)}`,
		);
	}
	assertCountingInteger(value.revision, "revision");
	const run = value.run;
	if (!isRecord(run)) {
		throw new Error("run must be an object");
	}
	assertString(run.id, "run.id");
	if (!SAFE_RUN_ID.test(run.id)) {
		throw new Error(`Unsafe run id: ${run.id}`);
	}
	if (!LIFECYCLE_STATES.includes(run.state as WorkflowRunLifecycleState)) {
		throw new Error(`Invalid run state: ${String(run.state)}`);
	}
	for (const field of [
		"repositoryRoot",
		"baseBranch",
		"baseCommit",
		"integrationBranch",
		"integrationHead",
		"createdAt",
		"updatedAt",
	] as const) {
		assertString(run[field], `run.${field}`);
	}
	assertOptionalText(run.error, "run.error");
	const plan = validateWorkflowPlan(run.plan);
	const profiles: unknown = run.capabilityProfiles;
	assertCapabilityProfiles(profiles, "run.capabilityProfiles");
	if (
		!Number.isSafeInteger(run.maxConcurrentWorkers) ||
		(run.maxConcurrentWorkers as number) < 1 ||
		(run.maxConcurrentWorkers as number) > MAX_CONCURRENT_WORKERS
	) {
		throw new Error(
			`run.maxConcurrentWorkers must be an integer from 1 to ${MAX_CONCURRENT_WORKERS}`,
		);
	}
	const definitions = validateStoredSteps(run, plan, profiles);
	validateStoredAttempts(run, definitions, profiles);
	validateStoredIntegration(run, plan, definitions, profiles);
	validateStoredEvents(run);
	return value as unknown as StoredWorkflowRun;
}

function parseJson(text: string, context: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`Invalid JSON in ${context}`, { cause: error });
	}
}

/**
 * Stores engine workflow runs as one validated JSON snapshot per run, beside
 * the legacy `RunStore` snapshots.
 *
 * Every mutation goes through `transaction`, which holds an exclusive
 * cross-process lock for the whole read-modify-write cycle and replaces the
 * snapshot atomically. A run therefore survives an arbitrary process death
 * with a state that is complete, consistent, and recoverable.
 */
export class FileWorkflowStateStore implements WorkflowStateStore {
	constructor(readonly directory: string) {}

	private fileNameFor(runId: string): string {
		if (!SAFE_RUN_ID.test(runId)) {
			throw new Error(`Unsafe run id: ${runId}`);
		}
		return `${runId}.json`;
	}

	private async withLock<T>(
		runId: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const fileName = this.fileNameFor(runId);
		await mkdir(this.directory, { recursive: true });
		let release: () => Promise<void>;
		try {
			release = await acquireStorageLock(
				join(this.directory, `.${runId}.state`),
				join(this.directory, `.${fileName}.lock`),
			);
		} catch (error) {
			throw new Error(
				`Failed to acquire state lock for workflow run ${runId}`,
				{
					cause: error,
				},
			);
		}
		try {
			return await operation();
		} finally {
			await release();
		}
	}

	private async writeAtomic(stored: StoredWorkflowRun): Promise<void> {
		const validated = validateStoredWorkflowRun(stored);
		await writeFileAtomic(
			this.directory,
			this.fileNameFor(validated.run.id),
			`${JSON.stringify(validated, null, 2)}\n`,
		);
	}

	private async readStored(runId: string): Promise<StoredWorkflowRun> {
		const path = join(this.directory, this.fileNameFor(runId));
		return validateStoredWorkflowRun(
			parseJson(await readFile(path, "utf8"), path),
		);
	}

	/** Persists a new run, failing when a snapshot for that id already exists. */
	async create(run: WorkflowRunState): Promise<WorkflowRunState> {
		return this.withLock(run.id, async () => {
			try {
				await readFile(join(this.directory, this.fileNameFor(run.id)), "utf8");
				throw new Error(`Workflow run already exists: ${run.id}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					throw error;
				}
			}
			await this.writeAtomic({
				schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
				revision: 0,
				run,
			});
			return structuredClone(run);
		});
	}

	/**
	 * Whether a snapshot exists for this run. An unreadable snapshot still
	 * exists: a corrupt engine run must never look like a run that never
	 * started on the engine.
	 */
	async has(runId: string): Promise<boolean> {
		try {
			await stat(join(this.directory, this.fileNameFor(runId)));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return false;
			}
			throw error;
		}
	}

	async load(runId: string): Promise<WorkflowRunState> {
		try {
			return (await this.readStored(runId)).run;
		} catch (error) {
			throw new Error(`Failed to load workflow run ${runId}`, { cause: error });
		}
	}

	async transaction(
		runId: string,
		mutate: (current: WorkflowRunState) => WorkflowRunState,
	): Promise<WorkflowRunState> {
		return this.withLock(runId, async () => {
			const stored = await this.readStored(runId);
			const baseline = JSON.stringify(stored.run);
			const next = mutate(structuredClone(stored.run));
			if (next.id !== runId) {
				throw new Error("A transaction must not change the run id");
			}
			if (JSON.stringify(next) === baseline) {
				return stored.run;
			}
			await this.writeAtomic({
				schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
				revision: stored.revision + 1,
				run: next,
			});
			return next;
		});
	}

	/** Lists every stored run, reporting unreadable snapshots instead of throwing. */
	async scan(): Promise<StoredWorkflowRunEntry[]> {
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
		return Promise.all(
			runIds.map(async (runId): Promise<StoredWorkflowRunEntry> => {
				try {
					return { kind: "run", run: await this.load(runId) };
				} catch (error) {
					return {
						kind: "unreadable",
						runId,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}),
		);
	}

	async list(): Promise<WorkflowRunState[]> {
		const entries = await this.scan();
		const unreadable = entries.find((entry) => entry.kind === "unreadable");
		if (unreadable) {
			throw new Error(
				`Failed to list workflow run ${unreadable.runId}: ${unreadable.error}`,
			);
		}
		return entries.flatMap((entry) =>
			entry.kind === "run" ? [entry.run] : [],
		);
	}
}
