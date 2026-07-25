import { randomUUID } from "node:crypto";
import {
	link,
	mkdir,
	open,
	readdir,
	readFile,
	rm,
	stat,
} from "node:fs/promises";
import { join } from "node:path";
import {
	ARTIFACT_KIND_MEDIA_TYPES,
	ARTIFACT_RECORD_VERSION,
	type ArtifactIdentity,
	type ArtifactKind,
	type ArtifactPayload,
	type ArtifactRecord,
	type ArtifactSummary,
	artifactContentHash,
	artifactIdFor,
	artifactSummary,
	MAX_ARTIFACT_TITLE_LENGTH,
	parseArtifactId,
	serializeArtifactPayload,
	validateArtifactRecord,
} from "../domain/artifacts.js";

const SAFE_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const DEFAULT_MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RUN_ARTIFACTS = 500;
const DEFAULT_MAX_RUN_BYTES = 64 * 1024 * 1024;

export type ArtifactStoreErrorCode =
	| "invalid_artifact"
	| "artifact_exists"
	| "artifact_too_large"
	| "artifact_count_exceeded"
	| "artifact_bytes_exceeded"
	| "artifact_not_found"
	| "artifact_corrupt";

export class ArtifactStoreError extends Error {
	readonly code: ArtifactStoreErrorCode;

	constructor(code: ArtifactStoreErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ArtifactStoreError";
		this.code = code;
	}
}

export interface ArtifactWriteRequest extends ArtifactIdentity {
	runId: string;
	kind: ArtifactKind;
	title: string;
	payload: ArtifactPayload;
}

export interface ArtifactStoreOptions {
	/** Maximum payload bytes for one artifact. */
	maxArtifactBytes?: number;
	/** Maximum number of retained artifacts per run. */
	maxRunArtifacts?: number;
	/** Maximum total stored bytes per run, including metadata. */
	maxRunBytes?: number;
	/**
	 * When set, only the newest N attempts of each step output are retained;
	 * older attempts are deleted after a successful write. All attempts are
	 * retained by default so evidence survives retries.
	 */
	retainedAttemptsPerOutput?: number;
	now?: () => string;
}

export type StoredArtifactEntry =
	| { kind: "artifact"; artifact: ArtifactSummary }
	| { kind: "unreadable"; fileName: string; error: string };

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive safe integer`);
	}
	return value;
}

function invalid(message: string, cause?: unknown): ArtifactStoreError {
	return new ArtifactStoreError("invalid_artifact", message, cause);
}

export class ArtifactStore {
	readonly directory: string;
	private readonly maxArtifactBytes: number;
	private readonly maxRunArtifacts: number;
	private readonly maxRunBytes: number;
	private readonly retainedAttemptsPerOutput: number | undefined;
	private readonly now: () => string;

	constructor(directory: string, options: ArtifactStoreOptions = {}) {
		this.directory = directory;
		this.maxArtifactBytes = positiveInteger(
			options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
			"maxArtifactBytes",
		);
		this.maxRunArtifacts = positiveInteger(
			options.maxRunArtifacts ?? DEFAULT_MAX_RUN_ARTIFACTS,
			"maxRunArtifacts",
		);
		this.maxRunBytes = positiveInteger(
			options.maxRunBytes ?? DEFAULT_MAX_RUN_BYTES,
			"maxRunBytes",
		);
		this.retainedAttemptsPerOutput =
			options.retainedAttemptsPerOutput === undefined
				? undefined
				: positiveInteger(
						options.retainedAttemptsPerOutput,
						"retainedAttemptsPerOutput",
					);
		this.now = options.now ?? (() => new Date().toISOString());
	}

	private runDirectory(runId: string): string {
		if (!SAFE_RUN_ID.test(runId)) {
			throw invalid(`Unsafe run id: ${runId}`);
		}
		return join(this.directory, runId);
	}

	private pathFor(runId: string, artifactId: string): string {
		return join(this.runDirectory(runId), `${artifactId}.json`);
	}

	private async listFileNames(runId: string): Promise<string[]> {
		try {
			const entries = await readdir(this.runDirectory(runId));
			return entries
				.filter((entry) => entry.endsWith(".json"))
				.sort((left, right) => left.localeCompare(right));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return [];
			}
			throw error;
		}
	}

	private async readRecordFile(
		runId: string,
		fileName: string,
	): Promise<ArtifactRecord> {
		const path = join(this.runDirectory(runId), fileName);
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new ArtifactStoreError(
					"artifact_not_found",
					`Artifact not found: ${path}`,
					error,
				);
			}
			throw error;
		}
		let record: ArtifactRecord;
		try {
			record = validateArtifactRecord(JSON.parse(raw) as unknown);
		} catch (error) {
			throw new ArtifactStoreError(
				"artifact_corrupt",
				`Corrupt artifact record in ${path}: ${error instanceof Error ? error.message : String(error)}`,
				error,
			);
		}
		if (record.runId !== runId || `${record.id}.json` !== fileName) {
			throw new ArtifactStoreError(
				"artifact_corrupt",
				`Corrupt artifact record in ${path}: stored identity does not match its location`,
			);
		}
		return record;
	}

	private buildRecord(request: ArtifactWriteRequest): ArtifactRecord {
		if (!SAFE_RUN_ID.test(request.runId)) {
			throw invalid(`Unsafe run id: ${request.runId}`);
		}
		if (
			typeof request.title !== "string" ||
			request.title.length === 0 ||
			request.title.length > MAX_ARTIFACT_TITLE_LENGTH
		) {
			throw invalid(
				`artifact title must be 1 to ${MAX_ARTIFACT_TITLE_LENGTH} characters`,
			);
		}
		let id: string;
		let payload: string;
		try {
			id = artifactIdFor(request);
			payload = serializeArtifactPayload(request.kind, request.payload);
		} catch (error) {
			throw invalid(
				error instanceof Error ? error.message : String(error),
				error,
			);
		}
		const sizeBytes = Buffer.byteLength(payload, "utf8");
		if (sizeBytes > this.maxArtifactBytes) {
			throw new ArtifactStoreError(
				"artifact_too_large",
				`Artifact ${id} payload is ${sizeBytes} bytes; the limit is ${this.maxArtifactBytes} bytes`,
			);
		}
		return {
			version: ARTIFACT_RECORD_VERSION,
			id,
			runId: request.runId,
			stepId: request.stepId,
			output: request.output,
			attempt: request.attempt,
			kind: request.kind,
			mediaType: ARTIFACT_KIND_MEDIA_TYPES[request.kind],
			title: request.title,
			createdAt: this.now(),
			sizeBytes,
			contentHash: artifactContentHash(payload),
			payload,
		};
	}

	private async enforceRunLimits(
		record: ArtifactRecord,
		serialized: string,
	): Promise<void> {
		const fileNames = await this.listFileNames(record.runId);
		if (fileNames.length + 1 > this.maxRunArtifacts) {
			throw new ArtifactStoreError(
				"artifact_count_exceeded",
				`Run ${record.runId} already stores ${fileNames.length} artifacts; the limit is ${this.maxRunArtifacts}`,
			);
		}
		let storedBytes = 0;
		for (const fileName of fileNames) {
			try {
				const fileStats = await stat(
					join(this.runDirectory(record.runId), fileName),
				);
				storedBytes += fileStats.size;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					throw error;
				}
			}
		}
		const newBytes = Buffer.byteLength(serialized, "utf8");
		if (storedBytes + newBytes > this.maxRunBytes) {
			throw new ArtifactStoreError(
				"artifact_bytes_exceeded",
				`Run ${record.runId} stores ${storedBytes} artifact bytes; adding ${newBytes} bytes exceeds the ${this.maxRunBytes} byte limit`,
			);
		}
	}

	private async publishExclusive(
		record: ArtifactRecord,
		serialized: string,
	): Promise<"published" | "exists"> {
		const runDirectory = this.runDirectory(record.runId);
		await mkdir(runDirectory, { recursive: true, mode: 0o700 });
		const destination = this.pathFor(record.runId, record.id);
		const temporary = join(runDirectory, `.${record.id}.${randomUUID()}.tmp`);
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(serialized, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await link(temporary, destination);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				return "exists";
			}
			throw error;
		} finally {
			await rm(temporary, { force: true });
		}
		const directoryHandle = await open(runDirectory, "r");
		try {
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
		return "published";
	}

	private async applyRetention(record: ArtifactRecord): Promise<void> {
		if (this.retainedAttemptsPerOutput === undefined) {
			return;
		}
		const attempts: { attempt: number; fileName: string }[] = [];
		for (const fileName of await this.listFileNames(record.runId)) {
			try {
				const identity = parseArtifactId(fileName.slice(0, -".json".length));
				if (
					identity.stepId === record.stepId &&
					identity.output === record.output
				) {
					attempts.push({ attempt: identity.attempt, fileName });
				}
			} catch {
				// Unreadable names are surfaced by scan(), never silently deleted.
			}
		}
		attempts.sort((left, right) => right.attempt - left.attempt);
		for (const stale of attempts.slice(this.retainedAttemptsPerOutput)) {
			await rm(join(this.runDirectory(record.runId), stale.fileName), {
				force: true,
			});
		}
	}

	/**
	 * Persists one immutable artifact. Rewriting an identity with identical
	 * content returns the stored record; rewriting it with different content
	 * fails with `artifact_exists`.
	 */
	async write(request: ArtifactWriteRequest): Promise<ArtifactRecord> {
		const record = this.buildRecord(request);
		const serialized = `${JSON.stringify(record, null, 2)}\n`;
		const existing = await this.readExisting(record.runId, record.id);
		if (existing) {
			return this.reconcileExisting(existing, record);
		}
		await this.enforceRunLimits(record, serialized);
		if ((await this.publishExclusive(record, serialized)) === "exists") {
			const published = await this.readRecordFile(
				record.runId,
				`${record.id}.json`,
			);
			return this.reconcileExisting(published, record);
		}
		await this.applyRetention(record);
		return record;
	}

	private async readExisting(
		runId: string,
		artifactId: string,
	): Promise<ArtifactRecord | undefined> {
		try {
			return await this.readRecordFile(runId, `${artifactId}.json`);
		} catch (error) {
			if (
				error instanceof ArtifactStoreError &&
				error.code === "artifact_not_found"
			) {
				return undefined;
			}
			throw error;
		}
	}

	private reconcileExisting(
		existing: ArtifactRecord,
		proposed: ArtifactRecord,
	): ArtifactRecord {
		if (
			existing.contentHash === proposed.contentHash &&
			existing.payload === proposed.payload &&
			existing.kind === proposed.kind &&
			existing.title === proposed.title
		) {
			return existing;
		}
		throw new ArtifactStoreError(
			"artifact_exists",
			`Artifact ${proposed.id} already exists in run ${proposed.runId} with different content`,
		);
	}

	async read(runId: string, artifactId: string): Promise<ArtifactRecord> {
		try {
			parseArtifactId(artifactId);
		} catch (error) {
			throw invalid(
				error instanceof Error ? error.message : String(error),
				error,
			);
		}
		return this.readRecordFile(runId, `${artifactId}.json`);
	}

	/** Reads the newest stored attempt of one step output, if any. */
	async latest(
		runId: string,
		stepId: string,
		output: string,
	): Promise<ArtifactRecord | undefined> {
		let newest: ArtifactIdentity | undefined;
		for (const fileName of await this.listFileNames(runId)) {
			try {
				const identity = parseArtifactId(fileName.slice(0, -".json".length));
				if (identity.stepId !== stepId || identity.output !== output) {
					continue;
				}
				if (!newest || identity.attempt > newest.attempt) {
					newest = identity;
				}
			} catch {
				// Unreadable names are surfaced by scan().
			}
		}
		if (!newest) {
			return undefined;
		}
		return this.read(runId, artifactIdFor(newest));
	}

	/** Lists every stored artifact of a run, tolerating unreadable files. */
	async scan(runId: string): Promise<StoredArtifactEntry[]> {
		const entries: StoredArtifactEntry[] = [];
		for (const fileName of await this.listFileNames(runId)) {
			try {
				entries.push({
					kind: "artifact",
					artifact: artifactSummary(await this.readRecordFile(runId, fileName)),
				});
			} catch (error) {
				entries.push({
					kind: "unreadable",
					fileName,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return entries;
	}

	/** Lists every stored artifact of a run, failing on unreadable files. */
	async list(runId: string): Promise<ArtifactSummary[]> {
		const entries = await this.scan(runId);
		const unreadable = entries.find((entry) => entry.kind === "unreadable");
		if (unreadable) {
			throw new ArtifactStoreError(
				"artifact_corrupt",
				`Failed to list artifact ${unreadable.fileName}: ${unreadable.error}`,
			);
		}
		return entries.flatMap((entry) =>
			entry.kind === "artifact" ? [entry.artifact] : [],
		);
	}

	/** Removes every artifact of one run; used when the run is pruned. */
	async pruneRun(runId: string): Promise<void> {
		await rm(this.runDirectory(runId), { recursive: true, force: true });
	}
}
