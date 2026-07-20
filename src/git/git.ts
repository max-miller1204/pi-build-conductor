import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RepositoryInfo {
	root: string;
	commonDirectory: string;
	currentBranch: string;
	head: string;
	isClean: boolean;
}

export interface GitClient {
	inspect(cwd: string): Promise<RepositoryInfo>;
	branchExists(repositoryRoot: string, branch: string): Promise<boolean>;
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

export class GitCli implements GitClient {
	private async execute(cwd: string, args: string[]): Promise<string> {
		try {
			const result = await execFileAsync("git", args, {
				cwd,
				encoding: "utf8",
				maxBuffer: 10 * 1024 * 1024,
			});
			return result.stdout.trim();
		} catch (error) {
			const failure = error as NodeJS.ErrnoException & { stderr?: string };
			throw new GitCommandError(args, cwd, failure.stderr ?? failure.message);
		}
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

	status(repositoryRoot: string): Promise<string> {
		return this.execute(repositoryRoot, [
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
		]);
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
