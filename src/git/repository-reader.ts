import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_MAX_FILE_READ_BYTES = 8 * 1024 * 1024;
const MAX_LISTING_OUTPUT_BYTES = 64 * 1024 * 1024;
const LISTING_METADATA_PATTERN =
	/^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64}) +(\d+|-)$/;

/** One regular tracked file at a specific commit. */
export interface RepositoryFileEntry {
	path: string;
	mode: "100644" | "100755";
	sizeBytes: number;
	blobHash: string;
}

export interface RepositoryFileListing {
	files: RepositoryFileEntry[];
	/** Tree entries that are not regular files: symlinks and submodules. */
	skippedEntryCount: number;
}

/**
 * The read surface repository discovery needs. Implementations must read
 * committed state only, never the working tree, so discovery stays
 * deterministic for a given commit.
 */
export interface RepositoryFileReader {
	listFiles(commit: string): Promise<RepositoryFileListing>;
	readFile(commit: string, path: string): Promise<string | undefined>;
}

/** Reads tracked files from a Git repository at an exact commit. */
export class GitRepositoryReader implements RepositoryFileReader {
	constructor(
		private readonly repositoryRoot: string,
		private readonly maxFileReadBytes: number = DEFAULT_MAX_FILE_READ_BYTES,
	) {
		if (
			!Number.isSafeInteger(this.maxFileReadBytes) ||
			this.maxFileReadBytes < 1
		) {
			throw new Error("maxFileReadBytes must be a positive safe integer");
		}
	}

	private async execute(args: string[], maxBuffer: number): Promise<string> {
		try {
			const result = await execFileAsync("git", args, {
				cwd: this.repositoryRoot,
				encoding: "utf8",
				maxBuffer,
			});
			return result.stdout;
		} catch (error) {
			const failure = error as NodeJS.ErrnoException & { stderr?: string };
			throw new Error(
				`git ${args.join(" ")} failed in ${this.repositoryRoot}: ${(failure.stderr ?? failure.message).trim()}`,
			);
		}
	}

	async listFiles(commit: string): Promise<RepositoryFileListing> {
		const output = await this.execute(
			["ls-tree", "-z", "-r", "-l", "--full-tree", commit, "--"],
			MAX_LISTING_OUTPUT_BYTES,
		);
		const files: RepositoryFileEntry[] = [];
		let skippedEntryCount = 0;
		for (const record of output.split("\0")) {
			if (record.length === 0) {
				continue;
			}
			const separator = record.indexOf("\t");
			if (separator < 0) {
				throw new Error("Git returned a malformed tree listing record");
			}
			const metadata = record.slice(0, separator);
			const path = record.slice(separator + 1);
			const match = metadata.match(LISTING_METADATA_PATTERN);
			if (!match || path.length === 0) {
				throw new Error("Git returned a malformed tree listing record");
			}
			const [, mode, type, blobHash, size] = match as unknown as [
				string,
				string,
				string,
				string,
				string,
			];
			if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
				skippedEntryCount += 1;
				continue;
			}
			files.push({
				path,
				mode,
				sizeBytes: Number(size),
				blobHash,
			});
		}
		files.sort((left, right) =>
			left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
		);
		return { files, skippedEntryCount };
	}

	async readFile(commit: string, path: string): Promise<string | undefined> {
		try {
			return await this.execute(
				["cat-file", "blob", `${commit}:${path}`],
				this.maxFileReadBytes,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (
				message.includes("does not exist in") ||
				message.includes("Not a valid object name") ||
				message.includes("Invalid object name")
			) {
				return undefined;
			}
			throw error;
		}
	}
}
