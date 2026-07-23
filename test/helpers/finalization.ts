import type {
	FinalValidationEvidence,
	TaskValidationEvidence,
} from "../../src/domain/types.js";
import type { GitClient, TaskWorktreeSnapshot } from "../../src/git/git.js";
import type { FinalValidator } from "../../src/validation/final-validator.js";
import type {
	TaskValidationInput,
	TaskValidator,
} from "../../src/validation/task-validator.js";

const now = "2026-01-01T00:00:00.000Z";

function changedPath(input: TaskValidationInput): string {
	const allowed = input.task.allowedPaths[0];
	if (!allowed) {
		throw new Error("test task has no allowed path");
	}
	return allowed.endsWith("/") ? `${allowed}result.txt` : allowed;
}

export function createFakeFinalizationDependencies(): {
	git: GitClient;
	validator: TaskValidator;
	finalValidator: FinalValidator;
	verifyReviewWorktree: () => Promise<void>;
} {
	const integrationHeads = new Map<string, string>();
	const validator: TaskValidator = {
		async validate(input) {
			const path = changedPath(input);
			const snapshot: TaskWorktreeSnapshot = {
				branch: input.attempt.branch,
				baseCommit: input.attempt.baseCommit,
				changedFiles: [{ path, status: " M" }],
				diffHash: `diff-${input.attempt.id}`,
			};
			const evidence: TaskValidationEvidence = {
				startedAt: now,
				finishedAt: now,
				passed: true,
				changedFiles: snapshot.changedFiles,
				diffHash: snapshot.diffHash,
				checks: [
					{
						command: "test",
						args: [],
						startedAt: now,
						finishedAt: now,
						exitCode: 0,
						stdoutTail: "",
						stderrTail: "",
						passed: true,
					},
				],
			};
			return { snapshot, evidence };
		},
	};
	const finalValidator: FinalValidator = {
		async validate(input) {
			const evidence: FinalValidationEvidence = {
				startedAt: now,
				finishedAt: now,
				passed: true,
				checks: input.commands.map((command) => ({
					command: command.command,
					args: [...command.args],
					startedAt: now,
					finishedAt: now,
					exitCode: 0,
					stdoutTail: "",
					stderrTail: "",
					passed: true,
				})),
			};
			return evidence;
		},
	};
	const git = {
		async commitTaskWork(
			_worktreePath: string,
			snapshot: TaskWorktreeSnapshot,
		): Promise<string> {
			return `commit-${snapshot.diffHash}`;
		},
		async branchHead(_repositoryRoot: string, branch: string): Promise<string> {
			return branch.endsWith("/integration")
				? (integrationHeads.get(branch) ?? "abc123")
				: "recovered-commit";
		},
		async verifyTaskCommit(): Promise<void> {},
		async verifyMergeReadyHistory(input: {
			integrationBranch: string;
			integrationHead: string;
			baseBranch: string;
			baseCommit: string;
			commits: Array<{ integratedCommit: string }>;
			verifiedAt: string;
		}) {
			return {
				verifiedAt: input.verifiedAt,
				integrationBranch: input.integrationBranch,
				integrationHead: input.integrationHead,
				baseBranch: input.baseBranch,
				baseCommit: input.baseCommit,
				commits: input.commits.map((commit, index) => ({
					hash: commit.integratedCommit,
					parent:
						index === 0
							? input.baseCommit
							: (input.commits[index - 1]?.integratedCommit ??
								input.baseCommit),
					subject: "test integration",
				})),
				userWorktreeClean: true as const,
				userBranch: input.baseBranch,
				userHead: input.baseCommit,
			};
		},
		async integrateCommit(
			_repositoryRoot: string,
			branch: string,
			expectedHead: string,
			commit: string,
		): Promise<string> {
			const actualHead = integrationHeads.get(branch) ?? "abc123";
			if (actualHead !== expectedHead) {
				throw new Error(`Unexpected integration head ${actualHead}`);
			}
			const integratedCommit = `integrated-${commit}`;
			integrationHeads.set(branch, integratedCommit);
			return integratedCommit;
		},
	} as unknown as GitClient;
	return {
		git,
		validator,
		finalValidator,
		verifyReviewWorktree: async () => {},
	};
}
