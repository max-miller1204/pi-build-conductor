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
