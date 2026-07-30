import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { orchestratorConfigurationValue } from "./configuration.js";
import { validateTaskPlan } from "./domain/dag.js";
import { retryableRunWork } from "./domain/run-control.js";
import {
	MAX_CONCURRENT_WORKERS,
	MIN_CONCURRENT_WORKERS,
	type OrchestrationRun,
	type TaskPlan,
} from "./domain/types.js";
import { StepWorkerRunner } from "./engine/steps/worker-runner.js";
import { GitCli, type RepositoryInfo } from "./git/git.js";
import { GitRepositoryReader } from "./git/repository-reader.js";
import { GitWorktreeManager } from "./git/worktrees.js";
import {
	latestWorkerAttempt,
	renderAttemptDetails,
	renderRunList,
	renderRunOverview,
	renderTaskDetails,
	resolveRunAttempt,
} from "./inspection/run-presentation.js";
import {
	type LaunchOptions,
	type LaunchResult,
	Orchestrator,
	type WorkerLifecycleProgress,
	type WorkerModelSelection,
} from "./orchestrator.js";
import {
	type PlanEditorSnapshot,
	reviewPlanInteractively,
} from "./planning/plan-editor.js";
import { renderApprovalSummary } from "./planning/plan-presentation.js";
import {
	renderPlanRepositoryIssues,
	validatePlanAgainstRepository,
} from "./planning/plan-repository-validation.js";
import {
	PlanningWorker,
	renderPlanningObservations,
	validatePlanningDocument,
} from "./planning/planning-worker.js";
import { discoverRepositoryProfile } from "./planning/repository-discovery.js";
import { readSecurityPolicy, securityPolicyLines } from "./security/policy.js";
import { ArtifactStore } from "./storage/artifact-store.js";
import {
	type AttemptLogEntry,
	AttemptLogStore,
} from "./storage/attempt-log-store.js";
import { RunStore } from "./storage/run-store.js";
import {
	migrateLegacyOrchestratorStorage,
	STORAGE_DIRECTORY_NAME,
} from "./storage/storage-migration.js";
import { LocalFinalValidator } from "./validation/final-validator.js";
import { LocalTaskValidator } from "./validation/task-validator.js";
import { OfficialServerBackend } from "./workers/server-backend.js";
import {
	buildInvestigateWorkflowPlan,
	INVESTIGATE_REPORT_OUTPUT,
	investigateStepHandlers,
	investigationQuestionsFromRequest,
	SYNTHESIS_STEP_ID,
} from "./workflows/investigate.js";
import {
	buildPlanOnlyWorkflowPlan,
	PLAN_ONLY_PLAN_OUTPUT,
	PLAN_ONLY_STEP_ID,
	planOnlyStepHandlers,
} from "./workflows/plan-only.js";
import {
	describeFailedSteps,
	newWorkflowRunId,
	runReadOnlyWorkflow,
} from "./workflows/runner.js";

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
	requestPath: string,
): Promise<TaskPlan | undefined> {
	const sidecarPath = `${requestPath}.plan.json`;
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

function worktreeRoots(repositoryRoot: string): {
	root: string;
	legacyRoot: string;
} {
	const repositoryKey = createHash("sha256")
		.update(repositoryRoot)
		.digest("hex")
		.slice(0, 16);
	return {
		root: join(
			configurationDirectory(),
			"orchestrator",
			"worktrees",
			repositoryKey,
		),
		// Existing Git worktrees cannot be renamed without breaking their
		// metadata, so runs started before the storage migration keep their
		// original location for recovery and cleanup.
		legacyRoot: join(
			configurationDirectory(),
			"build-conductor",
			"worktrees",
			repositoryKey,
		),
	};
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

function configuredTimeoutMs(suffix: string): number | undefined {
	const resolved = orchestratorConfigurationValue(suffix);
	if (resolved === undefined) {
		return undefined;
	}
	const timeout = Number(resolved.value);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error(`${resolved.name} must be a positive number`);
	}
	return timeout;
}

function configuredWorkerTimeoutMs(): number | undefined {
	return configuredTimeoutMs("WORKER_TIMEOUT_MS");
}

function configuredValidationTimeoutMs(): number | undefined {
	return configuredTimeoutMs("VALIDATION_TIMEOUT_MS");
}

function configuredFinalValidationTimeoutMs(): number | undefined {
	return configuredTimeoutMs("FINAL_VALIDATION_TIMEOUT_MS");
}

function configuredMaxConcurrentWorkers(): number {
	const resolved = orchestratorConfigurationValue("MAX_CONCURRENT_WORKERS");
	if (resolved === undefined) {
		return MIN_CONCURRENT_WORKERS;
	}
	const maximum = Number(resolved.value);
	if (
		!Number.isInteger(maximum) ||
		maximum < MIN_CONCURRENT_WORKERS ||
		maximum > MAX_CONCURRENT_WORKERS
	) {
		throw new Error(
			`${resolved.name} must be an integer from ${MIN_CONCURRENT_WORKERS} to ${MAX_CONCURRENT_WORKERS}`,
		);
	}
	return maximum;
}

async function createStore(repository: RepositoryInfo): Promise<RunStore> {
	await migrateLegacyOrchestratorStorage(repository.commonDirectory);
	return new RunStore(
		join(repository.commonDirectory, STORAGE_DIRECTORY_NAME, "runs"),
	);
}

async function createRuntime(git: GitCli, repository: RepositoryInfo) {
	const store = await createStore(repository);
	const attemptLogs = new AttemptLogStore(join(store.directory, "output"));
	const workers = new OfficialServerBackend();
	const workerTimeoutMs = configuredWorkerTimeoutMs();
	const securityPolicy = readSecurityPolicy();
	const validationTimeoutMs = configuredValidationTimeoutMs();
	const finalValidationTimeoutMs = configuredFinalValidationTimeoutMs();
	const orchestrator = new Orchestrator({
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
		worktrees: new GitWorktreeManager(
			git,
			worktreeRoots(repository.root).root,
			worktreeRoots(repository.root).legacyRoot,
		),
		attemptLogs,
		securityPolicy,
		...(workerTimeoutMs === undefined ? {} : { workerTimeoutMs }),
	});
	return { attemptLogs, orchestrator, securityPolicy, store, workers };
}

async function readRequestFile(
	cwd: string,
	pathArgument: string,
): Promise<string> {
	const requestPath = isAbsolute(pathArgument)
		? pathArgument
		: resolve(cwd, pathArgument);
	const requestText = await readFile(requestPath, "utf8");
	if (!requestText.trim()) {
		throw new Error(`Request file is empty: ${requestPath}`);
	}
	return requestText;
}

/** The dependencies an engine-backed read-only workflow command needs. */
async function readOnlyWorkflowRuntime(
	git: GitCli,
	repository: RepositoryInfo,
) {
	await migrateLegacyOrchestratorStorage(repository.commonDirectory);
	const roots = worktreeRoots(repository.root);
	return {
		git,
		workers: new OfficialServerBackend(),
		securityPolicy: readSecurityPolicy(),
		worktrees: new GitWorktreeManager(git, roots.root, roots.legacyRoot),
		artifacts: new ArtifactStore(
			join(repository.commonDirectory, STORAGE_DIRECTORY_NAME, "artifacts"),
		),
	};
}

function assertRunRepository(
	run: OrchestrationRun,
	repository: RepositoryInfo,
): void {
	if (run.repositoryRoot !== repository.root) {
		throw new Error(`Run ${run.id} belongs to a different repository`);
	}
}

function assertRunBase(
	run: OrchestrationRun,
	repository: RepositoryInfo,
): void {
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
			case "ui_blocked":
				line(
					`[${entry.timestamp}] worker blocked on ${entry.event.method} request ${entry.event.requestId}`,
				);
				break;
			case "ui_decision":
				line(
					`[${entry.timestamp}] worker UI policy ${entry.event.policy}: ${entry.event.outcome} ${entry.event.method} request ${entry.event.requestId}`,
				);
				break;
			case "ui_resolved":
				line(
					`[${entry.timestamp}] worker UI request ${entry.event.requestId} resolved: ${entry.event.outcome}`,
				);
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
		const choice = await ctx.ui.select(`Run ${run.id}`, [
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
				? `/orchestrate-retry ${run.id}`
				: choice === "Prepare cancel command"
					? `/orchestrate-cancel ${run.id}`
					: choice === "Prepare prune command"
						? `/orchestrate-prune ${run.id}`
						: `/orchestrate-resume ${run.id}`;
		ctx.ui.setEditorText(command);
		ctx.ui.notify(`Prepared ${command}`, "info");
		return;
	}
}

function editorSnapshot(run: OrchestrationRun): PlanEditorSnapshot {
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
	runtime: Awaited<ReturnType<typeof createRuntime>>,
	initialRun: OrchestrationRun,
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
						await runtime.orchestrator.revisePlan(
							run.id,
							plan,
							maxConcurrentWorkers,
							expectedPlanRevision,
						),
					),
				restore: async (revisionNumber, expectedPlanRevision) =>
					editorSnapshot(
						await runtime.orchestrator.restorePlanRevision(
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
				`Exited plan review. Resume revision ${run.planRevision} with /orchestrate-resume ${run.id}.`,
				"info",
			);
			return;
		}
		if (review.action === "cancel") {
			const cancel = await ctx.ui.confirm(
				`Cancel run ${run.id}?`,
				"The persisted revision history will remain inspectable, but this run cannot be approved or resumed.",
			);
			if (!cancel) {
				continue;
			}
			run = await runtime.orchestrator.cancelRun(run);
			ctx.ui.notify(`Run ${run.id} cancelled before approval`, "info");
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
		ctx.ui.setStatus("pi-orchestrator", "checking server");
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
		ctx.ui.setStatus("pi-orchestrator", "launching workers");
		const result = await runtime.orchestrator.approveAndLaunch(
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
	return `pi-orchestrator:${runId}`;
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
		case "ui_blocked":
			return `${progress.taskId}: waiting on ${progress.event.method}`;
		case "ui_decision":
			return `${progress.taskId}: ${progress.event.outcome} ${progress.event.method}`;
		case "ui_resolved":
			return `${progress.taskId}: running`;
		default:
			return undefined;
	}
}

function taskStateSummary(run: OrchestrationRun): string {
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

function workerBlockSummary(run: OrchestrationRun): string {
	if (run.blockedWorkers.length === 0) {
		return "Worker prompts: none";
	}
	return `Worker prompts: ${run.blockedWorkers
		.map((blocked) => `${blocked.attemptId} waiting on ${blocked.method}`)
		.join(", ")}`;
}

function reviewStateSummary(run: OrchestrationRun): string {
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
			ctx.ui.setStatus(
				runUiKey(run.id),
				run.blockedWorkers.length > 0
					? `${run.blockedWorkers.length} worker prompt(s) blocked`
					: taskStateSummary(run),
			);
			ctx.ui.setWidget(runUiKey(run.id), [
				`Run ${run.id}`,
				`Run: ${run.state}`,
				`Tasks: ${taskStateSummary(run)}`,
				workerBlockSummary(run),
				reviewStateSummary(run),
				`Integration head: ${run.integrationHead.slice(0, 12)}`,
			]);
		},
	};
}

function showCompletion(
	ctx: ExtensionCommandContext,
	_result: LaunchResult,
	run: OrchestrationRun,
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
		`Run ${run.id}`,
		`Run: ${run.state}`,
		`Plan revision: ${run.approvedPlanRevision ?? run.planRevision}`,
		`Worker limit: ${run.maxConcurrentWorkers}`,
		...securityPolicyLines(run.securityPolicy),
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
		"Security limitation: merge-ready evidence does not prove that workers or repository code caused no host, credential, network, or external side effects.",
		`State file: ${store.directory}`,
	]);
	if (run.state === "completed") {
		ctx.ui.setStatus(runUiKey(run.id), "merge-ready validation passed");
		ctx.ui.notify(
			`Run ${run.id} is merge-ready on ${run.integrationBranch} at ${run.integrationHead}`,
			"info",
		);
		return;
	}
	if (run.state === "cancelled") {
		ctx.ui.setStatus(runUiKey(run.id), "run cancelled");
		ctx.ui.notify(`Run ${run.id} was cancelled`, "warning");
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
	ctx.ui.setStatus(runUiKey(run.id), "run failed");
	ctx.ui.notify(
		finalValidationFailure?.error ??
			integrationFailure?.integrationError ??
			repairFailure ??
			reviewFailure ??
			reviewRoundFailure ??
			failure?.error ??
			`Run ${run.id} failed`,
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
	ctx.ui.setStatus("pi-orchestrator", undefined);
	ctx.ui.setStatus(key, taskStateSummary(result.run));
	ctx.ui.setWidget(key, [
		`Run ${result.run.id}`,
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
			? `Launched ${result.launches.length} implementation worker(s) for run ${result.run.id}`
			: `Resuming ${result.run.state} lifecycle for run ${result.run.id}`,
		"info",
	);
	void result.completion.then(
		(run) => showCompletion(ctx, result, run, store),
		(error: unknown) => {
			ctx.ui.setStatus(key, "run failed");
			ctx.ui.notify(errorMessage(error), "error");
		},
	);
}

export default function piOrchestratorExtension(pi: ExtensionAPI) {
	const registerWithLegacyAlias = (
		name: string,
		legacyName: string,
		options: Parameters<ExtensionAPI["registerCommand"]>[1] & {
			description: string;
		},
	): void => {
		pi.registerCommand(name, options);
		pi.registerCommand(legacyName, {
			...options,
			description: `${options.description} (temporary alias of /${name})`,
		});
	};
	registerWithLegacyAlias("orchestrate-list", "build-list", {
		description: "List and inspect orchestration runs for this repository",
		handler: async (_args, ctx) => {
			try {
				const repository = await new GitCli().inspect(ctx.cwd);
				const store = await createStore(repository);
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
				ctx.ui.setWidget("pi-orchestrator:runs", [
					...renderRunList(runs),
					...unreadable,
				]);
				if (!ctx.hasUI || runs.length === 0) {
					ctx.ui.notify(
						runs.length === 0
							? "No orchestration runs found"
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
					"Orchestration runs",
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

	registerWithLegacyAlias("orchestrate-show", "build-show", {
		description: "Show run, task, or attempt details",
		handler: async (args, ctx) => {
			const [runId, subject, subjectId, ...extra] = args.trim().split(/\s+/);
			if (!runId || extra.length > 0 || (subject && !subjectId)) {
				ctx.ui.notify(
					"Usage: /orchestrate-show <run-id> [task <task-id> | attempt <attempt-id>]",
					"error",
				);
				return;
			}
			try {
				const repository = await new GitCli().inspect(ctx.cwd);
				const store = await createStore(repository);
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
				ctx.ui.notify(`Showing run ${run.id}`, "info");
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	registerWithLegacyAlias("orchestrate-follow", "build-follow", {
		description: "Replay and follow captured worker output",
		handler: async (args, ctx) => {
			const [runId, requestedAttemptId, ...extra] = args.trim().split(/\s+/);
			if (!runId || extra.length > 0) {
				ctx.ui.notify(
					"Usage: /orchestrate-follow <run-id> [attempt-id]",
					"error",
				);
				return;
			}
			try {
				const repository = await new GitCli().inspect(ctx.cwd);
				const store = await createStore(repository);
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

	registerWithLegacyAlias("orchestrate-retry", "build-retry", {
		description: "Retry safe failed work while preserving attempt history",
		handler: async (args, ctx) => {
			const [runId, requestedTaskId, ...extra] = args.trim().split(/\s+/);
			if (!runId || extra.length > 0) {
				ctx.ui.notify("Usage: /orchestrate-retry <run-id> [task-id]", "error");
				return;
			}
			ctx.ui.setStatus("pi-orchestrator", "preparing retry");
			try {
				const git = new GitCli();
				const repository = await git.inspect(ctx.cwd);
				const runtime = await createRuntime(git, repository);
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
						`Retry run ${run.id}?`,
						assessment.phase === "tasks"
							? `New attempts will be created for failed tasks: ${assessment.failedTaskIds.join(", ")}`
							: "A new final-validation attempt will run the approved complete suite.",
					);
					if (!confirmed) {
						ctx.ui.setStatus("pi-orchestrator", undefined);
						ctx.ui.notify("Retry cancelled", "info");
						return;
					}
				}
				const result = await runtime.orchestrator.retryAndLaunch(
					run.id,
					repository,
					selectedWorkerModel(ctx),
					lifecycleUi(ctx),
				);
				showLaunch(ctx, result, runtime.store);
			} catch (error) {
				ctx.ui.setStatus("pi-orchestrator", "retry failed");
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	registerWithLegacyAlias("orchestrate-prune", "build-prune", {
		description:
			"Prune safe resources retained by a terminal orchestration run",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (!runId || /\s/.test(runId)) {
				ctx.ui.notify("Usage: /orchestrate-prune <run-id>", "error");
				return;
			}
			try {
				const git = new GitCli();
				const repository = await git.inspect(ctx.cwd);
				const runtime = await createRuntime(git, repository);
				const run = await runtime.store.load(runId);
				assertRunRepository(run, repository);
				if (!["completed", "failed", "cancelled"].includes(run.state)) {
					throw new Error(`Run ${runId} is not terminal and cannot be pruned`);
				}
				if (
					ctx.hasUI &&
					!(await ctx.ui.confirm(
						`Prune run ${runId}?`,
						"Clean terminal worktrees and expendable branches will be removed. Integration and source-evidence branches, dirty worktrees, snapshots, and output logs are retained.",
					))
				) {
					ctx.ui.notify("Prune cancelled", "info");
					return;
				}
				const report = await runtime.orchestrator.pruneRunResources(runId);
				ctx.ui.setWidget(`${runUiKey(runId)}:prune`, [
					`Pruned run ${runId}`,
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
				ctx.ui.notify(`Finished pruning run ${runId}`, "info");
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	registerWithLegacyAlias("orchestrate", "build", {
		description: "Plan and launch isolated workers from a request file",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				throw new Error(
					"/orchestrate requires an interactive UI for explicit plan approval",
				);
			}
			const pathArgument = parsePathArgument(args);
			if (!pathArgument) {
				ctx.ui.notify("Usage: /orchestrate <request-file>", "error");
				return;
			}
			const requestPath = isAbsolute(pathArgument)
				? pathArgument
				: resolve(ctx.cwd, pathArgument);
			ctx.ui.setStatus("pi-orchestrator", "planning");
			try {
				const requestText = await readFile(requestPath, "utf8");
				if (!requestText.trim()) {
					throw new Error(`Request file is empty: ${requestPath}`);
				}
				const git = new GitCli();
				const repository = await git.inspect(ctx.cwd);
				if (!repository.isClean) {
					throw new Error(
						"Commit or stash all changes before starting /orchestrate",
					);
				}
				let plan = await loadSidecarPlan(requestPath);
				const planSource = plan ? "sidecar" : "generated";
				const runtime = await createRuntime(git, repository);
				const reader = new GitRepositoryReader(repository.root);
				const listing = await reader.listFiles(repository.head);
				const profile = await discoverRepositoryProfile(
					reader,
					repository.head,
					{ listing },
				);
				let planningEvidence: string[] = [];
				if (!plan) {
					ctx.ui.notify(
						"No plan sidecar found. Launching the read-only planning worker to inspect the repository.",
						"info",
					);
					const model = selectedWorkerModel(ctx);
					const planner = new PlanningWorker({
						workers: runtime.workers,
						securityPolicy: runtime.securityPolicy,
						...(model ? { provider: model.provider, model: model.model } : {}),
					});
					const document = await planner.plan({
						repositoryRoot: repository.root,
						requestText,
						profile,
						repositoryPaths: listing.files.map((file) => file.path),
					});
					plan = document.plan;
					planningEvidence = renderPlanningObservations(document.observations);
				}
				const repositoryValidation = validatePlanAgainstRepository(plan, {
					paths: listing.files.map((file) => file.path),
					detectedCommands: profile.detectedCommands,
				});
				if (!repositoryValidation.ok) {
					const errors = repositoryValidation.issues.filter(
						(issue) => issue.severity === "error",
					);
					throw new Error(
						`The ${planSource} plan conflicts with the repository at commit ${repository.head}:\n${renderPlanRepositoryIssues(errors).join("\n")}`,
					);
				}
				const warnings = repositoryValidation.issues.filter(
					(issue) => issue.severity === "warning",
				);
				if (warnings.length > 0) {
					planningEvidence = [
						...planningEvidence,
						"Repository validation warnings:",
						...renderPlanRepositoryIssues(warnings),
					];
					ctx.ui.notify(
						`Plan accepted with ${warnings.length} repository validation ${warnings.length === 1 ? "warning" : "warnings"}`,
						"warning",
					);
				}
				const run = await runtime.orchestrator.createRun({
					repository,
					requestPath,
					requestText,
					plan,
					planSource,
					maxConcurrentWorkers: configuredMaxConcurrentWorkers(),
				});
				if (planningEvidence.length > 0) {
					ctx.ui.setWidget(
						`${runUiKey(run.id)}:planning-evidence`,
						planningEvidence,
					);
				}
				ctx.ui.notify(
					`Persisted run ${run.id} at plan revision 1. Resume interrupted review with /orchestrate-resume ${run.id}.`,
					"info",
				);
				await reviewAndLaunchRun(ctx, git, repository, runtime, run);
			} catch (error) {
				ctx.ui.setStatus("pi-orchestrator", "failed");
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	registerWithLegacyAlias("orchestrate-plan", "build-plan", {
		description:
			"Propose an evidence-backed plan from a request file without executing it",
		handler: async (args, ctx) => {
			const pathArgument = parsePathArgument(args);
			if (!pathArgument) {
				ctx.ui.notify("Usage: /orchestrate-plan <request-file>", "error");
				return;
			}
			ctx.ui.setStatus("pi-orchestrator", "plan-only workflow");
			try {
				const requestText = await readRequestFile(ctx.cwd, pathArgument);
				const git = new GitCli();
				const repository = await git.inspect(ctx.cwd);
				const workflow = await readOnlyWorkflowRuntime(git, repository);
				const model = selectedWorkerModel(ctx);
				const runId = newWorkflowRunId("plan");
				const state = await runReadOnlyWorkflow(workflow, {
					runId,
					repository,
					plan: buildPlanOnlyWorkflowPlan(requestText),
					handlers: planOnlyStepHandlers({
						worker: new PlanningWorker({
							workers: workflow.workers,
							securityPolicy: workflow.securityPolicy,
							...(model
								? { provider: model.provider, model: model.model }
								: {}),
						}),
						git,
						requestText,
					}),
				});
				ctx.ui.setStatus("pi-orchestrator", undefined);
				if (state.state !== "completed") {
					ctx.ui.setWidget(runUiKey(runId), [
						`Plan-only run ${runId}: ${state.state}`,
						...describeFailedSteps(state),
					]);
					ctx.ui.notify(`Plan-only run ${runId} ${state.state}`, "error");
					return;
				}
				const artifact = await workflow.artifacts.latest(
					runId,
					PLAN_ONLY_STEP_ID,
					PLAN_ONLY_PLAN_OUTPUT,
				);
				if (!artifact) {
					throw new Error("The plan-only run stored no plan document");
				}
				const document = validatePlanningDocument(JSON.parse(artifact.payload));
				ctx.ui.setWidget(runUiKey(runId), [
					`Proposed plan: ${document.plan.title}`,
					...document.plan.tasks.map(
						(task) =>
							`- ${task.id}: ${task.title} (paths: ${task.allowedPaths.join(", ")})`,
					),
					...renderPlanningObservations(document.observations),
					`Stored as artifact ${artifact.id}`,
				]);
				ctx.ui.notify(
					`Proposed plan "${document.plan.title}" with ${document.plan.tasks.length} tasks (artifact ${artifact.id})`,
					"info",
				);
			} catch (error) {
				ctx.ui.setStatus("pi-orchestrator", "failed");
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	registerWithLegacyAlias("orchestrate-investigate", "build-investigate", {
		description:
			"Answer a request file read-only through investigation and synthesis workers",
		handler: async (args, ctx) => {
			const pathArgument = parsePathArgument(args);
			if (!pathArgument) {
				ctx.ui.notify(
					"Usage: /orchestrate-investigate <request-file>",
					"error",
				);
				return;
			}
			ctx.ui.setStatus("pi-orchestrator", "investigate workflow");
			try {
				const requestText = await readRequestFile(ctx.cwd, pathArgument);
				const questions = investigationQuestionsFromRequest(requestText);
				if (questions.length === 0) {
					throw new Error("The request file contains nothing to investigate");
				}
				const git = new GitCli();
				const repository = await git.inspect(ctx.cwd);
				const workflow = await readOnlyWorkflowRuntime(git, repository);
				const model = selectedWorkerModel(ctx);
				const runId = newWorkflowRunId("investigate");
				const state = await runReadOnlyWorkflow(workflow, {
					runId,
					repository,
					plan: buildInvestigateWorkflowPlan({ requestText, questions }),
					handlers: investigateStepHandlers({
						worker: new StepWorkerRunner({
							workers: workflow.workers,
							securityPolicy: workflow.securityPolicy,
							...(model
								? { provider: model.provider, model: model.model }
								: {}),
						}),
						git,
						securityPolicy: workflow.securityPolicy,
						requestText,
					}),
				});
				ctx.ui.setStatus("pi-orchestrator", undefined);
				if (state.state !== "completed") {
					ctx.ui.setWidget(runUiKey(runId), [
						`Investigate run ${runId}: ${state.state}`,
						...describeFailedSteps(state),
					]);
					ctx.ui.notify(`Investigate run ${runId} ${state.state}`, "error");
					return;
				}
				const report = await workflow.artifacts.latest(
					runId,
					SYNTHESIS_STEP_ID,
					INVESTIGATE_REPORT_OUTPUT,
				);
				if (!report) {
					throw new Error("The investigate run stored no synthesis report");
				}
				ctx.ui.setWidget(runUiKey(runId), [
					`Investigated ${questions.length} ${questions.length === 1 ? "question" : "questions"}:`,
					...questions.map((question) => `- ${question}`),
					"",
					report.payload.slice(0, 4_000),
					`Stored as artifact ${report.id}`,
				]);
				ctx.ui.notify(`Investigation complete (artifact ${report.id})`, "info");
			} catch (error) {
				ctx.ui.setStatus("pi-orchestrator", "failed");
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	registerWithLegacyAlias("orchestrate-cancel", "build-cancel", {
		description: "Cancel a orchestration run and stop its active workers",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (!runId || /\s/.test(runId)) {
				ctx.ui.notify("Usage: /orchestrate-cancel <run-id>", "error");
				return;
			}
			ctx.ui.setStatus("pi-orchestrator", "cancelling run");
			try {
				const git = new GitCli();
				const repository = await git.inspect(ctx.cwd);
				const { orchestrator, store } = await createRuntime(git, repository);
				const stored = await store.load(runId);
				assertRunRepository(stored, repository);
				if (
					!["completed", "failed", "cancelled"].includes(stored.state) &&
					ctx.hasUI &&
					!(await ctx.ui.confirm(
						`Cancel run ${runId}?`,
						`The run is ${stored.state}. Active workers and validation will be stopped. State, logs, and worktrees remain inspectable.`,
					))
				) {
					ctx.ui.setStatus("pi-orchestrator", undefined);
					ctx.ui.notify("Cancellation declined", "info");
					return;
				}
				const cancelled = await orchestrator.cancelRun(stored);
				const key = runUiKey(runId);
				ctx.ui.setStatus("pi-orchestrator", undefined);
				ctx.ui.setStatus(key, `run ${runId}: ${cancelled.state}`);
				ctx.ui.setWidget(key, renderRunOverview(cancelled));
				ctx.ui.notify(
					cancelled.state === "cancelled"
						? `Run ${runId} cancelled and workers stopped`
						: `Run ${runId} was already ${cancelled.state}; no lifecycle work was changed`,
					"info",
				);
			} catch (error) {
				ctx.ui.setStatus("pi-orchestrator", "cancellation failed");
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	registerWithLegacyAlias("orchestrate-resume", "build-resume", {
		description:
			"Recover an interrupted orchestration run and launch ready retries",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (!runId || /\s/.test(runId)) {
				ctx.ui.notify("Usage: /orchestrate-resume <run-id>", "error");
				return;
			}
			ctx.ui.setStatus("pi-orchestrator", "recovering run");
			try {
				const git = new GitCli();
				const repository = await git.inspect(ctx.cwd);
				if (!repository.isClean) {
					throw new Error("Commit or stash all changes before resuming a run");
				}
				const runtime = await createRuntime(git, repository);
				const { orchestrator, store } = runtime;
				const stored = await store.load(runId);
				assertRunRepository(stored, repository);
				if (stored.state === "failed") {
					throw new Error(
						`Run ${runId} failed; inspect it with /orchestrate-show ${runId} and retry safe failed work with /orchestrate-retry ${runId}`,
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
				const recovered = await orchestrator.recoverRun(runId);
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
					ctx.ui.setStatus("pi-orchestrator", undefined);
					ctx.ui.notify(
						`Run ${runId} is already merge-ready at ${recovered.integrationHead}`,
						"info",
					);
					return;
				}
				assertRunBase(recovered, freshRepository);
				ctx.ui.setStatus("pi-orchestrator", "launching retries");
				const result = await orchestrator.resumeAndLaunch(
					recovered,
					freshRepository,
					selectedWorkerModel(ctx),
					lifecycleUi(ctx),
				);
				showLaunch(ctx, result, store);
			} catch (error) {
				ctx.ui.setStatus("pi-orchestrator", "failed");
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});
}
