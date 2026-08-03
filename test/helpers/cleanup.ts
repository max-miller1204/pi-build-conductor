import { rm } from "node:fs/promises";

/**
 * Removes one temporary directory a finished test may still have a writer in.
 *
 * A store flush, a lock release, or a worktree cleanup can land between the
 * recursive walk and the final rmdir, which surfaces as ENOTEMPTY rather than
 * as anything the test asserted. Removal therefore retries, so machine timing
 * is never reported as a test failure.
 */
export async function removeTemporaryDirectory(
	directory: string,
): Promise<void> {
	await rm(directory, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 20,
	});
}

/** Removes and empties a list of temporary directories a test collected. */
export async function removeTemporaryDirectories(
	directories: string[],
): Promise<void> {
	await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
}
