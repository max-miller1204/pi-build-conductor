import { afterEach, describe, expect, it } from "vitest";
import { StepWorkerRunner } from "../src/engine/steps/worker-runner.js";
import { GitCli } from "../src/git/git.js";
import { readSecurityPolicy } from "../src/security/policy.js";
import type {
	SpawnWorkerRequest,
	WorkerBackend,
	WorkerExecution,
	WorkerInstance,
} from "../src/workers/backend.js";
import {
	buildInvestigateWorkflowPlan,
	INVESTIGATE_REPORT_OUTPUT,
	investigateStepHandlers,
	investigationQuestionsFromRequest,
	investigationStepId,
	SYNTHESIS_STEP_ID,
} from "../src/workflows/investigate.js";
import {
	createWorkflowHarness,
	execute,
	removeWorkflowHarnessDirectories,
} from "./helpers/workflow.js";

afterEach(removeWorkflowHarnessDirectories);

const securityPolicy = readSecurityPolicy({});

/** Answers each prompt from a rule list matched against the prompt text. */
class ScriptedInvestigationWorkers implements WorkerBackend {
	readonly prompts: string[] = [];
	readonly spawns: SpawnWorkerRequest[] = [];
	stopped = 0;
	private nextWorker = 0;

	constructor(
		private readonly rules: Array<{
			match: string;
			output?: string;
			error?: string;
		}>,
	) {}

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		this.spawns.push(request);
		this.nextWorker += 1;
		return {
			id: `worker-${this.nextWorker}`,
			status: "online",
			cwd: request.cwd,
		};
	}

	async list(): Promise<WorkerInstance[]> {
		return [];
	}

	async status(workerId: string): Promise<WorkerInstance> {
		return { id: workerId, status: "online", cwd: "/" };
	}

	async startPrompt(
		_workerId: string,
		prompt: string,
	): Promise<WorkerExecution> {
		this.prompts.push(prompt);
		const rule = this.rules.find((entry) => prompt.includes(entry.match));
		if (!rule) {
			return {
				completion: Promise.resolve({
					status: "failed" as const,
					error: `No scripted answer for prompt: ${prompt.slice(0, 80)}`,
				}),
			};
		}
		if (rule.error !== undefined) {
			return {
				completion: Promise.resolve({
					status: "failed" as const,
					error: rule.error,
				}),
			};
		}
		return {
			completion: Promise.resolve({
				status: "succeeded" as const,
				output: rule.output ?? "",
			}),
		};
	}

	async stop(): Promise<void> {
		this.stopped += 1;
	}
}

async function createInvestigateHarness(
	workers: ScriptedInvestigationWorkers,
	questions: string[],
) {
	const plan = buildInvestigateWorkflowPlan({
		requestText: "How does the widget work?",
		questions,
	});
	const handlers = investigateStepHandlers({
		worker: new StepWorkerRunner({ workers, securityPolicy }),
		git: new GitCli(),
		securityPolicy,
		requestText: "How does the widget work?",
	});
	return createWorkflowHarness(plan, handlers);
}

describe("investigate workflow end to end", () => {
	it("answers every question and synthesizes the reports into one answer", async () => {
		const workers = new ScriptedInvestigationWorkers([
			// Ordered most-specific first: the synthesis prompt also contains the
			// question texts through upstream artifact titles.
			{
				match: "Synthesize the investigation findings",
				output: "The widget lives in src/index.ts and is currently untested.",
			},
			{
				match: "Where is the widget defined?",
				output: "The widget lives in src/index.ts.",
			},
			{
				match: "How is the widget tested?",
				output: "There are no widget tests yet.",
			},
		]);
		const harness = await createInvestigateHarness(workers, [
			"Where is the widget defined?",
			"How is the widget tested?",
		]);
		const settled = await harness.engine.run(harness.initial.id);

		expect(settled.state).toBe("completed");
		expect(settled.steps[investigationStepId(0)]?.state).toBe("succeeded");
		expect(settled.steps[investigationStepId(1)]?.state).toBe("succeeded");
		expect(settled.steps[SYNTHESIS_STEP_ID]?.state).toBe("succeeded");

		// The synthesis worker received both reports as untrusted artifacts.
		const synthesisPrompt = workers.prompts.find((prompt) =>
			prompt.includes("Synthesize the investigation findings"),
		);
		expect(synthesisPrompt).toContain("BEGIN_UNTRUSTED_ARTIFACT");
		expect(synthesisPrompt).toContain("The widget lives in src/index.ts.");
		expect(synthesisPrompt).toContain("There are no widget tests yet.");

		// The synthesized answer is the workflow's final report artifact.
		const report = await harness.artifacts.latest(
			harness.initial.id,
			SYNTHESIS_STEP_ID,
			INVESTIGATE_REPORT_OUTPUT,
		);
		expect(report?.kind).toBe("report");
		expect(report?.payload).toBe(
			"The widget lives in src/index.ts and is currently untested.",
		);

		// Every worker was stopped and the repository stayed clean.
		expect(workers.stopped).toBe(3);
		const status = await execute("git", ["status", "--porcelain"], {
			cwd: harness.repositoryRoot,
		});
		expect(status.stdout.trim()).toBe("");
	});

	it("fails the run when an investigation cannot be answered", async () => {
		const workers = new ScriptedInvestigationWorkers([
			{ match: "Where is the widget defined?", error: "worker crashed" },
			{
				match: "Synthesize the investigation findings",
				output: "never reached",
			},
		]);
		const harness = await createInvestigateHarness(workers, [
			"Where is the widget defined?",
		]);
		const settled = await harness.engine.run(harness.initial.id);

		expect(settled.state).toBe("failed");
		expect(settled.steps[investigationStepId(0)]?.state).toBe("failed");
		// The synthesis step never ran because its dependency failed.
		expect(settled.steps[SYNTHESIS_STEP_ID]?.state).toBe("blocked");
	});
});

describe("buildInvestigateWorkflowPlan", () => {
	it("rejects an empty or oversized question list", () => {
		expect(() =>
			buildInvestigateWorkflowPlan({ requestText: "r", questions: [] }),
		).toThrow(/1 to 4/);
		expect(() =>
			buildInvestigateWorkflowPlan({
				requestText: "r",
				questions: ["a?", "b?", "c?", "d?", "e?"],
			}),
		).toThrow(/1 to 4/);
	});

	it("declares read-only steps and no final validation", () => {
		const plan = buildInvestigateWorkflowPlan({
			requestText: "How?",
			questions: ["How does it work?"],
		});
		expect(plan.finalValidationCommands).toStrictEqual([]);
		for (const step of plan.steps) {
			expect(step.capabilities).toStrictEqual(["read-repository"]);
		}
	});
});

describe("investigationQuestionsFromRequest", () => {
	it("extracts question lines and falls back to the whole request", () => {
		expect(
			investigationQuestionsFromRequest(
				"Context first.\nWhere is it defined?\nHow is it tested?\n",
			),
		).toStrictEqual(["Where is it defined?", "How is it tested?"]);
		expect(
			investigationQuestionsFromRequest("Explain the widget module."),
		).toStrictEqual(["Explain the widget module."]);
		expect(investigationQuestionsFromRequest("  \n")).toStrictEqual([]);
	});

	it("bounds the number of extracted questions", () => {
		const request = Array.from(
			{ length: 6 },
			(_value, index) => `Question ${index}?`,
		).join("\n");
		expect(investigationQuestionsFromRequest(request)).toHaveLength(4);
	});
});
