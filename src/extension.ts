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
import { retryableRunWork } from "./domain/run-control.js";
import {
	type BuildRun,
	MAX_CONCURRENT_WORKERS,
	MIN_CONCURRENT_WORKERS,
	type TaskPlan,
} from "./domain/types.js";
import { GitCli, type RepositoryInfo } from "./git/git.js";
import { GitWorktreeManager } from "./git/worktrees.js";
import {
	latestWorkerAttempt,
	renderAttemptDetails,
	renderRunList,
	renderRunOverview,
	renderTaskDetails,
	resolveRunAttempt,
} from "./inspection/run-presentation.js";
import { generatePlanWithPi } from "./planning/pi-plan-generator.js";
import {
	type PlanEditorSnapshot,
	reviewPlanInteractively,
} from "./planning/plan-editor.js";
import { renderApprovalSummary } from "./planning/plan-presentation.js";
import {
	type AttemptLogEntry,
	AttemptLogStore,
} from "./storage/attempt-log-store.js";
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

function createStore(repository: RepositoryInfo): RunStore {
	return new RunStore(
		join(repository.commonDirectory, "pi-build-conductor", "runs"),
	);
}

function createRuntime(git: GitCli, repository: RepositoryInfo) {
	const store = createStore(repository);
	const attemptLogs = new AttemptLogStore(join(store.directory, "output"));
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
		attemptLogs,
		...(workerTimeoutMs === undefined ? {} : { workerTimeoutMs }),
	});
	return { attemptLogs, conductor, store, workers };
}

function assertRunRepository(run: BuildRun, repository: RepositoryInfo): void {
	if (run.repositoryRoot !== repository.root) {
		throw new Error(`Run ${run.id} belongs to a different repository`);
	}
}

function assertRunBase(run: BuildRun, repository: RepositoryInfo): void {
	assertRunRepository(run, repository);
	if (
		!repository.isClean ||
		repository.currentBranch !== run.baseBranch ||
		repository.head !== run.baseCommit
	) {
		throw new Error(
			`Run ${run.id} must be resumed from clean ${run.baseBranch} at ${run.baseCommit}`,
		);
	}
}

function characterWidth(character: string): number {
	const codePoint = character.codePointAt(0) ?? 0;
	return codePoint <= 0x7f ? 1 : 2;
}

function truncateTerminalLine(value: string, width: number): string {
	let output = "";
	let used = 0;
	for (const character of value) {
		const next = characterWidth(character);
		if (used + next > width) {
			return width > 1 ? `${output.slice(0, -1)}…` : "";
		}
		output += character;
		used += next;
	}
	return output;
}

function wrapTerminalLine(value: string, width: number): string[] {
	if (!value) {
		return [""];
	}
	const lines: string[] = [];
	let current = "";
	let used = 0;
	for (const character of value) {
		const next = characterWidth(character);
		if (current && used + next > width) {
			lines.push(current);
			current = "";
			used = 0;
		}
		if (next <= width) {
			current += character;
			used += next;
		}
	}
	lines.push(current);
	return lines;
}

function attemptLogText(entries: readonly AttemptLogEntry[]): string {
	let output = "";
	const line = (text: string) => {
		if (output && !output.endsWith("\n")) {
			output += "\n";
		}
		output += `${text}\n`;
	};
	for (const entry of entries) {
		if (entry.kind === "truncated") {
			line(`[truncated] ${entry.message}`);
			continue;
		}
		if (entry.kind === "terminal") {
			line(
				`[${entry.timestamp}] worker ${entry.status}${entry.message ? `: ${entry.message}` : ""}`,
			);
			continue;
		}
		switch (entry.event.type) {
			case "agent_started":
				line(`[${entry.timestamp}] agent started`);
				break;
			case "text_delta":
				output += entry.event.text;
				break;
			case "tool_started":
				line(`[${entry.timestamp}] tool started: ${entry.event.toolName}`);
				break;
			case "tool_finished":
				line(
					`[${entry.timestamp}] tool ${entry.event.isError ? "failed" : "finished"}: ${entry.event.toolName}`,
				);
				break;
			case "retrying":
				line(`[${entry.timestamp}] retrying: ${entry.event.message}`);
				break;
		}
	}
	return output.trimEnd();
}

async function followAttemptOutput(
	ctx: ExtensionCommandContext,
	store: RunStore,
	logs: AttemptLogStore,
	runId: string,
	attemptId: string,
): Promise<void> {
	const initial = await store.load(runId);
	const resolution = resolveRunAttempt(initial, attemptId);
	if (resolution.kind === "final-validation" || !resolution.attempt.workerId) {
		throw new Error(`Attempt ${attemptId} has no worker output stream`);
	}

	if (ctx.mode !== "tui") {
		const entries = await logs.readTail(runId, attemptId);
		const captured = attemptLogText(entries);
		ctx.ui.setWidget(`${runUiKey(runId)}:output`, [
			`Worker output: ${attemptId}`,
			...(captured ? captured.split("\n").slice(-40) : ["No captured output."]),
		]);
		ctx.ui.notify(
			entries.length > 0
				? `Showing captured output for ${attemptId}`
				: `No captured output is available for ${attemptId}`,
			"info",
		);
		return;
	}

	let interval: ReturnType<typeof setInterval> | undefined;
	try {
		await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
			let output = "Loading captured output...";
			let state = resolution.attempt.state;
			let refreshing = false;
			const refresh = async () => {
				if (refreshing) {
					return;
				}
				refreshing = true;
				try {
					const [entries, fresh] = await Promise.all([
						logs.readTail(runId, attemptId),
						store.load(runId),
					]);
					output = attemptLogText(entries) || "No captured output yet.";
					state = resolveRunAttempt(fresh, attemptId).attempt.state;
					tui.requestRender();
				} catch (error) {
					output = errorMessage(error);
					tui.requestRender();
				} finally {
					refreshing = false;
				}
			};
			interval = setInterval(() => void refresh(), 500);
			interval.unref();
			void refresh();
			return {
				render: (width: number) => {
					const contentWidth = Math.max(1, width);
					const body = output
						.split("\n")
						.flatMap((value) => wrapTerminalLine(value, contentWidth))
						.slice(-40)
						.map((value) => truncateTerminalLine(value, contentWidth));
					return [
						truncateTerminalLine(
							`Worker ${attemptId} (${state}) - Esc, Enter, or q to close`,
							contentWidth,
						),
						...body,
					];
				},
				handleInput: (data: string) => {
					if (
						data === "\u001b" ||
						data === "\r" ||
						data === "\n" ||
						data === "q"
					) {
						done(undefined);
					}
				},
				invalidate: () => {},
			};
		});
	} finally {
		if (interval) {
			clearInterval(interval);
		}
	}
}

async function inspectRunInteractively(
	ctx: ExtensionCommandContext,
	store: RunStore,
	logs: AttemptLogStore,
	runId: string,
): Promise<void> {
	for (;;) {
		const run = await store.load(runId);
		ctx.ui.setWidget(runUiKey(run.id), renderRunOverview(run));
		if (!ctx.hasUI) {
			return;
		}
		const latest = latestWorkerAttempt(run);
		const choice = await ctx.ui.select(`Build ${run.id}`, [
			"Inspect task",
			"Inspect attempt",
			...(latest ? ["Follow latest worker output"] : []),
			...(run.state === "failed" ? ["Prepare retry command"] : []),
			...([
				"running",
				"integrating",
				"reviewing",
				"repairing",
				"reviewed",
				"validating",
			].includes(run.state)
				? ["Prepare cancel command"]
				: []),
			...([
				"planning",
				"awaiting_approval",
				"running",
				"integrating",
				"reviewing",
				"repairing",
				"reviewed",
				"validating",
			].includes(run.state)
				? ["Prepare resume command"]
				: []),
			...(["completed", "failed", "cancelled"].includes(run.state)
				? ["Prepare prune command"]
				: []),
			"Close",
		]);
		if (!choice || choice === "Close") {
			return;
		}
		if (choice === "Inspect task") {
			const taskId = await ctx.ui.select(
				"Task",
				run.plan.tasks.map(
					(task) => `${task.id} | ${run.tasks[task.id]?.state ?? "missing"}`,
				),
			);
			if (taskId) {
				ctx.ui.setWidget(
					runUiKey(run.id),
					renderTaskDetails(run, taskId.split(" | ")[0] ?? taskId),
				);
			}
			continue;
		}
		if (choice === "Inspect attempt") {
			const attempts = [
				...run.attempts,
				...run.reviewAttempts,
				...run.repairAttempts,
				...run.finalValidationAttempts,
			];
			if (attempts.length === 0) {
				ctx.ui.notify("This run has no attempts yet", "info");
				continue;
			}
			const attemptId = await ctx.ui.select(
				"Attempt",
				attempts.map((attempt) => `${attempt.id} | ${attempt.state}`),
			);
			if (attemptId) {
				ctx.ui.setWidget(
					runUiKey(run.id),
					renderAttemptDetails(run, attemptId.split(" | ")[0] ?? attemptId),
				);
			}
			continue;
		}
		if (choice === "Follow latest worker output" && latest) {
			await followAttemptOutput(ctx, store, logs, run.id, latest.attempt.id);
			continue;
		}
		const command =
			choice === "Prepare retry command"
				? `/build-retry ${run.id}`
				: choice === "Prepare cancel command"
					? `/build-cancel ${run.id}`
					: choice === "Prepare prune command"
						? `/build-prune ${run.id}`
						: `/build-resume ${run.id}`;
		ctx.ui.setEditorText(command);
		ctx.ui.notify(`Prepared ${command}`, "info");
		return;
	}
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
		// pi-lens-ignore: await-in-loop
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
	pi.registerCommand("build-list", {
		description: "List and inspect build runs for this repository",
		handler: async (_args, ctx) => {
			try {
				const repository = await new GitCli().inspect(ctx.cwd);
				const store = createStore(repository);
				const entries = await store.scan();
				const runs = entries.flatMap((entry) =>
					entry.kind === "run" && entry.run.repositoryRoot === repository.root
						? [entry.run]
						: [],
				);
				const unreadable = entries.flatMap((entry) =>
					entry.kind === "unreadable"
						? [`Unreadable ${entry.runId}: ${entry.error}`]
						: [],
				);
				ctx.ui.setWidget("pi-build-conductor:runs", [
					...renderRunList(runs),
					...unreadable,
				]);
				if (!ctx.hasUI || runs.length === 0) {
					ctx.ui.notify(
						runs.length === 0
							? "No build runs found"
							: `Found ${runs.length} runs`,
						"info",
					);
					return;
				}
				const sorted = [...runs].sort(
					(left, right) =>
						right.updatedAt.localeCompare(left.updatedAt) ||
						left.id.localeCompare(right.id),
				);
				const selected = await ctx.ui.select(
					"Build runs",
					sorted.map(
						(run) =>
							`${run.id} | ${run.state} | ${run.plan.title} | ${run.updatedAt}`,
					),
				);
				if (selected) {
					const runId = selected.split(" | ")[0];
					if (runId) {
						await inspectRunInteractively(
							ctx,
							store,
							new AttemptLogStore(join(store.directory, "output")),
							runId,
						);
					}
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.registerCommand("build-show", {
		description: "Show run, task, or attempt details",
		handler: async (args, ctx) => {
			const [runId, subject, subjectId, ...extra] = args.trim().split(/\s+/);
			if (!runId || extra.length > 0 || (subject && !subjectId)) {
				ctx.ui.notify(
					"Usage: /build-show <run-id> [task <task-id> | attempt <attempt-id>]",
					"error",
				);
				return;
			}
			try {
				const repository = await new GitCli().inspect(ctx.cwd);
				const store = createStore(repository);
				const run = await store.load(runId);
				assertRunRepository(run, repository);
				let lines: string[];
				if (!subject) {
					lines = renderRunOverview(run);
				} else if (subject === "task" && subjectId) {
					lines = renderTaskDetails(run, subjectId);
				} else if (subject === "attempt" && subjectId) {
					lines = renderAttemptDetails(run, subjectId);
				} else {
					throw new Error(
						"Detail selector must be 'task <task-id>' or 'attempt <attempt-id>'",
					);
				}
				ctx.ui.setWidget(runUiKey(run.id), lines);
				ctx.ui.notify(`Showing build ${run.id}`, "info");
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.registerCommand("build-follow", {
		description: "Replay and follow captured worker output",
		handler: async (args, ctx) => {
			const [runId, requestedAttemptId, ...extra] = args.trim().split(/\s+/);
			if (!runId || extra.length > 0) {
				ctx.ui.notify("Usage: /build-follow <run-id> [attempt-id]", "error");
				return;
			}
			try {
				const repository = await new GitCli().inspect(ctx.cwd);
				const store = createStore(repository);
				const run = await store.load(runId);
				assertRunRepository(run, repository);
				const attemptId =
					requestedAttemptId ?? latestWorkerAttempt(run)?.attempt.id;
				if (!attemptId) {
					throw new Error(`Run ${runId} has no worker attempts to follow`);
				}
				await followAttemptOutput(
					ctx,
					store,
					new AttemptLogStore(join(store.directory, "output")),
					runId,
					attemptId,
				);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.registerCommand("build-retry", {
		description: "Retry safe failed work while preserving attempt history",
		handler: async (args, ctx) => {
			const [runId, requestedTaskId, ...extra] = args.trim().split(/\s+/);
			if (!runId || extra.length > 0) {
				ctx.ui.notify("Usage: /build-retry <run-id> [task-id]", "error");
				return;
			}
			ctx.ui.setStatus("pi-build-conductor", "preparing retry");
			try {
				const git = new GitCli();
				const repository = await git.inspect(ctx.cwd);
				const runtime = createRuntime(git, repository);
				const run = await runtime.store.load(runId);
				assertRunBase(run, repository);
				const assessment = retryableRunWork(run);
				if (!assessment.retryable) {
					throw new Error(assessment.reason);
				}
				if (
					requestedTaskId &&
					(assessment.phase !== "tasks" ||
						!assessment.failedTaskIds.includes(requestedTaskId))
				) {
					throw new Error(
						`Task ${requestedTaskId} is not part of this run's retryable failed work`,
					);
				}
				if (ctx.hasUI) {
					const confirmed = await ctx.ui.confirm(
						`Retry build ${run.id}?`,
						assessment.phase === "tasks"
							? `New attempts will be created for failed tasks: ${assessment.failedTaskIds.join(", ")}`
							: "A new final-validation attempt will run the approved complete suite.",
					);
					if (!confirmed) {
						ctx.ui.setStatus("pi-build-conductor", undefined);
						ctx.ui.notify("Retry cancelled", "info");
						return;
					}
				}
				const result = await runtime.conductor.retryAndLaunch(
					run.id,
					repository,
					selectedWorkerModel(ctx),
					lifecycleUi(ctx),
				);
				showLaunch(ctx, result, runtime.store);
			} catch (error) {
				ctx.ui.setStatus("pi-build-conductor", "retry failed");
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.registerCommand("build-prune", {
		description: "Prune safe resources retained by a terminal build run",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (!runId || /\s/.test(runId)) {
				ctx.ui.notify("Usage: /build-prune <run-id>", "error");
				return;
			}
			try {
				const git = new GitCli();
				const repository = await git.inspect(ctx.cwd);
				const runtime = createRuntime(git, repository);
				const run = await runtime.store.load(runId);
				assertRunRepository(run, repository);
				if (!["completed", "failed", "cancelled"].includes(run.state)) {
					throw new Error(`Run ${runId} is not terminal and cannot be pruned`);
				}
				if (
					ctx.hasUI &&
					!(await ctx.ui.confirm(
						`Prune build ${runId}?`,
						"Clean terminal worktrees and expendable branches will be removed. Integration and source-evidence branches, dirty worktrees, snapshots, and output logs are retained.",
					))
				) {
					ctx.ui.notify("Prune cancelled", "info");
					return;
				}
				const report = await runtime.conductor.pruneRunResources(runId);
				ctx.ui.setWidget(`${runUiKey(runId)}:prune`, [
					`Pruned build ${runId}`,
					`Removed worktrees: ${report.removedWorktrees.length}`,
					...report.removedWorktrees.map((path) => `- ${path}`),
					`Removed branches: ${report.removedBranches.length}`,
					...report.removedBranches.map((branch) => `- ${branch}`),
					`Retained dirty worktrees: ${report.retainedDirtyWorktrees.length}`,
					...report.retainedDirtyWorktrees.map((path) => `- ${path}`),
					`Retained unexpected worktrees: ${report.retainedUnexpectedWorktrees.length}`,
					...report.retainedUnexpectedWorktrees.map((path) => `- ${path}`),
					`Retained unexpected branches: ${report.retainedUnexpectedBranches.length}`,
					...report.retainedUnexpectedBranches.map((branch) => `- ${branch}`),
				]);
				ctx.ui.notify(`Finished pruning build ${runId}`, "info");
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

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
			if (!runId || /\s/.test(runId)) {
				ctx.ui.notify("Usage: /build-cancel <run-id>", "error");
				return;
			}
			ctx.ui.setStatus("pi-build-conductor", "cancelling run");
			try {
				const git = new GitCli();
				const repository = await git.inspect(ctx.cwd);
				const { conductor, store } = createRuntime(git, repository);
				const stored = await store.load(runId);
				assertRunRepository(stored, repository);
				if (
					!["completed", "failed", "cancelled"].includes(stored.state) &&
					ctx.hasUI &&
					!(await ctx.ui.confirm(
						`Cancel build ${runId}?`,
						`The run is ${stored.state}. Active workers and validation will be stopped. State, logs, and worktrees remain inspectable.`,
					))
				) {
					ctx.ui.setStatus("pi-build-conductor", undefined);
					ctx.ui.notify("Cancellation declined", "info");
					return;
				}
				const cancelled = await conductor.cancelRun(stored);
				const key = runUiKey(runId);
				ctx.ui.setStatus("pi-build-conductor", undefined);
				ctx.ui.setStatus(key, `build ${runId}: ${cancelled.state}`);
				ctx.ui.setWidget(key, renderRunOverview(cancelled));
				ctx.ui.notify(
					cancelled.state === "cancelled"
						? `Build ${runId} cancelled and workers stopped`
						: `Build ${runId} was already ${cancelled.state}; no lifecycle work was changed`,
					"info",
				);
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
			if (!runId || /\s/.test(runId)) {
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
				assertRunRepository(stored, repository);
				if (stored.state === "failed") {
					throw new Error(
						`Run ${runId} failed; inspect it with /build-show ${runId} and retry safe failed work with /build-retry ${runId}`,
					);
				}
				if (stored.state === "cancelled") {
					throw new Error(`Cancelled run ${runId} cannot be resumed`);
				}
				if (["planning", "awaiting_approval"].includes(stored.state)) {
					assertRunBase(stored, repository);
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
				assertRunBase(recovered, freshRepository);
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
