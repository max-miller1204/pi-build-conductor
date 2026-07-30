import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerLaunchPolicy } from "../src/domain/types.js";
import { ChangeStepHandler } from "../src/engine/steps/change.js";
import { CommandStepHandler } from "../src/engine/steps/command.js";
import { InvestigationStepHandler } from "../src/engine/steps/investigation.js";
import {
	type StepWorkerProgress,
	StepWorkerRunner,
} from "../src/engine/steps/worker-runner.js";
import { GitCli } from "../src/git/git.js";
import { readSecurityPolicy } from "../src/security/policy.js";
import { LocalTaskValidator } from "../src/validation/task-validator.js";
import type {
	SpawnWorkerRequest,
	WorkerBackend,
	WorkerExecution,
	WorkerExecutionOptions,
	WorkerInstance,
} from "../src/workers/backend.js";
import {
	changeStep,
	commandStep,
	createWorkflowHarness,
	execute,
	investigationStep,
	removeWorkflowHarnessDirectories,
	workflowPlanOf,
} from "./helpers/workflow.js";

interface ScriptedWorker {
	act?: (cwd: string) => Promise<void>;
	output?: string;
	fail?: string;
	requestUi?: boolean;
}

class ScriptedWorkers implements WorkerBackend {
	readonly spawned: SpawnWorkerRequest[] = [];
	readonly prompts: string[] = [];
	readonly stopped: string[] = [];
	private readonly workers = new Map<string, WorkerInstance>();
	private next = 1;

	constructor(private readonly scripts: Record<string, ScriptedWorker>) {}

	async spawn(request: SpawnWorkerRequest): Promise<WorkerInstance> {
		this.spawned.push(request);
		const worker: WorkerInstance = {
			id: `worker-${this.next++}`,
			status: "online",
			cwd: request.cwd,
			...(request.label ? { label: request.label } : {}),
			...(request.launchPolicy ? { appliedPolicy: request.launchPolicy } : {}),
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
		options?: WorkerExecutionOptions,
	): Promise<WorkerExecution> {
		this.prompts.push(prompt);
		const worker = this.workers.get(workerId);
		if (!worker) {
			throw new Error(`Unknown worker ${workerId}`);
		}
		const stepId = /step ([a-z][a-z0-9-]*)\./.exec(prompt)?.[1] ?? "";
		const script = this.scripts[stepId] ?? {};
		const completion = (async () => {
			options?.onEvent?.({ type: "agent_started" });
			if (script.requestUi) {
				await options?.onUiRequest?.(
					{ id: "ui-1", method: "confirm", title: "Deploy?", message: "now?" },
					async () => {},
				);
			}
			await script.act?.(worker.cwd);
			if (script.fail) {
				return { status: "failed" as const, error: script.fail };
			}
			return {
				status: "succeeded" as const,
				...(script.output === undefined ? {} : { output: script.output }),
			};
		})();
		return { completion };
	}

	async stop(workerId: string): Promise<void> {
		this.stopped.push(workerId);
		this.workers.delete(workerId);
	}
}

function handlersFor(
	workers: WorkerBackend,
	progress: StepWorkerProgress[] = [],
	commandTimeoutMs?: number,
) {
	const git = new GitCli();
	const securityPolicy = readSecurityPolicy({});
	const worker = new StepWorkerRunner({
		workers,
		securityPolicy,
		pollIntervalMs: 50,
		onProgress: (event) => {
			progress.push(event);
		},
	});
	return [
		new InvestigationStepHandler({ worker, git, securityPolicy }),
		new ChangeStepHandler({
			worker,
			git,
			securityPolicy,
			validator: new LocalTaskValidator(git),
		}),
		new CommandStepHandler({
			git,
			securityPolicy,
			...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }),
		}),
	];
}

async function writeFileIn(cwd: string, path: string, body: string) {
	const target = join(cwd, path);
	await mkdir(join(target, ".."), { recursive: true });
	await writeFile(target, body);
}

afterEach(removeWorkflowHarnessDirectories);

describe("ported workflow step handlers", () => {
	it("runs a real investigate, change, and verify workflow end to end", async () => {
		const progress: StepWorkerProgress[] = [];
		const workers = new ScriptedWorkers({
			survey: { output: "The api module needs a greeting export." },
			api: {
				act: async (cwd) => {
					await writeFileIn(
						cwd,
						join("src", "api", "index.ts"),
						'export const greeting = "hi";\n',
					);
				},
				output: "Added the greeting export.",
			},
		});
		const plan = workflowPlanOf([
			investigationStep("survey", [], { outputs: ["report"] }),
			changeStep("api", ["survey"], ["src/api/"], {
				inputs: [{ stepId: "survey", output: "report" }],
				outputs: ["evidence", "commit"],
			}),
			commandStep("verify", ["api"], { outputs: ["evidence"] }),
		]);
		const harness = await createWorkflowHarness(
			plan,
			handlersFor(workers, progress),
		);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		expect(finished.steps.api?.integratedCommit).toBeDefined();

		// The orchestrator owns exactly one commit per change step.
		const history = await execute(
			"git",
			["log", "--format=%s", finished.integrationBranch],
			{ cwd: harness.repositoryRoot },
		);
		expect(history.stdout.trim().split("\n")).toEqual([
			"step(api): api",
			"Initial",
		]);
		const committed = await execute(
			"git",
			["show", `${finished.integrationBranch}:src/api/index.ts`],
			{ cwd: harness.repositoryRoot },
		);
		expect(committed.stdout).toContain("greeting");

		// The investigation answer became the dependent step's upstream artifact.
		const report = await harness.artifacts.read(
			harness.initial.id,
			"survey.report.1",
		);
		expect(report.payload).toContain("greeting export");
		const changePrompt = workers.prompts[1] ?? "";
		expect(changePrompt).toContain("BEGIN_UNTRUSTED_ARTIFACT survey.report.1");
		expect(changePrompt).toContain("Write only within these approved");
		expect(changePrompt).toContain("- src/api/");

		// Validation evidence and the commit reference were stored as artifacts.
		const evidence = await harness.artifacts.read(
			harness.initial.id,
			"api.evidence.1",
		);
		expect(JSON.parse(evidence.payload)).toMatchObject({
			passed: true,
			changedFiles: [{ path: "src/api/index.ts" }],
		});
		const commit = await harness.artifacts.read(
			harness.initial.id,
			"api.commit.1",
		);
		expect(JSON.parse(commit.payload).commit).toBeTruthy();
		const verification = await harness.artifacts.read(
			harness.initial.id,
			"verify.evidence.1",
		);
		expect(JSON.parse(verification.payload)).toMatchObject({ passed: true });

		// Each worker launched under the allowlist of its own step authority.
		const policies = workers.spawned.map(
			(request) => request.launchPolicy as WorkerLaunchPolicy,
		);
		expect(policies[0]).toEqual({
			version: 1,
			role: "review",
			tools: ["read", "grep", "find", "ls"],
			resourceDiscovery: "disabled",
		});
		expect(policies[1]).toEqual({
			version: 1,
			role: "implementation",
			tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
			resourceDiscovery: "disabled",
		});
		expect(workers.stopped).toEqual(["worker-1", "worker-2"]);
		expect(progress.map((entry) => entry.event.type)).toEqual([
			"agent_started",
			"agent_started",
		]);

		// The user worktree is untouched.
		const status = await execute("git", ["status", "--porcelain"], {
			cwd: harness.repositoryRoot,
		});
		expect(status.stdout).toBe("");
	});

	it("rejects a change that leaves its approved paths", async () => {
		const workers = new ScriptedWorkers({
			api: {
				act: async (cwd) => {
					await writeFileIn(cwd, join("src", "api", "index.ts"), "ok\n");
					await writeFileIn(cwd, join("src", "secret", "index.ts"), "no\n");
				},
			},
		});
		const plan = workflowPlanOf([changeStep("api", [], ["src/api/"])]);
		const harness = await createWorkflowHarness(plan, handlersFor(workers));

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.api?.error).toContain(
			"changed paths outside its approved scope",
		);
		const history = await execute(
			"git",
			["log", "--format=%s", finished.integrationBranch],
			{ cwd: harness.repositoryRoot },
		);
		expect(history.stdout.trim()).toBe("Initial");
	});

	it("rejects a change step that declared away its mutation authority", async () => {
		const workers = new ScriptedWorkers({
			api: {
				act: async (cwd) => {
					await writeFileIn(cwd, join("src", "api", "index.ts"), "ok\n");
				},
			},
		});
		const plan = workflowPlanOf([
			changeStep("api", [], ["src/api/"], {
				capabilities: ["read-repository", "execute-commands"],
				retry: { maxAttempts: 3 },
			}),
		]);
		const harness = await createWorkflowHarness(plan, handlersFor(workers));

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.api?.error).toContain(
			"Observed repository mutations without the mutate-repository capability",
		);
		// A boundary breach is permanent: it never spends the retry budget.
		expect(finished.attempts).toHaveLength(1);
		expect(workers.spawned[0]?.launchPolicy?.tools).toEqual([
			"read",
			"grep",
			"find",
			"ls",
			"bash",
		]);
	});

	it("fails a change step whose focused checks fail, without committing", async () => {
		const workers = new ScriptedWorkers({
			api: {
				act: async (cwd) => {
					await writeFileIn(cwd, join("src", "api", "index.ts"), "ok\n");
				},
			},
		});
		const plan = workflowPlanOf([
			{
				...changeStep("api", [], ["src/api/"]),
				validationCommands: [
					{ command: process.execPath, args: ["-e", "process.exit(3)"] },
				],
			},
		]);
		const harness = await createWorkflowHarness(plan, handlersFor(workers));

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.api?.error).toContain("failed");
		const history = await execute(
			"git",
			["log", "--format=%s", finished.integrationBranch],
			{ cwd: harness.repositoryRoot },
		);
		expect(history.stdout.trim()).toBe("Initial");
	});

	it("declines blocked worker prompts instead of expanding authority", async () => {
		const progress: StepWorkerProgress[] = [];
		const workers = new ScriptedWorkers({
			survey: { requestUi: true, output: "nothing to report" },
		});
		const plan = workflowPlanOf([investigationStep("survey")]);
		const harness = await createWorkflowHarness(
			plan,
			handlersFor(workers, progress),
		);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("completed");
		expect(progress.map((entry) => entry.event)).toContainEqual({
			type: "ui_decision",
			requestId: "ui-1",
			method: "confirm",
			policy: "decline",
			outcome: "declined",
		});
	});

	it("reports a failed worker as a step failure", async () => {
		const workers = new ScriptedWorkers({
			survey: { fail: "the model gave up" },
		});
		const plan = workflowPlanOf([investigationStep("survey")]);
		const harness = await createWorkflowHarness(plan, handlersFor(workers));

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.survey?.error).toBe("the model gave up");
		expect(workers.stopped).toEqual(["worker-1"]);
	});

	it("rejects an investigation worker that changed the repository", async () => {
		const workers = new ScriptedWorkers({
			survey: {
				act: async (cwd) => {
					await writeFileIn(cwd, join("src", "index.ts"), "tampered\n");
				},
				output: "done",
			},
		});
		const plan = workflowPlanOf([investigationStep("survey")]);
		const harness = await createWorkflowHarness(plan, handlersFor(workers));

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.survey?.error).toContain(
			"Observed repository mutations",
		);
	});

	it("fails a command step whose command exits non-zero", async () => {
		const workers = new ScriptedWorkers({});
		const plan = workflowPlanOf([
			{
				...commandStep("verify", []),
				command: {
					command: process.execPath,
					args: ["-e", "console.error('boom'); process.exit(2)"],
				},
			},
		]);
		const harness = await createWorkflowHarness(plan, handlersFor(workers));

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.verify?.error).toContain("exited with code 2");
		expect(finished.steps.verify?.error).toContain("boom");
	});

	it("rejects a command step that declared away execution authority", async () => {
		const workers = new ScriptedWorkers({});
		const plan = workflowPlanOf([
			commandStep("verify", [], {
				capabilities: ["read-repository"],
				retry: { maxAttempts: 3 },
			}),
		]);
		const harness = await createWorkflowHarness(plan, handlersFor(workers));

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.verify?.error).toContain(
			"without the execute-commands capability",
		);
		expect(finished.attempts).toHaveLength(1);
	});

	it("fails a timed-out command even when SIGTERM produces exit code zero", async () => {
		const workers = new ScriptedWorkers({});
		const plan = workflowPlanOf([
			{
				...commandStep("verify", []),
				command: {
					command: process.execPath,
					args: [
						"-e",
						"process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
					],
				},
			},
		]);
		const harness = await createWorkflowHarness(
			plan,
			handlersFor(workers, [], 200),
		);

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.verify?.error).toContain("exited with a timeout");
	});

	it("rejects an output no handler knows how to produce", async () => {
		const workers = new ScriptedWorkers({});
		const plan = workflowPlanOf([
			changeStep("api", [], ["src/api/"], { outputs: ["mystery"] }),
		]);
		const harness = await createWorkflowHarness(plan, handlersFor(workers));

		const finished = await harness.engine.run(harness.initial.id);

		expect(finished.state).toBe("failed");
		expect(finished.steps.api?.error).toContain(
			"cannot produce output mystery",
		);
		expect(workers.spawned).toHaveLength(0);
	});

	it("keeps the failed attempt worktree available as evidence", async () => {
		const workers = new ScriptedWorkers({
			api: {
				act: async (cwd) => {
					await writeFileIn(cwd, join("src", "secret", "index.ts"), "no\n");
				},
			},
		});
		const plan = workflowPlanOf([changeStep("api", [], ["src/api/"])]);
		const harness = await createWorkflowHarness(plan, handlersFor(workers));

		const finished = await harness.engine.run(harness.initial.id);
		const attempt = finished.attempts[0];

		expect(attempt?.state).toBe("failed");
		expect(
			await readFile(
				join(attempt?.workspacePath ?? "", "src", "secret", "index.ts"),
				"utf8",
			),
		).toBe("no\n");
	});
});
