import { join } from "node:path";
import type { ArtifactRecord } from "../../src/domain/artifacts.js";
import { createOrchestrationRun } from "../../src/domain/run.js";
import { GitCli } from "../../src/git/git.js";
import { GitWorktreeManager } from "../../src/git/worktrees.js";
import { readSecurityPolicy } from "../../src/security/policy.js";
import {
	ArtifactStore,
	type ArtifactWriteRequest,
} from "../../src/storage/artifact-store.js";
import { RunStore } from "../../src/storage/run-store.js";
import { FileWorkflowStateStore } from "../../src/storage/workflow-state-store.js";
import { LocalFinalValidator } from "../../src/validation/final-validator.js";
import { LocalTaskValidator } from "../../src/validation/task-validator.js";
import { EngineChangeRunner } from "../../src/workflows/change-run.js";
import {
	CHANGE_RUN_CRASH_EXIT_CODE,
	CHANGE_RUN_CRASH_RUN_ID,
	ChangeRunWorkers,
} from "../helpers/change-run-workers.js";

/**
 * Runs a real live change run against a real repository and real durable
 * storage, then kills the process the moment the implementation step's commit
 * and evidence are both durable but before the engine records the step. What
 * survives on disk is exactly what a restarted orchestrator has to resume.
 */
const [
	repositoryRoot,
	runDirectory,
	stateDirectory,
	artifactDirectory,
	worktreeRoot,
] = process.argv.slice(2);
if (
	!repositoryRoot ||
	!runDirectory ||
	!stateDirectory ||
	!artifactDirectory ||
	!worktreeRoot
) {
	throw new Error(
		"Expected repository root, run directory, state directory, artifact directory, and worktree root arguments",
	);
}

/** Dies once a step's declared evidence is durable but unrecorded. */
class CrashAfterEvidenceStore extends ArtifactStore {
	override async write(request: ArtifactWriteRequest): Promise<ArtifactRecord> {
		const record = await super.write(request);
		if (request.stepId === "implementation") {
			process.exit(CHANGE_RUN_CRASH_EXIT_CODE);
		}
		return record;
	}
}

const git = new GitCli();
const repository = await git.inspect(repositoryRoot);
const store = new RunStore(runDirectory);
const run = await store.create(
	createOrchestrationRun({
		id: CHANGE_RUN_CRASH_RUN_ID,
		repositoryRoot,
		baseBranch: repository.currentBranch,
		baseCommit: repository.head,
		integrationBranch: `conductor/${CHANGE_RUN_CRASH_RUN_ID}/integration`,
		request: {
			sourcePath: join(repositoryRoot, "request.md"),
			text: "Ship it",
		},
		securityPolicy: readSecurityPolicy({}),
		plan: {
			version: 3,
			title: "Reviewed feature",
			tasks: [
				{
					id: "implementation",
					title: "Implementation",
					description: "Implement the feature",
					dependencies: [],
					acceptanceCriteria: ["Implementation exists"],
					allowedPaths: ["src/"],
					validationCommands: [
						{
							command: process.execPath,
							args: ["-e", "require('node:fs').accessSync('src/result.txt')"],
						},
					],
				},
			],
			finalValidationCommands: [
				{ command: process.execPath, args: ["-e", ""] },
			],
		},
		maxConcurrentWorkers: 2,
		now: new Date().toISOString(),
	}),
);

const runner = new EngineChangeRunner({
	store,
	workflowStates: new FileWorkflowStateStore(stateDirectory),
	artifacts: new CrashAfterEvidenceStore(artifactDirectory),
	// Every review is clean, so the run never needs a repair.
	workers: new ChangeRunWorkers(),
	git,
	worktrees: new GitWorktreeManager(git, worktreeRoot),
	validator: new LocalTaskValidator(git),
	finalValidator: new LocalFinalValidator(git),
	securityPolicy: readSecurityPolicy({}),
});
const launch = await runner.approveAndLaunch(run, repository);
await launch.completion;
throw new Error("The change run completed instead of crashing");
