import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ChangedFileEvidence } from "../domain/types.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface RepositoryInfo {
	root: string;
	commonDirectory: string;
	currentBranch: string;
	head: string;
	isClean: boolean;
}

export interface TaskWorktreeSnapshot {
	branch: string;
	baseCommit: string;
	changedFiles: ChangedFileEvidence[];
	diffHash: string;
}

export interface GitClient {
	inspect(cwd: string): Promise<RepositoryInfo>;
	branchExists(repositoryRoot: string, branch: string): Promise<boolean>;
	branchHead(repositoryRoot: string, branch: string): Promise<string>;
	createBranch(
		repositoryRoot: string,
		branch: string,
		startPoint: string,
	): Promise<void>;
	addWorktree(
		repositoryRoot: string,
		path: string,
		branch: string,
		startPoint: string,
	): Promise<void>;
	removeWorktree(repositoryRoot: string, path: string): Promise<void>;
	status(repositoryRoot: string): Promise<string>;
	inspectTaskWorktree(
		worktreePath: string,
		expectedBranch: string,
		expectedBaseCommit: string,
	): Promise<TaskWorktreeSnapshot>;
	checkTaskDiff(worktreePath: string, baseCommit: string): Promise<void>;
	commitTaskWork(
		worktreePath: string,
		expectedSnapshot: TaskWorktreeSnapshot,
		message: string,
	): Promise<string>;
	verifyTaskCommit(
		repositoryRoot: string,
		branch: string,
		commit: string,
		baseCommit: string,
	): Promise<void>;
	verifyIntegratedCommit(
		repositoryRoot: string,
		integratedCommit: string,
		expectedParent: string,
		sourceCommit: string,
	): Promise<void>;
	integrateCommit(
		repositoryRoot: string,
		branch: string,
		expectedHead: string,
		commit: string,
	): Promise<string>;
	commitAll(worktreePath: string, message: string): Promise<string>;
	cherryPick(worktreePath: string, commit: string): Promise<void>;
}

export class GitCommandError extends Error {
	constructor(
		readonly args: string[],
		readonly cwd: string,
		readonly stderr: string,
	) {
		super(`git ${args.join(" ")} failed in ${cwd}: ${stderr.trim()}`);
		this.name = "GitCommandError";
	}
}

function validateChangedPath(path: string): void {
	if (
		path.length === 0 ||
		path.includes("\0") ||
		isAbsolute(path) ||
		path === ".." ||
		path.startsWith("../") ||
		path.includes("/../") ||
		path === ".git" ||
		path.startsWith(".git/")
	) {
		throw new Error(
			`Git reported an unsafe changed path: ${JSON.stringify(path)}`,
		);
	}
}

function parsePorcelainV1Z(output: string): ChangedFileEvidence[] {
	const files: ChangedFileEvidence[] = [];
	let offset = 0;
	while (offset < output.length) {
		const end = output.indexOf("\0", offset);
		if (end < 0) {
			throw new Error("Git status returned a malformed NUL-delimited record");
		}
		const record = output.slice(offset, end);
		offset = end + 1;
		if (record.length < 4 || record[2] !== " ") {
			throw new Error(
				`Git status returned a malformed record: ${JSON.stringify(record)}`,
			);
		}
		const status = record.slice(0, 2);
		const path = record.slice(3);
		validateChangedPath(path);
		const conflict =
			status.includes("U") ||
			["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(status);
		if (conflict) {
			throw new Error(
				`Task worktree contains an unresolved conflict at ${path}`,
			);
		}
		const changed: ChangedFileEvidence = { path, status };
		if (status.includes("R") || status.includes("C")) {
			const previousEnd = output.indexOf("\0", offset);
			if (previousEnd < 0) {
				throw new Error("Git status returned a malformed rename record");
			}
			const previousPath = output.slice(offset, previousEnd);
			offset = previousEnd + 1;
			validateChangedPath(previousPath);
			changed.previousPath = previousPath;
		}
		files.push(changed);
	}
	return files.sort((left, right) =>
		`${left.path}\0${left.previousPath ?? ""}`.localeCompare(
			`${right.path}\0${right.previousPath ?? ""}`,
		),
	);
}

async function hashFile(
	hash: ReturnType<typeof createHash>,
	path: string,
): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolvePromise);
	});
}

function assertSnapshotMatches(
	actual: TaskWorktreeSnapshot,
	expected: TaskWorktreeSnapshot,
): void {
	if (
		actual.branch !== expected.branch ||
		actual.baseCommit !== expected.baseCommit ||
		actual.diffHash !== expected.diffHash ||
		JSON.stringify(actual.changedFiles) !==
			JSON.stringify(expected.changedFiles)
	) {
		throw new Error("Task worktree changed after validation");
	}
}

export class GitCli implements GitClient {
	private async executeRaw(
		cwd: string,
		args: string[],
		env?: NodeJS.ProcessEnv,
	): Promise<string> {
		try {
			const result = await execFileAsync("git", args, {
				cwd,
				...(env ? { env } : {}),
				encoding: "utf8",
				maxBuffer: MAX_GIT_OUTPUT_BYTES,
			});
			return result.stdout;
		} catch (error) {
			const failure = error as NodeJS.ErrnoException & { stderr?: string };
			throw new GitCommandError(args, cwd, failure.stderr ?? failure.message);
		}
	}

	private async execute(
		cwd: string,
		args: string[],
		env?: NodeJS.ProcessEnv,
	): Promise<string> {
		return (await this.executeRaw(cwd, args, env)).trim();
	}

	async inspect(cwd: string): Promise<RepositoryInfo> {
		const root = await this.execute(cwd, ["rev-parse", "--show-toplevel"]);
		const commonDirectoryOutput = await this.execute(root, [
			"rev-parse",
			"--git-common-dir",
		]);
		const [currentBranch, head, status] = await Promise.all([
			this.execute(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
			this.execute(root, ["rev-parse", "HEAD"]),
			this.status(root),
		]);
		return {
			root,
			commonDirectory: resolve(root, commonDirectoryOutput),
			currentBranch,
			head,
			isClean: status.length === 0,
		};
	}

	async branchExists(repositoryRoot: string, branch: string): Promise<boolean> {
		try {
			await this.execute(repositoryRoot, [
				"show-ref",
				"--verify",
				"--quiet",
				`refs/heads/${branch}`,
			]);
			return true;
		} catch (error) {
			if (error instanceof GitCommandError) {
				return false;
			}
			throw error;
		}
	}

	async branchHead(repositoryRoot: string, branch: string): Promise<string> {
		return this.execute(repositoryRoot, ["rev-parse", `refs/heads/${branch}`]);
	}

	async createBranch(
		repositoryRoot: string,
		branch: string,
		startPoint: string,
	): Promise<void> {
		await this.execute(repositoryRoot, ["branch", branch, startPoint]);
	}

	async addWorktree(
		repositoryRoot: string,
		path: string,
		branch: string,
		startPoint: string,
	): Promise<void> {
		await this.execute(repositoryRoot, [
			"worktree",
			"add",
			"-b",
			branch,
			path,
			startPoint,
		]);
	}

	async removeWorktree(repositoryRoot: string, path: string): Promise<void> {
		await this.execute(repositoryRoot, ["worktree", "remove", "--force", path]);
	}

	async status(repositoryRoot: string): Promise<string> {
		return (
			await this.executeRaw(repositoryRoot, [
				"status",
				"--porcelain=v1",
				"--untracked-files=all",
			])
		).trim();
	}

	async inspectTaskWorktree(
		worktreePath: string,
		expectedBranch: string,
		expectedBaseCommit: string,
	): Promise<TaskWorktreeSnapshot> {
		const [branch, head, statusOutput] = await Promise.all([
			this.execute(worktreePath, [
				"symbolic-ref",
				"--quiet",
				"--short",
				"HEAD",
			]),
			this.execute(worktreePath, ["rev-parse", "HEAD"]),
			this.executeRaw(worktreePath, [
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
			]),
		]);
		if (branch !== expectedBranch) {
			throw new Error(
				`Task worktree branch changed: expected ${expectedBranch}, found ${branch}`,
			);
		}
		if (head !== expectedBaseCommit) {
			throw new Error(
				`Task worktree HEAD changed: expected ${expectedBaseCommit}, found ${head}`,
			);
		}
		const changedFiles = parsePorcelainV1Z(statusOutput);
		if (changedFiles.length === 0) {
			throw new Error("Task worker produced no changes");
		}
		const pathSet = new Set(
			changedFiles.flatMap((file) => [
				file.path,
				...(file.previousPath ? [file.previousPath] : []),
			]),
		);
		const paths = [...pathSet].sort((left, right) => left.localeCompare(right));
		const stagedEntries = await this.executeRaw(worktreePath, [
			"--literal-pathspecs",
			"ls-files",
			"--stage",
			"-z",
			"--",
			...paths,
		]);
		for (const entry of stagedEntries.split("\0")) {
			if (entry.startsWith("160000 ")) {
				throw new Error(
					"Task worktree changes include an unsupported Git submodule",
				);
			}
		}
		const diff = await this.executeRaw(worktreePath, [
			"--literal-pathspecs",
			"diff",
			"--binary",
			"--no-ext-diff",
			"HEAD",
			"--",
			...paths,
		]);
		for (const path of paths) {
			try {
				const stat = await lstat(resolve(worktreePath, path));
				if (stat.isSymbolicLink()) {
					throw new Error(
						`Task worktree changes include an unsupported symbolic link: ${path}`,
					);
				}
				if (!stat.isFile()) {
					throw new Error(`Unsupported changed file type: ${path}`);
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					throw error;
				}
			}
		}
		const hash = createHash("sha256");
		hash.update(JSON.stringify(changedFiles));
		hash.update("\0");
		hash.update(diff);
		for (const file of changedFiles.filter((item) => item.status === "??")) {
			const absolutePath = resolve(worktreePath, file.path);
			const relativePath = relative(resolve(worktreePath), absolutePath);
			if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
				throw new Error(`Changed path escapes task worktree: ${file.path}`);
			}
			const stat = await lstat(absolutePath);
			hash.update(`\0${file.path}\0${stat.mode}\0`);
			if (stat.isFile()) {
				await hashFile(hash, absolutePath);
			} else {
				throw new Error(`Unsupported untracked file type: ${file.path}`);
			}
		}
		return {
			branch,
			baseCommit: expectedBaseCommit,
			changedFiles,
			diffHash: hash.digest("hex"),
		};
	}

	async checkTaskDiff(worktreePath: string, baseCommit: string): Promise<void> {
		await this.execute(worktreePath, ["diff", "--check", baseCommit, "--"]);
	}

	async commitTaskWork(
		worktreePath: string,
		expectedSnapshot: TaskWorktreeSnapshot,
		message: string,
	): Promise<string> {
		if (!message.trim() || /[\r\n]/.test(message)) {
			throw new Error("Task commit message must be a non-empty single line");
		}
		const actual = await this.inspectTaskWorktree(
			worktreePath,
			expectedSnapshot.branch,
			expectedSnapshot.baseCommit,
		);
		assertSnapshotMatches(actual, expectedSnapshot);
		const paths = [
			...new Set(
				expectedSnapshot.changedFiles.flatMap((file) => [
					file.path,
					...(file.previousPath ? [file.previousPath] : []),
				]),
			),
		].sort((left, right) => left.localeCompare(right));
		const temporaryIndexDirectory = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-index-"),
		);
		const indexEnvironment = {
			...process.env,
			GIT_INDEX_FILE: join(temporaryIndexDirectory, "index"),
		};
		let commit: string;
		try {
			await this.execute(
				worktreePath,
				["read-tree", expectedSnapshot.baseCommit],
				indexEnvironment,
			);
			for (const path of paths) {
				const absolutePath = resolve(worktreePath, path);
				let stat: Stats;
				try {
					stat = await lstat(absolutePath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						throw error;
					}
					await this.execute(
						worktreePath,
						[
							"--literal-pathspecs",
							"update-index",
							"--force-remove",
							"--",
							path,
						],
						indexEnvironment,
					);
					continue;
				}
				if (!stat.isFile()) {
					throw new Error(`Unsupported changed file type: ${path}`);
				}
				const blob = await this.execute(worktreePath, [
					"hash-object",
					"-w",
					"--no-filters",
					"--",
					path,
				]);
				const filteredBlob = await this.execute(worktreePath, [
					"hash-object",
					`--path=${path}`,
					"--",
					path,
				]);
				if (filteredBlob !== blob) {
					throw new Error(
						`Git clean filter would alter validated bytes for ${path}`,
					);
				}
				const mode = stat.mode & 0o111 ? "100755" : "100644";
				await this.execute(
					worktreePath,
					["update-index", "--add", "--cacheinfo", mode, blob, path],
					indexEnvironment,
				);
			}
			const tree = await this.execute(
				worktreePath,
				["write-tree"],
				indexEnvironment,
			);
			commit = await this.execute(worktreePath, [
				"commit-tree",
				tree,
				"-p",
				expectedSnapshot.baseCommit,
				"-m",
				message,
			]);
			await this.execute(worktreePath, [
				"update-ref",
				`refs/heads/${expectedSnapshot.branch}`,
				commit,
				expectedSnapshot.baseCommit,
			]);
			await this.execute(worktreePath, ["read-tree", commit]);
		} finally {
			await rm(temporaryIndexDirectory, { recursive: true, force: true });
		}
		await this.verifyTaskCommit(
			worktreePath,
			expectedSnapshot.branch,
			commit,
			expectedSnapshot.baseCommit,
		);
		const committedPaths = (
			await this.executeRaw(worktreePath, [
				"diff-tree",
				"--no-commit-id",
				"--name-only",
				"-r",
				"-z",
				"--no-renames",
				commit,
			])
		)
			.split("\0")
			.filter(Boolean)
			.sort((left, right) => left.localeCompare(right));
		if (JSON.stringify(committedPaths) !== JSON.stringify(paths)) {
			throw new Error(
				"Created task commit does not match the validated path set",
			);
		}
		if ((await this.status(worktreePath)).length > 0) {
			throw new Error("Task worktree is not clean after commit");
		}
		return commit;
	}

	async verifyTaskCommit(
		repositoryRoot: string,
		branch: string,
		commit: string,
		baseCommit: string,
	): Promise<void> {
		const [branchHead, parent] = await Promise.all([
			this.execute(repositoryRoot, ["rev-parse", `refs/heads/${branch}`]),
			this.execute(repositoryRoot, ["rev-parse", `${commit}^`]),
		]);
		if (branchHead !== commit) {
			throw new Error(
				`Task branch ${branch} does not point to recorded commit ${commit}`,
			);
		}
		if (parent !== baseCommit) {
			throw new Error(
				`Task commit ${commit} does not have expected parent ${baseCommit}`,
			);
		}
	}

	async verifyIntegratedCommit(
		repositoryRoot: string,
		integratedCommit: string,
		expectedParent: string,
		sourceCommit: string,
	): Promise<void> {
		const [parentLine, integratedTree, sourceTree] = await Promise.all([
			this.execute(repositoryRoot, [
				"rev-list",
				"--parents",
				"-n",
				"1",
				integratedCommit,
			]),
			this.execute(repositoryRoot, ["rev-parse", `${integratedCommit}^{tree}`]),
			this.execute(repositoryRoot, ["rev-parse", `${sourceCommit}^{tree}`]),
		]);
		const commitAndParents = parentLine.split(" ");
		if (
			commitAndParents.length !== 2 ||
			commitAndParents[1] !== expectedParent ||
			integratedTree !== sourceTree
		) {
			throw new Error(
				`Integrated commit ${integratedCommit} does not match source repair ${sourceCommit}`,
			);
		}
	}

	async integrateCommit(
		repositoryRoot: string,
		branch: string,
		expectedHead: string,
		commit: string,
	): Promise<string> {
		const repository = await this.inspect(repositoryRoot);
		if (repository.currentBranch === branch) {
			throw new Error(
				`Refusing to integrate into checked-out user branch ${branch}`,
			);
		}
		const actualHead = await this.branchHead(repositoryRoot, branch);
		if (actualHead !== expectedHead) {
			throw new Error(
				`Integration branch ${branch} moved from expected head ${expectedHead} to ${actualHead}`,
			);
		}
		const temporaryRoot = await mkdtemp(
			join(tmpdir(), "pi-build-conductor-integration-"),
		);
		const worktreePath = join(temporaryRoot, "worktree");
		let worktreeAdded = false;
		let temporaryRootRemoved = false;
		let integratedCommit: string | undefined;
		let operationError: unknown;
		try {
			await this.execute(repositoryRoot, [
				"worktree",
				"add",
				"--detach",
				worktreePath,
				expectedHead,
			]);
			worktreeAdded = true;
			try {
				await this.cherryPick(worktreePath, commit);
			} catch (error) {
				try {
					await this.execute(worktreePath, ["cherry-pick", "--abort"]);
				} catch {
					// Forced worktree removal below clears any remaining conflict state.
				}
				throw error;
			}
			integratedCommit = await this.execute(worktreePath, [
				"rev-parse",
				"HEAD",
			]);
			await this.removeWorktree(repositoryRoot, worktreePath);
			worktreeAdded = false;
			await rm(temporaryRoot, { recursive: true, force: true });
			temporaryRootRemoved = true;
			await this.execute(repositoryRoot, [
				"update-ref",
				`refs/heads/${branch}`,
				integratedCommit,
				expectedHead,
			]);
		} catch (error) {
			operationError = error;
		}

		let cleanupError: unknown;
		if (worktreeAdded) {
			try {
				await this.removeWorktree(repositoryRoot, worktreePath);
			} catch (error) {
				cleanupError = error;
			}
		}
		if (!temporaryRootRemoved) {
			try {
				await rm(temporaryRoot, { recursive: true, force: true });
			} catch (error) {
				cleanupError ??= error;
			}
		}
		if (operationError) {
			throw operationError;
		}
		if (cleanupError) {
			throw cleanupError;
		}
		if (!integratedCommit) {
			throw new Error(`Git did not create an integration commit for ${commit}`);
		}
		return integratedCommit;
	}

	async commitAll(worktreePath: string, message: string): Promise<string> {
		await this.execute(worktreePath, ["add", "--all"]);
		await this.execute(worktreePath, ["commit", "-m", message]);
		return this.execute(worktreePath, ["rev-parse", "HEAD"]);
	}

	async cherryPick(worktreePath: string, commit: string): Promise<void> {
		await this.execute(worktreePath, ["cherry-pick", commit]);
	}
}
