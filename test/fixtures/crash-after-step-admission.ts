import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import {
	capabilityProfilesFromEnvelope,
	freezeRunAuthority,
} from "../../src/security/authority.js";
import { readAuthorityEnvelopeDocument } from "../../src/security/envelope.js";
import { readSecurityPolicy } from "../../src/security/policy.js";
import { ArtifactStore } from "../../src/storage/artifact-store.js";
import { FileWorkflowStateStore } from "../../src/storage/workflow-state-store.js";
import {
	ADMISSION_CRASH_EXIT_CODE,
	changeStep,
	workflowPlanOf,
} from "../helpers/workflow.js";

/**
 * Runs a real engine workflow that grows its own graph, then kills the process
 * once the admitted step is durable but before the step that proposed it
 * finished. What survives on disk is a run whose plan no user ever approved
 * whole, which is exactly what a restarted orchestrator has to recover.
 */
const [repositoryRoot, stateDirectory, artifactDirectory, worktreeRoot] =
	process.argv.slice(2);
if (!repositoryRoot || !stateDirectory || !artifactDirectory || !worktreeRoot) {
	throw new Error(
		"Expected repository root, state directory, artifact directory, and worktree root arguments",
	);
}

const git = new GitCli();
const runId = "run-admission-crash";

const proposingChangeHandler: StepHandler = {
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
		if (context.step.id === "api") {
			await context.admission?.admit({
				steps: [changeStep("ui", ["api"], ["src/ui/"])],
				reason: "the api step found the interface work it implies",
			});
			// The admitted step is durable, the commit exists on the step branch,
			// and nothing has recorded that this attempt finished.
			process.exit(ADMISSION_CRASH_EXIT_CODE);
		}
		return { status: "succeeded", commit };
	},
};

const repository = await git.inspect(repositoryRoot);
const worktrees = new GitWorktreeManager(git, worktreeRoot);
const store = new FileWorkflowStateStore(stateDirectory);
const securityPolicy = readSecurityPolicy({});
const { authority } = freezeRunAuthority({
	repositoryRoot,
	securityPolicy,
	plan: workflowPlanOf([changeStep("api", [], ["src/api/"])]),
	envelope: readAuthorityEnvelopeDocument({
		version: 1,
		outcome: "Deliver the widget",
		acceptanceCriteria: ["The widget exists"],
		repositories: [
			{
				root: repositoryRoot,
				mutation: {
					capabilities: ["read-repository", "mutate-repository"],
					allowedPaths: ["src/"],
					forbiddenPaths: [],
				},
			},
		],
		forbiddenActions: [],
		externalEffects: "forbidden",
		sandbox: { workers: "worktree-only", validation: "none" },
		validation: {
			required: [{ command: process.execPath, args: ["-e", ""] }],
			perChange: true,
		},
		escalation: {
			conditions: [
				"add-repository",
				"widen-mutation-authority",
				"change-acceptance-criteria",
				"skip-required-validation",
				"external-effect",
			],
			reservedDecisions: [],
		},
	}),
});
await store.create(
	createWorkflowRunState({
		id: runId,
		plan: workflowPlanOf([changeStep("api", [], ["src/api/"])]),
		repositoryRoot,
		baseBranch: repository.currentBranch,
		baseCommit: repository.head,
		integrationBranch: await worktrees.prepareIntegrationBranch(
			repository,
			runId,
		),
		integrationHead: repository.head,
		capabilityProfiles: capabilityProfilesFromEnvelope(
			authority.envelope,
			repositoryRoot,
		),
		authority,
		maxConcurrentWorkers: 2,
	}),
);

const engine = new WorkflowEngine({
	store,
	repository,
	artifacts: new ArtifactStore(artifactDirectory),
	executor: new StepExecutor({
		workspaces: defaultWorkspaceProviders(worktrees),
		handlers: new StepHandlerRegistry([proposingChangeHandler]),
	}),
	integrator: new GitStepIntegrator(git),
});
await engine.run(runId);
throw new Error("The workflow completed instead of crashing after admission");
