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
import {
	type PlanEditorSnapshot,
	reviewPlanInteractively,
} from "./planning/plan-editor.js";
import { renderApprovalSummary } from "./planning/plan-presentation.js";
import { RunStore } from "./storage/run-store.js";
import { LocalFinalValidator } from "./validation/final-validator.js";
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

function configuredFinalValidationTimeoutMs(): number | undefined {
	const value = process.env.PI_BUILD_FINAL_VALIDATION_TIMEOUT_MS;
	if (value === undefined) {
		return undefined;
	}
	const timeout = Number(value);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error(
			"PI_BUILD_FINAL_VALIDATION_TIMEOUT_MS must be a positive number",
		);
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
	const finalValidationTimeoutMs = configuredFinalValidationTimeoutMs();
	const conductor = new BuildConductor({
		store,
		workers,
		git,
		validator: new LocalTaskValidator(git, {
			...(validationTimeoutMs === undefined
				? {}
				: { commandTimeoutMs: validationTimeoutMs }),
		}),
		finalValidator: new LocalFinalValidator(git, {
			...(finalValidationTimeoutMs === undefined
				? {}
				: { commandTimeoutMs: finalValidationTimeoutMs }),
		}),
		worktrees: new GitWorktreeManager(git, worktreeRoot(repository.root)),
		...(workerTimeoutMs === undefined ? {} : { workerTimeoutMs }),
	});
	return { conductor, store, workers };
}

function editorSnapshot(run: BuildRun): PlanEditorSnapshot {
	return {
		plan: run.plan,
		maxConcurrentWorkers: run.maxConcurrentWorkers,
		planRevision: run.planRevision,
		planRevisions: run.planRevisions,
	};
}

async function reviewAndLaunchRun(
	ctx: ExtensionCommandContext,
	git: GitCli,
	repository: RepositoryInfo,
	runtime: ReturnType<typeof createRuntime>,
	initialRun: BuildRun,
): Promise<void> {
	let run = initialRun;
	for (;;) {
		const review = await reviewPlanInteractively(
			{
				select: (title, options) => ctx.ui.select(title, options),
				input: (title, placeholder) => ctx.ui.input(title, placeholder),
				editor: (title, prefilled) => ctx.ui.editor(title, prefilled),
				notify: (message, level) => ctx.ui.notify(message, level),
			},
			editorSnapshot(run),
			{
				save: async (plan, maxConcurrentWorkers, expectedPlanRevision) =>
					editorSnapshot(
						await runtime.conductor.revisePlan(
							run.id,
							plan,
							maxConcurrentWorkers,
							expectedPlanRevision,
						),
					),
				restore: async (revisionNumber, expectedPlanRevision) =>
					editorSnapshot(
						await runtime.conductor.restorePlanRevision(
							run.id,
							revisionNumber,
							expectedPlanRevision,
						),
					),
				reload: async () => editorSnapshot(await runtime.store.load(run.id)),
			},
		);
		run = await runtime.store.load(run.id);
		if (review.action === "exit") {
			ctx.ui.notify(
				`Exited plan review. Resume revision ${run.planRevision} with /build-resume ${run.id}.`,
				"info",
			);
			return;
		}
		if (review.action === "cancel") {
			const cancel = await ctx.ui.confirm(
				`Cancel build ${run.id}?`,
				"The persisted revision history will remain inspectable, but this run cannot be approved or resumed.",
			);
			if (!cancel) {
				continue;
			}
			run = await runtime.conductor.cancelRun(run);
			ctx.ui.notify(`Build ${run.id} cancelled before approval`, "info");
			return;
		}
		const approved = await ctx.ui.confirm(
			`Approve revision ${run.planRevision}: ${run.plan.title}`,
			renderApprovalSummary(run),
		);
		if (!approved) {
			ctx.ui.notify(
				"Returned to plan editing without starting side effects",
				"info",
			);
			continue;
		}
		ctx.ui.setStatus("pi-build-conductor", "checking orchestrator");
		await runtime.workers.list();
		const freshRepository = await git.inspect(ctx.cwd);
		if (
			!freshRepository.isClean ||
			freshRepository.root !== repository.root ||
			freshRepository.head !== repository.head ||
			freshRepository.currentBranch !== repository.currentBranch
		) {
			throw new Error(
				"Repository changed during plan review. The persisted run remains awaiting approval; restore the recorded clean base and resume it.",
			);
		}
		ctx.ui.setStatus("pi-build-conductor", "launching workers");
		const result = await runtime.conductor.approveAndLaunch(
			run,
			freshRepository,
			selectedWorkerModel(ctx),
			lifecycleUi(ctx),
		);
		showLaunch(ctx, result, runtime.store);
		return;
	}
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

function reviewStateSummary(run: BuildRun): string {
	if (run.reviewRounds.length === 0) {
		return "Reviews: not started";
	}
	const round = run.reviewRounds.at(-1);
	const attempts = run.reviewAttempts.filter(
		(attempt) => attempt.round === round?.number,
	);
	const succeeded = attempts.filter(
		(attempt) => attempt.state === "succeeded",
	).length;
	const findings = attempts.flatMap((attempt) => attempt.findings ?? []);
	const repairRequired = findings.filter(
		(finding) => finding.status === "repair_required",
	).length;
	const deferred = findings.filter(
		(finding) => finding.status === "deferred",
	).length;
	const unresolved = findings.filter(
		(finding) => finding.status === "unresolved",
	).length;
	return `Review round ${round?.number ?? 0}: ${succeeded}/5 reports received, ${repairRequired} repair-required, ${unresolved} unresolved, ${deferred} deferred`;
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
				reviewStateSummary(run),
				`Integration head: ${run.integrationHead.slice(0, 12)}`,
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
	const reviewLines = run.reviewAttempts.map(
		(attempt) =>
			`review ${attempt.round}/${attempt.category}: ${attempt.state}, findings ${attempt.findings?.length ?? 0}`,
	);
	const repairLines = run.repairAttempts.map(
		(attempt) =>
			`repair ${attempt.round}/${attempt.number}: ${attempt.state}${attempt.integratedCommit ? `, integrated ${attempt.integratedCommit.slice(0, 12)}` : ""}`,
	);
	const evidence = run.mergeReadyEvidence;
	const commitLines =
		evidence?.commits.map(
			(commit, index) =>
				`${index + 1}. ${commit.kind} ${commit.id}: ${commit.sourceCommit.slice(0, 12)} -> ${commit.integratedCommit.slice(0, 12)}`,
		) ?? [];
	const reviewSummaryLines =
		evidence?.finalReviews.map(
			(review) => `Final ${review.category} review: ${review.summary}`,
		) ?? [];
	const finalAttempt = run.finalValidationAttempts.at(-1);
	const finalChecks = finalAttempt?.evidence?.checks ?? [];
	const passedChecks = finalChecks.filter((check) => check.passed).length;
	const finalCheckLines = finalChecks.map(
		(check) =>
			`Final check: ${[check.command, ...check.args].join(" ")} (${check.passed ? "passed" : "failed"})`,
	);
	const riskLines =
		evidence?.remainingRisks.map(
			(risk) => `Remaining risk ${risk.id}: ${risk.title}`,
		) ?? [];
	let finalValidationWorktreeLine: string | undefined;
	if (finalAttempt) {
		const disposition =
			run.state === "completed" ? " (cleaned)" : " (retained if created)";
		finalValidationWorktreeLine = `Final validation worktree${disposition}: ${finalAttempt.worktreePath}`;
	}
	ctx.ui.setWidget(runUiKey(run.id), [
		`Build ${run.id}`,
		`Run: ${run.state}`,
		`Plan revision: ${run.approvedPlanRevision ?? run.planRevision}`,
		`Worker limit: ${run.maxConcurrentWorkers}`,
		`Tasks: ${taskStateSummary(run)}`,
		reviewStateSummary(run),
		...workerLines,
		...reviewLines,
		...repairLines,
		`Integration branch: ${run.integrationBranch}`,
		`Integration head: ${run.integrationHead}`,
		...commitLines,
		...reviewSummaryLines,
		`Final checks: ${passedChecks}/${finalChecks.length} passed`,
		...(finalValidationWorktreeLine ? [finalValidationWorktreeLine] : []),
		...finalCheckLines,
		...(riskLines.length > 0 ? riskLines : ["Remaining deferred risks: none"]),
		...(evidence
			? ["User branch stayed clean and untouched at the recorded base commit."]
			: ["User branch cleanliness was not certified as merge-ready."]),
		`State file: ${store.directory}`,
	]);
	if (run.state === "completed") {
		ctx.ui.setStatus(runUiKey(run.id), "merge-ready validation passed");
		ctx.ui.notify(
			`Build ${run.id} is merge-ready on ${run.integrationBranch} at ${run.integrationHead}`,
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
	const reviewFailure = run.reviewAttempts.find(
		(attempt) => attempt.state === "failed",
	)?.error;
	const repairFailure = run.repairAttempts.find(
		(attempt) => attempt.state === "failed",
	)?.error;
	const reviewRoundFailure = run.reviewRounds.find(
		(round) => round.state === "failed",
	)?.error;
	const finalValidationFailure = run.finalValidationAttempts.findLast(
		(attempt) => attempt.state === "failed",
	);
	ctx.ui.setStatus(runUiKey(run.id), "build failed");
	ctx.ui.notify(
		finalValidationFailure?.error ??
			integrationFailure?.integrationError ??
			repairFailure ??
			reviewFailure ??
			reviewRoundFailure ??
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
		`Plan revision: ${result.run.approvedPlanRevision ?? result.run.planRevision}`,
		`Worker limit: ${result.run.maxConcurrentWorkers}`,
		`Tasks: ${taskStateSummary(result.run)}`,
		reviewStateSummary(result.run),
		...launchLines,
		`State file: ${store.directory}`,
	]);
	ctx.ui.notify(
		result.launches.length > 0
			? `Launched ${result.launches.length} implementation worker(s) for build ${result.run.id}`
			: `Resuming ${result.run.state} lifecycle for build ${result.run.id}`,
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
				const planSource = plan ? "sidecar" : "generated";
				if (!plan) {
					ctx.ui.notify(
						"No plan sidecar found. Asking the selected Pi model to create a DAG.",
						"info",
					);
					plan = await generatePlanWithPi(ctx, handoffText);
				}
				const runtime = createRuntime(git, repository);
				const run = await runtime.conductor.createRun({
					repository,
					handoffPath,
					handoffText,
					plan,
					planSource,
					maxConcurrentWorkers: configuredMaxConcurrentWorkers(),
				});
				ctx.ui.notify(
					`Persisted build ${run.id} at plan revision 1. Resume interrupted review with /build-resume ${run.id}.`,
					"info",
				);
				await reviewAndLaunchRun(ctx, git, repository, runtime, run);
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
				const runtime = createRuntime(git, repository);
				const { conductor, store } = runtime;
				const stored = await store.load(runId);
				if (stored.repositoryRoot !== repository.root) {
					throw new Error(`Run ${runId} belongs to a different repository`);
				}
				if (["planning", "awaiting_approval"].includes(stored.state)) {
					if (!ctx.hasUI) {
						throw new Error(
							`Run ${runId} still requires interactive plan approval`,
						);
					}
					await reviewAndLaunchRun(ctx, git, repository, runtime, stored);
					return;
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
				if (recovered.state === "completed") {
					ctx.ui.setStatus(runUiKey(runId), "merge-ready validation passed");
					ctx.ui.setStatus("pi-build-conductor", undefined);
					ctx.ui.notify(
						`Build ${runId} is already merge-ready at ${recovered.integrationHead}`,
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
