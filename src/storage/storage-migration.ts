import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";

export const LEGACY_STORAGE_DIRECTORY_NAME = "pi-build-conductor";
export const STORAGE_DIRECTORY_NAME = "pi-orchestrator";

async function readDirectoryOrNull(path: string): Promise<string[] | null> {
	try {
		return await readdir(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

async function containsRunSnapshots(runsDirectory: string): Promise<boolean> {
	const entries = (await readDirectoryOrNull(runsDirectory)) ?? [];
	return entries.some((entry) => entry.endsWith(".json"));
}

/**
 * Moves `<git-common-dir>/pi-build-conductor` to `<git-common-dir>/pi-orchestrator`.
 *
 * The rename is atomic, keeps run snapshots and attempt logs together, and is
 * safe to repeat. When both directories exist the migration fails closed if
 * the legacy location still holds run snapshots, because silently reading from
 * two storage roots could hide runs from inspection and recovery.
 */
export async function migrateLegacyOrchestratorStorage(
	commonDirectory: string,
): Promise<void> {
	const legacyDirectory = join(commonDirectory, LEGACY_STORAGE_DIRECTORY_NAME);
	const directory = join(commonDirectory, STORAGE_DIRECTORY_NAME);
	if ((await readDirectoryOrNull(legacyDirectory)) === null) {
		return;
	}
	if ((await readDirectoryOrNull(directory)) === null) {
		try {
			await rename(legacyDirectory, directory);
			return;
		} catch (error) {
			// A concurrent session can win the same rename; tolerate the race
			// only when the legacy directory is gone or the target appeared.
			const legacyRemains =
				(await readDirectoryOrNull(legacyDirectory)) !== null;
			const targetExists = (await readDirectoryOrNull(directory)) !== null;
			if (legacyRemains && !targetExists) {
				throw new Error(
					`Failed to migrate orchestrator storage from ${legacyDirectory} to ${directory}`,
					{ cause: error },
				);
			}
		}
	}
	if (
		(await containsRunSnapshots(join(legacyDirectory, "runs"))) &&
		(await readDirectoryOrNull(directory)) !== null
	) {
		throw new Error(
			`Both ${legacyDirectory} and ${directory} contain orchestrator run state; move the snapshots from ${join(legacyDirectory, "runs")} into ${join(directory, "runs")} and delete the legacy directory before continuing`,
		);
	}
}
