import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { topologicalStepIds } from "../src/domain/steps.js";
import {
	admitSteps,
	admitWorkflowSteps,
	MAX_WORKFLOW_PLAN_STEPS,
	StepAdmissionError,
} from "../src/engine/admission.js";
import { WorkflowEngine } from "../src/engine/engine.js";
import { StepExecutor } from "../src/engine/executor.js";
import {
	type StepHandler,
	StepHandlerRegistry,
} from "../src/engine/handlers.js";
import { GitStepIntegrator } from "../src/engine/integration.js";
import { recoverWorkflowRun } from "../src/engine/recovery.js";
import {
	createWorkflowRunState,
	type WorkflowRunState,
} from "../src/engine/workflow-state.js";
import { defaultWorkspaceProviders } from "../src/engine/workspaces.js";
import { GitCli } from "../src/git/git.js";
import { GitWorktreeManager } from "../src/git/worktrees.js";
import {
	AuthorityViolationError,
	capabilityProfilesFromEnvelope,
	type FrozenAuthority,
	freezeRunAuthority,
} from "../src/security/authority.js";
import { readAuthorityEnvelopeDocument } from "../src/security/envelope.js";
import { readSecurityPolicy } from "../src/security/policy.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { FileWorkflowStateStore } from "../src/storage/workflow-state-store.js";
import {
	ADMISSION_CRASH_EXIT_CODE,
	changeStep,
	createWorkflowRepository,
	execute,
	removeWorkflowHarnessDirectories,
	workflowPlanOf,
} from "./helpers/workflow.js";

afterEach(removeWorkflowHarnessDirectories);

const FINAL_CHECK = { command: process.execPath, args: ["-e", ""] };

/** The envelope every run in this file is frozen under. */
function authorityFor(repositoryRoot: string): FrozenAuthority {
	return freezeRunAuthority({
		repositoryRoot,
		securityPolicy: readSecurityPolicy({}),
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
						forbiddenPaths: ["src/generated/"],
					},
				},
			],
			forbiddenActions: [],
			externalEffects: "forbidden",
			sandbox: { workers: "worktree-only", validation: "none" },
			validation: { required: [FINAL_CHECK], perChange: true },
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
		plan: workflowPlanOf([changeStep("first", [], ["src/first/"])]),
	}).authority;
}

/** A change handler that writes and commits one file for its step. */
const committingChangeHandler: StepHandler = {
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
		return { status: "succeeded", commit };
	},
};

interface AdmissionHarnessOptions {
	/** Whether the run freezes an authority envelope at all. */
	authority?: boolean;
	steps?: Record<string, unknown>[];
}

async function createAdmissionHarness(options: AdmissionHarnessOptions = {}) {
	const paths = await createWorkflowRepository();
	const git = new GitCli();
	const repository = await git.inspect(paths.repositoryRoot);
	const worktrees = new GitWorktreeManager(git, paths.worktreeRoot);
	const runId = "run-admission";
	const integrationBranch = await worktrees.prepareIntegrationBranch(
		repository,
		runId,
	);
	const authority = authorityFor(paths.repositoryRoot);
	const store = new FileWorkflowStateStore(join(paths.parent, "workflow-runs"));
	const artifacts = new ArtifactStore(paths.artifactRoot);
	const initial = createWorkflowRunState({
		id: runId,
		plan: workflowPlanOf(
			options.steps ?? [changeStep("first", [], ["src/first/"])],
		),
		repositoryRoot: paths.repositoryRoot,
		baseBranch: repository.currentBranch,
		baseCommit: repository.head,
		integrationBranch,
		integrationHead: repository.head,
		capabilityProfiles: capabilityProfilesFromEnvelope(
			authority.envelope,
			paths.repositoryRoot,
		),
		...(options.authority === false ? {} : { authority }),
		maxConcurrentWorkers: 2,
		createdAt: "2026-08-03T00:00:00.000Z",
	});
	await store.create(initial);
	const engineWith = (handlers: StepHandler[]) =>
		new WorkflowEngine({
			store,
			repository,
			artifacts,
			executor: new StepExecutor({
				workspaces: defaultWorkspaceProviders(worktrees),
				handlers: new StepHandlerRegistry(handlers),
			}),
			integrator: new GitStepIntegrator(git),
		});
	return {
		...paths,
		runId,
		repository,
		authority,
		store,
		artifacts,
		worktrees,
		initial,
		engineWith,
	};
}

/** Admits steps directly, as the port a running handler is given does. */
async function admit(
	store: FileWorkflowStateStore,
	runId: string,
	steps: Record<string, unknown>[],
	proposedBy = "first",
) {
	return admitWorkflowSteps(store, runId, {
		steps,
		proposedBy,
		reason: "the repository turned out to need it",
	});
}

/** Marks a step running, which is the state a proposing session is in. */
async function markRunning(
	store: FileWorkflowStateStore,
	runId: string,
	stepId: string,
): Promise<WorkflowRunState> {
	return store.transaction(runId, (current) => ({
		...current,
		steps: {
			...current.steps,
			// biome-ignore lint/style/noNonNullAssertion: the step is in the plan
			[stepId]: { ...current.steps[stepId]!, state: "running" },
		},
	}));
}

describe("admitting the steps a running session proposes", () => {
	it("runs, integrates, and completes work proposed during the run", async () => {
		const harness = await createAdmissionHarness();
		let proposed = false;
		const proposingHandler: StepHandler = {
			kind: "change",
			async execute(context) {
				if (!proposed) {
					proposed = true;
					const admitted = await context.admission?.admit({
						steps: [changeStep("follow-up", ["first"], ["src/follow-up/"])],
						reason: "the first step revealed the follow-up work",
					});
					expect(admitted?.map((step) => step.id)).toEqual(["follow-up"]);
				}
				return committingChangeHandler.execute(context);
			},
		};

		const settled = await harness
			.engineWith([proposingHandler])
			.run(harness.runId);

		expect(settled.state).toBe("completed");
		expect(Object.keys(settled.steps).sort()).toEqual(["first", "follow-up"]);
		expect(settled.steps["follow-up"]?.state).toBe("succeeded");
		// The admitted step integrated after the step that proposed it, so the
		// graph that grew still has one deterministic integration order.
		expect(topologicalStepIds(settled.plan)).toEqual(["first", "follow-up"]);
		expect(settled.steps["follow-up"]?.integratedCommit).toBe(
			settled.integrationHead,
		);
		expect(
			settled.events.filter((event) => event.kind === "step_admitted"),
		).toEqual([
			expect.objectContaining({
				kind: "step_admitted",
				stepId: "follow-up",
				proposedBy: "first",
				reason: "the first step revealed the follow-up work",
			}),
		]);
		// The grown graph is durable: a fresh reader validates and sees it.
		const reloaded = await new FileWorkflowStateStore(
			harness.store.directory,
		).load(harness.runId);
		expect(reloaded.plan.steps.map((step) => step.id)).toEqual([
			"first",
			"follow-up",
		]);
	});

	it("recovers and finishes a graph that grew before the process died", {
		timeout: 60_000,
	}, async () => {
		const paths = await createWorkflowRepository();
		const stateDirectory = join(paths.parent, "workflow-runs");
		// A real process runs a real engine, admits a step, and dies with the
		// grown plan durable and the proposing attempt still open.
		await expect(
			execute(
				"npm",
				[
					"run",
					"test:admission-crash-fixture",
					"--",
					paths.repositoryRoot,
					stateDirectory,
					paths.artifactRoot,
					paths.worktreeRoot,
				],
				{ cwd: process.cwd() },
			),
		).rejects.toMatchObject({ code: ADMISSION_CRASH_EXIT_CODE });

		const store = new FileWorkflowStateStore(stateDirectory);
		const [crashed] = await store.list();
		if (!crashed) {
			throw new Error("The crash fixture persisted no workflow run");
		}
		// The admitted step is in the durable plan, and no narrative handoff
		// was needed to know it exists.
		expect(crashed.plan.steps.map((step) => step.id)).toEqual(["api", "ui"]);
		expect(crashed.steps.ui?.state).toBe("planned");
		expect(crashed.events.some((event) => event.kind === "step_admitted")).toBe(
			true,
		);

		const git = new GitCli();
		const repository = await git.inspect(paths.repositoryRoot);
		const artifacts = new ArtifactStore(paths.artifactRoot);
		const { recovered } = await recoverWorkflowRun(
			{ store, git, artifacts },
			crashed.id,
		);
		expect(recovered.map((entry) => entry.stepId)).toEqual(["api"]);

		const settled = await new WorkflowEngine({
			store,
			repository,
			artifacts,
			executor: new StepExecutor({
				workspaces: defaultWorkspaceProviders(
					new GitWorktreeManager(git, paths.worktreeRoot),
				),
				handlers: new StepHandlerRegistry([committingChangeHandler]),
			}),
			integrator: new GitStepIntegrator(git),
		}).run(crashed.id);

		expect(settled.state).toBe("completed");
		expect(settled.steps.ui?.state).toBe("succeeded");
		expect(settled.steps.ui?.integratedCommit).toBe(settled.integrationHead);
	});

	it("refuses work the frozen envelope does not already allow", async () => {
		const harness = await createAdmissionHarness();
		await markRunning(harness.store, harness.runId, "first");

		await expect(
			admit(harness.store, harness.runId, [
				changeStep("leak", ["first"], ["docs/"]),
			]),
		).rejects.toThrow(
			/would mutate docs\/, which the approved envelope does not allow/,
		);
		await expect(
			admit(harness.store, harness.runId, [
				changeStep("withheld", ["first"], ["src/generated/"]),
			]),
		).rejects.toThrow(/which the approved envelope withholds/);
		await expect(
			admit(harness.store, harness.runId, [
				changeStep("wider", ["first"], ["src/wider/"], {
					capabilities: [
						"read-repository",
						"mutate-repository",
						"execute-commands",
					],
				}),
			]),
		).rejects.toBeInstanceOf(AuthorityViolationError);

		// Nothing entered the graph, and the run kept executing.
		const state = await harness.store.load(harness.runId);
		expect(Object.keys(state.steps)).toEqual(["first"]);
		expect(state.plan.steps).toHaveLength(1);
		expect(state.events).toHaveLength(0);
	});

	it("refuses growth a run cannot bound or a session cannot own", async () => {
		const unbounded = await createAdmissionHarness({ authority: false });
		await markRunning(unbounded.store, unbounded.runId, "first");
		await expect(
			admit(unbounded.store, unbounded.runId, [
				changeStep("follow-up", ["first"], ["src/follow-up/"]),
			]),
		).rejects.toThrow(/no frozen authority envelope/);

		const harness = await createAdmissionHarness();
		// A step that is not running has no session to propose anything.
		await expect(
			admit(harness.store, harness.runId, [
				changeStep("follow-up", ["first"], ["src/follow-up/"]),
			]),
		).rejects.toThrow(/only a running step can propose further work/);
		await markRunning(harness.store, harness.runId, "first");
		await expect(
			admit(
				harness.store,
				harness.runId,
				[changeStep("follow-up", ["first"], ["src/follow-up/"])],
				"absent",
			),
		).rejects.toThrow(/is not part of run/);
	});

	it("refuses proposals that would rewrite or overrun the graph", async () => {
		const harness = await createAdmissionHarness();
		const running = await markRunning(harness.store, harness.runId, "first");

		await expect(
			admit(harness.store, harness.runId, [
				changeStep("first", [], ["src/first/"]),
			]),
		).rejects.toThrow(/step id first already exists/);
		await expect(
			admit(harness.store, harness.runId, [
				changeStep("orphan", ["missing"], ["src/orphan/"]),
			]),
		).rejects.toThrow(/depends on unknown step missing/);
		await expect(
			admit(harness.store, harness.runId, [
				changeStep("left", ["right"], ["src/left/"]),
				changeStep("right", ["left"], ["src/right/"]),
			]),
		).rejects.toThrow(/dependency cycle/);
		await expect(admit(harness.store, harness.runId, [])).rejects.toThrow(
			/At least one step must be proposed/,
		);
		expect(() =>
			admitSteps(
				running,
				{
					steps: [changeStep("why", [], ["src/why/"])],
					proposedBy: "first",
					reason: "  ",
				},
				"2026-08-03T00:00:00.000Z",
			),
		).toThrow(/must record why they exist/);
		expect(() =>
			admitSteps(
				running,
				{
					steps: Array.from(
						{ length: MAX_WORKFLOW_PLAN_STEPS },
						(_value, index) =>
							changeStep(`step-${index}`, [], [`src/step-${index}/`]),
					),
					proposedBy: "first",
					reason: "too much work",
				},
				"2026-08-03T00:00:00.000Z",
			),
		).toThrow(new RegExp(`at most ${MAX_WORKFLOW_PLAN_STEPS} steps`));
	});

	it("refuses growth once the run stopped executing", async () => {
		const harness = await createAdmissionHarness();
		const settled = await harness
			.engineWith([committingChangeHandler])
			.run(harness.runId);
		expect(settled.state).toBe("completed");

		await expect(
			admit(harness.store, harness.runId, [
				changeStep("late", ["first"], ["src/late/"]),
			]),
		).rejects.toBeInstanceOf(StepAdmissionError);
	});

	it("keeps every integrated step ahead of the work admitted after it", async () => {
		const harness = await createAdmissionHarness({
			steps: [
				changeStep("first", [], ["src/first/"]),
				changeStep("second", ["first"], ["src/second/"]),
			],
		});
		let proposed = false;
		const proposingHandler: StepHandler = {
			kind: "change",
			async execute(context) {
				if (context.step.id === "first" && !proposed) {
					proposed = true;
					// A root step admitted after the run started must not sort ahead
					// of work that already integrated.
					await context.admission?.admit({
						steps: [changeStep("root", [], ["src/root/"])],
						reason: "independent work the session found",
					});
				}
				return committingChangeHandler.execute(context);
			},
		};

		const settled = await harness
			.engineWith([proposingHandler])
			.run(harness.runId);

		expect(settled.state).toBe("completed");
		expect(topologicalStepIds(settled.plan)).toEqual([
			"first",
			"second",
			"root",
		]);
		expect(settled.steps.root?.integratedCommit).toBe(settled.integrationHead);
	});
});
