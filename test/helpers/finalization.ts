import type { TaskValidationEvidence } from "../../src/domain/types.js";
import type { GitClient, TaskWorktreeSnapshot } from "../../src/git/git.js";
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
} {
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
	const git = {
		async commitTaskWork(
			_worktreePath: string,
			snapshot: TaskWorktreeSnapshot,
		): Promise<string> {
			return `commit-${snapshot.diffHash}`;
		},
		async branchHead(): Promise<string> {
			return "recovered-commit";
		},
		async verifyTaskCommit(): Promise<void> {},
	} as unknown as GitClient;
	return { git, validator };
}
