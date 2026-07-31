import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { lock } from "proper-lockfile";

const LOCK_STALE_MS = 5_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 20;
const LOCK_UPDATE_MS = 2_000;

/**
 * Acquires one exclusive advisory lock for a stored entity.
 *
 * The lock target is never resolved or created, so a lock also protects an
 * entity whose file does not exist yet, and a stale lock left by a killed
 * process expires instead of blocking recovery forever.
 */
export async function acquireStorageLock(
	target: string,
	lockfilePath: string,
): Promise<() => Promise<void>> {
	return lock(target, {
		realpath: false,
		lockfilePath,
		stale: LOCK_STALE_MS,
		update: LOCK_UPDATE_MS,
		retries: {
			retries: Math.ceil(LOCK_ACQUIRE_TIMEOUT_MS / LOCK_RETRY_MS),
			factor: 1,
			minTimeout: LOCK_RETRY_MS,
			maxTimeout: LOCK_RETRY_MS,
			randomize: false,
		},
	});
}

/**
 * Replaces one file so a reader only ever observes the complete previous or
 * the complete next content, even across a power loss: the payload is written
 * and flushed to a private temporary file, moved into place by rename, and the
 * containing directory entry is flushed before the write is reported durable.
 */
export async function writeFileAtomic(
	directory: string,
	fileName: string,
	contents: string,
): Promise<void> {
	await mkdir(directory, { recursive: true });
	const destination = join(directory, fileName);
	const temporary = join(directory, `.${fileName}.${randomUUID()}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(contents, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, destination);
		const directoryHandle = await open(directory, "r");
		try {
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
	} finally {
		await rm(temporary, { force: true });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, path: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${path} must be a non-empty string`);
	}
}

/**
 * Validates one stored record of the focused checks behind a commit. Both run
 * stores persist the same evidence, so they validate it the same way.
 */
export function validateStoredEvidence(value: unknown, path: string): void {
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
		if (check.executionBoundary !== undefined) {
			if (!isRecord(check.executionBoundary)) {
				throw new Error(`${checkPath}.executionBoundary must be an object`);
			}
			const boundary = check.executionBoundary;
			if (
				!["none", "nono"].includes(String(boundary.sandbox)) ||
				!["host", "blocked"].includes(String(boundary.network)) ||
				boundary.environment !== "temporary-home-reduced" ||
				(boundary.sandbox === "nono") !== (boundary.network === "blocked")
			) {
				throw new Error(`${checkPath}.executionBoundary is invalid`);
			}
		}
	}
}
