import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArtifactRecord } from "../../src/domain/artifacts.js";
import { WorkflowEngine } from "../../src/engine/engine.js";
import { StepExecutor } from "../../src/engine/executor.js";
import {
	type StepHandler,
	StepHandlerRegistry,
} from "../../src/engine/handlers.js";
import { GitStepIntegrator } from "../../src/engine/integration.js";
import { createWorkflowRunState } from "../../src/engine/workflow-state.js";
import { defaultWorkspaceProviders } from "../../src/engine/workspaces.js";
import { GitCli } from "../../src/git/git.js";
import { GitWorktreeManager } from "../../src/git/worktrees.js";
import { defaultCapabilityProfiles } from "../../src/security/capabilities.js";
import {
	ArtifactStore,
	type ArtifactWriteRequest,
} from "../../src/storage/artifact-store.js";
import { FileWorkflowStateStore } from "../../src/storage/workflow-state-store.js";
import { changeStep, workflowPlanOf } from "../helpers/workflow.js";

/**
 * Runs a real engine workflow against a real repository and a real durable
 * state store, then kills the process at one exact boundary. The surviving
 * on-disk state is what a restarted orchestrator has to recover from.
 */
const CRASH_BOUNDARIES = ["after-commit", "after-artifacts"] as const;
type CrashBoundary = (typeof CRASH_BOUNDARIES)[number];

export const CRASH_EXIT_CODES: Record<CrashBoundary, number> = {
	"after-commit": 91,
	"after-artifacts": 92,
};

const [repositoryRoot, stateDirectory, artifactDirectory, worktreeRoot, raw] =
	process.argv.slice(2);
const boundary = raw as CrashBoundary;
if (
	!repositoryRoot ||
	!stateDirectory ||
	!artifactDirectory ||
	!worktreeRoot ||
	!CRASH_BOUNDARIES.includes(boundary)
) {
	throw new Error(
		"Expected repository root, state directory, artifact directory, worktree root, and crash boundary arguments",
	);
}

/** Dies once an artifact is durable but before the engine records the step. */
class CrashAfterArtifactStore extends ArtifactStore {
	override async write(request: ArtifactWriteRequest): Promise<ArtifactRecord> {
		const record = await super.write(request);
		if (boundary === "after-artifacts") {
			process.exit(CRASH_EXIT_CODES["after-artifacts"]);
		}
		return record;
	}
}

const git = new GitCli();

const crashingChangeHandler: StepHandler = {
	kind: "change",
	async execute(context) {
		const target = join(
			context.workspace.path,
			"src",
			context.step.id,
			"index.ts",
		);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, `export const ${context.step.id} = true;\n`);
		const commit = await git.commitAll(
			context.workspace.path,
			`step(${context.step.id}): ${context.step.title}`,
		);
		// The process dies with the commit already durable on the step branch
		// but nothing at all recorded about the artifacts it owed.
		if (boundary === "after-commit" && context.step.id === "api") {
			process.exit(CRASH_EXIT_CODES["after-commit"]);
		}
		const outputs = context.step.outputs ?? [];
		return {
			status: "succeeded",
			commit,
			artifacts: outputs.map((output) => ({
				output,
				kind: "report" as const,
				title: `${context.step.id} ${output}`,
				payload: {
					format: "text" as const,
					text: `${context.step.id} produced ${commit}`,
				},
			})),
		};
	},
};

const runId = "run-workflow-crash";
const repository = await git.inspect(repositoryRoot);
const worktrees = new GitWorktreeManager(git, worktreeRoot);
const store = new FileWorkflowStateStore(stateDirectory);
await store.create(
	createWorkflowRunState({
		id: runId,
		plan: workflowPlanOf([
			changeStep("api", [], ["src/api/"], {
				outputs: ["report"],
				retry: { maxAttempts: 2 },
			}),
			changeStep("ui", ["api"], ["src/ui/"], {
				inputs: [{ stepId: "api", output: "report" }],
			}),
		]),
		repositoryRoot,
		baseBranch: repository.currentBranch,
		baseCommit: repository.head,
		integrationBranch: await worktrees.prepareIntegrationBranch(
			repository,
			runId,
		),
		integrationHead: repository.head,
		capabilityProfiles: defaultCapabilityProfiles(),
		maxConcurrentWorkers: 2,
	}),
);

const engine = new WorkflowEngine({
	store,
	repository,
	artifacts: new CrashAfterArtifactStore(artifactDirectory),
	executor: new StepExecutor({
		workspaces: defaultWorkspaceProviders(worktrees),
		handlers: new StepHandlerRegistry([crashingChangeHandler]),
	}),
	integrator: new GitStepIntegrator(git),
});
await engine.run(runId);
throw new Error(`The workflow completed instead of crashing at ${boundary}`);
