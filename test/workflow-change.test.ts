import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskPlan } from "../src/domain/types.js";
import { REVIEW_CATEGORIES } from "../src/domain/types.js";
import { finalizeWorkflowRun } from "../src/engine/finalization.js";
import { StepWorkerRunner } from "../src/engine/steps/worker-runner.js";
import { GitCli } from "../src/git/git.js";
import { GitWorktreeManager } from "../src/git/worktrees.js";
import {
	REVIEW_REPORT_END,
	REVIEW_REPORT_START,
} from "../src/review/review-report.js";
import { readSecurityPolicy } from "../src/security/policy.js";
import { LocalFinalValidator } from "../src/validation/final-validator.js";
import { LocalTaskValidator } from "../src/validation/task-validator.js";
import type {
	SpawnWorkerRequest,
	WorkerBackend,
	WorkerExecution,
	WorkerInstance,
} from "../src/workers/backend.js";
import {
	buildChangeWorkflowPlan,
	changeWorkflowStepHandlers,
	REPAIR_STEP_ID,
	reviewStepId,
} from "../src/workflows/change.js";
import {
	createWorkflowHarness,
	execute,
	removeWorkflowHarnessDirectories,
} from "./helpers/workflow.js";

afterEach(removeWorkflowHarnessDirectories);

const securityPolicy = readSecurityPolicy({});

interface Script {
	act?: (cwd: string) => Promise<void>;
	output?: string | ((prompt: string) => string);
}

class ScriptedWorkers implements WorkerBackend {
	readonly prompts: string[] = [];
	private readonly workers = new Map<string, WorkerInstance>();
	private next = 1;

	constructor(private readonly scripts: Record<string, Script>) {}

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		const worker: WorkerInstance = {
			id: `worker-${this.next++}`,
			status: "online",
			cwd: request.cwd,
		};
		this.workers.set(worker.id, worker);
		return worker;
	}

	async list(): Promise<WorkerInstance[]> {
		return [...this.workers.values()];
	}

	async status(workerId: string): Promise<WorkerInstance> {
		const worker = this.workers.get(workerId);
		if (!worker) {
			throw new Error(`Unknown worker ${workerId}`);
		}
		return worker;
	}

	async startPrompt(
		workerId: string,
		prompt: string,
	): Promise<WorkerExecution> {
		this.prompts.push(prompt);
		const worker = this.workers.get(workerId);
		if (!worker) {
			throw new Error(`Unknown worker ${workerId}`);
		}
		const stepId = /step ([a-z][a-z0-9-]*)[.,]/.exec(prompt)?.[1] ?? "";
		const script = this.scripts[stepId];
		if (!script) {
			return {
				completion: Promise.resolve({
					status: "failed" as const,
					error: `No script for step ${stepId}`,
				}),
			};
		}
		const completion = (async () => {
			await script.act?.(worker.cwd);
			const output =
				typeof script.output === "function"
					? script.output(prompt)
					: script.output;
			return {
				status: "succeeded" as const,
				...(output === undefined ? {} : { output }),
			};
		})();
		return { completion };
	}

	async stop(workerId: string): Promise<void> {
		this.workers.delete(workerId);
	}
}

function reviewReport(
	category: string,
	findings: Record<string, unknown>[],
): (prompt: string) => string {
	return (prompt) => {
		const baseCommit = /at commit ([0-9a-f]{40,64})/.exec(prompt)?.[1] ?? "";
		return `${REVIEW_REPORT_START}
${JSON.stringify({
	version: 1,
	category,
	baseCommit,
	summary: `${category} review complete`,
	findings,
})}
${REVIEW_REPORT_END}`;
	};
}

function taskPlanFixture(): TaskPlan {
	return {
		version: 3,
		title: "Deliver the API and its docs",
		tasks: [
			{
				id: "add-api",
				title: "Add the API",
				description: "Create src/api/index.ts.",
				dependencies: [],
				acceptanceCriteria: ["api exists"],
				allowedPaths: ["src/api/"],
				validationCommands: [{ command: process.execPath, args: ["-e", ""] }],
			},
			{
				id: "add-docs",
				title: "Add the docs",
				description: "Create docs/guide.md.",
				dependencies: [],
				acceptanceCriteria: ["docs exist"],
				allowedPaths: ["docs/"],
				validationCommands: [{ command: process.execPath, args: ["-e", ""] }],
			},
		],
		finalValidationCommands: [{ command: process.execPath, args: ["-e", ""] }],
	};
}

async function writeFileIn(cwd: string, path: string, body: string) {
	await mkdir(join(cwd, path, ".."), { recursive: true });
	await writeFile(join(cwd, path), body);
}

function cleanReviewScripts(): Record<string, Script> {
	return Object.fromEntries(
		REVIEW_CATEGORIES.map((category) => [
			reviewStepId(category),
			{ output: reviewReport(category, []) },
		]),
	);
}

async function createChangeHarness(scripts: Record<string, Script>) {
	const workers = new ScriptedWorkers(scripts);
	const git = new GitCli();
	const handlers = changeWorkflowStepHandlers({
		worker: new StepWorkerRunner({ workers, securityPolicy }),
		validator: new LocalTaskValidator(git),
		git,
		securityPolicy,
		requestText: "Deliver the API and its docs",
	});
	const plan = buildChangeWorkflowPlan(taskPlanFixture());
	const harness = await createWorkflowHarness(plan, handlers, {
		maxConcurrentWorkers: 2,
	});
	return { workers, git, harness };
}

describe("strict change workflow end to end", () => {
	it("implements, reviews, repairs, and produces merge-ready evidence", async () => {
		const { workers, git, harness } = await createChangeHarness({
			"add-api": {
				act: (cwd) =>
					writeFileIn(cwd, join("src", "api", "index.ts"), "export = 1;\n"),
			},
			"add-docs": {
				act: (cwd) => writeFileIn(cwd, join("docs", "guide.md"), "Guide.\n"),
			},
			...cleanReviewScripts(),
			[reviewStepId("security")]: {
				output: reviewReport("security", [
					{
						severity: "high",
						confidence: "high",
						title: "Unsafe export",
						description: "The export syntax is unsafe.",
						paths: ["src/api/index.ts"],
						recommendation: "Use export default.",
					},
				]),
			},
			[REPAIR_STEP_ID]: {
				act: (cwd) =>
					writeFileIn(
						cwd,
						join("src", "api", "index.ts"),
						"export default 1;\n",
					),
				output: "Replaced the unsafe export.",
			},
		});
		const settled = await harness.engine.run(harness.initial.id);

		expect(settled.state).toBe("completed");
		for (const category of REVIEW_CATEGORIES) {
			expect(settled.steps[reviewStepId(category)]?.state).toBe("succeeded");
		}
		expect(settled.steps[REPAIR_STEP_ID]?.state).toBe("succeeded");

		// The security findings were prioritized into the repair worker.
		const repairPrompt = workers.prompts.find((prompt) =>
			prompt.includes("repair worker"),
		);
		expect(repairPrompt).toContain("Unsafe export");

		// Integration lands change commits in plan order, then the repair.
		const history = await execute(
			"git",
			["log", "--format=%s", settled.integrationBranch],
			{ cwd: harness.repositoryRoot },
		);
		expect(history.stdout.trim().split("\n")).toEqual([
			`step(${REPAIR_STEP_ID}): Repair the review findings`,
			"step(add-docs): Add the docs",
			"step(add-api): Add the API",
			"Initial",
		]);

		// Final validation runs at the integrated head and yields evidence.
		const repository = await git.inspect(harness.repositoryRoot);
		const result = await finalizeWorkflowRun(
			{
				finalValidator: new LocalFinalValidator(git),
				worktrees: new GitWorktreeManager(git, harness.worktreeRoot),
				git,
				securityPolicy,
				artifacts: harness.artifacts,
			},
			{ state: settled, repository },
		);
		expect(result.mergeReady).toBeDefined();
		expect(result.mergeReady?.integrationHead).toBe(settled.integrationHead);

		// The user's branch and worktree stay untouched.
		expect(repository.isClean).toBe(true);
		expect(repository.head).toBe(harness.initial.baseCommit);
	});

	it("completes without a repair commit when every review is clean", async () => {
		const { harness } = await createChangeHarness({
			"add-api": {
				act: (cwd) =>
					writeFileIn(cwd, join("src", "api", "index.ts"), "export {};\n"),
			},
			"add-docs": {
				act: (cwd) => writeFileIn(cwd, join("docs", "guide.md"), "Guide.\n"),
			},
			...cleanReviewScripts(),
		});
		const settled = await harness.engine.run(harness.initial.id);

		expect(settled.state).toBe("completed");
		expect(settled.steps[REPAIR_STEP_ID]?.state).toBe("succeeded");
		const history = await execute(
			"git",
			["log", "--format=%s", settled.integrationBranch],
			{ cwd: harness.repositoryRoot },
		);
		expect(history.stdout.trim().split("\n")).toEqual([
			"step(add-docs): Add the docs",
			"step(add-api): Add the API",
			"Initial",
		]);
	});
});

describe("buildChangeWorkflowPlan", () => {
	it("appends one review per category and one bounded repair pass", () => {
		const plan = buildChangeWorkflowPlan(taskPlanFixture());
		expect(plan.steps.map((step) => step.id)).toEqual([
			"add-api",
			"add-docs",
			...REVIEW_CATEGORIES.map((category) => reviewStepId(category)),
			REPAIR_STEP_ID,
		]);
		const repair = plan.steps.find((step) => step.id === REPAIR_STEP_ID);
		if (repair?.kind !== "change") {
			throw new Error("repair step must be a change step");
		}
		expect(repair.profile).toBe("repair");
		expect(repair.allowedPaths).toEqual(["docs/", "src/api/"]);
		expect(repair.inputs).toHaveLength(REVIEW_CATEGORIES.length);
		for (const category of REVIEW_CATEGORIES) {
			const review = plan.steps.find(
				(step) => step.id === reviewStepId(category),
			);
			expect(review?.dependencies).toEqual(["add-api", "add-docs"]);
			expect(review?.profile).toBe("review");
		}
	});

	it("rejects task ids that collide with generated steps", () => {
		const taskPlan = taskPlanFixture();
		const first = taskPlan.tasks[0];
		if (!first) {
			throw new Error("fixture must have tasks");
		}
		first.id = REPAIR_STEP_ID;
		expect(() => buildChangeWorkflowPlan(taskPlan)).toThrow(/collides/);
	});
});
