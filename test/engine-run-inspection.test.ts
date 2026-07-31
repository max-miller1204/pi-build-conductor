import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createOrchestrationRun } from "../src/domain/run.js";
import type { TaskPlan } from "../src/domain/types.js";
import extension from "../src/extension.js";
import { GitCli } from "../src/git/git.js";
import { GitWorktreeManager } from "../src/git/worktrees.js";
import { readSecurityPolicy } from "../src/security/policy.js";
import { ArtifactStore } from "../src/storage/artifact-store.js";
import { RunStore } from "../src/storage/run-store.js";
import { STORAGE_DIRECTORY_NAME } from "../src/storage/storage-migration.js";
import {
	FileWorkflowStateStore,
	WORKFLOW_RUNS_DIRECTORY_NAME,
} from "../src/storage/workflow-state-store.js";
import { LocalFinalValidator } from "../src/validation/final-validator.js";
import { LocalTaskValidator } from "../src/validation/task-validator.js";
import { EngineChangeRunner } from "../src/workflows/change-run.js";
import { ChangeRunWorkers } from "./helpers/change-run-workers.js";

const execute = promisify(execFile);
const directories: string[] = [];

type CommandHandler = (
	args: string,
	ctx: ExtensionCommandContext,
) => Promise<void> | void;

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function plan(): TaskPlan {
	return {
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
		finalValidationCommands: [{ command: process.execPath, args: ["-e", ""] }],
	};
}

/**
 * A real engine change run, executed against a real repository, with its
 * stores where the extension commands look for them.
 */
async function executedRun() {
	const parent = await mkdtemp(join(tmpdir(), "pi-orchestrator-inspection-"));
	directories.push(parent);
	const root = join(parent, "repository");
	await execute("git", ["init", "-b", "main", root]);
	await execute("git", ["config", "user.name", "Test"], { cwd: root });
	await execute("git", ["config", "user.email", "test@example.com"], {
		cwd: root,
	});
	await writeFile(join(root, "README.md"), "base\n");
	await execute("git", ["add", "README.md"], { cwd: root });
	await execute("git", ["commit", "-m", "Initial"], { cwd: root });

	const git = new GitCli();
	const repository = await git.inspect(root);
	const directory = join(repository.commonDirectory, STORAGE_DIRECTORY_NAME);
	const store = new RunStore(join(directory, "runs"));
	const workflowStates = new FileWorkflowStateStore(
		join(directory, WORKFLOW_RUNS_DIRECTORY_NAME),
	);
	const created = await store.create(
		createOrchestrationRun({
			id: "inspect-engine-run",
			repositoryRoot: repository.root,
			baseBranch: repository.currentBranch,
			baseCommit: repository.head,
			integrationBranch: "conductor/inspect-engine-run/integration",
			request: { sourcePath: join(root, "request.md"), text: "Build it" },
			plan: plan(),
			maxConcurrentWorkers: 2,
			now: "2026-01-01T00:00:00.000Z",
		}),
	);
	const runner = new EngineChangeRunner({
		store,
		workflowStates,
		artifacts: new ArtifactStore(join(directory, "artifacts")),
		// The reviews raise one finding the policy requires repaired, so the run
		// has a repair with a commit and evidence to inspect.
		workers: new ChangeRunWorkers({
			path: "src/review-fix.txt",
			severity: "high",
		}),
		git,
		worktrees: new GitWorktreeManager(git, join(parent, "worktrees")),
		validator: new LocalTaskValidator(git),
		finalValidator: new LocalFinalValidator(git),
		securityPolicy: readSecurityPolicy({}),
	});
	const completed = await (await runner.approveAndLaunch(created, repository))
		.completion;
	expect(completed.state).toBe("completed");
	return { root, store, workflowStates, runId: created.id, view: completed };
}

function commandContext(root: string) {
	const widgets = new Map<string, string[]>();
	const notifications: string[] = [];
	const commands = new Map<string, CommandHandler>();
	extension({
		registerCommand(name: string, options: { handler: CommandHandler }) {
			commands.set(name, options.handler);
		},
	} as unknown as ExtensionAPI);
	const ctx = {
		cwd: root,
		hasUI: false,
		mode: "print",
		ui: {
			setWidget(key: string, lines: string[] | undefined) {
				if (lines) {
					widgets.set(key, lines);
				}
			},
			notify(message: string) {
				notifications.push(message);
			},
			setStatus() {},
		},
	} as unknown as ExtensionCommandContext;
	return {
		commands,
		ctx,
		notifications,
		widget: (key: string) => widgets.get(key)?.join("\n") ?? "",
	};
}

describe("inspecting an engine-backed run through the command surface", () => {
	it("shows the engine's own steps, rounds, findings, and attempts", async () => {
		const executed = await executedRun();
		const { commands, ctx, widget } = commandContext(executed.root);

		await commands.get("orchestrate-list")?.("", ctx);
		expect(widget("pi-orchestrator:runs")).toContain(
			`${executed.runId} | completed`,
		);

		await commands.get("orchestrate-show")?.(executed.runId, ctx);
		const overview = widget(`pi-orchestrator:${executed.runId}`);
		expect(overview).toContain("Execution record: engine");
		expect(overview).toContain("implementation [succeeded]");
		expect(overview).toContain("Review round 3: 5/5 reports received");
		expect(overview).toContain("Latest review round: succeeded");
		expect(overview).toContain("Final validation: succeeded");
		expect(overview).toContain("Merge-ready evidence: generated");
		// Reviews and repairs are steps, not a second lifecycle beside them.
		expect(overview).toContain(
			"Attempts: 1 change, 2 repair, 15 review, 1 final validation",
		);

		// A review step is inspectable by its engine step id.
		await commands.get("orchestrate-show")?.(
			`${executed.runId} step review-1-security`,
			ctx,
		);
		const review = widget(`pi-orchestrator:${executed.runId}`);
		expect(review).toContain("Step review-1-security (review)");
		expect(review).toContain("State: succeeded");

		// The repair attempt carries the finding it applied and the commit it
		// produced, read straight from the engine record.
		const repair = executed.view.attempts.find(
			(attempt) => attempt.unitId === "repair-1",
		);
		await commands.get("orchestrate-show")?.(
			`${executed.runId} attempt ${repair?.id}`,
			ctx,
		);
		const attempt = widget(`pi-orchestrator:${executed.runId}`);
		expect(attempt).toContain("Repair: round 1");
		expect(attempt).toContain("Worker authority: repair");
		expect(attempt).toContain("Evidence: passed");
	}, 120_000);

	it("follows the captured output of an engine attempt", async () => {
		const executed = await executedRun();
		const { commands, ctx, notifications, widget } = commandContext(
			executed.root,
		);

		await commands.get("orchestrate-follow")?.(executed.runId, ctx);

		expect(notifications.join("\n")).toContain("output");
		expect(widget(`pi-orchestrator:${executed.runId}:output`)).toContain(
			"Worker output:",
		);
	}, 120_000);

	it("refuses to follow an attempt that never ran a worker", async () => {
		const executed = await executedRun();
		const { commands, ctx, notifications } = commandContext(executed.root);
		const workerless = executed.view.attempts.find(
			(attempt) => attempt.workerId === undefined,
		);
		expect(workerless).toBeDefined();

		await commands.get("orchestrate-follow")?.(
			`${executed.runId} ${workerless?.id}`,
			ctx,
		);

		expect(notifications.join("\n")).toContain("no worker output stream");
	}, 120_000);

	it("reports a step id that the run does not have", async () => {
		const executed = await executedRun();
		const { commands, ctx, notifications } = commandContext(executed.root);

		await commands.get("orchestrate-show")?.(
			`${executed.runId} step missing-step`,
			ctx,
		);

		expect(notifications.join("\n")).toContain("Unknown step ID: missing-step");
	}, 120_000);

	it("does not cancel a workflow snapshot that is already failed", async () => {
		const executed = await executedRun();
		await executed.store.transaction(executed.runId, (stored) => ({
			...stored,
			state: "running",
		}));
		await executed.workflowStates.transaction(executed.runId, (state) => {
			const stepId = "review-1-security";
			const record = state.steps[stepId];
			if (!record) {
				throw new Error(`Missing test fixture step: ${stepId}`);
			}
			return {
				...state,
				state: "failed",
				error: "The reviewer failed after the last store update",
				steps: {
					...state.steps,
					[stepId]: {
						...record,
						state: "failed",
						error: "The reviewer failed after the last store update",
					},
				},
			};
		});
		const { commands, ctx, notifications, widget } = commandContext(
			executed.root,
		);

		await commands.get("orchestrate-cancel")?.(executed.runId, ctx);

		expect(notifications).toContain(
			`Run ${executed.runId} was already failed; no lifecycle work was changed`,
		);
		expect(widget(`pi-orchestrator:${executed.runId}`)).toContain(
			"State: failed",
		);
		expect((await executed.workflowStates.load(executed.runId)).state).toBe(
			"failed",
		);
	}, 120_000);
});
