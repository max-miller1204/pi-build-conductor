import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateWorkflowPlanResult } from "../src/domain/steps.js";
import { ChangeStepHandler } from "../src/engine/steps/change.js";
import { InvestigationStepHandler } from "../src/engine/steps/investigation.js";
import { RepairStepHandler } from "../src/engine/steps/repair.js";
import {
	ReviewStepHandler,
	reviewCategoryOf,
} from "../src/engine/steps/review.js";
import { StepWorkerRunner } from "../src/engine/steps/worker-runner.js";
import { GitCli } from "../src/git/git.js";
import {
	REVIEW_REPORT_END,
	REVIEW_REPORT_START,
} from "../src/review/review-report.js";
import { readSecurityPolicy } from "../src/security/policy.js";
import { LocalTaskValidator } from "../src/validation/task-validator.js";
import type {
	SpawnWorkerRequest,
	WorkerBackend,
	WorkerExecution,
	WorkerInstance,
} from "../src/workers/backend.js";
import {
	changeStep,
	createWorkflowHarness,
	execute,
	investigationStep,
	removeWorkflowHarnessDirectories,
	workflowPlanOf,
} from "./helpers/workflow.js";

interface Script {
	act?: (cwd: string) => Promise<void>;
	output?: string;
}

class ScriptedWorkers implements WorkerBackend {
	readonly spawned: SpawnWorkerRequest[] = [];
	readonly prompts: string[] = [];
	private readonly workers = new Map<string, WorkerInstance>();
	private next = 1;

	constructor(private readonly scripts: Record<string, Script>) {}

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		this.spawned.push(request);
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
		const script = this.scripts[stepId] ?? {};
		const completion = (async () => {
			await script.act?.(worker.cwd);
			return {
				status: "succeeded" as const,
				...(script.output === undefined ? {} : { output: script.output }),
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
	baseCommit: string,
	findings: Record<string, unknown>[],
): string {
	return `${REVIEW_REPORT_START}
${JSON.stringify({
	version: 1,
	category,
	baseCommit,
	summary: `${category} review complete`,
	findings,
})}
${REVIEW_REPORT_END}`;
}

function handlersFor(workers: WorkerBackend) {
	const git = new GitCli();
	const securityPolicy = readSecurityPolicy({});
	const worker = new StepWorkerRunner({
		workers,
		securityPolicy,
		pollIntervalMs: 50,
	});
	const change = {
		worker,
		git,
		securityPolicy,
		validator: new LocalTaskValidator(git),
	};
	return [
		new InvestigationStepHandler({ worker, git, securityPolicy }),
		new ChangeStepHandler(change),
		new ReviewStepHandler({ worker, git, securityPolicy }),
		new RepairStepHandler(change),
	];
}

async function writeFileIn(cwd: string, path: string, body: string) {
	const target = join(cwd, path);
	await mkdir(join(target, ".."), { recursive: true });
	await writeFile(target, body);
}

afterEach(removeWorkflowHarnessDirectories);

describe("review and repair step profiles", () => {
	it("rejects a profile the step kind cannot hold", () => {
		const result = validateWorkflowPlanResult({
			version: 4,
			title: "Plan",
			steps: [investigationStep("survey", [], { profile: "repair" })],
			finalValidationCommands: [{ command: "node", args: ["-e", ""] }],
		});

		expect(result.ok).toBe(false);
		expect(result.ok ? [] : result.issues.map((issue) => issue.code)).toContain(
			"profile_not_allowed",
		);
	});

	it("requires a review step id that names its category", () => {
		const plan = workflowPlanOf([
			investigationStep("review-security", [], { profile: "review" }),
		]);
		const step = plan.steps[0];
		if (!step || step.kind !== "investigation") {
			throw new Error("missing step");
		}

		expect(reviewCategoryOf(step)).toBe("security");
	});

	it("reviews the integrated result and repairs the findings it selected", async () => {
		const workers = new ScriptedWorkers({
			api: {
				act: async (cwd) => {
					await writeFileIn(
						cwd,
						join("src", "api", "index.ts"),
						"export {};\n",
					);
				},
			},
			"review-security": {
				output: "",
			},
			"repair-1": {
				act: async (cwd) => {
					await writeFileIn(
						cwd,
						join("src", "api", "index.ts"),
						"export const safe = true;\n",
					);
				},
			},
		});
		const plan = workflowPlanOf([
			changeStep("api", [], ["src/api/"]),
			investigationStep("review-security", ["api"], {
				profile: "review",
				outputs: ["findings"],
			}),
			changeStep("repair-1", ["review-security"], ["src/api/"], {
				profile: "repair",
				inputs: [{ stepId: "review-security", output: "findings" }],
				outputs: ["evidence"],
			}),
		]);
		const harness = await createWorkflowHarness(plan, handlersFor(workers));
		// The reviewer answers against the integration head it actually saw.
		const originalStart = workers.startPrompt.bind(workers);
		workers.startPrompt = async (workerId: string, prompt: string) => {
			if (prompt.includes("step review-security")) {
				const baseCommit = /at commit ([0-9a-f]{40})/.exec(prompt)?.[1] ?? "";
				workers.prompts.push(prompt);
				return {
					completion: Promise.resolve({
						status: "succeeded" as const,
						output: reviewReport("security", baseCommit, [
							{
								severity: "critical",
								confidence: "high",
								title: "Unsafe default",
								description: "The export is unguarded.",
								paths: ["src/api/index.ts"],
								recommendation: "Guard the export.",
							},
						]),
					}),
				};
			}
			return originalStart(workerId, prompt);
		};

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		const findings = await harness.artifacts.read(
			harness.initial.id,
			"review-security.findings.1",
		);
		expect(JSON.parse(findings.payload)).toMatchObject({
			category: "security",
			summary: "security review complete",
			findings: [{ severity: "critical", status: "deferred" }],
		});

		// The repair worker only ever saw the prioritized findings.
		const repairPrompt = workers.prompts.find((prompt) =>
			prompt.includes("repair worker"),
		);
		expect(repairPrompt).toContain("Unsafe default");
		expect(repairPrompt).toContain("- src/api/");

		const history = await execute(
			"git",
			["log", "--format=%s", finished.integrationBranch],
			{ cwd: harness.repositoryRoot },
		);
		expect(history.stdout.trim().split("\n")).toEqual([
			"step(repair-1): repair-1",
			"step(api): api",
			"Initial",
		]);
	});

	it("skips the repair worker when no finding requires one", async () => {
		const workers = new ScriptedWorkers({
			api: {
				act: async (cwd) => {
					await writeFileIn(
						cwd,
						join("src", "api", "index.ts"),
						"export {};\n",
					);
				},
			},
		});
		const plan = workflowPlanOf([
			changeStep("api", [], ["src/api/"]),
			investigationStep("review-tests", ["api"], {
				profile: "review",
				outputs: ["findings"],
			}),
			changeStep("repair-1", ["review-tests"], ["src/api/"], {
				profile: "repair",
				inputs: [{ stepId: "review-tests", output: "findings" }],
				outputs: ["evidence"],
			}),
		]);
		const harness = await createWorkflowHarness(plan, handlersFor(workers));
		const originalStart = workers.startPrompt.bind(workers);
		workers.startPrompt = async (workerId: string, prompt: string) => {
			if (prompt.includes("step review-tests")) {
				const baseCommit = /at commit ([0-9a-f]{40})/.exec(prompt)?.[1] ?? "";
				return {
					completion: Promise.resolve({
						status: "succeeded" as const,
						output: reviewReport("tests", baseCommit, [
							{
								severity: "low",
								confidence: "low",
								title: "Naming nit",
								description: "Consider a clearer name.",
								paths: ["src/api/index.ts"],
								recommendation: "Rename it.",
							},
						]),
					}),
				};
			}
			return originalStart(workerId, prompt);
		};

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		expect(finished.steps["repair-1"]?.state).toBe("succeeded");
		expect(
			workers.prompts.some((prompt) => prompt.includes("repair worker")),
		).toBe(false);
		const evidence = await harness.artifacts.read(
			harness.initial.id,
			"repair-1.evidence.1",
		);
		expect(JSON.parse(evidence.payload)).toMatchObject({ repaired: [] });
		const history = await execute(
			"git",
			["log", "--format=%s", finished.integrationBranch],
			{ cwd: harness.repositoryRoot },
		);
		expect(history.stdout.trim().split("\n")).toEqual([
			"step(api): api",
			"Initial",
		]);
	});

	it("fails a review that returns an unusable report", async () => {
		const workers = new ScriptedWorkers({
			"review-correctness": { output: "no markers here" },
		});
		const plan = workflowPlanOf([
			investigationStep("review-correctness", [], {
				profile: "review",
				outputs: ["findings"],
			}),
		]);
		const harness = await createWorkflowHarness(plan, handlersFor(workers));

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps["review-correctness"]?.error).toContain(
			"unusable report",
		);
	});

	it("gives review and repair workers their own frozen authority", async () => {
		const workers = new ScriptedWorkers({});
		const plan = workflowPlanOf([
			investigationStep("review-security", [], {
				profile: "review",
				outputs: ["findings"],
			}),
		]);
		const harness = await createWorkflowHarness(plan, handlersFor(workers));
		workers.startPrompt = async (_workerId: string, prompt: string) => {
			const baseCommit = /at commit ([0-9a-f]{40})/.exec(prompt)?.[1] ?? "";
			workers.prompts.push(prompt);
			return {
				completion: Promise.resolve({
					status: "succeeded" as const,
					output: reviewReport("security", baseCommit, []),
				}),
			};
		};

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		expect(workers.spawned[0]?.launchPolicy).toEqual({
			version: 1,
			role: "review",
			tools: ["read", "grep", "find", "ls"],
			resourceDiscovery: "disabled",
		});
		expect(workers.prompts[0]).toContain("independent security reviewer");
		expect(workers.prompts[0]).toContain(
			"Mutation and Bash tools are unavailable",
		);
	});
});
