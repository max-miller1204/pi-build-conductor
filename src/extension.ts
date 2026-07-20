import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	BuildConductor,
	type LaunchOptions,
	type LaunchResult,
	type WorkerLifecycleProgress,
	type WorkerModelSelection,
} from "./conductor.js";
import { validateTaskPlan } from "./domain/dag.js";
import type { BuildRun, TaskPlan } from "./domain/types.js";
import { GitCli, type RepositoryInfo } from "./git/git.js";
import { GitWorktreeManager } from "./git/worktrees.js";
import { generatePlanWithPi } from "./planning/pi-plan-generator.js";
import { RunStore } from "./storage/run-store.js";
import { OfficialOrchestratorBackend } from "./workers/orchestrator-backend.js";

function parsePathArgument(args: string): string {
	const trimmed = args.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

async function loadSidecarPlan(
	handoffPath: string,
): Promise<TaskPlan | undefined> {
	const sidecarPath = `${handoffPath}.plan.json`;
	try {
		return validateTaskPlan(JSON.parse(await readFile(sidecarPath, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw new Error(`Failed to load plan sidecar ${sidecarPath}`, {
			cause: error,
		});
	}
}

async function editPlan(
	ctx: ExtensionCommandContext,
	initialPlan: TaskPlan,
): Promise<TaskPlan | undefined> {
	let draft = `${JSON.stringify(initialPlan, null, 2)}\n`;
	for (;;) {
		const edited = await ctx.ui.editor("Review and edit build plan", draft);
		if (edited === undefined) {
			return undefined;
		}
		try {
			return validateTaskPlan(JSON.parse(edited));
		} catch (error) {
			ctx.ui.notify(
				error instanceof Error ? error.message : String(error),
				"error",
			);
			draft = edited;
			const retry = await ctx.ui.confirm(
				"Invalid task plan",
				"Return to the editor and fix the plan?",
			);
			if (!retry) {
				return undefined;
			}
		}
	}
}

function approvalSummary(plan: TaskPlan): string {
	return plan.tasks
		.map((task, index) => {
			const dependencies =
				task.dependencies.length > 0 ? task.dependencies.join(", ") : "none";
			return `${index + 1}. ${task.title} (${task.id})\n   dependencies: ${dependencies}`;
		})
		.join("\n");
}

function configurationDirectory(): string {
	return process.env.PI_CONFIG_DIR ?? join(homedir(), ".pi");
}

function worktreeRoot(repositoryRoot: string): string {
	const repositoryKey = createHash("sha256")
		.update(repositoryRoot)
		.digest("hex")
		.slice(0, 16);
	return join(
		configurationDirectory(),
		"build-conductor",
		"worktrees",
		repositoryKey,
	);
}

function errorMessage(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
	return `${error.message}${cause}`;
}

function selectedWorkerModel(
	ctx: ExtensionCommandContext,
): WorkerModelSelection | undefined {
	return ctx.model
		? { provider: ctx.model.provider, model: ctx.model.id }
		: undefined;
}

function configuredWorkerTimeoutMs(): number | undefined {
	const value = process.env.PI_BUILD_WORKER_TIMEOUT_MS;
	if (value === undefined) {
		return undefined;
	}
	const timeout = Number(value);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("PI_BUILD_WORKER_TIMEOUT_MS must be a positive number");
	}
	return timeout;
}

function createRuntime(git: GitCli, repository: RepositoryInfo) {
	const store = new RunStore(
		join(repository.commonDirectory, "pi-build-conductor", "runs"),
	);
	const workers = new OfficialOrchestratorBackend();
	const workerTimeoutMs = configuredWorkerTimeoutMs();
	const conductor = new BuildConductor({
		store,
		workers,
		worktrees: new GitWorktreeManager(git, worktreeRoot(repository.root)),
		...(workerTimeoutMs === undefined ? {} : { workerTimeoutMs }),
	});
	return { conductor, store, workers };
}

function runUiKey(runId: string): string {
	return `pi-build-conductor:${runId}`;
}

function progressText(progress: WorkerLifecycleProgress): string | undefined {
	switch (progress.event.type) {
		case "agent_started":
			return `${progress.taskId}: running`;
		case "text_delta":
			return undefined;
		case "tool_started":
			return `${progress.taskId}: ${progress.event.toolName}`;
		case "tool_finished":
			return progress.event.isError
				? `${progress.taskId}: ${progress.event.toolName} failed`
				: `${progress.taskId}: running`;
		case "retrying":
			return `${progress.taskId}: retrying`;
		default:
			return undefined;
	}
}

function lifecycleUi(ctx: ExtensionCommandContext): LaunchOptions {
	return {
		onProgress: (progress) => {
			const text = progressText(progress);
			if (text) {
				ctx.ui.setStatus(runUiKey(progress.runId), text);
			}
		},
	};
}

function showCompletion(
	ctx: ExtensionCommandContext,
	result: LaunchResult,
	run: BuildRun,
	store: RunStore,
): void {
	const attempt = run.attempts.find((item) => item.id === result.attempt.id);
	ctx.ui.setWidget(runUiKey(run.id), [
		`Build ${run.id}`,
		`Task: ${result.task.title}`,
		`Worker: ${result.attempt.workerId ?? "unknown"} (stopped)`,
		`Attempt: ${attempt?.state ?? "unknown"}`,
		`Run: ${run.state}`,
		`State file: ${store.directory}`,
	]);
	if (attempt?.state === "succeeded") {
		ctx.ui.setStatus(runUiKey(run.id), `${result.task.id}: complete`);
		ctx.ui.notify(`Worker completed ${result.task.id}`, "info");
		return;
	}
	if (attempt?.state === "cancelled") {
		ctx.ui.setStatus(runUiKey(run.id), `${result.task.id}: cancelled`);
		ctx.ui.notify(`Worker cancelled for ${result.task.id}`, "warning");
		return;
	}
	ctx.ui.setStatus(runUiKey(run.id), `${result.task.id}: failed`);
	ctx.ui.notify(
		attempt?.error ?? `Worker failed for ${result.task.id}`,
		"error",
	);
}

function showLaunch(
	ctx: ExtensionCommandContext,
	result: LaunchResult,
	store: RunStore,
): void {
	const key = runUiKey(result.run.id);
	ctx.ui.setStatus("pi-build-conductor", undefined);
	ctx.ui.setStatus(key, `${result.task.id}: running`);
	ctx.ui.setWidget(key, [
		`Build ${result.run.id}`,
		`Task: ${result.task.title}`,
		`Worker: ${result.attempt.workerId ?? "starting"}`,
		`Branch: ${result.attempt.branch}`,
	]);
	ctx.ui.notify(
		`Launched ${result.task.id} in ${result.attempt.worktreePath}. Run state: ${store.directory}`,
		"info",
	);
	void result.completion.then(
		(run) => showCompletion(ctx, result, run, store),
		(error: unknown) => {
			ctx.ui.setStatus(key, `${result.task.id}: failed`);
			ctx.ui.notify(errorMessage(error), "error");
		},
	);
}

export default function piBuildConductorExtension(pi: ExtensionAPI) {
	pi.registerCommand("build", {
		description: "Plan and launch an isolated build worker from a handoff file",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				throw new Error(
					"/build requires an interactive UI for explicit plan approval",
				);
			}
			const pathArgument = parsePathArgument(args);
			if (!pathArgument) {
				ctx.ui.notify("Usage: /build <handoff-file>", "error");
				return;
			}
			const handoffPath = isAbsolute(pathArgument)
				? pathArgument
				: resolve(ctx.cwd, pathArgument);
			ctx.ui.setStatus("pi-build-conductor", "planning");
			try {
				const handoffText = await readFile(handoffPath, "utf8");
				if (!handoffText.trim()) {
					throw new Error(`Handoff file is empty: ${handoffPath}`);
				}
				const git = new GitCli();
				const repository = await git.inspect(ctx.cwd);
				if (!repository.isClean) {
					throw new Error("Commit or stash all changes before starting /build");
				}
				let plan = await loadSidecarPlan(handoffPath);
				if (!plan) {
					ctx.ui.notify(
						"No plan sidecar found. Asking the selected Pi model to create a DAG.",
						"info",
					);
					plan = await generatePlanWithPi(ctx, handoffText);
				}
				const editedPlan = await editPlan(ctx, plan);
				if (!editedPlan) {
					ctx.ui.notify("Build cancelled before approval", "info");
					return;
				}
				const { conductor, store, workers } = createRuntime(git, repository);
				let run = await conductor.createRun({
					repository,
					handoffPath,
					handoffText,
					plan: editedPlan,
					maxConcurrentWorkers: 2,
				});
				const approved = await ctx.ui.confirm(
					`Approve build plan: ${editedPlan.title}`,
					`${approvalSummary(editedPlan)}\n\nThe conductor will create separate branches and launch the first ready task.`,
				);
				if (!approved) {
					run = await conductor.cancelRun(run);
					ctx.ui.notify(`Build ${run.id} cancelled`, "info");
					return;
				}
				ctx.ui.setStatus("pi-build-conductor", "checking orchestrator");
				await workers.list();
				const freshRepository = await git.inspect(ctx.cwd);
				if (
					!freshRepository.isClean ||
					freshRepository.root !== repository.root ||
					freshRepository.head !== repository.head ||
					freshRepository.currentBranch !== repository.currentBranch
				) {
					await conductor.cancelRun(run);
					throw new Error(
						"Repository changed during planning. Start /build again from a clean, unchanged branch.",
					);
				}
				ctx.ui.setStatus("pi-build-conductor", "launching worker");
				const result = await conductor.approveAndLaunch(
					run,
					freshRepository,
					selectedWorkerModel(ctx),
					lifecycleUi(ctx),
				);
				showLaunch(ctx, result, store);
			} catch (error) {
				ctx.ui.setStatus("pi-build-conductor", "failed");
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.registerCommand("build-cancel", {
		description: "Cancel a build run and stop its active workers",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (!runId) {
				ctx.ui.notify("Usage: /build-cancel <run-id>", "error");
				return;
			}
			ctx.ui.setStatus("pi-build-conductor", "cancelling run");
			try {
				const git = new GitCli();
				const repository = await git.inspect(ctx.cwd);
				const { conductor, store } = createRuntime(git, repository);
				const stored = await store.load(runId);
				if (stored.repositoryRoot !== repository.root) {
					throw new Error(`Run ${runId} belongs to a different repository`);
				}
				const cancelled = await conductor.cancelRun(stored);
				const key = runUiKey(runId);
				ctx.ui.setStatus("pi-build-conductor", undefined);
				ctx.ui.setStatus(key, `build ${runId}: cancelled`);
				ctx.ui.setWidget(key, [
					`Build ${runId}`,
					`Run: ${cancelled.state}`,
					`State file: ${store.directory}`,
				]);
				ctx.ui.notify(`Build ${runId} cancelled and workers stopped`, "info");
			} catch (error) {
				ctx.ui.setStatus("pi-build-conductor", "cancellation failed");
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.registerCommand("build-resume", {
		description: "Recover an interrupted build run and launch its next retry",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (!runId) {
				ctx.ui.notify("Usage: /build-resume <run-id>", "error");
				return;
			}
			ctx.ui.setStatus("pi-build-conductor", "recovering run");
			try {
				const git = new GitCli();
				const repository = await git.inspect(ctx.cwd);
				if (!repository.isClean) {
					throw new Error(
						"Commit or stash all changes before resuming a build",
					);
				}
				const { conductor, store } = createRuntime(git, repository);
				const stored = await store.load(runId);
				if (stored.repositoryRoot !== repository.root) {
					throw new Error(`Run ${runId} belongs to a different repository`);
				}
				if (
					!(await git.branchExists(repository.root, stored.integrationBranch))
				) {
					throw new Error(
						`Missing integration branch: ${stored.integrationBranch}`,
					);
				}
				const recovered = await conductor.recoverRun(runId);
				const freshRepository = await git.inspect(ctx.cwd);
				if (
					!freshRepository.isClean ||
					freshRepository.root !== repository.root ||
					freshRepository.head !== repository.head ||
					freshRepository.currentBranch !== repository.currentBranch
				) {
					throw new Error(
						"Repository changed during recovery. Resume again from a clean, unchanged branch.",
					);
				}
				ctx.ui.setStatus("pi-build-conductor", "launching retry");
				const result = await conductor.resumeAndLaunch(
					recovered,
					freshRepository,
					selectedWorkerModel(ctx),
					lifecycleUi(ctx),
				);
				showLaunch(ctx, result, store);
			} catch (error) {
				ctx.ui.setStatus("pi-build-conductor", "failed");
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});
}
