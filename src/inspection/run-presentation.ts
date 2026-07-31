import type {
	FinalValidationAttempt,
	FinalValidationEvidence,
	OrchestrationRun,
	RepairAttempt,
	ReviewAttempt,
	RunTask,
	TaskAttempt,
	TaskDefinition,
	TaskValidationEvidence,
	ValidationCheckEvidence,
} from "../domain/types.js";
import { REVIEW_CATEGORIES } from "../domain/types.js";
import { formatCommand } from "../planning/plan-presentation.js";
import { securityPolicyLines, workerLaunchPolicy } from "../security/policy.js";

const MAX_INLINE_LENGTH = 500;
const MAX_OUTPUT_LENGTH = 2_000;
const MAX_OUTPUT_LINES = 12;
const MAX_OUTPUT_LINE_LENGTH = 300;

export type RunAttemptResolution =
	| { kind: "task"; attempt: TaskAttempt }
	| { kind: "review"; attempt: ReviewAttempt }
	| { kind: "repair"; attempt: RepairAttempt }
	| { kind: "final-validation"; attempt: FinalValidationAttempt };

export type WorkerAttemptResolution = Exclude<
	RunAttemptResolution,
	{ kind: "final-validation" }
>;

function isUnsafeTerminalCharacter(character: string): boolean {
	const codePoint = character.codePointAt(0) ?? 0;
	return (
		codePoint <= 0x1f ||
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		(codePoint >= 0x2028 && codePoint <= 0x202e) ||
		(codePoint >= 0x2066 && codePoint <= 0x2069)
	);
}

function safeInline(value: string, maximum = MAX_INLINE_LENGTH): string {
	const safe = [...value]
		.map((character) =>
			isUnsafeTerminalCharacter(character) ? " " : character,
		)
		.join("")
		.trim();
	return safe.length <= maximum
		? safe
		: `${safe.slice(0, Math.max(0, maximum - 1))}…`;
}

function display(value: string | undefined, fallback = "none"): string {
	return value === undefined || value.length === 0
		? fallback
		: safeInline(value);
}

function displayList(values: string[], fallback = "none"): string {
	return values.length > 0
		? safeInline(values.map((value) => safeInline(value, 200)).join(", "))
		: fallback;
}

function commandText(check: Pick<ValidationCheckEvidence, "command" | "args">) {
	return safeInline(formatCommand(check), MAX_INLINE_LENGTH);
}

function outputTailLines(label: string, output: string): string[] {
	if (output.length === 0) {
		return [`  ${label}: (empty)`];
	}
	const bounded =
		output.length > MAX_OUTPUT_LENGTH
			? `…${output.slice(output.length - MAX_OUTPUT_LENGTH + 1)}`
			: output;
	const rawLines = bounded.split(/\r\n|\r|\n/);
	const selected = rawLines.slice(-MAX_OUTPUT_LINES);
	const omitted = rawLines.length - selected.length;
	return [
		`  ${label} tail${output.length > bounded.length || omitted > 0 ? " (truncated)" : ""}:`,
		...(omitted > 0 ? [`    … ${omitted} earlier line(s) omitted`] : []),
		...selected.map(
			(line) => `    ${safeInline(line, MAX_OUTPUT_LINE_LENGTH) || " "}`,
		),
	];
}

function renderCheck(check: ValidationCheckEvidence, index: number): string[] {
	const boundary = check.executionBoundary;
	return [
		`Check ${index + 1}: ${check.passed ? "passed" : "failed"} (exit ${check.exitCode ?? "none"}) - ${commandText(check)}`,
		`  Started: ${display(check.startedAt)} | Finished: ${display(check.finishedAt)}`,
		`  Boundary: ${boundary ? `${boundary.sandbox} sandbox, ${boundary.network} network, ${boundary.environment}` : "legacy unrecorded"}`,
		...outputTailLines("stdout", check.stdoutTail),
		...outputTailLines("stderr", check.stderrTail),
	];
}

function changedFileText(evidence: TaskValidationEvidence): string {
	if (evidence.changedFiles.length === 0) {
		return "none";
	}
	return safeInline(
		evidence.changedFiles
			.map((file) => {
				const rename = file.previousPath ? `${file.previousPath} -> ` : "";
				return `${file.status} ${rename}${file.path}`;
			})
			.join(", "),
	);
}

function renderEvidence(
	evidence: TaskValidationEvidence | FinalValidationEvidence | undefined,
): string[] {
	if (!evidence) {
		return ["Evidence: none recorded"];
	}
	const passed = evidence.checks.filter((check) => check.passed).length;
	const taskLines: string[] = [];
	if ("changedFiles" in evidence) {
		taskLines.push(
			`Diff hash: ${display(evidence.diffHash)}`,
			`Changed files: ${changedFileText(evidence)}`,
		);
	}
	return [
		`Evidence: ${evidence.passed ? "passed" : "failed"}, checks ${passed}/${evidence.checks.length}`,
		`Evidence time: ${display(evidence.startedAt)} -> ${display(evidence.finishedAt)}`,
		...taskLines,
		...evidence.checks.flatMap(renderCheck),
	];
}

export function taskStateSummary(run: OrchestrationRun): string {
	const counts = Object.values(run.tasks).reduce((result, task) => {
		result.set(task.state, (result.get(task.state) ?? 0) + 1);
		return result;
	}, new Map<string, number>());
	const summary = [
		"running",
		"validating",
		"succeeded",
		"ready",
		"planned",
		"blocked",
		"failed",
		"cancelled",
	]
		.flatMap((state) => {
			const count = counts.get(state);
			return count ? [`${count} ${state}`] : [];
		})
		.join(", ");
	return summary || "none";
}

export function reviewStateSummary(run: OrchestrationRun): string {
	if (run.reviewRounds.length === 0) {
		return "Reviews: not started";
	}
	const roundNumber = run.reviewRounds.at(-1)?.number ?? 0;
	let succeeded = 0;
	let repairRequired = 0;
	let deferred = 0;
	let unresolved = 0;
	for (const attempt of run.reviewAttempts) {
		if (attempt.round !== roundNumber) {
			continue;
		}
		if (attempt.state === "succeeded") {
			succeeded += 1;
		}
		for (const finding of attempt.findings ?? []) {
			switch (finding.status) {
				case "repair_required":
					repairRequired += 1;
					break;
				case "deferred":
					deferred += 1;
					break;
				case "unresolved":
					unresolved += 1;
					break;
				default:
					break;
			}
		}
	}
	return `Review round ${roundNumber}: ${succeeded}/${REVIEW_CATEGORIES.length} reports received, ${repairRequired} repair-required, ${unresolved} unresolved, ${deferred} deferred`;
}

function nextRunAction(run: OrchestrationRun): string {
	if (run.state === "completed" || run.state === "cancelled") {
		return `/orchestrate-prune ${safeInline(run.id)}`;
	}
	if (
		run.state === "running" ||
		run.state === "reviewing" ||
		run.state === "repairing"
	) {
		const followable = latestFollowableWorkerAttempt(run);
		if (followable) {
			return `/orchestrate-follow ${safeInline(run.id)} ${safeInline(followable.attempt.id)}`;
		}
		return `/orchestrate-cancel ${safeInline(run.id)}`;
	}
	return `/orchestrate-resume ${safeInline(run.id)}`;
}

export function renderRunList(runs: readonly OrchestrationRun[]): string[] {
	if (runs.length === 0) {
		return [
			"No orchestration runs found.",
			"Next: /orchestrate <request-file>",
		];
	}
	const sorted = [...runs].sort(
		(left, right) =>
			right.updatedAt.localeCompare(left.updatedAt) ||
			left.id.localeCompare(right.id),
	);
	return [
		`Orchestration runs (${runs.length}), newest first:`,
		...sorted.map(
			(run) =>
				`${display(run.updatedAt)} | ${safeInline(run.id)} | ${run.state} | ${taskStateSummary(run)} | ${safeInline(run.plan.title)}`,
		),
		"Next: /orchestrate-show <run-id>",
	];
}

function renderRunTaskOverview(
	definition: TaskDefinition,
	task: RunTask | undefined,
): string {
	let details = `- ${safeInline(definition.id)} [${task?.state ?? "missing"}] ${safeInline(definition.title)}; dependencies: ${displayList(definition.dependencies)}; attempts: ${task?.attemptIds.length ?? 0}`;
	if (task?.integratedCommit) {
		details += `; integrated ${display(task.integratedCommit)}`;
	}
	if (task?.integrationError) {
		details += `; error: ${safeInline(task.integrationError)}`;
	}
	return details;
}

function latestReviewRoundLines(run: OrchestrationRun): string[] {
	const round = run.reviewRounds.at(-1);
	if (!round) {
		return [];
	}
	const finished = round.finishedAt
		? display(round.finishedAt)
		: round.state === "running" || round.state === "repairing"
			? "in progress"
			: "finished (time unavailable)";
	let line = `Latest review round: ${round.state}; base ${display(round.baseCommit)}; ${display(round.startedAt)} -> ${finished}`;
	if (round.repairAttemptId) {
		line += `; repair ${display(round.repairAttemptId)}`;
	}
	if (round.error) {
		line += `; error: ${safeInline(round.error)}`;
	}
	return [line];
}

function blockedWorkerLines(
	run: OrchestrationRun,
	attemptId?: string,
): string[] {
	const blockedWorkers = attemptId
		? run.blockedWorkers.filter((blocked) => blocked.attemptId === attemptId)
		: run.blockedWorkers;
	if (blockedWorkers.length === 0) {
		return [attemptId ? "Worker prompts: none" : "Blocked workers: none"];
	}
	return [
		attemptId
			? `Worker prompts: ${blockedWorkers.length} pending`
			: `Blocked workers: ${blockedWorkers.length}`,
		...blockedWorkers.map(
			(blocked) =>
				`- ${safeInline(blocked.attemptId)} / ${safeInline(blocked.workerId)} waiting on ${blocked.method} since ${display(blocked.blockedAt)}${blocked.timeoutAt ? `; timeout ${display(blocked.timeoutAt)}` : ""}`,
		),
	];
}

function finalValidationLines(run: OrchestrationRun): string[] {
	const attempt = run.finalValidationAttempts.at(-1);
	if (!attempt) {
		return ["Final validation: not started"];
	}
	let line = `Final validation: ${attempt.state} at ${display(attempt.integrationCommit)}`;
	if (attempt.evidence) {
		const passed = attempt.evidence.checks.filter(
			(check) => check.passed,
		).length;
		line += `; checks ${passed}/${attempt.evidence.checks.length}`;
	}
	if (attempt.error) {
		line += `; error: ${safeInline(attempt.error)}`;
	}
	return [line];
}

export function renderRunOverview(run: OrchestrationRun): string[] {
	return [
		`Run ${safeInline(run.id)}: ${safeInline(run.plan.title)}`,
		`State: ${run.state} | Snapshot revision: ${run.revision} | Schema: ${run.schemaVersion}`,
		`Created: ${display(run.createdAt)} | Updated: ${display(run.updatedAt)} | Approved: ${display(run.approvedAt, "not approved")}`,
		`Repository: ${display(run.repositoryRoot)}`,
		`Base: ${display(run.baseBranch)} @ ${display(run.baseCommit)}`,
		`Integration: ${display(run.integrationBranch)} @ ${display(run.integrationHead)}`,
		`Plan revision: ${run.planRevision}${run.approvedPlanRevision ? ` (approved ${run.approvedPlanRevision})` : ""} | Worker limit: ${run.maxConcurrentWorkers}`,
		`Request: ${display(run.request.sourcePath)}`,
		"Security boundary:",
		...securityPolicyLines(run.securityPolicy).map((line) => safeInline(line)),
		`Tasks: ${taskStateSummary(run)}`,
		...run.plan.tasks.map((definition) =>
			renderRunTaskOverview(definition, run.tasks[definition.id]),
		),
		reviewStateSummary(run),
		...latestReviewRoundLines(run),
		`Attempts: ${run.attempts.length} task, ${run.reviewAttempts.length} review, ${run.repairAttempts.length} repair, ${run.finalValidationAttempts.length} final validation`,
		...blockedWorkerLines(run),
		...finalValidationLines(run),
		`Merge-ready evidence: ${run.mergeReadyEvidence ? `generated ${display(run.mergeReadyEvidence.generatedAt)}` : "none"}`,
		`Next: ${nextRunAction(run)}`,
	];
}

function bulletLines(values: string[]): string[] {
	if (values.length === 0) {
		return ["- none"];
	}
	return values.map((value) => `- ${safeInline(value)}`);
}

function taskAttemptHistoryLines(
	run: OrchestrationRun,
	attemptIds: string[],
): { lines: string[]; latest: TaskAttempt | undefined } {
	if (attemptIds.length === 0) {
		return { lines: ["- none"], latest: undefined };
	}
	let latest: TaskAttempt | undefined;
	const lines = attemptIds.flatMap((attemptId) => {
		const attempt = run.attempts.find(
			(candidate) => candidate.id === attemptId,
		);
		if (!attempt) {
			return [`- ${safeInline(attemptId)}: missing attempt record`];
		}
		latest = attempt;
		const attemptLines = [
			`- #${attempt.number} ${safeInline(attempt.id)}: ${attempt.state}, worker ${display(attempt.workerId, "not assigned")}, ${display(attempt.startedAt)} -> ${display(attempt.finishedAt, "in progress")}`,
			`  branch ${display(attempt.branch)} | worktree ${display(attempt.worktreePath)}`,
			`  base ${display(attempt.baseCommit)} | commit ${display(attempt.commit)}`,
		];
		if (attempt.evidence) {
			const passingChecks = attempt.evidence.checks.filter(
				(check) => check.passed,
			).length;
			attemptLines.push(
				`  evidence ${attempt.evidence.passed ? "passed" : "failed"}; checks ${passingChecks}/${attempt.evidence.checks.length}`,
			);
		}
		if (attempt.error) {
			attemptLines.push(`  error: ${safeInline(attempt.error)}`);
		}
		return attemptLines;
	});
	return { lines, latest };
}

function nextTaskAction(
	run: OrchestrationRun,
	taskId: string,
	task: RunTask,
	latest: TaskAttempt | undefined,
): string {
	if (latest && isFollowableWorkerAttempt({ kind: "task", attempt: latest })) {
		return `/orchestrate-follow ${safeInline(run.id)} ${safeInline(latest.id)}`;
	}
	if (
		task.state === "failed" ||
		latest?.state === "failed" ||
		latest?.state === "interrupted"
	) {
		return `/orchestrate-retry ${safeInline(run.id)} ${safeInline(taskId)}`;
	}
	if (latest) {
		return `/orchestrate-show ${safeInline(run.id)} attempt ${safeInline(latest.id)}`;
	}
	return `/orchestrate-show ${safeInline(run.id)}`;
}

export function renderTaskDetails(
	run: OrchestrationRun,
	taskId: string,
): string[] {
	const task = run.tasks[taskId];
	if (!task) {
		throw new Error(`Unknown task ID: ${safeInline(taskId)}`);
	}
	const definition = task.definition;
	const history = taskAttemptHistoryLines(run, task.attemptIds);
	return [
		`Task ${safeInline(definition.id)}: ${safeInline(definition.title)}`,
		`State: ${task.state} | Attempts: ${task.attemptIds.length}`,
		`Description: ${safeInline(definition.description)}`,
		`Dependencies: ${displayList(definition.dependencies)}`,
		`Allowed paths: ${displayList(definition.allowedPaths)}`,
		"Acceptance criteria:",
		...bulletLines(definition.acceptanceCriteria),
		"Validation commands:",
		...bulletLines(definition.validationCommands.map(formatCommand)),
		`Integrated commit: ${display(task.integratedCommit)}`,
		`Integration error: ${display(task.integrationError)}`,
		"Attempt history:",
		...history.lines,
		`Next: ${nextTaskAction(run, taskId, task, history.latest)}`,
	];
}

export function resolveRunAttempt(
	run: OrchestrationRun,
	attemptId: string,
): RunAttemptResolution {
	const matches: RunAttemptResolution[] = [];
	for (const attempt of run.attempts) {
		if (attempt.id === attemptId) {
			matches.push({ kind: "task", attempt });
		}
	}
	for (const attempt of run.reviewAttempts) {
		if (attempt.id === attemptId) {
			matches.push({ kind: "review", attempt });
		}
	}
	for (const attempt of run.repairAttempts) {
		if (attempt.id === attemptId) {
			matches.push({ kind: "repair", attempt });
		}
	}
	for (const attempt of run.finalValidationAttempts) {
		if (attempt.id === attemptId) {
			matches.push({ kind: "final-validation", attempt });
		}
	}
	if (matches.length === 0) {
		throw new Error(`Unknown attempt ID: ${safeInline(attemptId)}`);
	}
	if (matches.length > 1) {
		throw new Error(
			`Ambiguous attempt ID ${safeInline(attemptId)}: found ${matches.map((match) => match.kind).join(", ")}`,
		);
	}
	const match = matches[0];
	if (!match) {
		throw new Error(`Unknown attempt ID: ${safeInline(attemptId)}`);
	}
	return match;
}

function workerAttempts(run: OrchestrationRun): WorkerAttemptResolution[] {
	return [
		...run.attempts.map(
			(attempt): WorkerAttemptResolution => ({ kind: "task", attempt }),
		),
		...run.reviewAttempts.map(
			(attempt): WorkerAttemptResolution => ({ kind: "review", attempt }),
		),
		...run.repairAttempts.map(
			(attempt): WorkerAttemptResolution => ({ kind: "repair", attempt }),
		),
	];
}

export function latestWorkerAttempt(
	run: OrchestrationRun,
): WorkerAttemptResolution | undefined {
	return workerAttempts(run).sort(
		(left, right) =>
			right.attempt.startedAt.localeCompare(left.attempt.startedAt) ||
			right.attempt.number - left.attempt.number,
	)[0];
}

function isFollowableWorkerAttempt(resolution: RunAttemptResolution): boolean {
	return (
		resolution.kind !== "final-validation" &&
		resolution.attempt.workerId !== undefined &&
		["launched", "running"].includes(resolution.attempt.state)
	);
}

export function latestFollowableWorkerAttempt(
	run: OrchestrationRun,
): WorkerAttemptResolution | undefined {
	return workerAttempts(run)
		.filter(isFollowableWorkerAttempt)
		.sort(
			(left, right) =>
				right.attempt.startedAt.localeCompare(left.attempt.startedAt) ||
				right.attempt.number - left.attempt.number,
		)[0];
}

export function renderAttemptDetails(
	run: OrchestrationRun,
	attemptId: string,
): string[] {
	const resolution = resolveRunAttempt(run, attemptId);
	const { attempt } = resolution;
	const workerRole =
		resolution.kind === "task"
			? "implementation"
			: resolution.kind === "review"
				? "review"
				: resolution.kind === "repair"
					? "repair"
					: undefined;
	const launchPolicy = workerRole
		? workerLaunchPolicy(run.securityPolicy, workerRole)
		: undefined;
	const common = [
		`Attempt ${safeInline(attempt.id)} (${resolution.kind})`,
		`State: ${attempt.state} | Number: ${attempt.number}`,
		`Started: ${display(attempt.startedAt)} | Finished: ${display(attempt.finishedAt, "in progress")}`,
		...(workerRole
			? [
					`Worker authority: ${workerRole}; tools ${launchPolicy?.tools.join(", ") ?? "legacy unrestricted"}; resources ${run.securityPolicy.workers.resourceDiscovery}`,
				]
			: [
					`Validation authority: ${run.securityPolicy.validation.sandbox} sandbox; ${run.securityPolicy.validation.network} network; ${run.securityPolicy.validation.environment}`,
				]),
	];
	let details: string[];
	let evidence: TaskValidationEvidence | FinalValidationEvidence | undefined;
	if (resolution.kind === "task") {
		const task = run.tasks[resolution.attempt.taskId];
		details = [
			`Task: ${safeInline(resolution.attempt.taskId)}${task ? ` - ${safeInline(task.definition.title)}` : " (missing definition)"}`,
			`Worker: ${display(resolution.attempt.workerId, "not assigned")}`,
			`Branch: ${display(resolution.attempt.branch)}`,
			`Worktree: ${display(resolution.attempt.worktreePath)}`,
			`Base commit: ${display(resolution.attempt.baseCommit)}`,
			`Commit: ${display(resolution.attempt.commit)}`,
		];
		evidence = resolution.attempt.evidence;
	} else if (resolution.kind === "review") {
		details = [
			`Review: round ${resolution.attempt.round}, category ${resolution.attempt.category}`,
			`Worker: ${display(resolution.attempt.workerId, "not assigned")}`,
			`Branch: ${display(resolution.attempt.branch)}`,
			`Worktree: ${display(resolution.attempt.worktreePath)}`,
			`Base commit: ${display(resolution.attempt.baseCommit)}`,
			`Summary: ${display(resolution.attempt.summary)}`,
			`Findings: ${resolution.attempt.findings?.length ?? 0}`,
			...(resolution.attempt.findings ?? []).flatMap((finding) => [
				`- ${safeInline(finding.id)} [${finding.severity}/${finding.confidence}/${finding.status}] ${safeInline(finding.title)}; paths: ${displayList(finding.paths)}`,
				`  Description: ${safeInline(finding.description)}`,
				`  Recommendation: ${safeInline(finding.recommendation)}`,
			]),
		];
	} else if (resolution.kind === "repair") {
		details = [
			`Repair: round ${resolution.attempt.round}, findings ${displayList(resolution.attempt.findingIds)}`,
			`Worker: ${display(resolution.attempt.workerId, "not assigned")}`,
			`Branch: ${display(resolution.attempt.branch)}`,
			`Worktree: ${display(resolution.attempt.worktreePath)}`,
			`Base commit: ${display(resolution.attempt.baseCommit)}`,
			`Source commit: ${display(resolution.attempt.commit)}`,
			`Integrated commit: ${display(resolution.attempt.integratedCommit)}`,
		];
		evidence = resolution.attempt.evidence;
	} else {
		details = [
			`Integration commit: ${display(resolution.attempt.integrationCommit)}`,
			`Worktree: ${display(resolution.attempt.worktreePath)}`,
		];
		evidence = resolution.attempt.evidence;
	}
	let next: string;
	if (isFollowableWorkerAttempt(resolution)) {
		next = `/orchestrate-follow ${safeInline(run.id)} ${safeInline(attempt.id)}`;
	} else if (
		attempt.state === "failed" ||
		attempt.state === "interrupted" ||
		attempt.state === "cancelled"
	) {
		next =
			resolution.kind === "task"
				? `/orchestrate-retry ${safeInline(run.id)} ${safeInline(resolution.attempt.taskId)}`
				: `/orchestrate-resume ${safeInline(run.id)}`;
	} else {
		next = `/orchestrate-show ${safeInline(run.id)}`;
	}
	return [
		...common,
		...details,
		...blockedWorkerLines(run, attempt.id),
		`Error: ${display(attempt.error)}`,
		...renderEvidence(evidence),
		`Next: ${next}`,
	];
}
