import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowEngine } from "../src/engine/engine.js";
import { StepExecutor } from "../src/engine/executor.js";
import {
	type StepHandler,
	StepHandlerRegistry,
} from "../src/engine/handlers.js";
import { GitStepIntegrator } from "../src/engine/integration.js";
import { recoverWorkflowRun } from "../src/engine/recovery.js";
import { createWorkflowRunState } from "../src/engine/workflow-state.js";
import { defaultWorkspaceProviders } from "../src/engine/workspaces.js";
import { GitCli } from "../src/git/git.js";
import { GitWorktreeManager } from "../src/git/worktrees.js";
import { defaultCapabilityProfiles } from "../src/security/capabilities.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import {
	FileWorkflowStateStore,
	validateStoredWorkflowRun,
	WORKFLOW_RUN_SCHEMA_VERSION,
	WORKFLOW_RUNS_DIRECTORY_NAME,
} from "../src/storage/workflow-state-store.js";
import {
	changeStep,
	createWorkflowRepository,
	execute,
	investigationStep,
	removeWorkflowHarnessDirectories,
	workflowPlanOf,
} from "./helpers/workflow.js";

/**
 * Rebuilds the same engine the crashed process was running, so a resumed run
 * differs from the interrupted one only in which process is executing it.
 */
function resumingEngine(
	store: FileWorkflowStateStore,
	artifacts: ArtifactStore,
	repository: Awaited<ReturnType<GitCli["inspect"]>>,
	worktreeRoot: string,
	handler: StepHandler,
): WorkflowEngine {
	const git = new GitCli();
	return new WorkflowEngine({
		store,
		repository,
		artifacts,
		executor: new StepExecutor({
			workspaces: defaultWorkspaceProviders(
				new GitWorktreeManager(git, worktreeRoot),
			),
			handlers: new StepHandlerRegistry([handler]),
		}),
		integrator: new GitStepIntegrator(git),
	});
}

const completingChangeHandler: StepHandler = {
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
		const commit = await new GitCli().commitAll(
			context.workspace.path,
			`step(${context.step.id}): ${context.step.title}`,
		);
		return {
			status: "succeeded",
			commit,
			artifacts: (context.step.outputs ?? []).map((output) => ({
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

/** Runs the crash fixture in a real child process and returns its remains. */
async function crashDuringWorkflow(
	boundary: "after-commit" | "after-artifacts",
	exitCode: number,
) {
	const paths = await createWorkflowRepository();
	const stateDirectory = join(paths.parent, WORKFLOW_RUNS_DIRECTORY_NAME);
	await expect(
		execute(
			"npm",
			[
				"run",
				"test:workflow-crash-fixture",
				"--",
				paths.repositoryRoot,
				stateDirectory,
				paths.artifactRoot,
				paths.worktreeRoot,
				boundary,
			],
			{ cwd: process.cwd() },
		),
	).rejects.toMatchObject({ code: exitCode });
	const store = new FileWorkflowStateStore(stateDirectory);
	const [crashed] = await store.list();
	if (!crashed) {
		throw new Error("The crash fixture persisted no workflow run");
	}
	return {
		...paths,
		artifacts: new ArtifactStore(paths.artifactRoot),
		crashed,
		git: new GitCli(),
		store,
	};
}

afterEach(removeWorkflowHarnessDirectories);

describe("durable workflow state", () => {
	it("round-trips a run through the versioned on-disk schema", async () => {
		const paths = await createWorkflowRepository();
		const git = new GitCli();
		const repository = await git.inspect(paths.repositoryRoot);
		const worktrees = new GitWorktreeManager(git, paths.worktreeRoot);
		const store = new FileWorkflowStateStore(join(paths.parent, "state"));
		const initial = createWorkflowRunState({
			id: "run-durable-1",
			plan: workflowPlanOf([changeStep("api", [], ["src/api/"])]),
			repositoryRoot: paths.repositoryRoot,
			baseBranch: repository.currentBranch,
			baseCommit: repository.head,
			integrationBranch: await worktrees.prepareIntegrationBranch(
				repository,
				"run-durable-1",
			),
			integrationHead: repository.head,
			capabilityProfiles: defaultCapabilityProfiles(),
			maxConcurrentWorkers: 2,
		});

		await store.create(initial);

		expect(await store.load("run-durable-1")).toEqual(initial);
		await expect(store.create(initial)).rejects.toThrow(/already exists/);
		const raw = JSON.parse(
			await execute("cat", [join(store.directory, "run-durable-1.json")]).then(
				(result) => result.stdout,
			),
		) as { schemaVersion: number; revision: number };
		expect(raw.schemaVersion).toBe(WORKFLOW_RUN_SCHEMA_VERSION);
		expect(raw.revision).toBe(0);

		// A transaction that changes nothing must not churn the stored revision.
		await store.transaction("run-durable-1", (current) => current);
		await store.transaction("run-durable-1", (current) => ({
			...current,
			updatedAt: "2026-07-30T00:00:00.000Z",
		}));
		const stored = JSON.parse(
			await execute("cat", [join(store.directory, "run-durable-1.json")]).then(
				(result) => result.stdout,
			),
		) as { revision: number };
		expect(stored.revision).toBe(1);
		expect((await store.load("run-durable-1")).updatedAt).toBe(
			"2026-07-30T00:00:00.000Z",
		);
	});

	it("rejects stored state the engine could act on unsafely", async () => {
		const paths = await createWorkflowRepository();
		const git = new GitCli();
		const repository = await git.inspect(paths.repositoryRoot);
		const run = createWorkflowRunState({
			id: "run-durable-2",
			plan: workflowPlanOf([
				changeStep("api", [], ["src/api/"]),
				investigationStep("survey", ["api"]),
			]),
			repositoryRoot: paths.repositoryRoot,
			baseBranch: repository.currentBranch,
			baseCommit: repository.head,
			integrationBranch: "conductor/run-durable-2/integration",
			integrationHead: repository.head,
			capabilityProfiles: defaultCapabilityProfiles(),
			maxConcurrentWorkers: 2,
		});
		const stored = {
			schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
			revision: 0,
			run,
		};
		const api = run.steps.api;
		if (!api) {
			throw new Error("missing api step");
		}
		const attempt = {
			id: "api-1",
			stepId: "api",
			number: 1,
			state: "running",
			workspaceRequirement: "mutable",
			workspacePath: join(paths.worktreeRoot, "api"),
			branch: "conductor/run-durable-2/task/api/attempt-1",
			baseCommit: repository.head,
			startedAt: "2026-07-30T00:00:00.000Z",
		};
		const withAttempt = {
			...stored,
			run: {
				...run,
				steps: {
					...run.steps,
					api: { ...api, state: "running", attemptIds: ["api-1"] },
				},
				attempts: [attempt],
			},
		};

		expect(validateStoredWorkflowRun(stored)).toEqual(stored);
		expect(validateStoredWorkflowRun(withAttempt)).toEqual(withAttempt);
		expect(
			validateStoredWorkflowRun({
				...withAttempt,
				run: {
					...withAttempt.run,
					attempts: [{ ...attempt, error: "" }],
				},
			}),
		).toEqual({
			...withAttempt,
			run: {
				...withAttempt.run,
				attempts: [{ ...attempt, error: "" }],
			},
		});
		// A step may only ever have run in the workspace its frozen profile
		// approves, so a downgraded requirement is rejected rather than trusted.
		expect(() =>
			validateStoredWorkflowRun({
				...withAttempt,
				run: {
					...withAttempt.run,
					attempts: [
						{
							...attempt,
							workspaceRequirement: "read-only",
							branch: undefined,
						},
					],
				},
			}),
		).toThrow(/workspaceRequirement is read-only, but api is approved for/);
		expect(() =>
			validateStoredWorkflowRun({ ...stored, schemaVersion: 2 }),
		).toThrow(/Unsupported workflow run schema version/);
		expect(() =>
			validateStoredWorkflowRun({
				...stored,
				run: { ...run, integrationBranch: run.baseBranch },
			}),
		).toThrow(/must differ from run.baseBranch/);
		expect(() =>
			validateStoredWorkflowRun({
				...stored,
				run: { ...run, integrationHead: "0".repeat(40) },
			}),
		).toThrow(/must match the last integrated step commit/);
		expect(() =>
			validateStoredWorkflowRun({
				...stored,
				run: {
					...run,
					steps: {
						...run.steps,
						api: {
							...api,
							state: "succeeded",
							integratedCommit: "0".repeat(40),
						},
					},
				},
			}),
		).toThrow(/must match the last integrated step commit/);
		expect(() =>
			validateStoredWorkflowRun({
				...stored,
				run: {
					...run,
					steps: {
						...run.steps,
						api: {
							...api,
							definition: { ...api.definition, title: "Rewritten" },
						},
					},
				},
			}),
		).toThrow(/does not match the plan/);
		expect(() =>
			validateStoredWorkflowRun({
				...stored,
				run: { ...run, state: "completed" },
			}),
		).toThrow(/Completed run cannot contain step/);
		expect(() =>
			validateStoredWorkflowRun({
				...stored,
				run: {
					...run,
					steps: { ...run.steps, api: { ...api, attemptIds: ["ghost"] } },
				},
			}),
		).toThrow(/references invalid attempt ghost/);
		expect(() =>
			validateStoredWorkflowRun({
				...stored,
				run: { ...run, events: [{ kind: "run_settled", state: "completed" }] },
			}),
		).toThrow(/run.events\[0\].sequence must be a positive safe integer/);
		expect(() =>
			validateStoredWorkflowRun({
				...stored,
				run: {
					...run,
					eventSequence: 1,
					events: [
						{
							kind: "run_settled",
							sequence: 1,
							at: "2026-07-30T00:00:00.000Z",
							state: "completed",
							secret: "smuggled",
						},
					],
				},
			}),
		).toThrow(/unexpected run_settled fields: secret/);
	});
});

describe("workflow restart recovery", () => {
	it("resumes a run whose process died between the commit and its artifacts", async () => {
		const { artifacts, crashed, git, repositoryRoot, store, worktreeRoot } =
			await crashDuringWorkflow("after-commit", 91);
		expect(crashed.state).toBe("running");
		expect(crashed.steps.api?.state).toBe("running");
		const interrupted = crashed.attempts[0];
		if (!interrupted?.branch) {
			throw new Error("The crash fixture persisted no api attempt");
		}
		expect(interrupted.state).toBe("running");
		// The durable Git commit exists; the declared artifact never reached disk.
		expect(await git.branchHead(repositoryRoot, interrupted.branch)).not.toBe(
			interrupted.baseCommit,
		);
		expect(await artifacts.list(crashed.id)).toEqual([]);

		const recovery = await recoverWorkflowRun(
			{ store, git, artifacts },
			crashed.id,
		);

		expect(recovery.recovered).toEqual([
			{
				attemptId: interrupted.id,
				stepId: "api",
				outcome: "retry_scheduled",
				reason: expect.stringContaining(
					"did not durably store the declared output of api: report",
				),
			},
		]);
		expect(recovery.state.steps.api?.state).toBe("ready");
		expect(recovery.state.attempts[0]?.state).toBe("interrupted");
		// The abandoned commit is never adopted, so nothing can integrate it.
		expect(recovery.state.attempts[0]?.commit).toBeUndefined();

		const repository = await git.inspect(repositoryRoot);
		const resumed = await resumingEngine(
			store,
			artifacts,
			repository,
			worktreeRoot,
			completingChangeHandler,
		).run(crashed.id);

		expect(resumed.state).toBe("completed");
		expect(
			resumed.attempts.map((attempt) => `${attempt.stepId}#${attempt.number}`),
		).toEqual(["api#1", "api#2", "ui#1"]);
		expect(
			(await artifacts.list(crashed.id)).map((artifact) => artifact.id),
		).toEqual(["api.report.2"]);
		const history = await execute(
			"git",
			["log", "--format=%s", resumed.integrationBranch],
			{ cwd: repositoryRoot },
		);
		expect(history.stdout.trim().split("\n")).toEqual([
			"step(ui): ui",
			"step(api): api",
			"Initial",
		]);
		// The reloaded snapshot is the only thing that made the resume possible.
		expect(await store.load(crashed.id)).toEqual(resumed);
	}, 60_000);

	it("adopts an interrupted attempt whose commit and artifacts are both durable", async () => {
		const { artifacts, crashed, git, repositoryRoot, store, worktreeRoot } =
			await crashDuringWorkflow("after-artifacts", 92);
		const interrupted = crashed.attempts[0];
		if (!interrupted) {
			throw new Error("The crash fixture persisted no api attempt");
		}
		expect(interrupted.state).toBe("running");
		expect(
			(await artifacts.list(crashed.id)).map((artifact) => artifact.id),
		).toEqual(["api.report.1"]);

		const recovery = await recoverWorkflowRun(
			{ store, git, artifacts },
			crashed.id,
		);

		expect(recovery.recovered).toEqual([
			{
				attemptId: interrupted.id,
				stepId: "api",
				outcome: "adopted_commit",
				commit: expect.any(String),
				reason:
					"the worker's commit and every declared artifact already existed",
			},
		]);
		expect(recovery.state.attempts[0]).toMatchObject({
			state: "succeeded",
			artifactIds: ["api.report.1"],
		});

		const repository = await git.inspect(repositoryRoot);
		const resumed = await resumingEngine(
			store,
			artifacts,
			repository,
			worktreeRoot,
			completingChangeHandler,
		).run(crashed.id);

		expect(resumed.state).toBe("completed");
		// The adopted attempt is never repeated, so `ui` consumed exactly the
		// artifact the dead process had published.
		expect(resumed.attempts).toHaveLength(2);
		expect(
			(await artifacts.list(crashed.id)).map((artifact) => artifact.id),
		).toEqual(["api.report.1"]);
		const history = await execute(
			"git",
			["log", "--format=%s", resumed.integrationBranch],
			{ cwd: repositoryRoot },
		);
		expect(history.stdout.trim().split("\n")).toEqual([
			"step(ui): ui",
			"step(api): api",
			"Initial",
		]);
	}, 60_000);
});
