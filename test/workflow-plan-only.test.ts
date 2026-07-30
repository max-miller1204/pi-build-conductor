import { afterEach, describe, expect, it } from "vitest";
import { parseArtifactPayload } from "../src/domain/artifacts.js";
import { GitCli } from "../src/git/git.js";
import {
	BEGIN_PLAN_DOCUMENT_MARKER,
	END_PLAN_DOCUMENT_MARKER,
	PlanningWorker,
} from "../src/planning/planning-worker.js";
import { readSecurityPolicy } from "../src/security/policy.js";
import type {
	SpawnWorkerRequest,
	WorkerBackend,
	WorkerExecution,
	WorkerExecutionResult,
	WorkerInstance,
} from "../src/workers/backend.js";
import {
	buildPlanOnlyWorkflowPlan,
	PLAN_ONLY_PLAN_OUTPUT,
	PLAN_ONLY_STEP_ID,
	planOnlyStepHandlers,
	workflowTitleFromRequest,
} from "../src/workflows/plan-only.js";
import {
	createWorkflowHarness,
	execute,
	removeWorkflowHarnessDirectories,
} from "./helpers/workflow.js";

afterEach(removeWorkflowHarnessDirectories);

const securityPolicy = readSecurityPolicy({});

function plannedDocument(allowedPaths: string[]): unknown {
	return {
		version: 1,
		plan: {
			version: 3,
			title: "Extend the widget",
			tasks: [
				{
					id: "extend-widget",
					title: "Extend the widget",
					description: "Extend src/index.ts with the widget.",
					dependencies: [],
					acceptanceCriteria: ["widget exists"],
					allowedPaths,
					validationCommands: [{ command: process.execPath, args: ["-e", ""] }],
				},
			],
			finalValidationCommands: [
				{ command: process.execPath, args: ["-e", ""] },
			],
		},
		observations: [
			{
				taskId: "extend-widget",
				summary: "src/index.ts is the module the request extends.",
				paths: ["src/index.ts"],
			},
		],
	};
}

class ScriptedPlanningWorkers implements WorkerBackend {
	readonly spawns: SpawnWorkerRequest[] = [];
	stopped = 0;

	constructor(private readonly result: WorkerExecutionResult) {}

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		this.spawns.push(request);
		return { id: "planner-1", status: "online", cwd: request.cwd };
	}

	async list(): Promise<WorkerInstance[]> {
		return [];
	}

	async status(): Promise<WorkerInstance> {
		return { id: "planner-1", status: "online", cwd: "/repo" };
	}

	async startPrompt(): Promise<WorkerExecution> {
		return { completion: Promise.resolve(this.result) };
	}

	async stop(): Promise<void> {
		this.stopped += 1;
	}
}

function workerOutput(document: unknown): string {
	return [
		"Explored the repository.",
		BEGIN_PLAN_DOCUMENT_MARKER,
		JSON.stringify(document),
		END_PLAN_DOCUMENT_MARKER,
	].join("\n");
}

async function createPlanOnlyHarness(result: WorkerExecutionResult) {
	const workers = new ScriptedPlanningWorkers(result);
	const worker = new PlanningWorker({ workers, securityPolicy });
	const plan = buildPlanOnlyWorkflowPlan("Extend the widget in src/index.ts");
	const handlers = planOnlyStepHandlers({
		worker,
		git: new GitCli(),
		requestText: "Extend the widget in src/index.ts",
	});
	const harness = await createWorkflowHarness(plan, handlers);
	return { workers, harness };
}

describe("plan-only workflow end to end", () => {
	it("runs the engine to completion and publishes the plan document artifact", async () => {
		const { workers, harness } = await createPlanOnlyHarness({
			status: "succeeded",
			output: workerOutput(plannedDocument(["src/"])),
		});
		const settled = await harness.engine.run(harness.initial.id);

		expect(settled.state).toBe("completed");
		expect(settled.steps[PLAN_ONLY_STEP_ID]?.state).toBe("succeeded");

		// The proposed plan is stored as a decision artifact.
		const artifact = await harness.artifacts.latest(
			harness.initial.id,
			PLAN_ONLY_STEP_ID,
			PLAN_ONLY_PLAN_OUTPUT,
		);
		expect(artifact?.kind).toBe("decision");
		const payload = parseArtifactPayload("decision", artifact?.payload ?? "");
		if (payload.format !== "json") {
			throw new Error("decision artifacts must be JSON");
		}
		const document = payload.value as {
			plan: { title: string };
			observations: unknown[];
		};
		expect(document.plan.title).toBe("Extend the widget");
		expect(document.observations).toHaveLength(1);

		// The planning worker ran read-only in an isolated worktree, not the
		// user's repository, and was stopped afterwards.
		expect(workers.spawns[0]?.cwd).not.toBe(harness.repositoryRoot);
		expect(workers.spawns[0]?.launchPolicy?.tools).toStrictEqual([
			"read",
			"grep",
			"find",
			"ls",
		]);
		expect(workers.stopped).toBe(1);

		// The user's repository is untouched and still clean.
		const status = await execute("git", ["status", "--porcelain"], {
			cwd: harness.repositoryRoot,
		});
		expect(status.stdout.trim()).toBe("");
	});

	it("fails the step when the proposed plan cites paths the repository lacks", async () => {
		const { harness } = await createPlanOnlyHarness({
			status: "succeeded",
			output: workerOutput(plannedDocument(["missing-directory/"])),
		});
		const settled = await harness.engine.run(harness.initial.id);

		expect(settled.state).toBe("failed");
		const step = settled.steps[PLAN_ONLY_STEP_ID];
		expect(step?.state).toBe("failed");
		const attemptId = step?.attemptIds[step.attemptIds.length - 1];
		const attempt = settled.attempts.find((entry) => entry.id === attemptId);
		expect(attempt?.error).toContain("unknown_path");
		expect(attempt?.error).toContain("missing-directory/");
	});

	it("fails the step when the worker returns no plan document", async () => {
		const { harness } = await createPlanOnlyHarness({
			status: "succeeded",
			output: "I could not decide on a plan.",
		});
		const settled = await harness.engine.run(harness.initial.id);
		expect(settled.state).toBe("failed");
	});
});

describe("buildPlanOnlyWorkflowPlan", () => {
	it("builds a valid single-step read-only plan without final validation", () => {
		const plan = buildPlanOnlyWorkflowPlan("Do the thing\nwith details");
		expect(plan.title).toBe("Plan only: Do the thing");
		expect(plan.steps).toHaveLength(1);
		expect(plan.steps[0]?.capabilities).toStrictEqual(["read-repository"]);
		expect(plan.finalValidationCommands).toStrictEqual([]);
	});

	it("bounds the derived title", () => {
		const title = workflowTitleFromRequest("Plan only", "x".repeat(500));
		expect(title.length).toBeLessThanOrEqual(120);
	});
});
