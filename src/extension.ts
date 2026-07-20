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
import {
	type BuildRun,
	MAX_CONCURRENT_WORKERS,
	MIN_CONCURRENT_WORKERS,
	type TaskPlan,
} from "./domain/types.js";
import { GitCli, type RepositoryInfo } from "./git/git.js";
import { GitWorktreeManager } from "./git/worktrees.js";
import { generatePlanWithPi } from "./planning/pi-plan-generator.js";
import { RunStore } from "./storage/run-store.js";
import { LocalTaskValidator } from "./validation/task-validator.js";
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
			const paths = task.allowedPaths.join(", ");
			const commands = task.validationCommands
				.map(({ command, args }) => [command, ...args].join(" "))
				.join("; ");
			return `${index + 1}. ${task.title} (${task.id})\n   dependencies: ${dependencies}\n   allowed paths: ${paths}\n   validation: ${commands}`;
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

function configuredValidationTimeoutMs(): number | undefined {
	const value = process.env.PI_BUILD_VALIDATION_TIMEOUT_MS;
	if (value === undefined) {
		return undefined;
	}
	const timeout = Number(value);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("PI_BUILD_VALIDATION_TIMEOUT_MS must be a positive number");
	}
	return timeout;
}

function configuredMaxConcurrentWorkers(): number {
	const value = process.env.PI_BUILD_MAX_CONCURRENT_WORKERS;
	if (value === undefined) {
		return MIN_CONCURRENT_WORKERS;
	}
	const maximum = Number(value);
	if (
		!Number.isInteger(maximum) ||
		maximum < MIN_CONCURRENT_WORKERS ||
		maximum > MAX_CONCURRENT_WORKERS
	) {
		throw new Error(
			`PI_BUILD_MAX_CONCURRENT_WORKERS must be an integer from ${MIN_CONCURRENT_WORKERS} to ${MAX_CONCURRENT_WORKERS}`,
		);
	}
	return maximum;
}

function createRuntime(git: GitCli, repository: RepositoryInfo) {
	const store = new RunStore(
		join(repository.commonDirectory, "pi-build-conductor", "runs"),
	);
	const workers = new OfficialOrchestratorBackend();
	const workerTimeoutMs = configuredWorkerTimeoutMs();
	const validationTimeoutMs = configuredValidationTimeoutMs();
	const conductor = new BuildConductor({
		store,
		workers,
		git,
		validator: new LocalTaskValidator(git, {
			...(validationTimeoutMs === undefined
				? {}
				: { commandTimeoutMs: validationTimeoutMs }),
		}),
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

function taskStateSummary(run: BuildRun): string {
	const counts = new Map<string, number>();
	for (const task of Object.values(run.tasks)) {
		counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
	}
	return [
		"running",
		"validating",
		"succeeded",
		"ready",
		"planned",
		"blocked",
		"failed",
	]
		.flatMap((state) => {
			const count = counts.get(state);
			return count ? [`${count} ${state}`] : [];
		})
		.join(", ");
}

function lifecycleUi(ctx: ExtensionCommandContext): LaunchOptions {
	return {
		onProgress: (progress) => {
			const text = progressText(progress);
			if (text) {
				ctx.ui.setStatus(runUiKey(progress.runId), text);
			}
		},
		onRunUpdated: (run) => {
			ctx.ui.setStatus(runUiKey(run.id), taskStateSummary(run));
			ctx.ui.setWidget(runUiKey(run.id), [
				`Build ${run.id}`,
				`Run: ${run.state}`,
				`Tasks: ${taskStateSummary(run)}`,
			]);
		},
	};
}

function showCompletion(
	ctx: ExtensionCommandContext,
	_result: LaunchResult,
	run: BuildRun,
	store: RunStore,
): void {
	const workerLines = run.attempts.map((attempt) => {
		const passingChecks = attempt.evidence?.checks.filter(
			(check) => check.passed,
		).length;
		const checks = attempt.evidence
			? `, checks ${passingChecks}/${attempt.evidence.checks.length}`
			: "";
		const commit = attempt.commit
			? `, commit ${attempt.commit.slice(0, 12)}`
			: "";
		const integratedCommit = run.tasks[attempt.taskId]?.integratedCommit;
		const integrated = integratedCommit
			? `, integrated ${integratedCommit.slice(0, 12)}`
			: "";
		return `${attempt.taskId}: ${attempt.state} (${attempt.workerId ?? "not spawned"}${checks}${commit}${integrated})`;
	});
	ctx.ui.setWidget(runUiKey(run.id), [
		`Build ${run.id}`,
		`Run: ${run.state}`,
		`Tasks: ${taskStateSummary(run)}`,
		...workerLines,
		`State file: ${store.directory}`,
	]);
	if (run.state === "integrating") {
		ctx.ui.setStatus(
			runUiKey(run.id),
			"task commits integrated and ready for review",
		);
		ctx.ui.notify(
			`All task changes were integrated on ${run.integrationBranch}`,
			"info",
		);
		return;
	}
	if (run.state === "cancelled") {
		ctx.ui.setStatus(runUiKey(run.id), "build cancelled");
		ctx.ui.notify(`Build ${run.id} was cancelled`, "warning");
		return;
	}
	const failure = run.attempts.find((attempt) => attempt.state === "failed");
	const integrationFailure = Object.values(run.tasks).find(
		(task) => task.integrationError,
	);
	ctx.ui.setStatus(runUiKey(run.id), "build failed");
	ctx.ui.notify(
		integrationFailure?.integrationError ??
			failure?.error ??
			`Build ${run.id} failed`,
		"error",
	);
}

function showLaunch(
	ctx: ExtensionCommandContext,
	result: LaunchResult,
	store: RunStore,
): void {
	const key = runUiKey(result.run.id);
	const launchLines = result.launches.map(
		({ task, attempt }) =>
			`${task.id}: ${attempt.workerId ?? "starting"} in ${attempt.worktreePath}`,
	);
	ctx.ui.setStatus("pi-build-conductor", undefined);
	ctx.ui.setStatus(key, taskStateSummary(result.run));
	ctx.ui.setWidget(key, [
		`Build ${result.run.id}`,
		`Run: ${result.run.state}`,
		`Tasks: ${taskStateSummary(result.run)}`,
		...launchLines,
		`State file: ${store.directory}`,
	]);
	ctx.ui.notify(
		`Launched ${result.launches.length} worker(s) for build ${result.run.id}`,
		"info",
	);
	void result.completion.then(
		(run) => showCompletion(ctx, result, run, store),
		(error: unknown) => {
			ctx.ui.setStatus(key, "build failed");
			ctx.ui.notify(errorMessage(error), "error");
		},
	);
}

export default function piBuildConductorExtension(pi: ExtensionAPI) {
	pi.registerCommand("build", {
		description: "Plan and launch isolated build workers from a handoff file",
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
					maxConcurrentWorkers: configuredMaxConcurrentWorkers(),
				});
				const approved = await ctx.ui.confirm(
					`Approve build plan: ${editedPlan.title}`,
					`${approvalSummary(editedPlan)}\n\nThe conductor will create separate branches, run the exact validation commands above, and launch ready tasks up to the configured worker limit. Validation executes repository code without a sandbox.`,
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
				ctx.ui.setStatus("pi-build-conductor", "launching workers");
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
		description: "Recover an interrupted build run and launch ready retries",
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
				if (recovered.state === "integrating") {
					ctx.ui.setStatus(
						runUiKey(runId),
						"task commits integrated and ready for review",
					);
					ctx.ui.setStatus("pi-build-conductor", undefined);
					ctx.ui.notify(
						`Build ${runId} is integrated on ${recovered.integrationBranch}`,
						"info",
					);
					return;
				}
				ctx.ui.setStatus("pi-build-conductor", "launching retries");
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
